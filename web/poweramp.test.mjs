// node web/poweramp.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import eq from './eq.js';
import pa from './poweramp.js';

const row = (type, frequency, q, gain, extra = {}) => ({ type, channels: 0, frequency, q, gain, color: 0, ...extra });
const knobs = (bass = 0, treble = 0) => [row(0, 90, 0.800000011920929, bass), row(1, 10000, 0.6000000238418579, treble)];
const exported = (bands, extra = {}) => JSON.stringify([{ name: 'Export', preamp: -6.049314498901367, parametric: true, bands, ...extra }]);
const read = (text, name) => {
  const result = pa.read(text, name);
  assert.equal(result.ok, true, result.error);
  return result;
};
const shape = (preset) => eq.normalize(preset).bands.map((b) => [b.type, b.freq, b.gain, b.q]);

test('an export reads with its knobs as their shelves, the rest as written', () => {
  // The bands of a Poweramp export (github.com/maxmpz/powerampapi/issues/52), one of each type.
  const { preset, notes } = read(exported([
    ...knobs(7.486961841583252, 7.455280780792236),
    row(4, 105, 0.699999988079071, 7.5, { color: -7859968 }),
    row(3, 181, 0.18000000715255737, -5.999999523162842),
    row(2, 897, 1.5, 11.399999618530273),
    row(5, 6667, 0.699999988079071, 9.0),
  ]));
  assert.equal(preset.name, 'Export');
  assert.equal(preset.auto, false);
  assert.equal(eq.normalize(preset).preamp, -6.05);
  assert.deepEqual(shape(preset), [
    ['LSC', 90, 7.49, 0.8], ['HSC', 10000, 7.46, 0.6], ['LSC', 105, 7.5, 0.7],
    ['PK', 181, -6, 0.18], ['PK', 897, 11.4, 1.5], ['HSC', 6667, 9, 0.7],
  ]);
  assert.equal(pa.knob(eq.normalize(preset), 'bass'), 7.49);
  assert.equal(pa.knob(eq.normalize(preset), 'treble'), 7.46);
  assert.deepEqual(notes, ["The band at 897 Hz is of a kind Poweramp's file doesn't name. It's read as a peak, and may not sound quite as in Poweramp."]);
});

test('unturned knobs make no band, and a file the Q2 can play comes out', () => {
  // The start of github.com/V1rgul's EV6_REW_Slope1.5.json, peaks REW made.
  const { preset } = read(exported([...knobs(), row(2, 29, 5.71221923828125, -2.6101746559143066), row(2, 47, 9.995567321777344, 11.959613800048828)]));
  assert.deepEqual(shape(preset), [['PK', 29, -2.61, 5.712], ['PK', 47, 11.96, 9.996]]);
  const back = eq.parse(eq.serialize(preset));
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(back.preset.bands, eq.normalize(preset).bands);
  // Past three, a note counts the bands rather than naming them.
  const many = read(exported([...knobs(), ...[29, 38, 47, 55].map((f) => row(2, f, 5, 3))]));
  assert.match(many.notes[0], /^4 bands are of a kind/);
});

test('a knob is its band, through the file and back', () => {
  let preset = eq.normalize(eq.newPreset());
  preset = eq.normalize(pa.setKnob(preset, 'bass', 6));
  preset = eq.normalize(pa.setKnob(preset, 'treble', 2.5));
  assert.equal(preset.bands.length, 12);
  assert.deepEqual(preset.bands.at(-2), { on: true, channel: 'all', type: 'LSC', freq: 90, gain: 6, q: 0.8 });
  const back = eq.parse(eq.serialize(preset)).preset;
  assert.equal(pa.knob(back, 'bass'), 6);
  assert.equal(pa.knob(back, 'treble'), 2.5);
  // Turned again, the same band moves; at 0 it goes; off, the knob reads 0.
  assert.equal(pa.setKnob(back, 'bass', 9).bands.length, 12);
  assert.equal(pa.knob(pa.setKnob(back, 'bass', 9), 'bass'), 9);
  assert.equal(pa.setKnob(back, 'bass', 0).bands.length, 11);
  assert.equal(pa.knob(pa.setKnob(back, 'bass', 0), 'treble'), 2.5);
  back.bands[pa.knobIndex(back, 'bass')].on = false;
  assert.equal(pa.knob(back, 'bass'), 0);
  assert.equal(pa.knob(pa.setKnob(back, 'bass', 3), 'bass'), 3);
  // A shelf moved off the knob's frequency is a band like any other.
  assert.equal(pa.knobOf({ ...preset.bands.at(-2), freq: 100 }), null);
});

test('a knob needs a free band', () => {
  const full = eq.normalize({ ...eq.newPreset(), bands: Array.from({ length: eq.MAX_BANDS }, () => eq.newBand()) });
  assert.equal(pa.setKnob(full, 'bass', 3), null);
  assert.equal(pa.setKnob(full, 'bass', 0).bands.length, eq.MAX_BANDS);
});

test('what the Q2 lacks is left out or brought in, and said', () => {
  const { preset, notes } = read(JSON.stringify([
    { name: 'One', preamp: 0, parametric: true, bands: [...knobs(3), row(3, 250, 12, 2), row(3, 2000, 1, 3, { channels: 1 }), row(9, 500, 1, 1), row(3, 24000, 1, 1)] },
    { name: 'Two', preamp: 0, parametric: true, bands: [] },
  ]));
  assert.deepEqual(shape(preset), [['LSC', 90, 3, 0.8], ['PK', 250, 2, 10], ['PK', 20000, 1, 1]]);
  assert.deepEqual(notes, [
    'The file holds 2 presets. This is the first.',
    "The band at 2000 Hz is for one side only, and the file doesn't say which, so it's left out.",
    "A band couldn't be read, so it's left out.",
    "The bands at 250 Hz and 24000 Hz go past what the Q2 takes, 20 Hz to 20 kHz and Q 0.1 to 10, so they're brought inside it.",
  ]);
  const many = read(exported(Array.from({ length: 32 }, (_, i) => row(3, 100 + i, 1, 1))));
  assert.match(many.notes.join(' '), /the last 2 are left out/);
  assert.equal(eq.normalize(many.preset).bands.length, eq.MAX_BANDS);
});

test('a name comes from the file, else from its file name', () => {
  assert.equal(read(exported([]), 'file').preset.name, 'Export');
  assert.equal(read(exported([], { name: ' ' }), 'file').preset.name, 'file');
  assert.equal(read(JSON.stringify({ preamp: 1, bands: [] }), 'file').preset.name, 'file');
});

test('what is not a parametric export is refused', () => {
  assert.match(pa.read(exported(knobs(), { parametric: false })).error, /graphic EQ/);
  for (const text of ['[', '[]', '{"bands": 3}', '"x"', 'null']) assert.equal(pa.read(text).ok, false, text);
});

test('JSON is told from a preset text by its first character', () => {
  assert.ok(pa.isJson('﻿ \n[{"bands": []}]'));
  assert.ok(pa.isJson('{}'));
  assert.ok(!pa.isJson('Preamp: -3 dB\n'));
  assert.ok(!pa.isJson('# [comment]\n'));
});
