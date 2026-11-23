// node --test web/*.test.mjs
// Each format read back and checked against eq.response, the curve the Q2 plays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import eq from './eq.js';
import formats from './formats.js';

const band = (extra) => ({ ...eq.newBand(), ...extra });
const presetOf = (bands, extra = {}) => ({ name: '', auto: true, preamp: 0, balance: 0, bands, ...extra });
const near = (actual, expected, within, what = '') => assert.ok(Math.abs(actual - expected) <= within, `${what} ${actual} is not ${expected}`);
const SHELVES = [band({ type: 'LSC', freq: 30, gain: 6, q: 0.7 }), band({ freq: 3000, gain: -4, q: 2 }), band({ type: 'HSC', freq: 9000, gain: 3, q: 0.6 })];

// |H| in dB at f of biquads written as miniDSP's (a1 and a2 negated).
function biquadDb(list, f, rate) {
  const w = 2 * Math.PI * f / rate;
  let total = 0;
  for (const { b0, b1, b2, a1, a2 } of list) {
    const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
    const num = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
    const den = (1 - a1 * c1 - a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
    total += 10 * Math.log10(num / den);
  }
  return total;
}
const readBiquads = (text) => [...text.matchAll(/biquad\d+,\nb0=(\S+),\nb1=(\S+),\nb2=(\S+),\na1=(\S+),\na2=(\S+?)(?:,|\n|$)/g)]
  .map((m) => ({ b0: +m[1], b1: +m[2], b2: +m[3], a1: +m[4], a2: +m[5] }));

// |H| in dB at f of an impulse response, by its DFT at f.
function impulseDb(samples, f, rate) {
  let [re, im] = [0, 0];
  for (let n = 0; n < samples.length; n += 1) {
    re += samples[n] * Math.cos(2 * Math.PI * f * n / rate);
    im -= samples[n] * Math.sin(2 * Math.PI * f * n / rate);
  }
  return 10 * Math.log10(re * re + im * im);
}

test('Wavelet gets its 127 points, the curve with its loudest at 0 dB', () => {
  const preset = presetOf(SHELVES);
  const { text, notes } = formats.wavelet(preset);
  assert.match(text, /^GraphicEQ: 20 -?\d+\.\d; 21 /);
  const points = text.slice('GraphicEQ: '.length).trim().split('; ').map((pair) => pair.split(' ').map(Number));
  assert.equal(points.length, 127);
  assert.deepEqual(points.map(([f]) => f), formats.WAVELET_FREQS);
  assert.equal(Math.max(...points.map(([, gain]) => gain)), 0);
  const curve = (f) => eq.response(preset, f, 48000).left;
  for (const [f, gain] of points) near(gain - points[0][1], curve(f) - curve(20), 0.1, `${f} Hz`);
  assert.deepEqual(notes, []);
});

test("Wavelet says it has the left side's curve when the sides differ, and no balance", () => {
  const { text, notes } = formats.wavelet(presetOf([band({ gain: 6, channel: 'R' }), band({ freq: 100, gain: 3, channel: 'L' })], { balance: 2 }));
  assert.equal(notes.length, 2);
  const at = (f) => Number(new RegExp(`[: ]${f} (\\S+?);`).exec(text)[1]);
  assert.ok(at(1032) < at(103) - 2); // the left's bump at 100 Hz, not the right's at 1 kHz
});

test("miniDSP's biquads read back as the Q2's curve, a1 and a2 negated", () => {
  const preset = presetOf(SHELVES, { auto: false, preamp: -6.5 });
  for (const rate of [48000, 96000]) {
    const { text, notes, count } = formats.biquads(preset, rate);
    assert.doesNotMatch(text, /e[+-]?\d/i);
    const list = readBiquads(text);
    assert.equal(list.length, 3);
    assert.equal(count, 3);
    for (const f of [20, 31, 100, 1000, 3000, 9000, 16000]) near(biquadDb(list, f, rate), eq.response(preset, f, rate).left, 1e-6, `${f} Hz`);
    assert.deepEqual(notes, ['Biquads carry no preamp: set -6.5 dB on miniDSP\'s gain.']);
  }
});

test('biquads for sides that differ come as a left and a right list; off and flat bands are left out', () => {
  const preset = presetOf([band({ gain: 3 }), band({ freq: 200, gain: -2, channel: 'L' }), band({ freq: 500, gain: 5, on: false }), band({ freq: 700 })]);
  const { text } = formats.biquads(preset, 48000);
  const [left, right] = text.split('\n\n');
  assert.match(left, /^Left\n/);
  assert.match(right, /^Right\n/);
  assert.equal(readBiquads(left).length, 2);
  assert.equal(readBiquads(right).length, 1);
  for (const f of [100, 200, 1000]) {
    near(biquadDb(readBiquads(left), f, 48000), eq.response(preset, f, 48000).left, 1e-6);
    near(biquadDb(readBiquads(right), f, 48000), eq.response(preset, f, 48000).right, 1e-6);
  }
});

test('the impulse response is the curve with the preamp, Auto worked out at its rate', () => {
  const preset = presetOf(SHELVES);
  for (const rate of [44100, 48000]) {
    const [only, ...more] = formats.impulse(preset, rate);
    assert.equal(more.length, 0);
    const preamp = eq.autoPreamp(preset, rate);
    for (const f of [20, 30, 100, 1000, 3000, 9000, 18000]) near(impulseDb(only, f, rate), eq.response(preset, f, rate).left + preamp, 0.01, `${f} Hz at ${rate}`);
  }
});

test('a balance or sides that differ make it stereo, the balance turning one side down', () => {
  const preset = presetOf([band({ freq: 1000, gain: 6 })], { auto: false, preamp: -6, balance: 3 });
  const [left, right] = formats.impulse(preset, 48000);
  near(impulseDb(left, 1000, 48000), -3, 0.01);
  near(impulseDb(right, 1000, 48000), 0, 0.01);
  const sided = formats.impulse(presetOf([band({ freq: 1000, gain: 6, channel: 'R' })], { auto: false, preamp: -6 }), 48000);
  near(impulseDb(sided[0], 1000, 48000), -6, 0.01);
  near(impulseDb(sided[1], 1000, 48000), 0, 0.01);
});

test('the .wav is 24-bit PCM with its samples in place', () => {
  const view = new DataView(formats.wav([Float64Array.of(1, -1, 0.5), Float64Array.of(0, 2, -0.25)], 44100));
  const text = (at, n) => String.fromCharCode(...new Uint8Array(view.buffer, at, n));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), view.byteLength - 8);
  assert.equal(text(8, 8), 'WAVEfmt ');
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 2, 44100, 24]);
  assert.equal(view.getUint32(40, true), 3 * 2 * 3);
  const sample = (index) => (view.getUint8(44 + 3 * index) | (view.getUint8(45 + 3 * index) << 8) | (view.getInt8(46 + 3 * index) << 16));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(sample), [8388607, 0, -8388607, 8388607, 4194304, -2097152]);
});

test('a convolution past full scale says so', () => {
  assert.deepEqual(formats.convolution(presetOf(SHELVES), 48000).notes, []);
  const loud = formats.convolution(presetOf([band({ gain: 12, q: 4 })], { auto: false, preamp: 0 }), 48000);
  assert.equal(loud.notes.length, 1);
});
