// EQ Studio's page: one preset, edited on a graph and in a band editor (a phone's) or a band table (a
// computer's, from 960px wide: style.css lays out the same page beside the graph), and sent to the Q2
// as it changes (PUT /api/eq, one request at a time, only the newest waiting), with the AutoEq
// catalogue and the card's EQ folder. eq.js (window.Q2Eq) is the EQ model, formats.js the files for
// other apps. The editing model (history steps, add, sort, the graph's scale, Auto's notes) follows
// tyleree's Q2 Theme Studio EQ tab; the keys and the mouse's ways follow PEQdB Studio's.
(function () {
  'use strict';

  const eq = window.Q2Eq;
  const pa = window.Q2Poweramp;
  const formats = window.Q2Formats;
  const $ = (id) => document.getElementById(id);
  const wide = matchMedia('(min-width: 960px)'); // style.css's computer layout

  const HISTORY_MAX = 200;
  const PRESET_ROWS = 200; // rows a search shows at once
  const TIMEOUT_MS = 10000;
  const CATALOGUE_MS = 60000;
  const CALM_MS = 350; // "Sending" holds this long after the last answer, so a drag doesn't flicker
  const SIDE_MS = 120; // Output's sums run this often through a drag
  const HOLD_MS = 420; // a held − or + repeats after this
  const REPEAT_MS = 70;
  const TAP_MS = 320; // a second tap this soon is a double tap
  const TAP_SLOP = 10;
  const RANGE_STEP = 6; // the graph's dB range grows in these
  const RANGE_MIN = 12;
  const RANGE_MAX = 30;
  const ZOOMS = [6, 12, 18, 24, 30]; // the wheel's ranges
  const ZOOM_NOTCH = 100; // wheel pixels to a zoom step
  const WHEEL_Q = 0.0008; // Q's log change per wheel pixel: a mouse's notch is about 8%
  const ZERO_REACH = 9; // CSS pixels from the 0 dB line a click adds a band at
  const FINE = 0.2; // Shift's share of a drag
  const GAP = { left: 30, right: 10, top: 10, bottom: 22 };
  const FREQ_LINES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const LOG_LOW = Math.log10(eq.FREQ_MIN);
  const LOG_SPAN = Math.log10(eq.FREQ_MAX) - LOG_LOW;
  const DOT = 9;
  const DOT_PICKED = 12;
  const REACH = { mouse: 14, touch: 26 }; // CSS pixels a press can miss a dot by
  const BELOW = 30; // and by touch, this much more under it, so the dot can ride above the finger
  const STORE = 'eq-studio';
  const CHANNEL_NAMES = { all: 'Both', L: 'Left', R: 'Right' };
  const TYPE_NAMES = { PK: 'Peak', LSC: 'Low shelf', HSC: 'High shelf' };
  const KNOB_NAMES = { bass: 'Bass', treble: 'Treble' };
  const VIEWS = ['eq', 'presets', 'card'];
  const UNREACHABLE = "Can't reach the Q2. Check that it's on, EQ Studio is open on it, and this device is on the same Wi-Fi.";
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  /* ---------- Words and numbers ---------- */

  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const signed = (value, digits = 1) => {
    const text = Math.abs(value).toFixed(digits);
    return `${+text && value > 0 ? '+' : +text && value < 0 ? '−' : ''}${text}`;
  };
  const hertz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${+f.toFixed(f < 100 ? 1 : 0)} Hz`);
  const shortHertz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${+f.toFixed(f < 100 ? 1 : 0)}`);
  const axisHertz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);
  const count = (n) => n.toLocaleString('en-US');
  const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
  // At least low decimals, up to high where the value has them.
  function decimals(value, [low, high]) {
    for (let digits = low; digits < high; digits += 1) {
      if (+value.toFixed(digits) === +value.toFixed(high)) return value.toFixed(digits);
    }
    return value.toFixed(high);
  }
  // What a person types: a comma or a dot, a typographic minus, a unit, 1.2k for 1200.
  function readNumber(text, kilo) {
    const clean = String(text).trim().replace(/,/g, '.').replace(/[−–]/g, '-').replace(/\s*(k?hz|db)$/i, (unit) => (/k/i.test(unit) ? 'k' : ''));
    const thousand = kilo && /k$/i.test(clean);
    const value = Number(thousand ? clean.slice(0, -1) : clean);
    return clean !== '' && Number.isFinite(value) ? value * (thousand ? 1000 : 1) : null;
  }
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const radios = (group, value) => {
    for (const button of group.children) button.setAttribute('aria-checked', String(button.dataset.value === value));
  };

  /* ---------- The preset and its history ---------- */

  let preset = eq.normalize(eq.newPreset());
  let picked = 0;
  let rate = 48000;
  const steps = { past: [], future: [], key: null }; // key: edits with the same key are one step

  function commit(next, key = null) {
    const clean = eq.normalize(next);
    const before = JSON.stringify(preset);
    if (before === JSON.stringify(clean)) {
      if (key !== steps.key) steps.key = null;
      return false;
    }
    if (!key || key !== steps.key) {
      steps.past.push(before);
      if (steps.past.length > HISTORY_MAX) steps.past.shift();
    }
    steps.key = key;
    steps.future.length = 0;
    preset = clean;
    changed();
    return true;
  }

  function changed() {
    send();
    invalidate();
    // A toast's Undo is for the step it names: another step, and the toast is out of date.
    if (!$('toastUndo').hidden && steps.past.at(-1) !== toastStep) $('toast').hidden = true;
  }

  function stepHistory(from, to) {
    if (!from.length || drag || pinch) return;
    to.push(JSON.stringify(preset));
    preset = JSON.parse(from.pop());
    picked = Math.min(picked, Math.max(preset.bands.length - 1, 0));
    steps.key = null;
    changed();
    markChosen();
  }
  const undo = () => stepHistory(steps.past, steps.future);
  const redo = () => stepHistory(steps.future, steps.past);

  function editBand(index, edit, key) {
    if (!preset.bands[index]) return false;
    const next = structuredClone(preset);
    edit(next.bands[index]);
    return commit(next, key);
  }

  function pick(index) {
    if (index === picked) return;
    picked = index;
    steps.key = null;
    invalidate();
  }

  // The middle of the widest gap between bands, so a new dot lands clear of the others.
  function freeFreq() {
    if (!preset.bands.length) return 1000;
    const logs = [LOG_LOW, ...preset.bands.map((band) => Math.log10(band.freq)).sort((a, b) => a - b), LOG_LOW + LOG_SPAN];
    let [at, widest] = [3, -1];
    for (let i = 1; i < logs.length; i += 1) {
      if (logs[i] - logs[i - 1] > widest) [widest, at] = [logs[i] - logs[i - 1], (logs[i] + logs[i - 1]) / 2];
    }
    return Number((10 ** at).toPrecision(3));
  }

  function addBand(freq = freeFreq(), gain = 0) {
    if (preset.bands.length >= eq.MAX_BANDS) {
      toast(`The Q2 takes up to ${eq.MAX_BANDS} bands.`);
      return;
    }
    const next = structuredClone(preset);
    next.bands.push(eq.newBand(freq, gain));
    picked = next.bands.length - 1;
    commit(next);
  }

  function removeBand(index) {
    if (!preset.bands[index]) return;
    const next = structuredClone(preset);
    next.bands.splice(index, 1);
    if (index < picked) picked -= 1;
    picked = Math.min(picked, Math.max(next.bands.length - 1, 0));
    [graphHover, rowHover] = [-1, -1];
    if (commit(next)) toast(`Band ${index + 1} deleted.`, true);
  }

  function sortBands() {
    const next = structuredClone(preset);
    const chosen = next.bands[picked];
    next.bands.sort((a, b) => a.freq - b.freq);
    picked = Math.max(next.bands.indexOf(chosen), 0);
    commit(next);
  }

  // Every band off, or with every one off, on again.
  function bypassAll() {
    if (!preset.bands.length) return;
    const on = !preset.bands.some((band) => band.on);
    if (commit({ ...preset, bands: preset.bands.map((band) => ({ ...band, on })) })) {
      toast(on ? 'Every band is on.' : 'Every band is off.', true);
    }
  }

  function clearBands() {
    if (!preset.bands.length) return;
    picked = 0;
    if (commit({ ...preset, bands: [] })) toast('Every band is deleted.', true);
  }

  // A band's frequency and gain, as a drag or the arrows set them: Bass's and Treble's dots move as
  // their knobs do, up and down.
  function moveBand(index, freq, gain, key) {
    return editBand(index, (band) => {
      if (!pa.knobOf(band)) band.freq = clamp(freq, eq.FREQ_MIN, eq.FREQ_MAX);
      band.gain = clamp(gain, -eq.GAIN_MAX, eq.GAIN_MAX);
    }, key);
  }

  // One step of a band's value, up (dir 1) or down: the arrows', a table box's, finer with Shift.
  const STEPS = {
    freq: (fine) => ratioStep(2 ** (1 / (fine ? 48 : 12)), fix3, 1),
    gain: (fine) => lineStep(fine ? 0.1 : 0.5),
    q: (fine) => ratioStep(2 ** (1 / (fine ? 24 : 6)), fixed(2), 0.01),
  };
  const stepped = (field, value, dir, fine) => STEPS[field](fine)(value, dir);

  // A band's freq, gain or q set: Bass's and Treble's stay where their knobs have them.
  function setField(index, field, value, key) {
    const band = preset.bands[index];
    if (field === 'q') return !pa.knobOf(band) && editBand(index, (b) => { b.q = clamp(value, eq.Q_MIN, eq.Q_MAX); }, key);
    return moveBand(index, field === 'freq' ? value : band.freq, field === 'gain' ? value : band.gain, key);
  }

  function nudge(index, field, dir, fine, key) {
    if (preset.bands[index]) setField(index, field, stepped(field, preset.bands[index][field], dir, fine), key);
  }

  // Bass or Treble at gain dB, its band kept picked if it was, and the picked one kept when it goes.
  function turnKnob(which, gain, key) {
    const next = pa.setKnob(preset, which, gain);
    if (!next) {
      toast(`The Q2 takes up to ${eq.MAX_BANDS} bands, so ${KNOB_NAMES[which]} has no room. Delete a band first.`);
      return false;
    }
    const at = pa.knobIndex(preset, which);
    if (!gain && at >= 0 && picked > at) picked -= 1;
    picked = Math.min(picked, Math.max(next.bands.length - 1, 0));
    return commit(next, key);
  }

  // A preset in, replacing this one: Undo brings that back. parsed is eq.parse's, or Poweramp's read
  // with what it changed on the way in, said with the warnings: its preamp was made for Poweramp, and
  // on a live Q2 it plays at once.
  function load(parsed, from) {
    if (!parsed.ok) {
      notice("This preset couldn't be opened", parsed.line ? `${parsed.error}. The Q2 would refuse it too.` : parsed.error);
      return false;
    }
    picked = 0;
    commit(parsed.preset);
    steps.key = null;
    const called = preset.name ? `“${preset.name}”` : 'The preset';
    toast(live.on ? `${called} is playing.` : `${called} is loaded ${from}.`, steps.past.length > 0);
    const notes = parsed.notes ? [...parsed.notes, ...eq.warnings(preset, rate)] : [];
    if (notes.length) notice(parsed.notes.length ? `${called} is open, with changes` : `${called} is open`, notes.join(' '));
    return true;
  }

  function store() {
    try {
      localStorage.setItem(STORE, JSON.stringify(preset));
    } catch {
      // Private browsing: the page still works, it just starts afresh next time.
    }
  }

  function restore() {
    try {
      const kept = JSON.parse(localStorage.getItem(STORE));
      return kept && Array.isArray(kept.bands) ? eq.normalize(kept) : null;
    } catch {
      return null;
    }
  }

  /* ---------- Talking to the app ---------- */

  let signingIn = null;

  // fetch with the header every change needs, a time limit, and the PIN screen on 401, after which
  // the request goes again.
  async function api(method, path, body, timeout = TIMEOUT_MS) {
    for (;;) {
      const headers = { 'X-Q2': '1' };
      let data = body;
      if (typeof body === 'string') headers['Content-Type'] = 'text/plain; charset=utf-8';
      else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        data = JSON.stringify(body);
      }
      const response = await fetch(path, {
        method, headers, body: data, signal: AbortSignal.timeout(timeout),
        cache: path.startsWith('/api/') ? 'no-store' : 'default',
      });
      if (response.status !== 401 || path === '/api/login') return response;
      signingIn ??= askPin().finally(() => { signingIn = null; });
      await signingIn;
    }
  }

  const json = async (response) => {
    try {
      return await response.json();
    } catch {
      return {};
    }
  };
  const problem = (response, body) => body.error || `The Q2 answered ${response.status}.`;
  const reason = (error) => (error.name === 'TimeoutError' ? "The Q2 didn't answer in time." : UNREACHABLE);

  // local: the app says this Q2 Pod can't take an EQ. on: it can.
  const live = { known: false, local: false, on: false, mode: null, busy: false, queue: [], sent: null, error: null, calm: 0 };

  function setError(text, retry) {
    live.error = { text, retry };
    syncTop();
  }

  function clearError() {
    live.error = null;
    syncTop();
  }

  function goLocal() {
    Object.assign(live, { local: true, on: false, mode: null, queue: [], sent: null });
    clearError();
    invalidate();
  }

  // The preset as it stands goes to the Q2, unless that is what it has. A preset plays at once, so it
  // replaces anything waiting, an EQ off included.
  function send() {
    if (!live.on) return;
    const text = eq.serialize(preset);
    if (text === live.sent) return;
    live.sent = text;
    live.mode = 'peq';
    live.queue = [{ eq: text }];
    pump();
  }

  function resend() {
    live.sent = null;
    send();
  }

  // Compare: the EQ off or on, after any preset still waiting.
  function setMode(on) {
    if (!live.on) return;
    live.mode = on ? 'peq' : 'off';
    live.queue = live.queue.filter((item) => 'eq' in item);
    live.queue.push({ on });
    pump();
    invalidate();
  }

  async function pump() {
    if (live.busy || !live.queue.length) return;
    const item = live.queue.shift();
    live.busy = true;
    syncTop();
    let failure = null;
    try {
      const response = 'eq' in item ? await api('PUT', '/api/eq', item.eq) : await api('PUT', '/api/mode', { on: item.on });
      const body = await json(response);
      if (response.status === 503) goLocal();
      else if (!response.ok) failure = problem(response, body);
      else if (body.ok === false) failure = /^line \d/i.test(body.error) ? `The Q2 didn't take it: ${body.error}` : body.error || "The Q2 didn't take it.";
      else if (!live.queue.length && body.mode) live.mode = body.mode;
    } catch (error) {
      failure = reason(error);
    }
    live.busy = false;
    if (failure && !live.queue.length) setError(failure, 'eq' in item ? resend : () => setMode(item.on));
    else if (!failure && live.error) clearError();
    if (!live.queue.length) {
      live.calm = performance.now() + CALM_MS;
      setTimeout(syncTop, CALM_MS + 20);
    }
    invalidate();
    pump();
  }

  // What the Q2 has. The first time it opens with the Q2's EQ; later, a change made on the Q2 while
  // the page was away replaces the page's, unless the page has an edit on its way.
  async function readState(first = false) {
    let response;
    let body;
    try {
      response = await api('GET', '/api/state');
      body = await json(response);
    } catch (error) {
      live.known = true;
      setError(reason(error), () => readState(first));
      invalidate();
      return;
    }
    live.known = true;
    if (!response.ok) {
      setError(problem(response, body), () => readState(first));
      invalidate();
      return;
    }
    if (!body.live) {
      goLocal();
      return;
    }
    live.local = false;
    live.on = true;
    if (live.busy || live.queue.length) return;
    live.mode = body.mode ?? null;
    if (body.error) setError(body.error, () => readState(first));
    else clearError();
    if (typeof body.preset === 'string') take(body.preset, first);
    live.sent ??= eq.serialize(preset);
    invalidate();
  }

  function take(text, first) {
    const parsed = eq.parse(text);
    if (!parsed.ok) {
      setError(`The Q2's EQ couldn't be read here: ${parsed.error}.`, null);
      return;
    }
    const theirs = eq.normalize({ ...parsed.preset, name: preset.name });
    live.sent = eq.serialize(theirs);
    if (eq.serialize(preset) === live.sent) return;
    if (first) {
      // What this device kept is another EQ, so its name goes too.
      preset = { ...theirs, name: '' };
      picked = 0;
      return;
    }
    picked = Math.min(picked, Math.max(theirs.bands.length - 1, 0));
    commit(theirs);
    toast("The Q2's EQ changed while this page was away, so this is it now.", true);
  }

  /* ---------- Signing in ---------- */

  let pinDone = null;

  function askPin() {
    return new Promise((resolve) => {
      $('app').inert = true;
      $('pin').hidden = false;
      $('pinIn').value = '';
      $('pinError').hidden = true;
      $('pinGo').disabled = true;
      $('pinIn').focus();
      pinDone = () => {
        $('pin').hidden = true;
        $('app').inert = false;
        resolve();
      };
    });
  }

  async function submitPin(event) {
    event.preventDefault();
    const pin = $('pinIn').value.replace(/\D/g, '');
    if (pin.length !== 6 || $('pinGo').dataset.busy) return;
    $('pinGo').dataset.busy = '1';
    $('pinGo').disabled = true;
    let words = null;
    try {
      const response = await api('POST', '/api/login', { pin });
      if (response.ok) pinDone();
      else words = problem(response, await json(response));
    } catch (error) {
      words = reason(error);
    }
    delete $('pinGo').dataset.busy;
    if (!words) return;
    $('pinError').textContent = words;
    $('pinError').hidden = false;
    $('pinIn').value = '';
    $('pinIn').focus();
  }

  /* ---------- Number controls ---------- */

  // A held button repeats; each hold is one history step. A key press steps once.
  function hold(button, run) {
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(timer);
      timer = 0;
      steps.key = null;
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      stop();
      const key = `hold:${event.timeStamp}`;
      run(key);
      timer = setTimeout(() => { timer = setInterval(() => run(key), REPEAT_MS); }, HOLD_MS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
    button.addEventListener('click', (event) => { if (event.detail === 0) run(null); });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // A value to type, a slider, and − and +. spec: label, unit, min and max (the slider's), low and
  // high (what typing reaches), log (a log slider), signed (the keyboard needs a minus), digits
  // (decimals shown), fix (a slider's value tidied), step(value, ±1), get(), set(value, key).
  function control(name, spec) {
    const box = document.querySelector(`[data-ctl="${name}"]`);
    const id = `ctl-${name}`;
    const kind = spec.signed ? 'type="number" step="any"' : 'type="text" inputmode="decimal"';
    const word = spec.label.toLowerCase();
    box.innerHTML = `<div class="ctl-top"><label for="${id}">${spec.label}</label>`
      + `<span class="val"><input id="${id}" ${kind} autocomplete="off" enterkeyhint="done"><span class="unit">${spec.unit}</span></span></div>`
      + `<div class="ctl-row"><button type="button" class="step" data-dir="-1" aria-label="Lower ${word}"><svg class="i" aria-hidden="true"><use href="#i-minus"/></svg></button>`
      + `<input type="range" min="0" max="1000" step="1" aria-label="${spec.label}">`
      + `<button type="button" class="step" data-dir="1" aria-label="Raise ${word}"><svg class="i" aria-hidden="true"><use href="#i-plus"/></svg></button></div>`
      + (spec.ends ? `<div class="ends" aria-hidden="true"><span>${spec.ends[0]}</span><span>${spec.ends[1]}</span></div>` : '');
    const input = $(id);
    const range = box.querySelector('[type=range]');
    const span = spec.log ? Math.log(spec.max / spec.min) : spec.max - spec.min;
    const toPos = (value) => Math.round(1000 * (spec.log ? Math.log(value / spec.min) : value - spec.min) / span);
    const fromPos = (pos) => spec.fix(spec.log ? spec.min * Math.exp(span * pos / 1000) : spec.min + span * pos / 1000);
    let sliding = false;

    range.addEventListener('pointerdown', () => { sliding = true; });
    for (const type of ['pointerup', 'pointercancel']) range.addEventListener(type, () => { sliding = false; });
    range.addEventListener('input', () => spec.set(fromPos(Number(range.value)), `range:${name}`));
    range.addEventListener('change', () => {
      sliding = false;
      steps.key = null;
    });
    input.addEventListener('change', () => {
      const value = readNumber(input.value, name === 'freq');
      if (value !== null) spec.set(clamp(value, spec.low, spec.high), null);
      show(spec.get(), true);
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    input.addEventListener('focus', () => input.select());
    for (const button of box.querySelectorAll('.step')) {
      hold(button, (key) => spec.set(spec.step(spec.get(), Number(button.dataset.dir)), key));
    }

    function show(value, force = false) {
      const text = decimals(value, spec.digits);
      if ((force || document.activeElement !== input) && input.value !== text) input.value = text;
      if (!sliding) range.value = String(clamp(toPos(value), 0, 1000));
      range.setAttribute('aria-valuetext', `${spec.signed ? signed(value, spec.digits[0]) : text} ${spec.unit}`.trim());
    }
    return { show };
  }

  const fix3 = (value) => Number(value.toPrecision(3));
  const fixed = (digits) => (value) => +value.toFixed(digits);
  // By a ratio, tidied, and by tick where tidying would undo it.
  const ratioStep = (ratio, fix, tick) => (value, dir) => {
    const next = fix(value * ratio ** dir);
    return next !== value ? next : fix(value + dir * tick);
  };
  const lineStep = (tick) => (value, dir) => +(value + dir * tick).toFixed(2);
  const bandGet = (name) => () => preset.bands[picked]?.[name] ?? 0;
  const bandSet = (name) => (value, key) => editBand(picked, (band) => { band[name] = value; }, key);

  let controls = null;

  function makeControls() {
    controls = {
      freq: control('freq', {
        label: 'Frequency', unit: 'Hz', min: eq.FREQ_MIN, max: eq.FREQ_MAX, low: eq.FREQ_MIN, high: eq.FREQ_MAX,
        log: true, digits: [0, 2], fix: fix3, step: ratioStep(2 ** (1 / 48), fix3, 1), get: bandGet('freq'), set: bandSet('freq'),
      }),
      gain: control('gain', {
        label: 'Gain', unit: 'dB', min: -eq.GAIN_MAX, max: eq.GAIN_MAX, low: -eq.GAIN_MAX, high: eq.GAIN_MAX,
        signed: true, digits: [1, 2], fix: fixed(1), step: lineStep(0.1), get: bandGet('gain'), set: bandSet('gain'),
      }),
      q: control('q', {
        label: 'Q', unit: '', min: eq.Q_MIN, max: eq.Q_MAX, low: eq.Q_MIN, high: eq.Q_MAX,
        log: true, digits: [2, 3], fix: fixed(2), step: ratioStep(2 ** (1 / 24), fixed(2), 0.01), get: bandGet('q'), set: bandSet('q'),
      }),
      preamp: control('preamp', {
        label: 'Level', unit: 'dB', min: -30, max: 6, low: eq.PREAMP_MIN, high: eq.PREAMP_MAX,
        signed: true, digits: [1, 2], fix: fixed(1), step: lineStep(0.1),
        get: () => preset.preamp, set: (value, key) => commit({ ...preset, preamp: value }, key),
      }),
      balance: control('balance', {
        label: 'Balance', unit: 'dB', min: -eq.BALANCE_MAX, max: eq.BALANCE_MAX, low: -eq.BALANCE_MAX, high: eq.BALANCE_MAX,
        signed: true, digits: [1, 2], fix: fixed(1), step: lineStep(0.1), ends: ['Left', 'Right'],
        get: () => preset.balance, set: (value, key) => commit({ ...preset, balance: value }, key),
      }),
    };
    // The slider and − are Poweramp's knob, boost only, − stopping at 0; typed, a knob cuts too, as the
    // Q2's shelves can.
    const knobStep = (value, dir) => {
      const next = lineStep(0.1)(value, dir);
      return value >= 0 && next < 0 ? 0 : next;
    };
    for (const which of Object.keys(pa.KNOBS)) {
      controls[which] = control(which, {
        label: KNOB_NAMES[which], unit: 'dB', min: 0, max: pa.KNOB_MAX, low: -eq.GAIN_MAX, high: eq.GAIN_MAX,
        signed: true, digits: [1, 2], fix: fixed(1), step: knobStep,
        get: () => pa.knob(preset, which), set: (value, key) => turnKnob(which, value, key),
      });
    }
    const shelf = (which) => `${hertz(pa.KNOBS[which].freq)}, Q ${pa.KNOBS[which].q}`;
    setText($('toneNote'), `As Poweramp's knobs: a low shelf at ${shelf('bass')} and a high shelf at ${shelf('treble')}, each its own band. `
      + "Close to Poweramp's sound, but not checked against it.");
  }

  /* ---------- The graph ---------- */

  let scale = null; // the last drawing's, kept through a drag
  let drag = null;
  let pinch = null;
  let tap = null; // a press that may be a tap on the empty graph
  let lastTap = null;
  const pointers = new Map();
  const colours = {};
  let font = 'sans-serif';
  let mouse = null; // where a mouse over the graph is, not pressed: { x, y, ghost }
  let graphHover = -1; // the band whose dot the mouse is over
  let rowHover = -1; // the band whose row the mouse is over
  let keyPicked = false; // [ or ] picked the band: the keys' band until the mouse moves
  let toastStep; // the step a toast's Undo takes back
  let inspect = false;
  let curves = false; // each band's own curve
  let zoom = null; // the dB range the wheel set, or null for the curve's own
  let zoomRoll = 0; // wheel pixels toward the next zoom step
  let wheelQ = null; // a wheel's turn of a band's Q, unrounded: { index, q, start, at }

  function readColours() {
    const style = getComputedStyle(document.documentElement);
    for (const key of ['grid', 'zero', 'axis', 'accent', 'accent-fill', 'on-accent', 'right', 'faint', 'text', 'muted', 'graph-bg']) {
      colours[key] = style.getPropertyValue(`--${key}`).trim();
    }
    font = getComputedStyle(document.body).fontFamily;
  }

  // The graph's reach follows the curve and the dots, but stands still through a drag.
  function rangeFor(points) {
    let most = 0;
    for (const point of points) most = Math.max(most, Math.abs(point.left), Math.abs(point.right));
    for (const band of preset.bands) if (band.on) most = Math.max(most, Math.abs(band.gain));
    return clamp(Math.ceil((most + 1) / RANGE_STEP) * RANGE_STEP, RANGE_MIN, RANGE_MAX);
  }

  function curve(context, s, points, key, colour, fill) {
    const trace = () => {
      context.beginPath();
      points.forEach((point, index) => {
        const [x, y] = [s.x(point.f), s.y(point[key])];
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
    };
    trace();
    if (fill) {
      context.save();
      context.lineTo(s.x(eq.FREQ_MAX), s.y(0));
      context.lineTo(s.x(eq.FREQ_MIN), s.y(0));
      context.closePath();
      context.globalAlpha *= fill;
      context.fillStyle = colour;
      context.fill();
      context.restore();
      trace();
    }
    context.strokeStyle = colour;
    context.stroke();
  }

  const bandColour = (band) => (!band.on ? colours.faint : band.channel === 'R' ? colours.right : colours.accent);

  // The graph on context, w by h CSS pixels: its grid, the curves and the dots, and on the page what
  // the mouse is doing. A picture (still) has a title and a legend instead. Returns its scale.
  function plot(context, w, h, still = false) {
    const gap = still ? { left: 40, right: 24, top: 46, bottom: 30 } : GAP;
    const [plotW, plotH] = [w - gap.left - gap.right, h - gap.top - gap.bottom];
    const n = clamp(Math.round(plotW / 1.5), 120, 480);
    const points = [];
    for (let i = 0; i < n; i += 1) {
      const f = 10 ** (LOG_LOW + LOG_SPAN * i / (n - 1));
      points.push({ f, ...eq.response(preset, f, rate) });
    }
    const range = !still && (drag || pinch) && scale ? scale.range : zoom ?? rangeFor(points);
    const s = {
      range, plotW, plotH, gap, points,
      x: (f) => gap.left + (Math.log10(f) - LOG_LOW) / LOG_SPAN * plotW,
      y: (gain) => gap.top + (range - clamp(gain, -range, range)) / (2 * range) * plotH,
      freqAt: (x) => 10 ** (LOG_LOW + clamp(x - gap.left, 0, plotW) / plotW * LOG_SPAN),
      gainAt: (y) => range - (y - gap.top) / plotH * 2 * range,
    };
    if (still) {
      context.fillStyle = colours['graph-bg'];
      context.fillRect(0, 0, w, h);
    }

    // The grid.
    context.font = `500 11px ${font}`;
    context.textBaseline = 'middle';
    context.fillStyle = colours.axis;
    context.lineWidth = 1;
    context.strokeStyle = colours.grid;
    for (const f of FREQ_LINES) {
      const x = Math.round(s.x(f)) + 0.5;
      context.beginPath();
      context.moveTo(x, gap.top);
      context.lineTo(x, gap.top + plotH);
      context.stroke();
    }
    // Labels from the right, each left out where it would touch the one after it.
    let room = Infinity;
    for (let index = FREQ_LINES.length - 1; index >= 0; index -= 1) {
      const [x, text] = [s.x(FREQ_LINES[index]), axisHertz(FREQ_LINES[index])];
      const width = context.measureText(text).width;
      const left = index === FREQ_LINES.length - 1 ? x - width : index === 0 ? x : x - width / 2;
      if (left + width + 6 > room) continue;
      context.textAlign = 'left';
      context.fillText(text, left, h - gap.bottom / 2);
      room = left;
    }
    const step = range <= 6 ? 2 : RANGE_STEP;
    for (let gain = -range; gain <= range; gain += step) {
      const y = Math.round(s.y(gain)) + 0.5;
      context.strokeStyle = gain ? colours.grid : colours.zero;
      context.beginPath();
      context.moveTo(gap.left, y);
      context.lineTo(gap.left + plotW, y);
      context.stroke();
      context.textAlign = 'right';
      context.fillText(gain > 0 ? `+${gain}` : `${gain}`.replace('-', '−'), gap.left - 5, y);
    }

    // The curves: each band's own where asked, the picked band's, then the whole EQ's, faded while
    // the Q2 isn't playing it.
    context.save();
    context.lineJoin = 'round';
    if (!still && live.on && live.mode !== 'peq') context.globalAlpha = 0.4;
    const own = (item) => points.map((point) => ({ f: point.f, gain: eq.bandResponse(item, point.f, rate) }));
    if (curves) {
      context.lineWidth = 1.25;
      preset.bands.forEach((item, index) => {
        if (index === picked || !item.on || !item.gain) return;
        context.save();
        context.globalAlpha *= 0.55;
        curve(context, s, own(item), 'gain', bandColour(item));
        context.restore();
      });
    }
    const band = preset.bands[picked];
    if (!still && band?.on && band.gain) {
      context.lineWidth = 1.5;
      context.setLineDash([4, 4]);
      curve(context, s, own(band), 'gain', colours.faint, 0.18);
      context.setLineDash([]);
    }
    const split = points.some((point) => Math.abs(point.left - point.right) > 0.01);
    context.lineWidth = 2.5;
    if (split) {
      curve(context, s, points, 'right', colours.right);
      curve(context, s, points, 'left', colours.accent);
    } else {
      curve(context, s, points, 'left', colours.accent, 0.14);
    }
    context.restore();

    // The dots, the picked one last so it sits on top; the one under the mouse ringed.
    const order = preset.bands.map((_, index) => index).filter((index) => index !== picked);
    if (band) order.push(picked);
    const hover = still || drag ? -1 : graphHover >= 0 ? graphHover : rowHover;
    context.textAlign = 'center';
    for (const index of order) {
      const item = preset.bands[index];
      const [x, y] = [s.x(item.freq), s.y(item.gain)];
      const colour = bandColour(item);
      if (index === hover) {
        context.save();
        context.globalAlpha = 0.22;
        context.fillStyle = colour;
        context.beginPath();
        context.arc(x, y, (index === picked ? DOT_PICKED : DOT) + 6, 0, 2 * Math.PI);
        context.fill();
        context.restore();
      }
      if (index === picked && !still) {
        if (drag || pinch) {
          context.save();
          context.globalAlpha = 0.35;
          context.strokeStyle = colour;
          context.beginPath();
          context.moveTo(Math.round(x) + 0.5, gap.top);
          context.lineTo(Math.round(x) + 0.5, gap.top + plotH);
          context.moveTo(gap.left, Math.round(y) + 0.5);
          context.lineTo(gap.left + plotW, Math.round(y) + 0.5);
          context.stroke();
          context.globalAlpha = 0.18;
          context.fillStyle = colour;
          context.beginPath();
          context.arc(x, y, 26, 0, 2 * Math.PI);
          context.fill();
          context.restore();
        }
        context.beginPath();
        context.arc(x, y, DOT_PICKED, 0, 2 * Math.PI);
        context.fillStyle = item.on ? (item.channel === 'R' ? colours.right : colours['accent-fill']) : colours.faint;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = colours['graph-bg'];
        context.stroke();
        context.fillStyle = colours['on-accent'];
        context.font = `700 12px ${font}`;
      } else {
        context.beginPath();
        context.arc(x, y, DOT, 0, 2 * Math.PI);
        context.fillStyle = colours['graph-bg'];
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = colour;
        if (!item.on) context.setLineDash([3, 3]);
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = colour;
        context.font = `700 10px ${font}`;
      }
      context.fillText(String(index + 1), x, y + 0.5);
    }

    if (still) {
      context.textAlign = 'left';
      context.fillStyle = colours.text;
      context.font = `650 17px ${font}`;
      context.fillText(preset.name || 'My EQ', gap.left, 22);
      context.fillStyle = colours.muted;
      context.font = `500 12px ${font}`;
      const words = `${plural(preset.bands.length, 'band')} · drawn at ${hertz(rate)}`;
      context.textAlign = 'right';
      context.fillText(split ? `${words} · left blue, right orange` : words, w - gap.right, 22);
      return s;
    }

    // Where a click adds a band: on the 0 dB line, where a new band's dot sits.
    if (mouse?.ghost && !drag) {
      const [x, y] = [mouse.x, s.y(0)];
      context.save();
      context.globalAlpha = 0.85;
      context.beginPath();
      context.arc(x, y, DOT, 0, 2 * Math.PI);
      context.fillStyle = colours['graph-bg'];
      context.fill();
      context.setLineDash([2, 2]);
      context.lineWidth = 1.5;
      context.strokeStyle = colours.accent;
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(x - 4, y);
      context.lineTo(x + 4, y);
      context.moveTo(x, y - 4);
      context.lineTo(x, y + 4);
      context.stroke();
      context.restore();
    }

    // Inspect: a line at the mouse, and the curve's gain there.
    if (inspect && mouse && mouse.x >= gap.left && mouse.x <= gap.left + plotW) {
      const f = s.freqAt(mouse.x);
      const { left, right } = eq.response(preset, f, rate);
      const x = Math.round(mouse.x) + 0.5;
      context.save();
      context.strokeStyle = colours.text;
      context.globalAlpha = 0.5;
      context.beginPath();
      context.moveTo(x, gap.top);
      context.lineTo(x, gap.top + plotH);
      context.stroke();
      context.globalAlpha = 1;
      for (const [gain, colour] of split ? [[left, colours.accent], [right, colours.right]] : [[left, colours.accent]]) {
        context.beginPath();
        context.arc(x, s.y(gain), 4, 0, 2 * Math.PI);
        context.fillStyle = colour;
        context.fill();
      }
      const text = `${hertz(f)}   ${split ? `L ${signed(left)} · R ${signed(right)}` : signed(left)} dB`;
      context.font = `600 12px ${font}`;
      const width = context.measureText(text).width + 16;
      const boxX = clamp(x - width / 2, gap.left, gap.left + plotW - width);
      context.fillStyle = colours.text;
      context.beginPath();
      const top = gap.top + ($('graphBadge').hidden && $('legend').hidden ? 2 : 34);
      if (context.roundRect) context.roundRect(boxX, top, width, 22, 6);
      else context.rect(boxX, top, width, 22);
      context.fill();
      context.fillStyle = colours['graph-bg'];
      context.textAlign = 'left';
      context.fillText(text, boxX + 8, top + 11.5);
      context.restore();
    }
    return s;
  }

  function drawGraph() {
    const canvas = $('graph');
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    if (!w || !h) return;
    const ratio = window.devicePixelRatio || 1;
    const [pw, ph] = [Math.round(w * ratio), Math.round(h * ratio)];
    if (canvas.width !== pw || canvas.height !== ph) [canvas.width, canvas.height] = [pw, ph];
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, h);
    scale = plot(context, w, h);
    // Undo, a paste or a load moves the dots under a still mouse: the one it's over now.
    const hover = mouse && !drag && !pinch ? dotAt(mouse, 'mouse') : graphHover;
    if (hover !== graphHover) {
      graphHover = hover;
      context.clearRect(0, 0, w, h);
      scale = plot(context, w, h);
    }
    $('legend').hidden = !scale.points.some((point) => Math.abs(point.left - point.right) > 0.01);
    $('fit').hidden = zoom === null;

    // What a drag or a pinch is setting, where the finger isn't.
    const band = preset.bands[picked];
    const readout = $('readout');
    readout.hidden = !((drag || pinch) && band);
    if (!readout.hidden) {
      setText(readout, pinch ? `Band ${picked + 1} · Q ${decimals(band.q, [2, 3])}`
        : `Band ${picked + 1} · ${hertz(band.freq)} · ${signed(band.gain)} dB${drag.fine ? ' · fine' : ''}`);
      readout.classList.toggle('low', scale.y(band.gain) < GAP.top + 56);
    }
  }

  // A picture of the graph, twice its size in pixels, for Export.
  function graphPicture() {
    const [w, h] = [1200, 640];
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [w * 2, h * 2];
    const context = canvas.getContext('2d');
    context.scale(2, 2);
    plot(context, w, h, true);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function pointerAt(event) {
    const box = $('graph').getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function dotAt({ x, y }, type) {
    if (!scale) return -1;
    const touch = type !== 'mouse';
    let [best, reach] = [-1, touch ? REACH.touch : REACH.mouse];
    preset.bands.forEach((band, index) => {
      let dy = y - scale.y(band.gain);
      if (touch && dy > 0) dy = Math.max(0, dy - BELOW);
      const away = Math.hypot(scale.x(band.freq) - x, dy);
      if (away < reach || (away === reach && index === picked)) [best, reach] = [index, away];
    });
    return best;
  }

  // Whether a mouse at this point, on no dot, is on the 0 dB line inside the plot.
  const onZero = ({ x, y }) => !!scale && x >= scale.gap.left && x <= scale.gap.left + scale.plotW
    && Math.abs(y - scale.y(0)) <= ZERO_REACH && preset.bands.length < eq.MAX_BANDS;

  // A tick under the finger, where the phone has one and the page may use it.
  const buzz = (event) => {
    if (event.pointerType === 'touch' && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
  };

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function startDrag(index, at, event, key = `drag:${event.timeStamp}`) {
    const { freq, gain } = preset.bands[index];
    drag = { index, key, dx: scale.x(freq) - at.x, gain, from: at.y, last: at, pos: { ...at }, fine: false };
    $('graph').classList.add('dragging');
  }

  function graphDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!$('moreMenu').hidden) return closeMenu();
    const canvas = $('graph');
    canvas.setPointerCapture(event.pointerId);
    const at = pointerAt(event);
    pointers.set(event.pointerId, at);
    if (pointers.size === 2) {
      // Two fingers: the picked band's Q. The drag that began stays one step of its own.
      drag = null;
      tap = null;
      steps.key = null;
      const band = preset.bands[picked];
      pinch = band ? { key: `pinch:${event.timeStamp}`, from: spread(), q: band.q } : null;
      invalidate();
      return;
    }
    if (pointers.size > 2) return;
    tap = { x: at.x, y: at.y, id: event.pointerId };
    const index = dotAt(at, event.pointerType);
    if (index < 0 && event.pointerType === 'mouse' && onZero(at)) {
      // A click on the 0 dB line: a band there, flat, dragged from where it was born. One step.
      const key = `drag:${event.timeStamp}`;
      const next = structuredClone(preset);
      next.bands.push(eq.newBand(Number(scale.freqAt(at.x).toPrecision(3)), 0));
      picked = next.bands.length - 1;
      commit(next, key);
      startDrag(picked, at, event, key);
      tap = null;
      mouse = null;
      invalidate();
      return;
    }
    if (index < 0) return;
    tap = null;
    pick(index);
    startDrag(index, at, event);
    buzz(event);
    invalidate();
  }

  // A mouse over the graph, no button down: the dot it's on, or the 0 dB line.
  function graphHoverAt(event) {
    const at = pointerAt(event);
    const index = dotAt(at, 'mouse');
    mouse = { ...at, ghost: index < 0 && onZero(at) };
    graphHover = index;
    keyPicked = false;
    $('graph').classList.toggle('over-dot', index >= 0 || mouse.ghost);
    invalidate();
  }

  function graphMove(event) {
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') graphHoverAt(event);
      return;
    }
    const at = pointerAt(event);
    pointers.set(event.pointerId, at);
    if (pinch) {
      const now = spread();
      if (pointers.size === 2 && now > 0) {
        editBand(picked, (band) => { band.q = +(pinch.q * pinch.from / now).toFixed(2); }, pinch.key);
      }
      return;
    }
    if (tap && Math.hypot(at.x - tap.x, at.y - tap.y) > TAP_SLOP) tap = null;
    if (!drag) return;
    if (event.pointerType === 'mouse') mouse = { ...at, ghost: false };
    // Shift: a fifth of the way the mouse goes, for the last tenth of a dB.
    const share = event.shiftKey ? FINE : 1;
    drag.fine = event.shiftKey;
    drag.pos = { x: drag.pos.x + (at.x - drag.last.x) * share, y: drag.pos.y + (at.y - drag.last.y) * share };
    drag.last = at;
    const freq = Number(scale.freqAt(drag.pos.x + drag.dx).toPrecision(event.shiftKey ? 4 : 3));
    const raw = drag.gain + scale.gainAt(drag.pos.y) - scale.gainAt(drag.from);
    const gain = Math.round(raw * (event.shiftKey ? 100 : 10)) / (event.shiftKey ? 100 : 10);
    moveBand(drag.index, freq, gain, drag.key);
  }

  function endDrag() {
    drag = null;
    steps.key = null;
    $('graph').classList.remove('dragging');
    invalidate();
  }

  // Esc in a drag: the band back where it was, and the drag no step.
  function cancelDrag() {
    if (!drag) return false;
    const moved = steps.key === drag.key;
    endDrag();
    if (moved) {
      undo();
      steps.future.pop();
    }
    return true;
  }

  function graphUp(event) {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        steps.key = null;
        invalidate();
      }
      return;
    }
    if (drag) endDrag();
    if (event.type === 'pointerup' && tap?.id === event.pointerId) {
      const at = { x: tap.x, y: tap.y };
      if (lastTap && event.timeStamp - lastTap.t < TAP_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 30) {
        lastTap = null;
        addBand(Number(scale.freqAt(at.x).toPrecision(3)), Math.round(scale.gainAt(at.y) * 10) / 10);
        buzz(event);
      } else {
        lastTap = { ...at, t: event.timeStamp };
      }
    }
    tap = null;
  }

  function graphLeave(event) {
    if (event.pointerType !== 'mouse' || pointers.has(event.pointerId)) return;
    mouse = null;
    graphHover = -1;
    invalidate();
  }

  // The wheel on a dot turns its Q; elsewhere it zooms the dB scale. Pixels, not notches, so a
  // trackpad turns it smoothly; Ctrl's wheel (and a trackpad's pinch) is the browser's zoom.
  function graphWheel(event) {
    if (!scale || event.ctrlKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = (event.deltaY || event.deltaX) * unit;
    const index = dotAt(pointerAt(event), 'mouse');
    if (index >= 0) {
      const now = event.timeStamp;
      if (!wheelQ || wheelQ.index !== index || now - wheelQ.at > 600) {
        wheelQ = { index, q: preset.bands[index].q, start: now };
        const knob = pa.knobOf(preset.bands[index]);
        if (knob) toast(`${KNOB_NAMES[knob]} is Poweramp's knob: its Q stays.`);
      }
      wheelQ.at = now;
      wheelQ.q = clamp(wheelQ.q * Math.exp(-delta * WHEEL_Q * (event.shiftKey ? 0.25 : 1)), eq.Q_MIN, eq.Q_MAX);
      pick(index);
      setField(index, 'q', +wheelQ.q.toFixed(wheelQ.q < 1 ? 3 : 2), `wheel:${index}:${wheelQ.start}`);
      return;
    }
    zoomRoll += delta;
    if (Math.abs(zoomRoll) < ZOOM_NOTCH) return;
    const dir = Math.sign(zoomRoll);
    zoomRoll = 0;
    const now = zoom ?? scale.range;
    const at = dir < 0 ? ZOOMS.filter((r) => r < now).at(-1) : ZOOMS.find((r) => r > now);
    if (at) setZoom(at);
  }

  function setZoom(range) {
    zoom = range;
    zoomRoll = 0;
    setText($('fitText'), `±${range} dB · Fit`);
    invalidate();
  }

  /* ---------- Painting the page ---------- */

  let frame = 0;
  let sideAt = 0;
  let stripPicked = -1;
  let rowPicked = -1;
  let view = 'eq';

  function invalidate() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function paint(now) {
    frame = 0;
    drawGraph(); // nothing while it's hidden, a phone's on another tab
    syncStrip();
    syncTable();
    syncBand();
    syncTop();
    if (!(drag || pinch) || now - sideAt > SIDE_MS) {
      syncOutput();
      sideAt = now;
    }
  }

  function syncTop() {
    let [state, words] = ['wait', 'Connecting'];
    if (live.error) [state, words] = ['error', 'Error'];
    else if (live.local) [state, words] = ['local', 'Not live'];
    else if (live.on && (live.busy || live.queue.length || performance.now() < live.calm)) [state, words] = ['sending', 'Sending'];
    else if (live.on) [state, words] = ['live', 'Live'];
    $('status').dataset.state = state;
    setText($('statusText'), words);
    $('alert').hidden = !live.error;
    if (live.error) {
      setText($('alertText'), live.error.text);
      $('retry').hidden = !live.error.retry;
    }
    $('noteLocal').hidden = !live.local;
    $('note3eq').hidden = !(live.on && live.mode === '3eq');
    $('compare').hidden = !live.on;
    radios($('compare'), live.mode === 'peq' ? 'on' : live.mode === 'off' ? 'off' : '');
    const badge = !live.on ? '' : live.mode === 'off' ? 'EQ off: you hear the music without it' : live.mode === '3eq' ? 'The Q2 plays its 3-band EQ' : '';
    $('graphBadge').hidden = !badge;
    setText($('graphBadge'), badge);
    $('undo').disabled = !steps.past.length;
    $('redo').disabled = !steps.future.length;
    if (document.activeElement !== $('name')) $('name').value = preset.name;
    setText($('cardThis'), `${preset.name ? `“${preset.name}”, ` : ''}${plural(preset.bands.length, 'band')}. Saves as EQ/${eq.fileName(preset.name)}.`);
  }

  function syncStrip() {
    const strip = $('strip');
    const { bands } = preset;
    while (strip.children.length > bands.length) strip.lastChild.remove();
    while (strip.children.length < bands.length) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'band-chip';
      chip.setAttribute('role', 'option');
      chip.dataset.index = strip.children.length;
      chip.append(...['n', 'f', 'g'].map((part) => Object.assign(document.createElement('span'), { className: part })));
      strip.append(chip);
    }
    bands.forEach((band, index) => {
      const chip = strip.children[index];
      const knob = pa.knobOf(band);
      const tags = knob ? ` · ${KNOB_NAMES[knob]}`
        : `${band.channel === 'all' ? '' : ` ${band.channel}`}${band.type === 'LSC' ? ' · LS' : band.type === 'HSC' ? ' · HS' : ''}`;
      setText(chip.children[0], `${index + 1}${tags}`);
      setText(chip.children[1], shortHertz(band.freq));
      setText(chip.children[2], `${signed(band.gain)} dB`);
      chip.classList.toggle('off', !band.on);
      chip.setAttribute('aria-selected', String(index === picked));
      chip.setAttribute('aria-label', `Band ${index + 1}: ${knob ? `${KNOB_NAMES[knob]}, ` : ''}${TYPE_NAMES[band.type]}, ${hertz(band.freq)}, ${signed(band.gain)} dB`
        + `${band.channel === 'all' ? '' : `, ${CHANNEL_NAMES[band.channel]} only`}${band.on ? '' : ', off'}`);
    });
    setText($('count'), `${bands.length} of ${eq.MAX_BANDS}`);
    $('add').disabled = bands.length >= eq.MAX_BANDS;
    $('sort').disabled = bands.length < 2;
    if (picked !== stripPicked && strip.children[picked]) {
      stripPicked = picked;
      const chip = strip.children[picked];
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  // A computer's band table: a row a band, its boxes rewritten unless one is being typed in.
  const ROW = '<button type="button" class="tnum" tabindex="-1"></button>'
    + '<input type="checkbox" class="tsw" role="switch">'
    + '<select class="tsel" data-field="type"><option value="PK">Peak</option><option value="LSC">Low shelf</option><option value="HSC">High shelf</option></select>'
    + '<select class="tsel" data-field="channel"><option value="all">Both</option><option value="L">Left</option><option value="R">Right</option></select>'
    + ['freq', 'gain', 'q'].map((field) => `<input class="tin" data-field="${field}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" enterkeyhint="next">`).join('')
    + '<button type="button" class="icon-btn ghost tdel"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>';
  const FIELD_DIGITS = { freq: [0, 2], gain: [1, 2], q: [2, 3] };

  function showField(input, value) {
    const text = decimals(value, FIELD_DIGITS[input.dataset.field]);
    if (document.activeElement !== input && input.value !== text) input.value = text;
  }

  function syncTable() {
    const body = $('tbody');
    const { bands } = preset;
    while (body.children.length > bands.length) body.lastChild.remove();
    while (body.children.length < bands.length) {
      const row = document.createElement('div');
      row.className = 'trow';
      row.dataset.index = body.children.length;
      row.innerHTML = ROW;
      body.append(row);
    }
    const hover = graphHover >= 0 ? graphHover : rowHover;
    bands.forEach((band, index) => {
      const row = body.children[index];
      const [num, on, type, channel, freq, gain, q, del] = row.children;
      const knob = pa.knobOf(band);
      const n = index + 1;
      setText(num, String(n));
      if (row.dataset.n !== String(n) || row.dataset.knob !== String(knob)) {
        row.dataset.n = String(n);
        row.dataset.knob = String(knob);
        num.setAttribute('aria-label', `Pick band ${n}${knob ? `, ${KNOB_NAMES[knob]}` : ''}`);
        row.title = knob ? `${KNOB_NAMES[knob]}: Poweramp's knob, its gain under Bass and treble` : '';
        on.setAttribute('aria-label', `Band ${n} on`);
        type.setAttribute('aria-label', `Band ${n} type`);
        channel.setAttribute('aria-label', `Band ${n} channel`);
        freq.setAttribute('aria-label', `Band ${n} frequency, Hz`);
        gain.setAttribute('aria-label', `Band ${n} gain, dB`);
        q.setAttribute('aria-label', `Band ${n} Q`);
        del.setAttribute('aria-label', `Delete band ${n}`);
        // Bass's and Treble's Hz and Q are Poweramp's knobs': their gain alone moves.
        freq.readOnly = q.readOnly = !!knob;
        type.disabled = channel.disabled = !!knob;
      }
      on.checked = band.on;
      if (type.value !== band.type) type.value = band.type;
      if (channel.value !== band.channel) channel.value = band.channel;
      showField(freq, band.freq);
      showField(gain, band.gain);
      showField(q, band.q);
      row.classList.toggle('picked', index === picked);
      row.classList.toggle('hover', index === hover && index !== picked);
      row.classList.toggle('off', !band.on);
      row.classList.toggle('right', band.channel === 'R');
      row.classList.toggle('knob', !!knob);
    });
    $('tableEmpty').hidden = bands.length > 0;
    $('table').hidden = !bands.length;
    if (picked !== rowPicked && body.children[picked]) {
      rowPicked = picked;
      if (wide.matches && keyPicked) body.children[picked].scrollIntoView({ block: 'nearest' });
    }
  }

  function syncBand() {
    const band = preset.bands[picked];
    $('bandEmpty').hidden = !!band;
    $('bandBody').hidden = !band;
    $('bandOn').closest('.switch').hidden = !band;
    $('del').hidden = !band;
    const knob = band && pa.knobOf(band);
    setText($('bandTitle'), band ? `Band ${picked + 1}${knob ? ` · ${KNOB_NAMES[knob]}` : ''}` : 'Bands');
    if (!band) return;
    $('bandOn').checked = band.on;
    $('bandOnLabel').textContent = `Band ${picked + 1} on`;
    radios($('type'), band.type);
    radios($('channel'), band.channel);
    controls.freq.show(band.freq);
    controls.gain.show(band.gain);
    controls.q.show(band.q);
  }

  function fillWarnings(list, messages) {
    if (list.dataset.shown === messages.join('\n')) return;
    list.dataset.shown = messages.join('\n');
    list.textContent = '';
    for (const message of messages) {
      const item = document.createElement('li');
      item.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-warn"/></svg><span></span>';
      item.lastChild.textContent = message;
      list.append(item);
    }
    list.hidden = !messages.length;
  }

  function syncOutput() {
    radios($('preampMode'), preset.auto ? 'auto' : 'hand');
    $('preampCtl').hidden = preset.auto;
    controls.preamp.show(preset.preamp);
    controls.balance.show(preset.balance);
    for (const which of Object.keys(pa.KNOBS)) controls[which].show(pa.knob(preset, which));
    const turned = Object.keys(pa.KNOBS).filter((which) => pa.knob(preset, which));
    setText($('toneSum'), turned.map((which) => `${KNOB_NAMES[which]} ${signed(pa.knob(preset, which))}`).join(' · ') || 'Off');
    radios($('rate'), String(rate));
    const cut = eq.autoPreamp(preset);
    setText($('autoNote'), preset.auto
      ? `Auto cuts ${signed(cut)} dB at 48 kHz. The Q2 works it out again for each song's sample rate.`
      : `Auto would cut ${signed(cut)} dB at 48 kHz.`);
    const { power, at } = eq.peak(preset, rate, eq.FREQ_MIN);
    setText($('peak'), power > 1 ? `Loudest boost ${signed(10 * Math.log10(power))} dB at ${hertz(at)}.` : 'No boost anywhere.');
    fillWarnings($('warnings'), eq.warnings(preset, rate));
  }

  /* ---------- Presets ---------- */

  const catalogue = { items: null, loading: false, type: '', chosen: -1 };

  async function loadCatalogue() {
    if (catalogue.items || catalogue.loading) return;
    catalogue.loading = true;
    $('presetRetry').hidden = true;
    $('presetNote').textContent = 'Loading the presets…';
    try {
      const response = await api('GET', '/presets.json', undefined, CATALOGUE_MS);
      if (!response.ok) throw new Error(problem(response, await json(response)));
      const { credit, presets } = await response.json();
      catalogue.items = presets.map((item, index) => ({ ...item, index, find: `${item.name} ${item.source} ${item.type}`.toLowerCase() }));
      $('credit').textContent = credit;
      $('search').placeholder = `Search ${count(presets.length)} headphones`;
      const kinds = {};
      for (const item of presets) kinds[item.type] = (kinds[item.type] || 0) + 1;
      const types = $('types');
      for (const [value, label] of [['', 'All'], ...Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a]).map((kind) => [kind, kind[0].toUpperCase() + kind.slice(1)])]) {
        const button = document.createElement('button');
        Object.assign(button, { type: 'button', textContent: label });
        button.dataset.value = value;
        button.setAttribute('role', 'radio');
        types.append(button);
      }
      renderPresets();
    } catch (error) {
      $('presetNote').textContent = `The presets couldn't be loaded. ${error.name === 'Error' ? error.message : reason(error)}`;
      $('presetRetry').hidden = false;
    }
    catalogue.loading = false;
  }

  // The popular few before a search. A search wants every word, in any order, in the name, the
  // measurement's source or the kind.
  function renderPresets() {
    if (!catalogue.items) return;
    const words = $('search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const { type } = catalogue;
    let found = catalogue.items.filter((item) => (!type || item.type === type) && words.every((word) => item.find.includes(word)));
    const popular = !words.length && found.some((item) => item.top);
    if (popular) found = found.filter((item) => item.top);
    radios($('types'), type);
    const list = $('presetList');
    const rows = document.createDocumentFragment();
    for (const item of found.slice(0, PRESET_ROWS)) {
      const row = document.createElement('li');
      row.innerHTML = '<button type="button" class="row"><span class="row-text"><span class="t"></span><span class="s"></span></span>'
        + '<svg class="i" aria-hidden="true"><use href="#i-check"/></svg></button>';
      const button = row.firstChild;
      button.dataset.index = item.index;
      button.querySelector('.t').textContent = item.name;
      button.querySelector('.s').textContent = `${item.source} · ${item.type}`;
      rows.append(row);
    }
    list.textContent = '';
    list.append(rows);
    markChosen();
    const kind = type ? `${type}s` : 'headphones';
    $('presetNote').textContent = popular ? `Popular in-ears. Search for any of ${count(catalogue.items.length)} headphones.`
      : !found.length ? 'No match. Try fewer words, or another kind.'
        : found.length > PRESET_ROWS ? `The first ${PRESET_ROWS} of ${count(found.length)} ${words.length ? 'matches' : kind}. Add a word to narrow it.`
          : words.length ? `${count(found.length)} ${found.length === 1 ? 'match' : 'matches'}.` : `${count(found.length)} ${kind}.`;
  }

  function markChosen() {
    for (const button of $('presetList').querySelectorAll('.row')) {
      const item = catalogue.items[Number(button.dataset.index)];
      const on = item.index === catalogue.chosen && eq.cleanName(item.name) === preset.name;
      if (on) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  }

  /* ---------- The card ---------- */

  let cardFiles = null;
  const cardPath = (file, extra = '') => `/api/card/file?name=${encodeURIComponent(file)}${extra}`;
  const size = (bytes) => (bytes < 1024 ? plural(bytes, 'byte') : `${(bytes / 1024).toFixed(1)} KB`);
  const day = (seconds) => {
    const when = new Date(seconds * 1000);
    const options = { day: 'numeric', month: 'short' };
    if (when.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return when.toLocaleDateString(undefined, options);
  };

  async function readCard() {
    if (!cardFiles) $('cardNote').textContent = 'Reading the card…';
    let response;
    let body;
    try {
      response = await api('GET', '/api/card');
      body = await json(response);
    } catch (error) {
      $('cardNote').textContent = reason(error);
      return;
    }
    if (!response.ok) {
      cardFiles = null;
      renderCard();
      $('cardNote').textContent = problem(response, body);
      return;
    }
    cardFiles = body.files || [];
    renderCard();
  }

  function renderCard() {
    const list = $('cardList');
    list.textContent = '';
    for (const file of cardFiles || []) {
      const row = document.createElement('li');
      row.innerHTML = '<button type="button" class="row"><span class="row-text"><span class="t"></span><span class="s"></span></span></button>'
        + '<button type="button" class="icon-btn danger"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>';
      const [open, remove] = row.children;
      open.dataset.file = file.file;
      open.querySelector('.t').textContent = file.name;
      open.querySelector('.s').textContent = `${size(file.size)} · ${day(file.mtime)}`;
      remove.dataset.remove = file.file;
      remove.setAttribute('aria-label', `Delete ${file.name}`);
      list.append(row);
    }
    if (cardFiles) $('cardNote').textContent = cardFiles.length ? '' : 'Nothing in the EQ folder yet. Save this EQ to put it there.';
  }

  async function openCardFile(file) {
    try {
      const response = await api('GET', cardPath(file));
      if (!response.ok) notice("This preset couldn't be opened", problem(response, await json(response)));
      else load(eq.parse(await response.text(), eq.nameOfFile(file)), 'from the card');
    } catch (error) {
      notice("This preset couldn't be opened", reason(error));
    }
  }

  async function removeCardFile(file) {
    const name = eq.nameOfFile(file);
    const sure = await ask({
      title: `Delete “${name}”?`,
      text: "It goes from the card's EQ folder. If the Q2 imported it, the Q2 keeps its copy.",
      yes: 'Delete', danger: true,
    });
    if (!sure) return;
    try {
      const response = await api('DELETE', cardPath(file));
      if (response.ok || response.status === 404) toast(`“${name}” is deleted.`);
      else notice("It couldn't be deleted", problem(response, await json(response)));
    } catch (error) {
      notice("It couldn't be deleted", reason(error));
    }
    readCard();
  }

  function saveStep(replace) {
    $('saveAsk').hidden = replace;
    $('saveReplace').hidden = !replace;
    $('saveGo').textContent = replace ? 'Replace' : 'Save';
    $('saveGo').classList.toggle('danger', replace);
    $('saveGo').classList.toggle('primary', !replace);
    $('saveError').hidden = true;
  }

  function syncSave() {
    setText($('savePath'), `Saves as EQ/${eq.fileName($('saveName').value)} on the card.`);
    fillWarnings($('saveWarn'), eq.warnings(preset, rate));
  }

  function openSave() {
    $('saveName').value = preset.name;
    saveStep(false);
    syncSave();
    $('dlgSave').showModal();
  }

  async function saveGo() {
    if ($('saveGo').disabled) return;
    const name = eq.cleanName($('saveName').value);
    if (name !== preset.name) commit({ ...preset, name });
    const file = eq.fileName(name);
    const replace = !$('saveReplace').hidden;
    $('saveGo').disabled = true;
    $('saveCancel').disabled = true;
    let words = null;
    try {
      const response = await api('PUT', cardPath(file, replace ? '&replace=1' : ''), eq.serialize(preset));
      const body = await json(response);
      if (response.status === 409 && !replace) {
        $('replaceText').textContent = `“${eq.nameOfFile(file)}” is already on the card.`;
        saveStep(true);
      } else if (!response.ok) {
        words = problem(response, body);
      } else {
        $('dlgSave').close();
        toast(live.on ? `Saved to the card as EQ/${file}.`
          : `Saved as EQ/${file}. On the Q2, pick it under the EQ page's “Import from SD /EQ” row.`);
        if (cardFiles) readCard();
      }
    } catch (error) {
      words = reason(error);
    }
    $('saveGo').disabled = false;
    $('saveCancel').disabled = false;
    // Asked to replace: focus on Cancel, as the step before had it on Save.
    if (!replace && !$('saveReplace').hidden) $('saveCancel').focus();
    if (words) {
      $('saveError').textContent = words;
      $('saveError').hidden = false;
    }
  }

  // A preset's text or Poweramp's JSON, from a file, the clipboard or the paste box.
  function openText(text, name, from) {
    return pa.isJson(text) ? load(pa.read(text, name), 'from Poweramp') : load(eq.parse(text, name), from);
  }

  async function openFile(file) {
    if (!file) return;
    if (file.size > pa.FILE_MAX) {
      notice("This preset couldn't be opened", "It's too big to be a preset.");
      return;
    }
    openText(await file.text(), eq.nameOfFile(file.name.replace(/\.json$/i, '')), 'from the file');
  }

  function openPicked() {
    const file = $('fileIn').files[0];
    $('fileIn').value = '';
    openFile(file);
  }

  // A file to keep or send: the share sheet where the browser has one for files, else a download.
  async function saveFile(file) {
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (error) {
        if (error.name !== 'AbortError') toast("It couldn't be shared.");
      }
      return false;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    return true;
  }

  async function exportEq() {
    const name = eq.fileName(preset.name);
    if (await saveFile(new File([eq.serialize(preset)], name, { type: 'text/plain' }))) toast(`Downloaded ${name}.`);
  }

  // For other apps: kind is wavelet, biquad:<rate>, wav:<rate> or png.
  async function exportAs(kind) {
    const [what, rateText] = kind.split(':');
    const at = Number(rateText);
    const base = eq.fileName(preset.name).replace(/\.txt$/, '');
    const k = at ? `${+(at / 1000).toFixed(1)}k` : '';
    if (what !== 'png' && !preset.bands.some((band) => band.on && band.gain)) {
      toast('No band changes the sound yet, so there is nothing to export.');
      return;
    }
    let file;
    let notes = [];
    if (what === 'wavelet') {
      const out = formats.wavelet(preset);
      file = new File([out.text], `${base} Wavelet.txt`, { type: 'text/plain' });
      notes = out.notes;
    } else if (what === 'biquad') {
      const out = formats.biquads(preset, at);
      file = new File([out.text], `${base} biquads ${k}.txt`, { type: 'text/plain' });
      notes = out.notes;
    } else if (what === 'wav') {
      const out = formats.convolution(preset, at);
      file = new File([out.data], `${base} ${k}.wav`, { type: 'audio/wav' });
      notes = out.notes;
    } else {
      const picture = await graphPicture();
      if (!picture) {
        toast("The picture couldn't be made.");
        return;
      }
      file = new File([picture], `${base}.png`, { type: 'image/png' });
    }
    if (await saveFile(file)) toast([`Downloaded ${file.name}.`, ...notes].join(' '));
    else if (notes.length) toast(notes.join(' '));
  }

  /* ---------- Copy and paste ---------- */

  let copying = false; // Copy's own copy event, which copies even with text picked on the page

  const typingIn = (element) => element instanceof Element
    && element.matches('input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable]');

  // The page's HTTP from the Q2 has no clipboard API, so Copy runs the browser's copy command, whose
  // event the page fills; on HTTPS the API is there.
  // Auto's preamp is the Q2's, worked out as it plays, so the text has none: the figure, for the app it goes to.
  const copiedWords = () => (preset.auto
    ? `The EQ is copied, as text. Its preamp is Auto, so the text has none: set ${signed(eq.autoPreamp(preset))} dB where you paste it.`
    : 'The EQ is copied, as text.');

  async function copyEq() {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(eq.serialize(preset));
        toast(copiedWords());
        return;
      } catch {
        // The command below, then.
      }
    }
    copying = true;
    let done = false;
    try {
      done = document.execCommand('copy');
    } catch {
      done = false;
    }
    copying = false;
    toast(done ? copiedWords() : "This browser won't copy from here. Download it instead.");
  }

  function onCopy(event) {
    if (!copying && (typingIn(event.target) || String(window.getSelection()).trim() || modalOpen())) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', eq.serialize(preset));
    if (!copying) toast(copiedWords());
  }

  function onPaste(event) {
    if (typingIn(event.target) || modalOpen() || $('app').inert || drag || pinch) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    event.preventDefault();
    openText(text.slice(0, pa.FILE_MAX), '', 'from the clipboard');
  }

  // A box to paste into: a browser reads the clipboard for a page only when the paste is the person's.
  function openPaste() {
    $('pasteIn').value = '';
    $('pasteGo').disabled = true;
    $('dlgPaste').showModal();
  }

  function pasteGo() {
    const text = $('pasteIn').value;
    if (text.trim() && openText(text, '', 'from the paste')) $('dlgPaste').close();
  }

  /* ---------- Toasts and questions ---------- */

  let toastTimer = 0;

  function toast(text, undoable = false) {
    toastStep = steps.past.at(-1);
    $('toastText').textContent = text;
    $('toastUndo').hidden = !undoable;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, Math.max(undoable ? 5000 : 3800, text.length * 65));
  }

  function ask({ title, text, yes = 'OK', no = 'Cancel', danger = false }) {
    const dialog = $('dlgAsk');
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    $('askYes').textContent = yes;
    $('askYes').classList.toggle('danger', danger);
    $('askYes').classList.toggle('primary', !danger);
    $('askNo').hidden = !no;
    $('askNo').textContent = no || '';
    dialog.showModal();
    return new Promise((resolve) => {
      const done = (answer) => {
        dialog.close();
        resolve(answer);
      };
      $('askYes').onclick = () => done(true);
      $('askNo').onclick = () => done(false);
      dialog.oncancel = () => resolve(false);
    });
  }

  const notice = (title, text) => ask({ title, text, no: null });

  /* ---------- Tabs ---------- */

  const scrolls = {};
  // A phone's page scrolls; a computer's tabs each scroll in the sidebar.
  const scroller = (name) => (wide.matches ? $(`view-${name}`) : null);

  function show(name, first = false) {
    if (!first) scrolls[view] = scroller(view)?.scrollTop ?? window.scrollY;
    view = name;
    $('app').dataset.view = name;
    for (const tab of document.querySelectorAll('.tabs [role=tab]')) {
      const on = tab.dataset.view === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`view-${tab.dataset.view}`).hidden = !on;
    }
    window.history.replaceState(null, '', name === 'eq' ? location.pathname : `#${name}`);
    const box = scroller(name);
    if (box) box.scrollTop = scrolls[name] || 0;
    else window.scrollTo(0, scrolls[name] || 0);
    closeMenu();
    invalidate();
    if (name === 'presets') loadCatalogue();
    if (name === 'card') readCard();
  }

  /* ---------- The bands' menu ---------- */

  function openMenu() {
    const items = $('moreMenu');
    setText($('bypassText'), preset.bands.some((band) => band.on) ? 'Turn every band off' : 'Turn every band on');
    setText(items.querySelector('[data-act=curves] span'), curves ? "Hide each band's curve" : "Show each band's curve");
    for (const act of ['bypass', 'clear']) items.querySelector(`[data-act=${act}]`).disabled = !preset.bands.length;
    items.hidden = false;
    items.scrollIntoView({ block: 'nearest' });
    $('more').setAttribute('aria-expanded', 'true');
    items.querySelector('button:not(:disabled)').focus();
  }

  function closeMenu(refocus = false) {
    if ($('moreMenu').hidden) return;
    $('moreMenu').hidden = true;
    $('more').setAttribute('aria-expanded', 'false');
    if (refocus) $('more').focus();
  }

  function menuKey(event) {
    const items = [...$('moreMenu').querySelectorAll('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (go !== undefined) items[(go + items.length) % items.length].focus();
    else if (event.key === 'Escape' || event.key === 'Tab') closeMenu(event.key === 'Escape');
    else return;
    if (event.key !== 'Tab') event.preventDefault();
    event.stopPropagation();
  }

  function menuAct(act) {
    closeMenu(true);
    if (act === 'bypass') bypassAll();
    else if (act === 'curves') toggleCurves();
    else if (act === 'copy') copyEq();
    else if (act === 'paste') openPaste();
    else if (act === 'clear') clearBands();
  }

  /* ---------- Views of the graph, and the theme ---------- */

  function toggleCurves() {
    curves = !curves;
    $('curves').setAttribute('aria-pressed', String(curves));
    invalidate();
  }

  function toggleInspect() {
    inspect = !inspect;
    $('inspect').setAttribute('aria-pressed', String(inspect));
    invalidate();
  }

  function fit() {
    zoom = null;
    zoomRoll = 0;
    invalidate();
  }

  const THEMES = [null, 'light', 'dark'];
  const THEME_WORDS = { null: ['as the system', 'i-auto'], light: ['light', 'i-sun'], dark: ['dark', 'i-moon'] };

  function syncTheme() {
    const [words, icon] = THEME_WORDS[window.Q2Theme.picked];
    const button = $('theme');
    button.setAttribute('aria-label', `Theme: ${words}`);
    button.title = `Theme: ${words}`;
    button.querySelector('use').setAttribute('href', `#${icon}`);
  }

  function nextTheme() {
    const now = THEMES.indexOf(window.Q2Theme.picked);
    window.Q2Theme.pick(THEMES[(now + 1) % THEMES.length]);
    syncTheme();
    readColours();
    invalidate();
    toast(`Theme: ${THEME_WORDS[window.Q2Theme.picked][0]}.`);
  }

  /* ---------- Keys ---------- */

  const modalOpen = () => !!document.querySelector('dialog[open]');

  // The band the keys act on: the one under the mouse, on the graph or in the table, or the picked one.
  const keyBand = () => (keyPicked ? picked : graphHover >= 0 ? graphHover : rowHover >= 0 ? rowHover : picked);

  function onKey(event) {
    const command = (event.ctrlKey || event.metaKey) && !event.altKey;
    if ($('app').inert || modalOpen()) {
      // Not the browser's Save page or Open over the page, either.
      if (command && /^[so]$/i.test(event.key)) event.preventDefault();
      return;
    }
    if (event.defaultPrevented || event.isComposing) return;
    // Through a drag, Esc alone: it puts the band back.
    if (drag || pinch) {
      if (event.key === 'Escape' && cancelDrag()) event.preventDefault();
      return;
    }
    const target = event.target;
    const key = event.key;
    // AltGr, on Windows Ctrl and Alt both, types [ and ] on many keyboards.
    const altGr = event.getModifierState?.('AltGraph');
    if ((event.ctrlKey || event.metaKey) && !altGr) {
      if (event.altKey) return;
      const letter = key.toLowerCase();
      // A band's box is the app's: its undo is the app's, not the box's text.
      const box = target.classList?.contains('tin');
      const typing = typingIn(target) && !box;
      const boxBand = box && preset.bands[indexOf(target)];
      if (boxBand && letter === 'z' && !event.shiftKey
        && target.value !== decimals(boxBand[target.dataset.field], FIELD_DIGITS[target.dataset.field])) {
        // Half-typed: the first Ctrl+Z drops the typing, as the box's own would.
        target.value = decimals(boxBand[target.dataset.field], FIELD_DIGITS[target.dataset.field]);
        target.select();
        event.preventDefault();
        return;
      }
      if (letter === 's' && !event.shiftKey) openSave();
      else if (letter === 'o' && !event.shiftKey) $('fileIn').click();
      else if (typing || (box && letter === 'c')) return;
      else if (letter === 'z' && !event.shiftKey) undo();
      else if (letter === 'y' || (letter === 'z' && event.shiftKey)) redo();
      else if (letter === 'c' && !event.shiftKey && !String(window.getSelection()).trim()) copyEq();
      else return;
      event.preventDefault();
      if (box) {
        // What the undo left in it, the next paint leaving a focused box alone.
        const band = preset.bands[indexOf(target)];
        if (band) target.value = decimals(band[target.dataset.field], FIELD_DIGITS[target.dataset.field]);
        target.select();
      }
      return;
    }
    if ((event.altKey && !altGr) || typingIn(target) || !$('moreMenu').hidden) return;
    if (key === 'Escape') {
      if (inspect) toggleInspect();
      return;
    }
    // The tabs, the list and search anywhere; the rest is the graph's, and a phone's Presets and Card
    // have none.
    if (!wide.matches && view !== 'eq' && !['1', '2', '3', '?', '/'].includes(key)) return;
    // Space where nothing else takes it, the page or the graph. The arrows there too, or on a plain
    // button a click left focused, when the graph is under the mouse or the EQ tab beside it; else
    // they scroll.
    const free = target === document.body || target === $('graph') || target === document.documentElement;
    const plain = free || (target.tagName === 'BUTTON' && !target.getAttribute('role'));
    const arrows = target === $('graph') || (plain && (mouse || (wide.matches && view === 'eq')));
    const band = keyBand();
    const once = !event.repeat;
    const fine = event.shiftKey;
    const nudgeKey = `key:${band}:${key}`;
    switch (key) {
      case '1': case '2': case '3': show(VIEWS[Number(key) - 1]); break;
      case '?': if (once) $('dlgKeys').showModal(); break;
      case '/': show('presets'); $('search').focus(); break;
      case ' ': if (!free) return; if (once) toggleInspect(); break;
      case 'q': case 'Q': case 'w': case 'W': case 'e': case 'E':
        if (!preset.bands[band]) return;
        if (pa.knobOf(preset.bands[band])) {
          if (once) toast(`${KNOB_NAMES[pa.knobOf(preset.bands[band])]} is Poweramp's knob: it stays a shelf.`);
          break;
        }
        editBand(band, (b) => { b.type = { q: 'PK', w: 'LSC', e: 'HSC' }[key.toLowerCase()]; });
        break;
      case 'r': case 'R': case 't': case 'T':
        if (once) toast("The Q2's EQ has peaks and shelves, and no high- or low-pass.");
        break;
      case 's': case 'S':
        if (!once || !preset.bands[band]) return;
        editBand(band, (b) => { b.on = !b.on; });
        break;
      case 'd': case 'D': case 'Delete': case 'Backspace':
        if (!once) return;
        removeBand(band);
        break;
      case 'a': case 'A': case '+':
        if (!once) return;
        if (mouse && scale) addBand(Number(scale.freqAt(mouse.x).toPrecision(3)), Math.round(clamp(scale.gainAt(mouse.y), -eq.GAIN_MAX, eq.GAIN_MAX) * 10) / 10);
        else addBand();
        break;
      case 'b': case 'B': if (once) bypassAll(); break;
      case 'v': case 'V': if (once) toggleCurves(); break;
      case 'f': case 'F': if (once) fit(); break;
      case 'c': case 'C':
        if (!once) break;
        if (live.on) setMode(live.mode !== 'peq');
        else toast('EQ on and off is for a Q2 with live EQ.');
        break;
      case '[': case ']':
        if (!preset.bands.length) return;
        pick((picked + (key === ']' ? 1 : preset.bands.length - 1)) % preset.bands.length);
        keyPicked = true;
        break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': case ',': case '.': case '<': case '>':
        if ((key.startsWith('Arrow') && !arrows) || !preset.bands[band]) return;
        if (band !== picked) pick(band);
        nudge(band, key.startsWith('ArrowL') || key.startsWith('ArrowR') ? 'freq' : key.startsWith('Arrow') ? 'gain' : 'q',
          key === 'ArrowRight' || key === 'ArrowUp' || key === '.' || key === '>' ? 1 : -1, fine, nudgeKey);
        break;
      default: return;
    }
    event.preventDefault();
  }

  // A held key is one step; let go, the next press is another.
  function onKeyUp() {
    if (steps.key?.startsWith('key:')) steps.key = null;
  }

  /* ---------- The table's boxes ---------- */

  const rowOf = (element) => element.closest?.('#tbody .trow');
  const indexOf = (element) => Number(rowOf(element)?.dataset.index ?? -1);

  function tableChange(event) {
    const target = event.target;
    const index = indexOf(target);
    if (index < 0 || !preset.bands[index]) return;
    if (target.classList.contains('tsw')) {
      editBand(index, (band) => { band.on = target.checked; });
    } else if (target.classList.contains('tsel')) {
      editBand(index, (band) => { band[target.dataset.field] = target.value; });
    } else if (target.classList.contains('tin')) {
      const field = target.dataset.field;
      const value = readNumber(target.value, field === 'freq');
      if (value !== null) setField(index, field, value);
      target.value = decimals(preset.bands[index][field], FIELD_DIGITS[field]);
    }
  }

  function tableKey(event) {
    const target = event.target;
    if (!target.classList.contains('tin') || target.readOnly || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = indexOf(target);
    const field = target.dataset.field;
    const band = preset.bands[index];
    if (!band) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const typed = readNumber(target.value, field === 'freq') ?? band[field];
      setField(index, field, stepped(field, typed, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey), `key:box:${index}:${field}`);
      target.value = decimals(preset.bands[index][field], FIELD_DIGITS[field]);
      target.select();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      tableChange(event);
      const rows = $('tbody').children;
      const next = rows[index + (event.shiftKey ? -1 : 1)]?.querySelector(`[data-field=${field}]`);
      if (next) next.focus();
      else target.select();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      target.value = decimals(band[field], FIELD_DIGITS[field]);
      target.blur();
    }
  }

  /* ---------- Events ---------- */

  function bind() {
    const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
    for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.view));
    // The tabs as a tab list: the arrows go along it.
    document.querySelector('.tabs').addEventListener('keydown', (event) => {
      const go = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!go) return;
      event.preventDefault();
      event.stopPropagation();
      const next = tabs[(tabs.indexOf(document.activeElement) + go + tabs.length) % tabs.length];
      show(next.dataset.view);
      next.focus();
    });

    const canvas = $('graph');
    canvas.addEventListener('pointerdown', graphDown);
    canvas.addEventListener('pointermove', graphMove);
    canvas.addEventListener('pointerup', graphUp);
    canvas.addEventListener('pointercancel', graphUp);
    canvas.addEventListener('pointerleave', graphLeave);
    canvas.addEventListener('wheel', graphWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    $('undo').addEventListener('click', undo);
    $('redo').addEventListener('click', redo);
    $('curves').addEventListener('click', toggleCurves);
    $('inspect').addEventListener('click', toggleInspect);
    $('fit').addEventListener('click', fit);
    $('compare').addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (button) setMode(button.dataset.value === 'on');
    });
    $('add').addEventListener('click', () => addBand());
    $('sort').addEventListener('click', sortBands);
    $('strip').addEventListener('click', (event) => {
      const chip = event.target.closest('.band-chip');
      if (chip) pick(Number(chip.dataset.index));
    });

    $('more').addEventListener('click', () => ($('moreMenu').hidden ? openMenu() : closeMenu()));
    $('moreMenu').addEventListener('click', (event) => {
      const item = event.target.closest('[data-act]');
      if (item) menuAct(item.dataset.act);
    });
    $('moreMenu').addEventListener('keydown', menuKey);
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#moreMenu, #more')) closeMenu();
    });

    const body = $('tbody');
    body.addEventListener('change', tableChange);
    body.addEventListener('keydown', tableKey);
    body.addEventListener('focusin', (event) => {
      const index = indexOf(event.target);
      if (index >= 0) pick(index);
      if (event.target.classList.contains('tin')) event.target.select();
    });
    body.addEventListener('click', (event) => {
      const index = indexOf(event.target);
      if (index < 0) return;
      if (!event.target.closest('.tdel')) pick(index);
      else {
        const focused = document.activeElement === event.target.closest('.tdel');
        removeBand(index);
        syncTable();
        if (focused) (body.children[Math.min(index, body.children.length - 1)]?.querySelector('.tdel') ?? $('add')).focus();
      }
    });
    body.addEventListener('mouseover', (event) => {
      const index = indexOf(event.target);
      if (index !== rowHover) {
        rowHover = index;
        keyPicked = false;
        invalidate();
      }
    });
    body.addEventListener('mouseleave', () => {
      rowHover = -1;
      invalidate();
    });

    $('bandOn').addEventListener('change', (event) => editBand(picked, (band) => { band.on = event.target.checked; }));
    for (const name of ['type', 'channel']) {
      $(name).addEventListener('click', (event) => {
        const button = event.target.closest('[data-value]');
        if (button) editBand(picked, (band) => { band[name] = button.dataset.value; });
      });
    }
    $('del').addEventListener('click', () => removeBand(picked));
    $('preampMode').addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (!button) return;
      const auto = button.dataset.value === 'auto';
      commit({ ...preset, auto, preamp: auto ? preset.preamp : Number(eq.autoPreamp(preset).toFixed(1)) });
    });
    $('rate').addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (!button) return;
      rate = Number(button.dataset.value);
      invalidate();
    });
    $('reset').addEventListener('click', () => {
      picked = 0;
      if (commit({ ...eq.newPreset(), name: preset.name })) toast('Ten flat bands, as the Q2 resets to.', true);
    });

    const name = $('name');
    name.addEventListener('input', () => commit({ ...preset, name: name.value }, 'name'));
    name.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });
    name.addEventListener('blur', () => {
      steps.key = null;
      name.value = preset.name;
    });

    $('saveTop').addEventListener('click', openSave);
    $('noteSave').addEventListener('click', openSave);
    $('cardSave').addEventListener('click', openSave);
    $('retry').addEventListener('click', () => live.error?.retry?.());
    $('toastUndo').addEventListener('click', () => {
      undo();
      $('toast').hidden = true;
    });
    $('theme').addEventListener('click', nextTheme);
    $('keys').addEventListener('click', () => $('dlgKeys').showModal());
    $('keysClose').addEventListener('click', () => $('dlgKeys').close());

    $('search').addEventListener('input', renderPresets);
    $('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.target.blur(); });
    $('types').addEventListener('click', (event) => {
      const button = event.target.closest('[data-value]');
      if (!button) return;
      catalogue.type = button.dataset.value;
      renderPresets();
    });
    $('presetList').addEventListener('click', (event) => {
      const button = event.target.closest('.row');
      if (!button) return;
      const item = catalogue.items[Number(button.dataset.index)];
      if (load(eq.parse(item.text, item.name), 'from AutoEq')) {
        catalogue.chosen = item.index;
        markChosen();
      }
    });
    $('presetRetry').addEventListener('click', loadCatalogue);

    $('cardRefresh').addEventListener('click', readCard);
    $('cardList').addEventListener('click', (event) => {
      const open = event.target.closest('[data-file]');
      const remove = event.target.closest('[data-remove]');
      if (open) openCardFile(open.dataset.file);
      else if (remove) removeCardFile(remove.dataset.remove);
    });
    $('openFile').addEventListener('click', () => $('fileIn').click());
    $('fileIn').addEventListener('change', openPicked);
    $('export').addEventListener('click', exportEq);
    $('copy').addEventListener('click', copyEq);
    $('paste').addEventListener('click', openPaste);
    $('exports').addEventListener('click', (event) => {
      const row = event.target.closest('[data-export]');
      if (row) exportAs(row.dataset.export);
    });

    $('pasteIn').addEventListener('input', () => { $('pasteGo').disabled = !$('pasteIn').value.trim(); });
    $('pasteIn').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        pasteGo();
      }
    });
    $('pasteGo').addEventListener('click', pasteGo);
    $('pasteCancel').addEventListener('click', () => $('dlgPaste').close());

    $('saveName').addEventListener('input', syncSave);
    $('saveName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveGo();
      }
    });
    $('saveGo').addEventListener('click', saveGo);
    $('saveCancel').addEventListener('click', () => $('dlgSave').close());

    $('pinForm').addEventListener('submit', submitPin);
    $('pinIn').addEventListener('input', () => {
      const pin = $('pinIn').value.replace(/\D/g, '').slice(0, 6);
      if ($('pinIn').value !== pin) $('pinIn').value = pin;
      $('pinGo').disabled = pin.length !== 6;
      if (pin.length === 6) $('pinForm').requestSubmit();
    });

    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);

    // A preset's file dropped anywhere on the page opens.
    let over = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
    const files = (event) => hasFiles(event) && !$('app').inert && !modalOpen();
    const dropping = (on) => document.body.classList.toggle('dropping', on);
    document.addEventListener('dragenter', (event) => {
      if (!files(event)) return;
      over += 1;
      dropping(true);
    });
    document.addEventListener('dragleave', (event) => {
      if (!files(event)) return;
      over = Math.max(over - 1, 0);
      if (!over) dropping(false);
    });
    // A file let go anywhere is ours, so the browser doesn't open it in place of the page.
    document.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      over = 0;
      dropping(false);
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (files(event)) openFile(event.dataTransfer.files[0]);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') store();
      else if (live.known) readState();
    });
    window.addEventListener('pagehide', store);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      readColours();
      invalidate();
    });
    // Across 960px the page changes layout: what was laid out for the other one goes.
    // The tab's place, kept across 960px: a computer's tab scrolls in the sidebar, a phone's page as a whole.
    let viewTop = 0;
    document.addEventListener('scroll', (event) => {
      const box = scroller(view);
      if (event.target === (box ?? document)) viewTop = box ? box.scrollTop : window.scrollY;
    }, { capture: true, passive: true });
    wide.addEventListener('change', () => {
      const top = viewTop;
      requestAnimationFrame(() => {
        const box = scroller(view);
        if (box) box.scrollTop = top;
        else window.scrollTo(0, top);
      });
      closeMenu($('moreMenu').contains(document.activeElement));
      [stripPicked, rowPicked, rowHover] = [-1, -1, -1];
      for (const name of VIEWS) delete scrolls[name];
      invalidate();
    });
    new ResizeObserver(invalidate).observe(canvas);
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--top-h', `${Math.round($('top').getBoundingClientRect().height)}px`);
    }).observe($('top'));
  }

  readColours();
  preset = restore() ?? preset;
  makeControls();
  bind();
  syncTheme();
  if (typeof navigator.canShare === 'function') {
    $('exportLabel').textContent = 'Share';
    $('export').querySelector('use').setAttribute('href', '#i-share');
  }
  if (MAC) {
    const mac = (text) => text.replace('Ctrl+Shift+', '⇧⌘').replace('Ctrl+', '⌘');
    for (const key of document.querySelectorAll('kbd[data-mod]')) key.textContent = mac(key.textContent);
    for (const element of document.querySelectorAll('[title*="Ctrl+"]')) element.title = mac(element.title);
    for (const element of document.querySelectorAll('[aria-keyshortcuts*="Control+"]')) {
      element.setAttribute('aria-keyshortcuts', element.getAttribute('aria-keyshortcuts').replace('Control+', 'Meta+'));
    }
  }
  show(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'eq', true);
  readState(true);
})();
