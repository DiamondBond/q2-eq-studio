// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Diamond Bond

// q2-eq-studio is EQ Studio, a Q2 Pod card app: turned on from the Q2's Library → Apps, it serves an
// EQ editor to a phone on the same Wi-Fi, opened from the QR code (or the address and PIN) the Q2
// shows, and plays what the phone sets on the Q2 at once through the firmware's live EQ (eq.go), or,
// on a firmware without it, saves presets to the card's EQ folder for the Q2's EQ page to import. It
// runs from the card's .eq-studio folder (copied to /tmp first, so the card is never kept busy), and
// stops by itself after 15 minutes unused. The Q2 glue follows q2-filebrowser's (MIT).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"github.com/DiamondBond/q2-eq-studio/internal/q2"
	"github.com/DiamondBond/q2-eq-studio/internal/q2spot"
	"github.com/DiamondBond/q2-eq-studio/internal/qr"
)

const (
	id       = "eq-studio"
	idleQuit = 15 * time.Minute // unused this long, the app stops
	holdFor  = 2 * time.Minute  // the phone used this recently keeps the Q2 out of standby
)

// settings is .eq-studio/config.json.
type settings struct {
	Key string `json:"web_key"` // the QR code's: signs a phone in
	PIN string `json:"pin"`     // the Q2's screen's, typed with the address
}

// options are where things are: the card and /tmp on the Q2, folders of one's own on a computer.
type options struct {
	dir, card, tmp string
	port           int
}

type app struct {
	opts   options
	state  *q2.State
	eq     *bridge
	browse string
	port   int
	ln     net.Listener

	mu     sync.Mutex
	set    settings
	used   time.Time // the phone or the Q2's page, last
	webAt  time.Time // the phone, last
	addr   string    // ip:port, "" without Wi-Fi
	qrFor  string
	qrHex  string
	qrSize int
	quit   chan struct{}
	once   sync.Once
}

func main() {
	var o options
	flag.StringVar(&o.dir, "dir", "/mnt/mmc/.eq-studio", "the app's folder on the card")
	flag.StringVar(&o.card, "card", "/mnt/mmc", "the card's mount point (its EQ folder is the presets')")
	flag.StringVar(&o.tmp, "tmp", "/tmp", "the folder of the files Q2 Pod reads and writes")
	flag.IntVar(&o.port, "port", 8020, "the page's port (the next free one if taken)")
	flag.Parse()
	debug.SetGCPercent(50)
	debug.SetMemoryLimit(32 << 20)
	q2.Card = o.card
	a, err := start(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "q2-eq-studio:", err)
		os.Exit(1)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() { <-sig; a.shutdown() }()
	a.run()
}

// tmpFile is /tmp/q2-eq-studio<suffix>.
func (o options) tmpFile(suffix string) string { return filepath.Join(o.tmp, "q2-"+id+suffix) }

// newApp is the app with its settings and paths, not yet listening.
func newApp(o options) *app {
	now := time.Now() // turned on counts as used: the Q2 stays awake while the phone scans the code
	return &app{
		opts:  o,
		state: &q2.State{Path: o.tmpFile(".state")},
		eq: &bridge{caps: filepath.Join(o.tmp, "q2-addon.caps"), req: o.tmpFile(".eq"), done: o.tmpFile(".eq.done"),
			wait: 3 * time.Second},
		browse: o.tmpFile(".browse.sock"),
		set:    loadSettings(o.dir),
		used:   now,
		webAt:  now,
		quit:   make(chan struct{}),
	}
}

func start(o options) (*app, error) {
	a := newApp(o)
	// A request left by a run that ended without its clean exit is never sent now.
	os.Remove(a.eq.req)
	os.Remove(a.eq.done)
	if a.ln, a.port = listen(o.port); a.ln == nil {
		return nil, fmt.Errorf("no port for the page from %d", o.port)
	}
	srv := &http.Server{Handler: newWeb(a), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go srv.Serve(a.ln)
	a.writeState() // the code there before the browse socket answers: Q2 Pod opens it then
	go q2spot.Serve(a.browse, a.device)
	fmt.Fprintf(os.Stderr, "q2-eq-studio: http://%s/?k=%s\n", a.addr, a.set.Key) // for a computer's run
	return a, nil
}

// loadSettings reads config.json, making the key and PIN the first time; they stay, so a phone
// signed in once stays signed in.
func loadSettings(dir string) settings {
	var s settings
	path := filepath.Join(dir, "config.json")
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &s)
	}
	if len(s.Key) < 12 || len(s.PIN) != 6 {
		if len(s.Key) < 12 {
			s.Key = q2.Key(12)
		}
		if len(s.PIN) != 6 {
			s.PIN = q2.PIN(6)
		}
		b, _ := json.MarshalIndent(s, "", "  ")
		q2.WriteFile(path, b) // without the card folder they last this run only
	}
	return s
}

// listen takes port, or the next free of the nine after it.
func listen(port int) (net.Listener, int) {
	for p := port; p < port+10; p++ {
		if l, err := net.Listen("tcp4", fmt.Sprintf(":%d", p)); err == nil {
			return l, p
		}
	}
	return nil, 0
}

// touch notes a use: web is the phone's, which holds standby off a while.
func (a *app) touch(web bool) {
	a.mu.Lock()
	a.used = time.Now()
	if web {
		a.webAt = a.used
	}
	a.mu.Unlock()
}

func (a *app) shutdown() { a.once.Do(func() { close(a.quit) }) }

// run writes the status file every second and stops by itself once unused for idleQuit.
func (a *app) run() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-a.quit:
			a.ln.Close()
			a.state.Remove()
			for _, p := range []string{a.browse, a.eq.req, a.eq.done} {
				os.Remove(p)
			}
			return
		case <-t.C:
			a.writeState()
			a.mu.Lock()
			idle := time.Since(a.used)
			a.mu.Unlock()
			if idle > idleQuit {
				a.shutdown()
			}
		}
	}
}

// writeState is what the Q2 reads (addon.c's qr_open and poll_one): the page's address, PIN and QR
// code, and whether to hold standby off.
func (a *app) writeState() {
	ip := q2.LocalIP()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.addr = ""
	url := ""
	if ip != "" {
		a.addr = fmt.Sprintf("%s:%d", ip, a.port)
		url = "http://" + a.addr + "/?k=" + a.set.Key
	}
	if url != a.qrFor {
		a.qrFor, a.qrHex, a.qrSize = url, "", 0
		if c, err := qr.Encode([]byte(url)); url != "" && err == nil {
			a.qrHex, a.qrSize = c.Hex(), c.Size
		}
	}
	hold := "0"
	if time.Since(a.webAt) < holdFor {
		hold = "1"
	}
	a.state.Write(map[string]string{"addr": a.addr, "pin": a.set.PIN, "qr": a.qrHex,
		"qrsize": fmt.Sprint(a.qrSize), "note": "Use a phone on the same Wi-Fi", "hold": hold})
}

// device answers the Q2's page (Q2SPOT/1): a row that shows the QR code again, and whether the
// firmware takes the phone's EQ live. "refresh" asks again every 2 s, so a Wi-Fi link shows.
func (a *app) device(req q2spot.Request) q2spot.Reply {
	a.touch(false)
	if req.Op != "menu" {
		return q2spot.Fail(q2spot.Unsupported, "Update EQ Studio on the card")
	}
	a.mu.Lock()
	addr, pin := a.addr, a.set.PIN
	a.mu.Unlock()
	open := q2spot.Row{Kind: "remote", Title: "Open on Your Phone",
		Subtitle: "http://" + addr + " · PIN " + pin[:3] + " " + pin[3:]}
	if addr == "" {
		open.Subtitle = "Connect the Q2 to Wi-Fi first"
	}
	live := q2spot.Row{Kind: "info", Title: "Live EQ", Subtitle: "What you set on the phone plays at once"}
	if !a.eq.live() {
		live.Title, live.Subtitle = "No Live EQ", "Update Q2 Pod for it; the phone still saves to the card's EQ folder"
	}
	return q2spot.Reply{Message: "refresh", Rows: []q2spot.Row{open, live}}
}
