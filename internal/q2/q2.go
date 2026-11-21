// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the q2-filebrowser authors (internal/LICENSE)
// From q2-filebrowser (github.com/group-a-study/q2-filebrowser, internal/q2), trimmed to what EQ
// Studio uses.

// Package q2 holds what the card add-ons share with Q2 Pod's side (q2-pod's patch/addon.c): the
// status file it reads, and file writes that never leave half a file behind.
package q2

import (
	"crypto/rand"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// State is a key=value status file rewritten whole (a .tmp, renamed), so a reader never sees half of
// one. Values have newlines replaced, as the payload's field() reads a line.
type State struct {
	Path string
	mu   sync.Mutex
	last string
}

// Write replaces the file with kv, in key order, when it differs from the last one written.
func (s *State) Write(kv map[string]string) error {
	keys := make([]string, 0, len(kv))
	for k := range kv {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + strings.NewReplacer("\n", " ", "\r", " ").Replace(kv[k]) + "\n")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if b.String() == s.last {
		return nil
	}
	if err := WriteFile(s.Path, []byte(b.String())); err != nil {
		return err
	}
	s.last = b.String()
	return nil
}

// Remove deletes the file, as an add-on does when it exits.
func (s *State) Remove() {
	s.mu.Lock()
	defer s.mu.Unlock()
	os.Remove(s.Path)
	s.last = ""
}

// WriteFile writes data aside and renames it into place, synced first when it is on the card.
func WriteFile(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil && OnCard(path) {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// Card is where the card is mounted; tests point it elsewhere.
var Card = "/mnt/mmc"

// OnCard reports whether path is under the card's mount point.
func OnCard(path string) bool {
	rel, err := filepath.Rel(Card, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// LocalIP is the Q2's Wi-Fi address: the first IPv4 address of an interface that is up and not the
// loopback, wlan first; "" without one.
func LocalIP() string {
	ifs, _ := net.Interfaces()
	sort.SliceStable(ifs, func(i, j int) bool {
		return strings.HasPrefix(ifs[i].Name, "wlan") && !strings.HasPrefix(ifs[j].Name, "wlan")
	})
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, ad := range addrs {
			if n, ok := ad.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLinkLocalUnicast() {
				return n.IP.String()
			}
		}
	}
	return ""
}

// Key is n characters a person can read back: no 0/O or 1/I/L. PIN is n digits.
func Key(n int) string { return random(n, "23456789ABCDEFGHJKMNPQRSTUVWXYZ") }
func PIN(n int) string { return random(n, "0123456789") }

func random(n int, alphabet string) string {
	b := make([]byte, n)
	for i := range b {
		k, _ := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		b[i] = alphabet[k.Int64()]
	}
	return string(b)
}
