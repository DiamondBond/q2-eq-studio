// A preset for other apps: Wavelet's GraphicEQ, miniDSP's biquads, and an impulse response as a .wav
// for a convolver (Equalizer APO's, Roon's, JamesDSP's). Each is the curve the Q2 plays, its filters
// as eq.js designs them; what a format can't hold is said in notes. Loaded by index.html after eq.js
// as window.Q2Formats and by formats.test.mjs as a module.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(require('./eq.js'));
  else root.Q2Formats = make(root.Q2Eq);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (eq) {
  'use strict';

  // The 127 points Wavelet's GraphicEQ takes, as AutoEq writes them.
  const WAVELET_FREQS = [
    20, 21, 22, 23, 24, 26, 27, 29, 30, 32, 34, 36, 38, 40, 43, 45, 48, 50, 53, 56, 59, 63, 66, 70, 74, 78, 83,
    87, 92, 97, 103, 109, 115, 121, 128, 136, 143, 151, 160, 169, 178, 188, 199, 210, 222, 235, 248, 262, 277,
    292, 309, 326, 345, 364, 385, 406, 429, 453, 479, 506, 534, 565, 596, 630, 665, 703, 743, 784, 829, 875, 924,
    977, 1032, 1090, 1151, 1216, 1284, 1357, 1433, 1514, 1599, 1689, 1784, 1885, 1991, 2103, 2221, 2347, 2479,
    2618, 2766, 2921, 3086, 3260, 3443, 3637, 3842, 4058, 4287, 4528, 4783, 5052, 5337, 5637, 5955, 6290, 6644,
    7018, 7414, 7831, 8272, 8738, 9230, 9749, 10298, 10878, 11490, 12137, 12821, 13543, 14305, 15110, 15961,
    16860, 17809, 18812, 19871,
  ];
  const WAVELET_RATE = 48000;
  const IMPULSE_LENGTH = 65536; // a Q 10 peak at 20 Hz has rung down past -100 dB by then, at 48 kHz
  const PCM_MAX = 8388607; // 24-bit

  const db = (value) => `${value > 0 ? '+' : ''}${(Math.round(value * 10) / 10 || 0).toFixed(1)}`;

  // The filters each side plays: one list when both sides are the same, else the left's and the right's.
  function sides(preset, rate) {
    const filters = preset.bands.map((band) => eq.design(band, rate)).filter(Boolean);
    const both = filters.every((filter) => filter.channel === 'all');
    const of = (side) => filters.filter((filter) => filter.channel === 'all' || filter.channel === side);
    return both ? [{ side: 'all', filters }] : [{ side: 'L', filters: of('L') }, { side: 'R', filters: of('R') }];
  }

  // The preamp the Q2 plays at this rate: Auto's figure, or the one set.
  const preampAt = (preset, rate) => (preset.auto ? eq.autoPreamp(preset, rate) : preset.preamp);

  // Wavelet's GraphicEQ line. Wavelet has one curve for both sides, and its own preamp and balance,
  // so the curve's loudest point is 0 dB, as AutoEq writes it.
  function wavelet(input) {
    const preset = eq.normalize(input);
    const lists = sides(preset, WAVELET_RATE);
    // Bands on the right alone: the right's curve, not a flat left.
    const side = lists.length > 1 && !lists[0].filters.length ? 'right' : 'left';
    const notes = [];
    if (lists.length > 1) notes.push(`Wavelet's EQ is the same on both sides, so this is the ${side} side's.`);
    if (preset.balance) notes.push("Wavelet has its own balance, so this one isn't in it.");
    const gains = WAVELET_FREQS.map((f) => eq.response(preset, f, WAVELET_RATE)[side]);
    const top = Math.max(...gains);
    const points = WAVELET_FREQS.map((f, index) => `${f} ${(Math.round((gains[index] - top) * 10) / 10 || 0).toFixed(1)}`);
    return { text: `GraphicEQ: ${points.join('; ')}\n`, notes };
  }

  // A coefficient as miniDSP's text has them: a plain decimal, never an exponent.
  const coefficient = (value) => {
    const text = value.toFixed(15);
    return /^-0\.0+$/.test(text) ? text.slice(1) : text;
  };

  // miniDSP's biquads at rate, a1 and a2 negated as miniDSP takes them. Sides that differ come as two
  // lists, each headed, to paste into each output's own; the preamp and balance go in miniDSP's gain.
  function biquads(input, rate) {
    const preset = eq.normalize(input);
    const lists = sides(preset, rate);
    const notes = [];
    const preamp = preampAt(preset, rate);
    if (preamp) notes.push(`Biquads carry no preamp: set ${db(preamp)} dB on miniDSP's gain.`);
    if (preset.balance) notes.push(`Turn the ${preset.balance > 0 ? 'left' : 'right'} side down ${Math.abs(preset.balance).toFixed(1)} dB more there for the balance.`);
    const blocks = lists.map(({ side, filters }) => {
      const text = filters.map((f, index) => `biquad${index + 1},\nb0=${coefficient(f.b0)},\nb1=${coefficient(f.b1)},\nb2=${coefficient(f.b2)},\n`
        + `a1=${coefficient(-f.a1)},\na2=${coefficient(-f.a2)}`).join(',\n');
      const name = side === 'L' ? 'Left' : 'Right';
      return side === 'all' ? text : `${name}\n${text || `None: the ${name.toLowerCase()} side is flat.`}`;
    });
    return { text: `${blocks.join('\n\n')}\n`, notes, count: Math.max(...lists.map(({ filters }) => filters.length)) };
  }

  // Each side's impulse response at rate: the filters run on an impulse, with the preamp and balance in
  // it. One channel when both sides are the same.
  function impulse(input, rate, length = IMPULSE_LENGTH) {
    const preset = eq.normalize(input);
    const lists = sides(preset, rate);
    if (preset.balance && lists.length === 1) lists.push({ ...lists[0] });
    const preamp = preampAt(preset, rate);
    return lists.map(({ filters }, index) => {
      const side = lists.length === 1 ? 0 : index ? Math.min(preset.balance, 0) : Math.min(-preset.balance, 0);
      const out = new Float64Array(length);
      const state = filters.map(() => [0, 0]);
      out[0] = 10 ** ((preamp + side) / 20);
      for (let n = 0; n < length; n += 1) {
        let x = out[n];
        filters.forEach((f, k) => { // direct form II transposed
          const s = state[k];
          const y = f.b0 * x + s[0];
          s[0] = f.b1 * x - f.a1 * y + s[1];
          s[1] = f.b2 * x - f.a2 * y;
          x = y;
        });
        out[n] = x;
      }
      return out;
    });
  }

  // 24-bit PCM .wav of channels at rate; a sample past full scale is held at it.
  function wav(channels, rate) {
    const [count, length] = [channels.length, channels[0].length];
    const data = length * count * 3;
    const view = new DataView(new ArrayBuffer(44 + data));
    const ascii = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + data, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, count, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * count * 3, true);
    view.setUint16(32, count * 3, true);
    view.setUint16(34, 24, true);
    ascii(36, 'data');
    view.setUint32(40, data, true);
    let at = 44;
    for (let n = 0; n < length; n += 1) {
      for (const channel of channels) {
        const sample = Math.round(Math.min(Math.max(channel[n], -1), 1) * PCM_MAX);
        view.setUint8(at, sample & 255);
        view.setUint8(at + 1, (sample >> 8) & 255);
        view.setUint8(at + 2, (sample >> 16) & 255);
        at += 3;
      }
    }
    return view.buffer;
  }

  // The .wav a convolver loads, and what to know about it.
  function convolution(input, rate) {
    const preset = eq.normalize(input);
    const channels = impulse(preset, rate);
    const notes = [];
    if (channels.length === 2) notes.push('Stereo: the sides differ.');
    if (channels.some((channel) => channel.some((sample) => Math.abs(sample) > 1))) {
      notes.push('The preamp leaves it past full scale, so it clips: lower the preamp, or use Auto.');
    }
    return { data: wav(channels, rate), notes };
  }

  return { WAVELET_FREQS, wavelet, biquads, impulse, wav, convolution };
});
