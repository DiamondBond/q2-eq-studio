// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Diamond Bond

package main

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DiamondBond/q2-eq-studio/internal/q2"
)

// The firmware's live EQ, on a Q2 Pod whose /tmp/q2-addon.caps has the word eq. A request is
// /tmp/q2-eq-studio.eq, written whole: a seq on its first line, then get, on, off or a preset in
// the card EQ folder's text format. The answer is /tmp/q2-eq-studio.eq.done, written whole: its
// first line "<seq> ok" or "<seq> error <reason>"; after ok, "mode off|3eq|peq" and the PEQ as
// preset text. The firmware reads a request once per new seq, on its 500 ms poll, and one replaced
// before it was read is never answered, so one goes at a time.

type bridge struct {
	caps, req, done string
	wait            time.Duration // how long an answer may take

	mu sync.Mutex // one request at a time
}

// eqAnswer is the firmware's answer: ok with what plays (mode) and the PEQ (preset), or its reason.
type eqAnswer struct {
	ok           bool
	reason       string
	mode, preset string
}

var errNoAnswer = errors.New("The Q2 didn't answer")

// live is whether the firmware takes an EQ, read each time: an update can change it.
func (b *bridge) live() bool {
	caps, _ := os.ReadFile(b.caps)
	return slices.Contains(strings.Fields(string(caps)), "eq")
}

// ask sends body (get, on, off or a preset) and waits for its answer, or errNoAnswer.
func (b *bridge) ask(body string) (eqAnswer, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	seq := q2.Key(12) // random, so never one an earlier run sent
	if err := q2.WriteFile(b.req, []byte(seq+"\n"+body)); err != nil {
		return eqAnswer{}, fmt.Errorf("Couldn't ask the Q2: %v", err)
	}
	for end := time.Now().Add(b.wait); time.Now().Before(end); {
		time.Sleep(50 * time.Millisecond)
		if done, err := os.ReadFile(b.done); err == nil {
			if a, ok := parseAnswer(string(done), seq); ok {
				return a, nil
			}
		}
	}
	return eqAnswer{}, errNoAnswer
}

// parseAnswer reads a .done file; ok is false when it answers another seq.
func parseAnswer(done, seq string) (eqAnswer, bool) {
	lines := strings.SplitN(done, "\n", 3)
	status, ok := strings.CutPrefix(strings.TrimRight(lines[0], "\r"), seq+" ")
	if !ok {
		return eqAnswer{}, false
	}
	if status != "ok" {
		return eqAnswer{reason: strings.TrimPrefix(status, "error ")}, true
	}
	a := eqAnswer{ok: true}
	if len(lines) > 1 {
		a.mode = strings.TrimPrefix(strings.TrimSpace(lines[1]), "mode ")
	}
	if len(lines) > 2 {
		a.preset = lines[2]
	}
	return a, true
}
