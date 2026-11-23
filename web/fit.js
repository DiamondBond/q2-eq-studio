// An EQ worked out from a measurement and a target: the Q2's bands that bring the one to the other.
// AutoEq's shape: a low shelf at 105 Hz and a high shelf at 10 kHz, Q 0.7, and peaks between, each
// placed where the curve is furthest off, then every band moved in turn until none brings it closer.
// Nothing past 10 kHz is chased, where each ear and each fit differ, treble cuts stop at 6 dB, as a
// coupler's own resonance shows there, and boosts stop at maxBoost. Loaded by index.html after eq.js
// as window.Q2Fit and by fit.test.mjs as a module.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(require('./eq.js'));
  else root.Q2Fit = make(root.Q2Eq);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (eq) {
  'use strict';

  const RATE = 48000;
  const LOW = 20;
  const HIGH = 20000;
  const REACH = 10000; // past this the fit wants no change
  const PEAK_TOP = 9000; // the highest a peak goes
  const PER_OCTAVE = 48;
  const FREQS = [];
  for (let f = LOW; f <= HIGH; f *= 2 ** (1 / PER_OCTAVE)) FREQS.push(f);
  const SHELF_Q = 0.7;
  const Q_RANGE = [0.4, 6];
  const GAIN_RANGE = [-12, 12];
  const GAIN_COST = 0.1; // a little for each band's gain, so two bands don't fight to undo each other
  // How much each point counts: the treble less, its measurement the least sure; past the reach a
  // little, so the high shelf can't swing the top octave about.
  const WEIGHTS = FREQS.map((f) => (f > REACH ? 0.3 : f > 6000 || f < 30 ? 0.5 : 1));

  const clamp = (value, [low, high]) => Math.min(Math.max(value, low), high);

  // A curve as text: a frequency and a level a line, as REW, a graph tool or AutoEq write it, the
  // phase after them ignored, and lines that aren't numbers skipped.
  function readCurve(text) {
    const points = [];
    for (const line of String(text).split(/\r?\n/)) {
      const [f, level] = line.trim().split(/[\s,;]+/).map(Number);
      if (Number.isFinite(f) && Number.isFinite(level) && f > 0) points.push([f, level]);
    }
    return points.sort((a, b) => a[0] - b[0]);
  }

  // A curve at FREQS, straight between its points on a log scale, flat past its ends.
  function onGrid(points) {
    const out = new Float64Array(FREQS.length);
    let j = 0;
    FREQS.forEach((f, i) => {
      while (j < points.length - 2 && points[j + 1][0] < f) j += 1;
      const [[f0, a], [f1, b]] = [points[j], points[j + 1]];
      const t = clamp(Math.log(f / f0) / Math.log(f1 / f0), [0, 1]);
      out[i] = a + (b - a) * t;
    });
    return out;
  }

  // A moving average a fraction of an octave wide, wider up the treble: the trend, not each resonance.
  function smooth(values) {
    const sums = [0];
    for (const value of values) sums.push(sums.at(-1) + value);
    return FREQS.map((f, i) => {
      const half = Math.max(1, Math.round(PER_OCTAVE * (f < 2000 ? 1 / 12 : f < 6000 ? 1 / 6 : 1 / 2) / 2));
      const [a, b] = [Math.max(0, i - half), Math.min(values.length, i + half + 1)];
      return (sums[b] - sums[a]) / (b - a);
    });
  }

  const bandCurve = (band) => FREQS.map((f) => eq.bandResponse({ ...band, on: true, channel: 'all' }, f, RATE));

  function cost(goal, curves, bands) {
    let sum = GAIN_COST * bands.reduce((total, band) => total + band.gain ** 2, 0);
    for (let i = 0; i < FREQS.length; i += 1) {
      let level = 0;
      for (const curve of curves) level += curve[i];
      sum += WEIGHTS[i] * (goal[i] - level) ** 2;
    }
    return sum;
  }

  const SMALLEST = { freq: 0.005, q: 0.005, gain: 0.02 };

  // Every band's values nudged in turn, a step up or down, kept when the curve comes closer, the step
  // halved when neither does, until no step is left worth taking.
  function settle(goal, bands, rounds) {
    const curves = bands.map(bandCurve);
    let best = cost(goal, curves, bands);
    const steps = bands.map((band) => (band.type === 'PK' ? { freq: 1 / 6, gain: 1, q: 0.25 } : { gain: 1 }));
    for (let round = 0; round < rounds; round += 1) {
      let live = false;
      bands.forEach((band, index) => {
        for (const field of Object.keys(steps[index])) {
          const step = steps[index][field];
          if (step < SMALLEST[field]) continue;
          live = true;
          let better = false;
          for (const dir of [1, -1]) {
            const next = { ...band };
            if (field === 'freq') next.freq = clamp(band.freq * 2 ** (dir * step), [LOW, PEAK_TOP]);
            else if (field === 'q') next.q = clamp(band.q * 2 ** (dir * step), Q_RANGE);
            else next.gain = clamp(band.gain + dir * step, GAIN_RANGE);
            const old = curves[index];
            curves[index] = bandCurve(next);
            const now = cost(goal, curves, bands.map((other, i) => (i === index ? next : other)));
            if (now < best - 1e-9) {
              best = now;
              Object.assign(band, next);
              better = true;
              break;
            }
            curves[index] = old;
          }
          if (!better) steps[index][field] = step / 2;
        }
      });
      if (!live) break;
    }
  }

  // Where the curve is furthest off, under PEAK_TOP: a peak there, as wide as the bump at half its height.
  function nextPeak(goal, bands) {
    const curves = bands.map(bandCurve);
    const off = FREQS.map((_, i) => goal[i] - curves.reduce((sum, curve) => sum + curve[i], 0));
    let at = 0;
    for (let i = 0; i < FREQS.length && FREQS[i] <= PEAK_TOP; i += 1) {
      if (Math.abs(off[i]) * WEIGHTS[i] > Math.abs(off[at]) * WEIGHTS[at]) at = i;
    }
    const height = off[at];
    const inside = (i) => i >= 0 && i < FREQS.length && Math.sign(off[i]) === Math.sign(height) && Math.abs(off[i]) > Math.abs(height) / 2;
    let [a, b] = [at, at];
    while (inside(a - 1)) a -= 1;
    while (inside(b + 1)) b += 1;
    const octaves = Math.max((b - a + 1) / PER_OCTAVE, 1 / 6);
    const q = Math.sqrt(2 ** octaves) / (2 ** octaves - 1);
    return { type: 'PK', freq: FREQS[at], gain: clamp(height, GAIN_RANGE), q: clamp(q, Q_RANGE) };
  }

  // fit({ measurement: [points, ...] a side each, target: points, bands, maxBoost }): the Q2's bands,
  // the goal they were fitted to at FREQS, and how far from it they leave the curve, an RMS in dB.
  function fit({ measurement, target, bands: count = 10, maxBoost = 6 }) {
    const sides = measurement.filter((points) => points.length >= 2).map(onGrid);
    if (!sides.length) throw new Error('There is no measurement to fit.');
    if (target.length < 2) throw new Error('There is no target to fit to.');
    const wanted = onGrid(target);
    const heard = FREQS.map((_, i) => sides.reduce((sum, side) => sum + side[i], 0) / sides.length);
    const raw = smooth(FREQS.map((_, i) => wanted[i] - heard[i]));
    // 0 dB about 1 kHz, where a target and a measurement are lined up.
    const mid = raw.filter((_, i) => FREQS[i] >= 500 && FREQS[i] <= 2000);
    const centre = mid.reduce((sum, value) => sum + value, 0) / mid.length;
    const goal = raw.map((value, i) => (FREQS[i] > REACH ? 0
      : clamp(value - centre, [FREQS[i] > 6000 ? -6 : GAIN_RANGE[0], maxBoost])));

    const bands = [
      { type: 'LSC', freq: 105, gain: 0, q: SHELF_Q },
      { type: 'HSC', freq: 10000, gain: 0, q: SHELF_Q },
    ];
    settle(goal, bands, 20);
    while (bands.length < count) {
      bands.push(nextPeak(goal, bands));
      settle(goal, bands, 12);
    }
    settle(goal, bands, 200);
    const out = bands
      .map((band) => ({ ...eq.newBand(), ...band, freq: Math.round(band.freq), gain: Math.round(band.gain * 10) / 10, q: Math.round(band.q * 100) / 100 }))
      .filter((band) => Math.abs(band.gain) >= 0.1);
    return { bands: out, goal, rms: rms(goal, out) };
  }

  // How far bands leave the curve from a goal at FREQS: RMS dB up to the reach, an offset aside.
  function rms(goal, bands) {
    const curves = bands.map(bandCurve);
    const off = [];
    for (let i = 0; i < FREQS.length && FREQS[i] <= REACH; i += 1) off.push(goal[i] - curves.reduce((sum, curve) => sum + curve[i], 0));
    const mean = off.reduce((sum, value) => sum + value, 0) / off.length;
    return Math.sqrt(off.reduce((sum, value) => sum + (value - mean) ** 2, 0) / off.length);
  }

  return { FREQS, REACH, readCurve, fit, rms };
});
