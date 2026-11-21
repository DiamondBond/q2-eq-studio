// EQ Studio's phone page: one preset, edited on a graph and in a band editor and sent to the Q2 as it
// changes (PUT /api/eq, one request at a time, only the newest waiting), with the AutoEq catalogue and
// the card's EQ folder. eq.js (window.Q2Eq) is the EQ model. The editing model (history steps, add,
// sort, the graph's scale, Auto's notes) follows tyleree's Q2 Theme Studio EQ tab.
(function () {
  'use strict';

  const eq = window.Q2Eq;
  const $ = (id) => document.getElementById(id);

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
  const VIEWS = ['eq', 'presets', 'card'];
  const UNREACHABLE = "Can't reach the Q2. Check that it's on, EQ Studio is open on it, and this phone is on the same Wi-Fi.";

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
  }

  function stepHistory(from, to) {
    if (!from.length || drag || pinch) return;
    to.push(JSON.stringify(preset));
    preset = JSON.parse(from.pop());
    picked = Math.min(picked, Math.max(preset.bands.length - 1, 0));
    steps.key = null;
    changed();
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
    const next = structuredClone(preset);
    next.bands.splice(index, 1);
    picked = Math.min(picked, Math.max(next.bands.length - 1, 0));
    if (commit(next)) toast(`Band ${index + 1} deleted.`, true);
  }

  function sortBands() {
    const next = structuredClone(preset);
    const chosen = next.bands[picked];
    next.bands.sort((a, b) => a.freq - b.freq);
    picked = Math.max(next.bands.indexOf(chosen), 0);
    commit(next);
  }

  // A preset in, replacing this one: Undo brings that back.
  function load(text, name, from) {
    const parsed = eq.parse(text, name);
    if (!parsed.ok) {
      notice("This preset couldn't be opened", `${parsed.error}. The Q2 would refuse it too.`);
      return false;
    }
    picked = 0;
    commit(parsed.preset);
    steps.key = null;
    const called = preset.name ? `“${preset.name}”` : 'The preset';
    toast(live.on ? `${called} is playing.` : `${called} is loaded ${from}.`, steps.past.length > 0);
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
      // What this phone kept is another EQ, so its name goes too.
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

  function readColours() {
    const style = getComputedStyle(document.documentElement);
    for (const key of ['grid', 'zero', 'axis', 'accent', 'accent-fill', 'on-accent', 'right', 'faint', 'text', 'graph-bg']) {
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

  function curve(context, points, key, colour, fill) {
    context.beginPath();
    points.forEach((point, index) => {
      const [x, y] = [scale.x(point.f), scale.y(point[key])];
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    if (fill) {
      context.save();
      context.lineTo(scale.x(eq.FREQ_MAX), scale.y(0));
      context.lineTo(scale.x(eq.FREQ_MIN), scale.y(0));
      context.closePath();
      context.globalAlpha *= fill;
      context.fillStyle = colour;
      context.fill();
      context.restore();
      context.beginPath();
      points.forEach((point, index) => {
        const [x, y] = [scale.x(point.f), scale.y(point[key])];
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
    }
    context.strokeStyle = colour;
    context.stroke();
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

    const [plotW, plotH] = [w - GAP.left - GAP.right, h - GAP.top - GAP.bottom];
    const n = clamp(Math.round(plotW / 1.5), 120, 480);
    const points = [];
    for (let i = 0; i < n; i += 1) {
      const f = 10 ** (LOG_LOW + LOG_SPAN * i / (n - 1));
      points.push({ f, ...eq.response(preset, f, rate) });
    }
    const range = (drag || pinch) && scale ? scale.range : rangeFor(points);
    scale = {
      range,
      x: (f) => GAP.left + (Math.log10(f) - LOG_LOW) / LOG_SPAN * plotW,
      y: (gain) => GAP.top + (range - clamp(gain, -range, range)) / (2 * range) * plotH,
      freqAt: (x) => 10 ** (LOG_LOW + (x - GAP.left) / plotW * LOG_SPAN),
      gainAt: (y) => range - (y - GAP.top) / plotH * 2 * range,
    };

    // The grid.
    context.font = `500 11px ${font}`;
    context.textBaseline = 'middle';
    context.fillStyle = colours.axis;
    context.lineWidth = 1;
    context.strokeStyle = colours.grid;
    for (const f of FREQ_LINES) {
      const x = Math.round(scale.x(f)) + 0.5;
      context.beginPath();
      context.moveTo(x, GAP.top);
      context.lineTo(x, GAP.top + plotH);
      context.stroke();
    }
    // Labels from the right, each left out where it would touch the one after it.
    let room = Infinity;
    for (let index = FREQ_LINES.length - 1; index >= 0; index -= 1) {
      const [x, text] = [scale.x(FREQ_LINES[index]), axisHertz(FREQ_LINES[index])];
      const width = context.measureText(text).width;
      const left = index === FREQ_LINES.length - 1 ? x - width : index === 0 ? x : x - width / 2;
      if (left + width + 6 > room) continue;
      context.textAlign = 'left';
      context.fillText(text, left, h - GAP.bottom / 2);
      room = left;
    }
    for (let gain = -range; gain <= range; gain += RANGE_STEP) {
      const y = Math.round(scale.y(gain)) + 0.5;
      context.strokeStyle = gain ? colours.grid : colours.zero;
      context.beginPath();
      context.moveTo(GAP.left, y);
      context.lineTo(GAP.left + plotW, y);
      context.stroke();
      context.textAlign = 'right';
      context.fillText(gain > 0 ? `+${gain}` : `${gain}`.replace('-', '−'), GAP.left - 5, y);
    }

    // The curves: the picked band's own, then the whole EQ's, faded while the Q2 isn't playing it.
    context.save();
    context.lineJoin = 'round';
    if (live.on && live.mode !== 'peq') context.globalAlpha = 0.4;
    const band = preset.bands[picked];
    if (band?.on && band.gain) {
      const own = points.map((point) => ({ f: point.f, gain: eq.bandResponse(band, point.f, rate) }));
      context.lineWidth = 1.5;
      context.setLineDash([4, 4]);
      curve(context, own, 'gain', colours.faint, 0.18);
      context.setLineDash([]);
    }
    const split = points.some((point) => Math.abs(point.left - point.right) > 0.01);
    context.lineWidth = 2.5;
    if (split) {
      curve(context, points, 'right', colours.right);
      curve(context, points, 'left', colours.accent);
    } else {
      curve(context, points, 'left', colours.accent, 0.14);
    }
    context.restore();
    $('legend').hidden = !split;

    // The dots, the picked one last so it sits on top.
    const order = preset.bands.map((_, index) => index).filter((index) => index !== picked);
    if (band) order.push(picked);
    context.textAlign = 'center';
    for (const index of order) {
      const item = preset.bands[index];
      const [x, y] = [scale.x(item.freq), scale.y(item.gain)];
      const colour = !item.on ? colours.faint : item.channel === 'R' ? colours.right : colours.accent;
      if (index === picked) {
        if (drag || pinch) {
          context.save();
          context.globalAlpha = 0.35;
          context.strokeStyle = colour;
          context.beginPath();
          context.moveTo(Math.round(x) + 0.5, GAP.top);
          context.lineTo(Math.round(x) + 0.5, GAP.top + plotH);
          context.moveTo(GAP.left, Math.round(y) + 0.5);
          context.lineTo(GAP.left + plotW, Math.round(y) + 0.5);
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

    // What a drag or a pinch is setting, where the finger isn't.
    const readout = $('readout');
    readout.hidden = !((drag || pinch) && band);
    if (!readout.hidden) {
      setText(readout, pinch ? `Band ${picked + 1} · Q ${decimals(band.q, [2, 3])}`
        : `Band ${picked + 1} · ${hertz(band.freq)} · ${signed(band.gain)} dB`);
      readout.classList.toggle('low', scale.y(band.gain) < GAP.top + 56);
    }
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

  // A tick under the finger, where the phone has one and the page may use it.
  const buzz = (event) => {
    if (event.pointerType === 'touch' && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
  };

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function graphDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
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
    if (index < 0) return;
    tap = null;
    pick(index);
    const { freq, gain } = preset.bands[index];
    drag = { index, key: `drag:${event.timeStamp}`, dx: scale.x(freq) - at.x, dy: scale.y(gain) - at.y };
    canvas.classList.add('dragging');
    buzz(event);
    invalidate();
  }

  function graphMove(event) {
    const canvas = $('graph');
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') canvas.classList.toggle('over-dot', dotAt(pointerAt(event), 'mouse') >= 0);
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
    const freq = Number(scale.freqAt(at.x + drag.dx).toPrecision(3));
    const gain = Math.round(scale.gainAt(at.y + drag.dy) * 10) / 10;
    editBand(drag.index, (band) => {
      band.freq = freq;
      band.gain = gain;
    }, drag.key);
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
    if (drag) {
      drag = null;
      steps.key = null;
      $('graph').classList.remove('dragging');
      invalidate();
    }
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

  function graphWheel(event) {
    if (!scale || !preset.bands.length) return;
    event.preventDefault();
    const over = dotAt(pointerAt(event), 'mouse');
    const index = over >= 0 ? over : picked;
    picked = index;
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    editBand(index, (band) => { band.q = +(band.q * factor).toFixed(2); }, `wheel:${index}`);
  }

  /* ---------- Painting the page ---------- */

  let frame = 0;
  let sideAt = 0;
  let stripPicked = -1;
  let view = 'eq';

  function invalidate() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function paint(now) {
    frame = 0;
    if (view === 'eq') drawGraph();
    syncStrip();
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
      const tags = `${band.channel === 'all' ? '' : ` ${band.channel}`}${band.type === 'LSC' ? ' · LS' : band.type === 'HSC' ? ' · HS' : ''}`;
      setText(chip.children[0], `${index + 1}${tags}`);
      setText(chip.children[1], shortHertz(band.freq));
      setText(chip.children[2], `${signed(band.gain)} dB`);
      chip.classList.toggle('off', !band.on);
      chip.setAttribute('aria-selected', String(index === picked));
      chip.setAttribute('aria-label', `Band ${index + 1}: ${TYPE_NAMES[band.type]}, ${hertz(band.freq)}, ${signed(band.gain)} dB`
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

  function syncBand() {
    const band = preset.bands[picked];
    $('bandEmpty').hidden = !!band;
    $('bandBody').hidden = !band;
    $('bandOn').closest('.switch').hidden = !band;
    $('del').hidden = !band;
    setText($('bandTitle'), band ? `Band ${picked + 1}` : 'Bands');
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
      else load(await response.text(), eq.nameOfFile(file), 'from the card');
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
    if (words) {
      $('saveError').textContent = words;
      $('saveError').hidden = false;
    }
  }

  async function openPhoneFile() {
    const file = $('fileIn').files[0];
    $('fileIn').value = '';
    if (!file) return;
    if (file.size > eq.FILE_MAX * 4) {
      notice("This preset couldn't be opened", `Line 1: file exceeds ${eq.FILE_MAX} bytes. The Q2 would refuse it too.`);
      return;
    }
    load(await file.text(), eq.nameOfFile(file.name), 'from the file');
  }

  // A file to keep or send: the share sheet where the browser has one for files, else a download.
  async function exportEq() {
    const name = eq.fileName(preset.name);
    const file = new File([eq.serialize(preset)], name, { type: 'text/plain' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (error) {
        if (error.name !== 'AbortError') toast("It couldn't be shared.");
      }
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast(`Downloaded ${name}.`);
  }

  /* ---------- Toasts and questions ---------- */

  let toastTimer = 0;

  function toast(text, undoable = false) {
    $('toastText').textContent = text;
    $('toastUndo').hidden = !undoable;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, undoable ? 5000 : 3800);
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

  function show(name, first = false) {
    if (!first) scrolls[view] = window.scrollY;
    view = name;
    for (const tab of document.querySelectorAll('.tabs [role=tab]')) {
      const on = tab.dataset.view === name;
      tab.setAttribute('aria-selected', String(on));
      $(`view-${tab.dataset.view}`).hidden = !on;
    }
    window.history.replaceState(null, '', name === 'eq' ? location.pathname : `#${name}`);
    window.scrollTo(0, scrolls[name] || 0);
    invalidate();
    if (name === 'presets') loadCatalogue();
    if (name === 'card') readCard();
  }

  /* ---------- Events ---------- */

  function bind() {
    for (const tab of document.querySelectorAll('.tabs [role=tab]')) tab.addEventListener('click', () => show(tab.dataset.view));

    const canvas = $('graph');
    canvas.addEventListener('pointerdown', graphDown);
    canvas.addEventListener('pointermove', graphMove);
    canvas.addEventListener('pointerup', graphUp);
    canvas.addEventListener('pointercancel', graphUp);
    canvas.addEventListener('wheel', graphWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    $('undo').addEventListener('click', undo);
    $('redo').addEventListener('click', redo);
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
      if (load(item.text, item.name, 'from AutoEq')) {
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
    $('fileIn').addEventListener('change', openPhoneFile);
    $('export').addEventListener('click', exportEq);

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

    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target.matches('input:not([type=range]), textarea')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) redo();
      else return;
      event.preventDefault();
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
    new ResizeObserver(invalidate).observe(canvas);
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--top-h', `${Math.round($('top').getBoundingClientRect().height)}px`);
    }).observe($('top'));
  }

  readColours();
  preset = restore() ?? preset;
  makeControls();
  bind();
  if (typeof navigator.canShare === 'function') {
    $('exportLabel').textContent = 'Share';
    $('export').querySelector('use').setAttribute('href', '#i-share');
  }
  show(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'eq', true);
  readState(true);
})();
