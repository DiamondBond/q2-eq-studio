// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Diamond Bond
// The sign-in follows q2-filebrowser's (github.com/group-a-study/q2-filebrowser, MIT).

package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/DiamondBond/q2-eq-studio/internal/q2"
)

// webFiles is the phone page; its tests (web/*.test.mjs) stay out.
//
//go:embed web/*.html web/*.css web/*.js web/*.svg
var webFiles embed.FS

const (
	cookieName  = "q2eq"
	presetLimit = 16 << 10 // the firmware's PEQ_FILE_LIMIT
	csp         = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
		"connect-src 'self' https://squig.link https://*.squig.link; " + // squig.link's measurements, read by the page
		"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

// web is the page (web/) and a JSON API behind the key the QR code carries (or the PIN on the Q2's
// screen), kept in a cookie. A change must carry X-Q2: 1, which a page elsewhere can't send here
// without asking first, and the cookie is SameSite=Strict.
type web struct {
	a     *app
	files http.Handler

	mu      sync.Mutex
	fails   int
	lockout time.Time
}

func newWeb(a *app) http.Handler {
	sub, _ := fs.Sub(webFiles, "web")
	w := &web{a: a, files: http.FileServer(http.FS(sub))}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", w.page)
	mux.HandleFunc("GET /presets.json", w.presets)
	mux.HandleFunc("POST /api/login", w.login)
	mux.HandleFunc("GET /api/state", w.api(w.state))
	mux.HandleFunc("PUT /api/eq", w.api(w.putEQ))
	mux.HandleFunc("PUT /api/mode", w.api(w.putMode))
	mux.HandleFunc("GET /api/card", w.api(w.cardList))
	mux.HandleFunc("GET /api/card/file", w.api(w.cardGet))
	mux.HandleFunc("PUT /api/card/file", w.api(w.cardPut))
	mux.HandleFunc("DELETE /api/card/file", w.api(w.cardDelete))
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		h := rw.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(rw, r)
	})
}

func reply(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Cache-Control", "no-store")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(v)
}

func refuse(rw http.ResponseWriter, code int, msg string) {
	reply(rw, code, map[string]string{"error": msg})
}

var okReply = map[string]bool{"ok": true}

func (w *web) authed(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	return err == nil && w.isKey(c.Value)
}

func (w *web) isKey(k string) bool {
	w.a.mu.Lock()
	defer w.a.mu.Unlock()
	return subtle.ConstantTimeCompare([]byte(k), []byte(w.a.set.Key)) == 1
}

func (w *web) setCookie(rw http.ResponseWriter) {
	w.a.mu.Lock()
	key := w.a.set.Key
	w.a.mu.Unlock()
	http.SetCookie(rw, &http.Cookie{Name: cookieName, Value: key, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, MaxAge: 400 * 24 * 3600})
}

// page is web/, index.html at /; /?k=<key>, the QR code's address, signs the phone in.
func (w *web) page(rw http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		w.a.touch(true)
		if k := r.URL.Query().Get("k"); k != "" {
			if w.isKey(k) {
				w.setCookie(rw)
			}
			http.Redirect(rw, r, "/", http.StatusFound)
			return
		}
	}
	rw.Header().Set("Cache-Control", "no-cache")
	w.files.ServeHTTP(rw, r)
}

// login takes the Q2's PIN; ten wrong ones lock it for a minute.
func (w *web) login(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Q2") != "1" {
		refuse(rw, http.StatusBadRequest, "bad request")
		return
	}
	w.a.touch(true)
	var body struct{ PIN string }
	json.NewDecoder(http.MaxBytesReader(rw, r.Body, 1024)).Decode(&body)
	w.a.mu.Lock()
	pin := w.a.set.PIN
	w.a.mu.Unlock()
	w.mu.Lock()
	locked := time.Now().Before(w.lockout)
	good := !locked && subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.PIN)), []byte(pin)) == 1
	if good {
		w.fails = 0
	} else if !locked {
		if w.fails++; w.fails >= 10 {
			w.fails, w.lockout = 0, time.Now().Add(time.Minute)
		}
	}
	w.mu.Unlock()
	switch {
	case locked:
		refuse(rw, http.StatusTooManyRequests, "Too many tries. Wait a minute.")
	case !good:
		refuse(rw, http.StatusForbidden, "That's not the PIN on the Q2's screen.")
	default:
		w.setCookie(rw)
		reply(rw, http.StatusOK, okReply)
	}
}

// api is h for a signed-in phone; a change without X-Q2: 1 is refused.
func (w *web) api(h http.HandlerFunc) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Q2") != "1" {
			refuse(rw, http.StatusBadRequest, "bad request")
			return
		}
		if !w.authed(r) {
			refuse(rw, http.StatusUnauthorized, "sign in")
			return
		}
		w.a.touch(true)
		h(rw, r)
	}
}

// state is whether the Q2 takes the EQ live and, if it does, what it has now.
func (w *web) state(rw http.ResponseWriter, r *http.Request) {
	out := map[string]any{"live": false, "mode": nil, "preset": nil, "error": nil}
	if w.a.eq.live() {
		out["live"] = true
		a, err := w.a.eq.ask("get")
		switch {
		case err != nil:
			out["error"] = err.Error()
		case !a.ok:
			out["error"] = a.reason
		default:
			out["mode"], out["preset"] = a.mode, a.preset
		}
	}
	reply(rw, http.StatusOK, out)
}

// send asks the Q2 for body and replies with its answer: 503 when the firmware has no live EQ.
func (w *web) send(rw http.ResponseWriter, body string) {
	if !w.a.eq.live() {
		refuse(rw, http.StatusServiceUnavailable, "This Q2 Pod can't take an EQ from the phone: update it")
		return
	}
	a, err := w.a.eq.ask(body)
	switch {
	case err != nil:
		reply(rw, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
	case !a.ok:
		reply(rw, http.StatusOK, map[string]any{"ok": false, "error": a.reason})
	default:
		reply(rw, http.StatusOK, map[string]any{"ok": true, "mode": a.mode})
	}
}

// readPreset is a request's body, at most presetLimit bytes.
func readPreset(rw http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(http.MaxBytesReader(rw, r.Body, presetLimit))
	if err != nil {
		refuse(rw, http.StatusRequestEntityTooLarge, "A preset is at most 16 KB")
		return nil, false
	}
	return b, true
}

func (w *web) putEQ(rw http.ResponseWriter, r *http.Request) {
	if b, good := readPreset(rw, r); good {
		w.send(rw, string(b))
	}
}

func (w *web) putMode(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		On *bool `json:"on"`
	}
	if json.NewDecoder(http.MaxBytesReader(rw, r.Body, 1024)).Decode(&body) != nil || body.On == nil {
		refuse(rw, http.StatusBadRequest, "bad body")
		return
	}
	if *body.On {
		w.send(rw, "on")
	} else {
		w.send(rw, "off")
	}
}

// The card's EQ folder, the one the Q2's EQ page imports .txt presets from.

// cardReady is whether the card is there: the app's own folder is on it, and gone while USB storage
// has the card (the mount point is then the rootfs's empty folder).
func (w *web) cardReady(rw http.ResponseWriter) bool {
	if _, err := os.Stat(w.a.opts.dir); err != nil {
		refuse(rw, http.StatusServiceUnavailable, "The card isn't there just now (USB storage?)")
		return false
	}
	return true
}

func (w *web) eqDir() string { return filepath.Join(w.a.opts.card, "EQ") }

// validName is a preset's file name the Q2 imports and the card takes: a base name ending .txt,
// none of / \ : * ? " < > | or control characters, no leading dot, at most 64 bytes.
func validName(name string) bool {
	if len(name) <= len(".txt") || len(name) > 64 || !strings.HasSuffix(name, ".txt") || name[0] == '.' ||
		!utf8.ValidString(name) || strings.ContainsAny(name, `/\:*?"<>|`) {
		return false
	}
	for _, c := range name {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

// cardFile is the request's name= in the EQ folder, or false once refused.
func (w *web) cardFile(rw http.ResponseWriter, r *http.Request) (string, bool) {
	name := r.URL.Query().Get("name")
	if !validName(name) {
		refuse(rw, http.StatusBadRequest, `A name ends in .txt, without / \ : * ? " < > | or a dot first`)
		return "", false
	}
	if !w.cardReady(rw) {
		return "", false
	}
	return filepath.Join(w.eqDir(), name), true
}

func (w *web) cardList(rw http.ResponseWriter, r *http.Request) {
	if !w.cardReady(rw) {
		return
	}
	type file struct {
		Name  string `json:"name"`
		File  string `json:"file"`
		Size  int64  `json:"size"`
		MTime int64  `json:"mtime"`
	}
	files := []file{}
	des, err := os.ReadDir(w.eqDir())
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		refuse(rw, http.StatusInternalServerError, fmt.Sprintf("Couldn't read the EQ folder: %v", err))
		return
	}
	for _, d := range des {
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() || !validName(d.Name()) {
			continue
		}
		files = append(files, file{strings.TrimSuffix(d.Name(), ".txt"), d.Name(), info.Size(), info.ModTime().Unix()})
	}
	sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name) })
	reply(rw, http.StatusOK, map[string]any{"files": files})
}

func (w *web) cardGet(rw http.ResponseWriter, r *http.Request) {
	path, good := w.cardFile(rw, r)
	if !good {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		refuse(rw, http.StatusNotFound, "That preset isn't on the card")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		refuse(rw, http.StatusNotFound, "That preset isn't on the card")
		return
	}
	rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
	rw.Header().Set("Cache-Control", "no-store")
	http.ServeContent(rw, r, "", info.ModTime(), f)
}

func (w *web) cardPut(rw http.ResponseWriter, r *http.Request) {
	path, good := w.cardFile(rw, r)
	if !good {
		return
	}
	b, good := readPreset(rw, r)
	if !good {
		return
	}
	if err := os.MkdirAll(w.eqDir(), 0o755); err != nil {
		refuse(rw, http.StatusInternalServerError, fmt.Sprintf("Couldn't make the EQ folder: %v", err))
		return
	}
	if _, err := os.Lstat(path); err == nil && r.URL.Query().Get("replace") != "1" {
		refuse(rw, http.StatusConflict, "There's a preset with that name on the card")
		return
	}
	if err := q2.WriteFile(path, b); err != nil {
		refuse(rw, http.StatusInternalServerError, fmt.Sprintf("Couldn't save it: %v", err))
		return
	}
	reply(rw, http.StatusOK, okReply)
}

func (w *web) cardDelete(rw http.ResponseWriter, r *http.Request) {
	path, good := w.cardFile(rw, r)
	if !good {
		return
	}
	if err := os.Remove(path); errors.Is(err, fs.ErrNotExist) {
		refuse(rw, http.StatusNotFound, "That preset isn't on the card")
		return
	} else if err != nil {
		refuse(rw, http.StatusInternalServerError, fmt.Sprintf("Couldn't delete it: %v", err))
		return
	}
	reply(rw, http.StatusOK, okReply)
}

// presets is the AutoEq catalogue, presets.json as Theme Studio has it, sent as the card holds it,
// gzipped, for the phone to keep: its ETag changes with the file.
func (w *web) presets(rw http.ResponseWriter, r *http.Request) {
	if !w.cardReady(rw) {
		return
	}
	f, err := os.Open(filepath.Join(w.a.opts.dir, "presets.json.gz"))
	if err != nil {
		refuse(rw, http.StatusNotFound, "The AutoEq presets aren't on the card")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		refuse(rw, http.StatusNotFound, "The AutoEq presets aren't on the card")
		return
	}
	h := rw.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Encoding", "gzip")
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, info.Size(), info.ModTime().UnixNano()))
	http.ServeContent(rw, r, "", info.ModTime(), f)
}
