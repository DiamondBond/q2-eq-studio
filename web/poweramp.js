// Poweramp's Bass and Treble knobs, and the presets Poweramp exports. Loaded by index.html after eq.js
// as window.Q2Poweramp and by poweramp.test.mjs as a module.
//
// Poweramp exports a preset as JSON: [{ name, preamp, parametric, bands: [{ type, channels, frequency,
// q, gain, color }] }], gain and preamp in dB. Every export seen opens with the knobs, type 0 Bass and
// type 1 Treble, at 90 Hz, Q 0.8 and 10 kHz, Q 0.6 and 0 dB while unturned. 3, 4 and 5 are its peak,
// low shelf and high shelf, the filters the Q2 has. 2 is in presets REW made and in graphic EQ ones,
// with a gain and a Q: read here as a peak. None of this is documented; it is read off exports.
//
// ponytail: a knob is a shelf here, the closest the Q2's filters come. Types 0, 1 and 2 seem to be
// Poweramp's low-, high- and band-pass with the gain applied some other way, so its curve may differ
// near the knob's frequency: compare it with Poweramp's own graph and change the shelf in KNOBS (or
// read 2 as something else) if it doesn't match.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(require('./eq.js'));
  else root.Q2Poweramp = make(root.Q2Eq);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (eq) {
  'use strict';

  const KNOBS = {
    bass: { type: 'LSC', freq: 90, q: 0.8 },
    treble: { type: 'HSC', freq: 10000, q: 0.6 },
  };
  const KNOB_MAX = 15; // dB: Poweramp's knobs boost only, up to its EQ's most
  const FILE_MAX = 1 << 20; // an export of every preset is still far under this
  const TYPES = { 0: 'LSC', 1: 'HSC', 2: 'PK', 3: 'PK', 4: 'LSC', 5: 'HSC' };
  const NOT_POWERAMP = "This isn't a preset Poweramp exported.";

  /* ---------- The knobs ---------- */

  // A knob is the band at its own shelf, so it lasts through a file and the Q2 as any band does.
  // Bands are compared as normalize leaves them.
  const knobOf = (band) => Object.keys(KNOBS).find((which) => band.channel === 'all'
    && band.type === KNOBS[which].type && band.freq === KNOBS[which].freq && band.q === KNOBS[which].q) ?? null;

  const knobIndex = (preset, which) => preset.bands.findIndex((band) => knobOf(band) === which);

  // The knob's dB: its band's gain, or 0 with no band or the band off.
  function knob(preset, which) {
    const band = preset.bands[knobIndex(preset, which)];
    return band?.on ? band.gain : 0;
  }

  // The preset with the knob at gain dB: its band set, added at the end, or at 0 taken out. Null when
  // the Q2 has no room for another band.
  function setKnob(preset, which, gain) {
    const at = knobIndex(preset, which);
    const bands = preset.bands.slice();
    if (!gain) {
      if (at >= 0) bands.splice(at, 1);
    } else if (at >= 0) {
      bands[at] = { ...bands[at], on: true, gain };
    } else if (bands.length < eq.MAX_BANDS) {
      bands.push({ on: true, channel: 'all', ...KNOBS[which], gain });
    } else {
      return null;
    }
    return { ...preset, bands };
  }

  /* ---------- Reading an export ---------- */

  const hz = (freq) => `${Math.round(freq)} Hz`; // Poweramp's are whole
  const list = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  const bandsAt = (freqs) => (freqs.length > 3 ? `${freqs.length} bands`
    : `${freqs.length === 1 ? 'The band' : 'The bands'} at ${list(freqs.map(hz))}`);

  // { ok: true, preset, notes } with the values as read, notes saying what changed on the way, or
  // { ok: false, error }. name is for a preset without one.
  function read(text, name = '') {
    const fail = (error) => ({ ok: false, error });
    let data;
    try {
      data = JSON.parse(String(text).replace(/^﻿/, ''));
    } catch {
      return fail(NOT_POWERAMP);
    }
    const presets = Array.isArray(data) ? data : [data];
    const [first] = presets;
    if (!first || typeof first !== 'object' || !Array.isArray(first.bands)) return fail(NOT_POWERAMP);
    if (first.parametric === false) {
      return fail("This preset is from Poweramp's graphic EQ, and EQ Studio reads its parametric ones. "
        + "Turn on Poweramp's parametric EQ, then export the preset again.");
    }

    const notes = [];
    const bands = [];
    const [sided, typeTwo, wide, unread] = [[], [], [], []];
    for (const row of first.bands) {
      const code = Number(row?.type);
      const [freq, gain, q] = [row?.frequency, row?.gain, row?.q].map(Number);
      if (!TYPES[code] || !Number.isFinite(gain) || !(freq > 0) || !(q > 0)) {
        unread.push(row);
        continue;
      }
      if (code <= 1 && !gain) continue; // an unturned knob
      if (Number(row.channels ?? 0) !== 0) {
        sided.push(freq);
        continue;
      }
      if (code === 2) typeTwo.push(freq);
      if (freq < eq.FREQ_MIN || freq > eq.FREQ_MAX || q < eq.Q_MIN || q > eq.Q_MAX || Math.abs(gain) > eq.GAIN_MAX) wide.push(freq);
      bands.push({ on: row.enabled !== false, channel: 'all', type: TYPES[code], freq, gain, q });
    }

    if (presets.length > 1) notes.push(`The file holds ${presets.length} presets. This is the first.`);
    if (sided.length) {
      notes.push(`${bandsAt(sided)} ${sided.length === 1 ? 'is' : 'are'} for one side only, and the file doesn't say which, so ${sided.length === 1 ? "it's" : "they're"} left out.`);
    }
    if (unread.length) notes.push(`${unread.length === 1 ? 'A band' : `${unread.length} bands`} couldn't be read, so ${unread.length === 1 ? "it's" : "they're"} left out.`);
    if (typeTwo.length) {
      notes.push(`${bandsAt(typeTwo)} ${typeTwo.length === 1 ? 'is' : 'are'} of a kind Poweramp's file doesn't name. ${typeTwo.length === 1 ? "It's read as a peak" : "They're read as peaks"}, and may not sound quite as in Poweramp.`);
    }
    if (wide.length) notes.push(`${bandsAt(wide)} ${wide.length === 1 ? 'goes' : 'go'} past what the Q2 takes, 20 Hz to 20 kHz and Q 0.1 to 10, so ${wide.length === 1 ? "it's" : "they're"} brought inside it.`);
    if (bands.length > eq.MAX_BANDS) notes.push(`The Q2 takes ${eq.MAX_BANDS} bands, so the last ${bands.length - eq.MAX_BANDS} are left out.`);

    const preamp = Number(first.preamp);
    return {
      ok: true,
      notes,
      preset: {
        name: typeof first.name === 'string' && eq.cleanName(first.name) ? first.name : name,
        auto: false,
        preamp: Number.isFinite(preamp) ? preamp : 0,
        balance: 0,
        bands,
      },
    };
  }

  // Whether a file's text is JSON, so one for read rather than eq.parse: a preset's text never opens
  // with a bracket.
  const isJson = (text) => /^﻿?\s*[[{]/.test(text);

  return { KNOBS, KNOB_MAX, FILE_MAX, knobOf, knobIndex, knob, setKnob, read, isJson };
});
