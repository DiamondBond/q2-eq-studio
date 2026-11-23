// node --test web/: the fit finds a known EQ again, leaves the top octave and big boosts alone, and
// reads curves as REW and squig.link write them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import eq from './eq.js';
import fit from './fit.js';

const band = (extra) => ({ ...eq.newBand(), ...extra });
const level = (bands, f) => bands.reduce((sum, b) => sum + eq.bandResponse(b, f, 48000), 0);
const curve = (shape) => fit.FREQS.filter((_, i) => i % 4 === 0).map((f) => [f, shape(f)]);
// A target with a bass shelf and an ear-gain bump, as in-ear targets have.
const TARGET = [band({ type: 'LSC', freq: 105, gain: 6, q: 0.7 }), band({ freq: 2800, gain: 8, q: 1 })];
const target = curve((f) => level(TARGET, f));

test('readCurve takes REW text: its notes, tabs, commas and a phase after the level', () => {
  const points = fit.readCurve('* Measurement data measured by REW\n* Note:\n20.5\t101.2\t170.1\n1000, 98.5\nfrequency,raw\n500 99\n');
  assert.deepEqual(points, [[20.5, 101.2], [500, 99], [1000, 98.5]]);
});

test('a measurement off its target by a known EQ: the fit finds that EQ again', () => {
  const known = [band({ type: 'LSC', freq: 105, gain: -4, q: 0.7 }), band({ freq: 3000, gain: 5, q: 2 }), band({ freq: 6000, gain: -3, q: 3 }), band({ freq: 300, gain: 2, q: 1 })];
  const measured = curve((f) => 90 + level(TARGET, f) - level(known, f));
  const { bands, rms } = fit.fit({ measurement: [measured, measured], target });
  assert.ok(rms < 0.3, `rms ${rms}`);
  // Lined up at 1 kHz, as the fit lines them up.
  const offset = level(bands, 1000) - level(known, 1000);
  for (const f of [40, 100, 300, 1000, 3000, 6000, 8000]) {
    assert.ok(Math.abs(level(bands, f) - level(known, f) - offset) < 1, `${f} Hz: ${level(bands, f)} vs ${level(known, f)}`);
  }
});

test('the Q2 takes every band it fits', () => {
  const measured = curve((f) => 95 + 10 * Math.sin(Math.log2(f) * 2));
  const { bands } = fit.fit({ measurement: [measured], target });
  assert.ok(bands.length <= 10);
  for (const b of bands) {
    assert.ok(['PK', 'LSC', 'HSC'].includes(b.type));
    assert.ok(b.freq >= eq.FREQ_MIN && b.freq <= 10000, `freq ${b.freq}`);
    assert.ok(Math.abs(b.gain) <= 12 && b.q >= 0.4 && b.q <= 6, `gain ${b.gain} q ${b.q}`);
  }
});

test('past 10 kHz the fit wants no change, and boosts stop at maxBoost', () => {
  // A deep treble dip, and a wide hole in the mids it would take 15 dB to fill.
  const measured = curve((f) => 90 + level(TARGET, f) + (f > 12000 && f < 16000 ? -10 : 0)
    + level([band({ freq: 1500, gain: -15, q: 0.8 })], f));
  const { bands } = fit.fit({ measurement: [measured], target, maxBoost: 6 });
  for (const f of [12000, 14000, 16000]) assert.ok(Math.abs(level(bands, f)) < 3, `${f} Hz: ${level(bands, f)}`);
  const most = Math.max(...fit.FREQS.map((f) => level(bands, f)));
  const atMid = level(bands, 1000);
  assert.ok(most - atMid < 7 + 6, `the biggest boost over 1 kHz's: ${most - atMid}`);
});

test('one side is enough; none is said', () => {
  const measured = curve((f) => 90 + level(TARGET, f));
  assert.ok(fit.fit({ measurement: [[], measured], target }).rms < 0.5);
  assert.throws(() => fit.fit({ measurement: [[], []], target }), /no measurement/);
});
