// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Diamond Bond

package main

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DiamondBond/q2-eq-studio/internal/q2"
)

// testApp is an app on a card folder and a /tmp of its own, and its web handler.
func testApp(t *testing.T) (*app, http.Handler) {
	root := t.TempDir()
	o := options{card: filepath.Join(root, "mmc"), tmp: filepath.Join(root, "tmp")}
	o.dir = filepath.Join(o.card, ".eq-studio")
	os.MkdirAll(o.dir, 0o755)
	os.MkdirAll(o.tmp, 0o755)
	q2.Card = o.card
	a := newApp(o)
	a.eq.wait = 500 * time.Millisecond
	return a, newWeb(a)
}

// firmware plays Q2 Pod's side until the test ends: the caps say eq, and each new request is
// answered with answer(seq, body).
func firmware(t *testing.T, a *app, answer func(seq, body string) string) {
	os.WriteFile(a.eq.caps, []byte("pages art eq sort\n"), 0o644)
	stop, gone := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(stop); <-gone })
	go func() {
		defer close(gone)
		last := ""
		for {
			select {
			case <-stop:
				return
			case <-time.After(10 * time.Millisecond):
			}
			req, err := os.ReadFile(a.eq.req)
			seq, body, _ := strings.Cut(string(req), "\n")
			if err == nil && seq != last {
				last = seq
				q2.WriteFile(a.eq.done, []byte(answer(seq, body)))
			}
		}
	}()
}

func TestBridge(t *testing.T) {
	a, _ := testApp(t)
	if a.eq.live() {
		t.Fatal("live without caps")
	}
	// A stale answer there first is passed over.
	os.WriteFile(a.eq.done, []byte("OLD ok\nmode off\n"), 0o644)
	firmware(t, a, func(seq, body string) string {
		if body == "get" {
			return seq + " ok\nmode peq\nFilter 1: ON PK Fc 100 Hz Gain 2.0 dB Q 1.00\n"
		}
		return seq + " error line 1: no filter"
	})
	if !a.eq.live() {
		t.Fatal("not live with eq in the caps")
	}
	got, err := a.eq.ask("get")
	if err != nil || !got.ok || got.mode != "peq" || got.preset != "Filter 1: ON PK Fc 100 Hz Gain 2.0 dB Q 1.00\n" {
		t.Fatalf("get: %+v %v", got, err)
	}
	got, err = a.eq.ask("Filter 1: nonsense")
	if err != nil || got.ok || got.reason != "line 1: no filter" {
		t.Fatalf("error: %+v %v", got, err)
	}
}

func TestBridgeTimeout(t *testing.T) {
	a, _ := testApp(t)
	firmware(t, a, func(seq, body string) string { return "OTHER ok\nmode peq\n" }) // never this seq
	a.eq.wait = 200 * time.Millisecond
	began := time.Now()
	if _, err := a.eq.ask("get"); err != errNoAnswer || time.Since(began) < 200*time.Millisecond {
		t.Fatalf("%v after %v", err, time.Since(began))
	}
}

// do sends a request to h, with the cookie if signed in.
func do(h http.Handler, method, url, body string, signedIn *http.Cookie, xq2 bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	if signedIn != nil {
		r.AddCookie(signedIn)
	}
	if xq2 {
		r.Header.Set("X-Q2", "1")
	}
	rw := httptest.NewRecorder()
	h.ServeHTTP(rw, r)
	return rw
}

func cookie(rw *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rw.Result().Cookies() {
		if c.Name == cookieName {
			return c
		}
	}
	return nil
}

func TestSignIn(t *testing.T) {
	a, h := testApp(t)
	if b := newApp(a.opts); b.set != a.set {
		t.Fatal("key and PIN not kept")
	}
	if rw := do(h, "GET", "/?k=WRONGKEY2345", "", nil, false); rw.Code != 302 || cookie(rw) != nil {
		t.Fatalf("wrong key: %d", rw.Code)
	}
	rw := do(h, "GET", "/?k="+a.set.Key, "", nil, false)
	c := cookie(rw)
	if rw.Code != 302 || c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("key: %d %+v", rw.Code, c)
	}
	if rw := do(h, "GET", "/api/state", "", nil, false); rw.Code != 401 {
		t.Fatalf("no cookie: %d", rw.Code)
	}
	if rw := do(h, "GET", "/api/state", "", c, false); rw.Code != 200 || rw.Body.String() != `{"error":null,"live":false,"mode":null,"preset":null}`+"\n" {
		t.Fatalf("state: %d %s", rw.Code, rw.Body)
	}
	if rw := do(h, "PUT", "/api/mode", `{"on":true}`, c, false); rw.Code != 400 {
		t.Fatalf("no X-Q2: %d", rw.Code)
	}
	if rw := do(h, "PUT", "/api/mode", `{"on":true}`, c, true); rw.Code != 503 {
		t.Fatalf("not live: %d", rw.Code)
	}
	if rw := do(h, "POST", "/api/login", `{"pin":"`+a.set.PIN+`"}`, nil, true); rw.Code != 200 || cookie(rw) == nil {
		t.Fatalf("PIN: %d", rw.Code)
	}
	for i := 0; i < 10; i++ {
		if rw := do(h, "POST", "/api/login", `{"pin":"x"}`, nil, true); rw.Code != 403 {
			t.Fatalf("wrong PIN %d: %d", i, rw.Code)
		}
	}
	if rw := do(h, "POST", "/api/login", `{"pin":"`+a.set.PIN+`"}`, nil, true); rw.Code != 429 || cookie(rw) != nil {
		t.Fatalf("locked: %d", rw.Code)
	}
}

func TestLiveAPI(t *testing.T) {
	a, h := testApp(t)
	c := &http.Cookie{Name: cookieName, Value: a.set.Key}
	firmware(t, a, func(seq, body string) string {
		switch body {
		case "off":
			return seq + " ok\nmode off\nFilter 1: ON PK Fc 100 Hz Gain 2.0 dB Q 1.00\n"
		case "Filter 1: bad":
			return seq + " error line 1: bad filter"
		}
		return seq + " ok\nmode peq\n" + body
	})
	for _, tc := range []struct{ method, url, body, want string }{
		{"PUT", "/api/eq", "Filter 1: ON PK Fc 1000 Hz Gain -3.0 dB Q 1.41\n", `{"mode":"peq","ok":true}`},
		{"PUT", "/api/eq", "Filter 1: bad", `{"error":"line 1: bad filter","ok":false}`},
		{"PUT", "/api/mode", `{"on":false}`, `{"mode":"off","ok":true}`},
		{"GET", "/api/state", "", `{"error":null,"live":true,"mode":"peq","preset":"get"}`},
	} {
		if rw := do(h, tc.method, tc.url, tc.body, c, true); rw.Code != 200 || rw.Body.String() != tc.want+"\n" {
			t.Errorf("%s %s: %d %s", tc.method, tc.url, rw.Code, rw.Body)
		}
	}
	if rw := do(h, "PUT", "/api/eq", strings.Repeat("x", presetLimit+1), c, true); rw.Code != 413 {
		t.Errorf("too big: %d", rw.Code)
	}
}

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{"HD 600.txt": true, "Ünïcode ½.txt": true, ".txt": false,
		".hidden.txt": false, "a.TXT": false, "a.peq": false, "a/b.txt": false, `a\b.txt`: false, "a:b.txt": false,
		"a*.txt": false, "a?.txt": false, `a".txt`: false, "a<.txt": false, "a|.txt": false, "a\n.txt": false,
		"../a.txt": false, strings.Repeat("a", 60) + ".txt": true, strings.Repeat("a", 61) + ".txt": false} {
		if validName(name) != want {
			t.Errorf("%q: %v", name, !want)
		}
	}
}

func TestCardFiles(t *testing.T) {
	a, h := testApp(t)
	c := &http.Cookie{Name: cookieName, Value: a.set.Key}
	if rw := do(h, "GET", "/api/card", "", c, false); rw.Body.String() != `{"files":[]}`+"\n" {
		t.Fatalf("no folder: %s", rw.Body)
	}
	steps := []struct {
		method, url, body string
		code              int
	}{
		{"PUT", "/api/card/file?name=b.txt", "B1", 200},
		{"PUT", "/api/card/file?name=b.txt", "B2", 409},
		{"PUT", "/api/card/file?name=b.txt&replace=1", "B3", 200},
		{"PUT", "/api/card/file?name=A.txt", "A", 200},
		{"PUT", "/api/card/file?name=..%2Fx.txt", "X", 400},
		{"GET", "/api/card/file?name=b.txt", "", 200},
		{"DELETE", "/api/card/file?name=A.txt", "", 200},
		{"DELETE", "/api/card/file?name=A.txt", "", 404},
		{"GET", "/api/card/file?name=A.txt", "", 404},
	}
	for _, s := range steps {
		if rw := do(h, s.method, s.url, s.body, c, true); rw.Code != s.code {
			t.Fatalf("%s %s: %d %s", s.method, s.url, rw.Code, rw.Body)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(a.opts.card, "EQ", "b.txt")); string(b) != "B3" {
		t.Fatalf("b.txt: %q", b)
	}
	os.WriteFile(filepath.Join(a.opts.card, "EQ", "a.peq"), nil, 0o644)
	os.WriteFile(filepath.Join(a.opts.card, "EQ", "._b.txt"), nil, 0o644)
	do(h, "PUT", "/api/card/file?name=C.txt", "C", c, true)
	var list struct{ Files []struct{ Name, File string } }
	json.NewDecoder(do(h, "GET", "/api/card", "", c, false).Body).Decode(&list)
	if len(list.Files) != 2 || list.Files[0].Name != "b" || list.Files[1].File != "C.txt" {
		t.Fatalf("list: %+v", list)
	}
	os.RemoveAll(a.opts.dir) // the card gone
	if rw := do(h, "GET", "/api/card", "", c, false); rw.Code != 503 {
		t.Fatalf("card away: %d", rw.Code)
	}
}

func TestPresets(t *testing.T) {
	a, h := testApp(t)
	var gz strings.Builder
	zw := gzip.NewWriter(&gz)
	zw.Write([]byte(`{"credit":"AutoEq","presets":[]}`))
	zw.Close()
	os.WriteFile(filepath.Join(a.opts.dir, "presets.json.gz"), []byte(gz.String()), 0o644)
	rw := do(h, "GET", "/presets.json", "", nil, false)
	hd := rw.Header()
	if rw.Code != 200 || hd.Get("Content-Encoding") != "gzip" || hd.Get("Content-Type") != "application/json" ||
		hd.Get("ETag") == "" || hd.Get("Content-Security-Policy") == "" {
		t.Fatalf("%d %v", rw.Code, hd)
	}
	zr, err := gzip.NewReader(rw.Body)
	if b, _ := io.ReadAll(zr); err != nil || string(b) != `{"credit":"AutoEq","presets":[]}` {
		t.Fatalf("body %q %v", b, err)
	}
	r := httptest.NewRequest("GET", "/presets.json", nil)
	r.Header.Set("If-None-Match", hd.Get("ETag"))
	rw = httptest.NewRecorder()
	h.ServeHTTP(rw, r)
	if rw.Code != 304 {
		t.Fatalf("cached: %d", rw.Code)
	}
}
