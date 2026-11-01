import { ALGORITHMS, PARAMS, SWITCHES, defaultState, toNorm, fromNorm, formatValue } from './params.js';
import { FACTORY_PRESETS } from './presets.js';
import { Knob } from './ui/knob.js';
import { Display } from './ui/display.js';
import { getDemo } from './sources.js';
import { encodeWav, download } from './wav.js';
import { LiveInput } from './live-input.js';

const WORKLET_URL = new URL('./worklet/reverb-processor.js', import.meta.url);
// Hosted inside a sandboxed claude.ai artifact: no microphone, no .wav downloads
const EMBED = !!document.querySelector('meta[name="dam-embed"]');

async function loadWorklet(context) {
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    // some sandboxes refuse module URLs: retry from a blob of the same code
    const code = await (await fetch(WORKLET_URL)).text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(blobUrl);
  }
}
const LS_STATE = 'damercury.state.v1';
const LS_PRESETS = 'damercury.presets.v1';
const LS_LIVE = 'damercury.live.v1';
// switches that describe the setup rather than the sound: never stored in presets
const RIG_SWITCHES = ['bypass', 'freeze', 'killDry'];

// ======================================================================= state
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable – ignore */
    }
  },
};

function sanitizeState(s) {
  const def = defaultState();
  if (!s || typeof s !== 'object') return def;
  const out = def;
  if (ALGORITHMS.some((a) => a.id === s.algorithm)) out.algorithm = s.algorithm;
  for (const k of Object.keys(PARAMS)) {
    const v = s.params && s.params[k];
    if (typeof v === 'number' && Number.isFinite(v)) out.params[k] = Math.min(PARAMS[k].max, Math.max(PARAMS[k].min, v));
  }
  for (const k of Object.keys(SWITCHES)) {
    const v = s.switches && s.switches[k];
    if (typeof v === typeof SWITCHES[k]) out.switches[k] = v;
  }
  // transient switches never persist
  out.switches.bypass = false;
  out.switches.freeze = false;
  return out;
}

function presetToState(p) {
  const s = defaultState();
  s.algorithm = p.algorithm;
  Object.assign(s.params, p.params || {});
  Object.assign(s.switches, p.switches || {});
  return sanitizeState(s);
}

const saved = store.get(LS_STATE, null);
const state = saved ? sanitizeState(saved.state) : presetToState(FACTORY_PRESETS[1]);
let presetName = saved ? saved.presetName || 'Init' : FACTORY_PRESETS[1].name;
let presetRef = saved ? saved.presetRef || null : 'f:1';
let modified = false;
let userPresets = store.get(LS_PRESETS, []);
if (!Array.isArray(userPresets)) userPresets = [];

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(LS_STATE, { state, presetName, presetRef }), 300);
}

// ======================================================================= audio
let ctx = null;
let node = null;
let srcGain = null;
let inAnalyser = null;
let outAnalyser = null;
let recDest = null;
let recorder = null;
let recChunks = [];

let sourceKind = 'demo'; // demo | file | mic
let demoId = 'guitar';
let fileBuffer = null;
let fileLabel = '';
let playing = false;
let bufferNode = null;
let live = null; // LiveInput, created with the AudioContext
const livePrefs = Object.assign({ inputId: '', routing: '0-1', outputId: '' }, store.get(LS_LIVE, {}));

function send(partial, snap = false) {
  if (node) node.port.postMessage({ type: 'state', state: partial, snap });
}

async function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  await loadWorklet(ctx);
  node = new AudioWorkletNode(ctx, 'reverb-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { state: JSON.parse(JSON.stringify(state)) },
  });
  srcGain = ctx.createGain();
  inAnalyser = ctx.createAnalyser();
  outAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 2048;
  outAnalyser.fftSize = 4096;
  outAnalyser.smoothingTimeConstant = 0.6;
  srcGain.connect(node);
  srcGain.connect(inAnalyser);
  node.connect(ctx.destination);
  node.connect(outAnalyser);
  display.setAnalysers(inAnalyser, outAnalyser);
  ctx.onstatechange = () => {
    if (ctx.state === 'suspended') setPlaying(false);
  };
  live = new LiveInput(ctx, srcGain);
  live.routing = livePrefs.routing;
  live.onEnded = () => {
    toast('Das Eingangsgerät wurde getrennt.');
    if (sourceKind === 'mic') stop();
    live.close();
    refreshDevices();
  };
  if (livePrefs.outputId) setOutputDevice(livePrefs.outputId, true);
}

function stopBuffer() {
  if (bufferNode) {
    try {
      bufferNode.stop();
    } catch {
      /* already stopped */
    }
    bufferNode.disconnect();
    bufferNode = null;
  }
}

function stopMic() {
  if (live) live.close();
}

function currentBuffer() {
  if (sourceKind === 'demo') return getDemo(ctx, demoId);
  if (sourceKind === 'file') return fileBuffer;
  return null;
}

async function play() {
  await initAudio();
  if (ctx.state !== 'running') await ctx.resume();
  stopBuffer();
  if (sourceKind === 'mic') {
    if (EMBED || !LiveInput.supported()) {
      toast('Live-Eingänge sind hier nicht verfügbar. Bitte die App lokal starten.');
      return;
    }
    try {
      if (!live.stream) await openLiveInput(livePrefs.inputId);
      live.connect();
      setPlaying(true);
    } catch (err) {
      liveError(err);
      setPlaying(false);
    }
    return;
  }
  const buf = currentBuffer();
  if (!buf) {
    toast('Bitte zuerst eine Audiodatei wählen.');
    return;
  }
  bufferNode = ctx.createBufferSource();
  bufferNode.buffer = buf;
  bufferNode.loop = true;
  bufferNode.connect(srcGain);
  bufferNode.start();
  setPlaying(true);
}

function stop() {
  stopBuffer();
  if (live) live.disconnect();
  setPlaying(false);
}

// ======================================================================= live input
async function openLiveInput(deviceId) {
  try {
    await live.open(deviceId);
  } catch (err) {
    // a remembered device may be gone: fall back to the default input
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      livePrefs.inputId = '';
      await live.open('');
    } else {
      throw err;
    }
  }
  livePrefs.inputId = deviceId && live.deviceId === deviceId ? deviceId : livePrefs.inputId;
  livePrefs.routing = live.routing;
  store.set(LS_LIVE, livePrefs);
  await refreshDevices();
  renderRouting();
  renderLiveInfo();
}

function liveError(err) {
  const msg =
    err.name === 'NotAllowedError'
      ? 'Zugriff verweigert. Bitte den Audioeingang in den Browser-Einstellungen erlauben.'
      : err.name === 'NotFoundError'
        ? 'Kein Audioeingang gefunden. Ist das Interface angeschlossen?'
        : err.name === 'NotReadableError'
          ? 'Das Gerät wird gerade von einer anderen Anwendung blockiert.'
          : 'Eingang konnte nicht geöffnet werden: ' + err.message;
  toast(msg);
  $('#liveInfo').textContent = msg;
}

async function refreshDevices() {
  const { inputs, outputs } = await LiveInput.devices();
  const fill = (sel, list, current, defLabel, prefix) => {
    sel.innerHTML = '';
    sel.append(new Option(defLabel, ''));
    list.forEach((d, i) => sel.append(new Option(d.label || `${prefix} ${i + 1}`, d.deviceId)));
    sel.value = list.some((d) => d.deviceId === current) ? current : '';
  };
  fill($('#inputDevice'), inputs, livePrefs.inputId, 'Standard-Eingang', 'Eingang');
  fill($('#outputDevice'), outputs, livePrefs.outputId, 'Standard-Ausgang', 'Ausgang');
  $('#outputDeviceField').hidden = !(ctx ? LiveInput.canSelectOutput(ctx) : 'setSinkId' in AudioContext.prototype);
}

function renderRouting() {
  const sel = $('#inputRouting');
  sel.innerHTML = '';
  for (const o of live.routingOptions()) sel.append(new Option(o.label, o.value));
  sel.value = live.routing;
}

function renderLiveInfo() {
  if (!live || !live.stream) return;
  const st = live.settings;
  const parts = [live.label, live.channels === 1 ? '1 Kanal' : `${live.channels} Kanäle`];
  if (st.sampleRate) parts.push(`${(st.sampleRate / 1000).toFixed(1)} kHz`);
  parts.push(`Latenz ≈ ${live.latencyMs()} ms`);
  $('#liveInfo').textContent = parts.join(' · ');
}

async function setOutputDevice(id, silent = false) {
  if (!ctx || !LiveInput.canSelectOutput(ctx)) return;
  try {
    await ctx.setSinkId(id || '');
    livePrefs.outputId = id;
    store.set(LS_LIVE, livePrefs);
    if (!silent) toast('Ausgang gewechselt.');
    renderLiveInfo();
  } catch (err) {
    livePrefs.outputId = '';
    store.set(LS_LIVE, livePrefs);
    if (!silent) toast('Ausgang konnte nicht gewechselt werden: ' + err.message);
  }
}

function bindLiveInput() {
  $('#inputDevice').addEventListener('change', async (e) => {
    livePrefs.inputId = e.target.value;
    store.set(LS_LIVE, livePrefs);
    if (!ctx || !live.stream) return;
    try {
      await openLiveInput(livePrefs.inputId);
      toast('Eingang: ' + live.label);
    } catch (err) {
      liveError(err);
    }
  });
  $('#inputRouting').addEventListener('change', (e) => {
    livePrefs.routing = e.target.value;
    store.set(LS_LIVE, livePrefs);
    if (live) live.setRouting(e.target.value);
  });
  $('#outputDevice').addEventListener('change', async (e) => {
    livePrefs.outputId = e.target.value;
    store.set(LS_LIVE, livePrefs);
    await initAudio();
    setOutputDevice(e.target.value);
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices());
  }
  if (!EMBED) refreshDevices();
}

function setPlaying(p) {
  playing = p;
  const btn = $('#playBtn');
  btn.classList.toggle('playing', p);
  $('#playLabel').textContent = p ? 'Stop' : sourceKind === 'mic' ? 'Live' : 'Play';
}

// ======================================================================= UI helpers
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const display = new Display($('#display'), () => ({
  algorithm: state.algorithm,
  params: state.params,
  switches: state.switches,
  presetName: presetName + (modified ? ' *' : ''),
}));

// ======================================================================= knobs
const knobs = {};

function onKnobChange(key, value) {
  state.params[key] = value;
  send({ params: { [key]: value } });
  markModified();
  display.touch(key);
  if (key === 'predelay' || key === 'pitchInterval') renderChain();
}

function onKnobTouch(key) {
  display.touch(key);
}

function buildKnobs() {
  const main = $('#mainKnobs');
  for (const key of ['decay', 'mix', 'predelay', 'size']) {
    const k = new Knob(key, { big: true, onChange: onKnobChange, onTouch: onKnobTouch });
    knobs[key] = k;
    main.append(k.el);
  }
  for (const row of $$('[data-knobs]')) {
    for (const key of row.dataset.knobs.split(',')) {
      const k = new Knob(key, { onChange: onKnobChange, onTouch: onKnobTouch });
      knobs[key] = k;
      row.append(k.el);
    }
  }
}

// ======================================================================= algorithms
function buildAlgos() {
  const wrap = $('#algoButtons');
  for (const a of ALGORITHMS) {
    const b = document.createElement('button');
    b.className = 'algo-btn';
    b.textContent = a.name;
    b.dataset.algo = a.id;
    b.setAttribute('role', 'radio');
    b.title = a.desc;
    b.addEventListener('click', () => setAlgorithm(a.id));
    wrap.append(b);
  }
}

function setAlgorithm(id) {
  if (state.algorithm === id) return;
  state.algorithm = id;
  send({ algorithm: id });
  markModified();
  renderAlgo();
  renderChain();
  display.flash(ALGORITHMS.find((a) => a.id === id).name.toUpperCase());
}

function renderAlgo() {
  for (const b of $$('.algo-btn')) {
    const on = b.dataset.algo === state.algorithm;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  }
  $('#algoDesc').textContent = ALGORITHMS.find((a) => a.id === state.algorithm).desc;
}

// ======================================================================= switches
function setSwitch(key, value, { silentModify = false } = {}) {
  state.switches[key] = value;
  send({ switches: { [key]: value } });
  if (!silentModify && key !== 'bypass' && key !== 'freeze') markModified();
  renderSwitches();
  renderChain();
}

function renderSwitches() {
  const sw = state.switches;
  for (const t of $$('.led-toggle')) {
    const on = !!sw[t.dataset.switch];
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', on);
    const card = t.closest('.card');
    if (card) card.classList.toggle('off', !on);
  }
  for (const seg of $$('[data-switch-seg]')) {
    const key = seg.dataset.switchSeg;
    const v = typeof SWITCHES[key] === 'boolean' ? (sw[key] ? 1 : 0) : sw[key];
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.value) === v);
  }
  $('#bypassLed').classList.toggle('on', !sw.bypass);
  $('#holdLed').classList.toggle('on', sw.freeze);
  $('#trails').checked = sw.trails;
}

function bindSwitches() {
  for (const t of $$('.led-toggle')) {
    t.addEventListener('click', () => setSwitch(t.dataset.switch, !state.switches[t.dataset.switch]));
  }
  for (const seg of $$('[data-switch-seg]')) {
    const key = seg.dataset.switchSeg;
    for (const b of seg.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const v = Number(b.dataset.value);
        setSwitch(key, typeof SWITCHES[key] === 'boolean' ? v === 1 : v);
      });
    }
  }
  $('#trails').addEventListener('change', (e) => setSwitch('trails', e.target.checked));

  $('#bypassBtn').addEventListener('click', toggleBypass);

  // HOLD: tap = latch, press & hold = momentary
  const hold = $('#holdBtn');
  let downAt = 0;
  let wasOn = false;
  hold.addEventListener('pointerdown', (e) => {
    hold.setPointerCapture(e.pointerId);
    downAt = performance.now();
    wasOn = state.switches.freeze;
    if (!wasOn) setSwitch('freeze', true);
    hold.classList.add('pressed');
  });
  const up = () => {
    if (!downAt) return;
    const dt = performance.now() - downAt;
    downAt = 0;
    hold.classList.remove('pressed');
    if (wasOn || dt > 450) setSwitch('freeze', false);
  };
  hold.addEventListener('pointerup', up);
  hold.addEventListener('pointercancel', up);
  hold.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setSwitch('freeze', !state.switches.freeze);
    }
  });
}

function toggleBypass() {
  setSwitch('bypass', !state.switches.bypass);
  display.flash(state.switches.bypass ? 'BYPASS' : 'ON');
}

// ======================================================================= chain
const CHAIN = [
  { id: 'in', label: 'IN', fixed: true },
  { id: 'swell', label: 'SWELL', sw: 'swellOn', sub: () => formatValue('swell', state.params.swell) },
  { id: 'drive', label: 'DRIVE', sw: 'driveOn', sub: () => formatValue('drive', state.params.drive) },
  { id: 'predelay', label: 'PRE-DLY', fixed: true, sub: () => formatValue('predelay', state.params.predelay) },
  { id: 'pitch', label: 'PITCH', sw: 'pitchOn', sub: () => formatValue('pitchInterval', state.params.pitchInterval) + ' st' },
  { id: 'reverb', label: 'REVERB', core: true, sub: () => ALGORITHMS.find((a) => a.id === state.algorithm).name },
  { id: 'eq', label: 'EQ', sw: 'eqOn', sub: () => 'Lo/Hi Cut' },
  { id: 'duck', label: 'DUCK', sw: 'duckOn', sub: () => formatValue('duck', state.params.duck) },
  { id: 'out', label: 'OUT', fixed: true },
];

function buildChain() {
  const wrap = $('#chain');
  CHAIN.forEach((c, i) => {
    if (i > 0) {
      const a = document.createElement('div');
      a.className = 'chain-arrow';
      wrap.append(a);
    }
    const b = document.createElement('button');
    b.className = 'chain-block' + (c.core ? ' core' : '') + (c.fixed ? ' fixed' : '');
    b.dataset.chain = c.id;
    b.innerHTML = `${c.label}<span class="sub"></span>`;
    if (c.sw) {
      b.title = `${c.label} an/aus`;
      b.addEventListener('click', () => {
        setSwitch(c.sw, !state.switches[c.sw]);
        const card = document.querySelector(`.card[data-block="${c.id}"]`);
        if (card) {
          card.classList.add('flash');
          setTimeout(() => card.classList.remove('flash'), 500);
        }
      });
    } else {
      b.tabIndex = -1;
    }
    wrap.append(b);
  });
}

function renderChain() {
  for (const c of CHAIN) {
    const b = document.querySelector(`[data-chain="${c.id}"]`);
    if (!b) continue;
    if (c.sw) {
      b.classList.toggle('on', !!state.switches[c.sw]);
      b.setAttribute('aria-pressed', !!state.switches[c.sw]);
    } else if (c.fixed && c.id === 'predelay') {
      b.classList.add('on');
    }
    b.querySelector('.sub').textContent = c.sub ? c.sub() : c.id === 'in' ? 'Stereo' : 'Mix';
  }
}

// ======================================================================= full state
function applyState(s, { name, ref, snap = false } = {}) {
  state.algorithm = s.algorithm;
  Object.assign(state.params, s.params);
  // bypass, hold and kill-dry belong to the rig, not to the sound
  const keep = { bypass: state.switches.bypass, freeze: state.switches.freeze, killDry: state.switches.killDry };
  Object.assign(state.switches, s.switches, keep);
  send(JSON.parse(JSON.stringify(state)), snap);
  if (name !== undefined) {
    presetName = name;
    presetRef = ref || null;
    modified = false;
  }
  renderAll();
  persist();
}

function renderAll() {
  for (const [k, kn] of Object.entries(knobs)) kn.set(state.params[k]);
  renderAlgo();
  renderSwitches();
  renderChain();
  renderPresetSelect();
}

function markModified() {
  if (!modified) {
    modified = true;
    renderPresetSelect();
  }
  persist();
}

// ======================================================================= presets
function renderPresetSelect() {
  const sel = $('#presetSelect');
  sel.innerHTML = '';
  const gF = document.createElement('optgroup');
  gF.label = 'Factory';
  FACTORY_PRESETS.forEach((p, i) => gF.append(new Option(p.name, 'f:' + i)));
  sel.append(gF);
  if (userPresets.length) {
    const gU = document.createElement('optgroup');
    gU.label = 'Eigene';
    userPresets.forEach((p, i) => gU.append(new Option(p.name, 'u:' + i)));
    sel.append(gU);
  }
  if (!presetRef || modified) {
    const o = new Option(presetName + (modified ? ' *' : ''), 'cur');
    sel.prepend(o);
    sel.value = 'cur';
  } else {
    sel.value = presetRef;
  }
  $('#presetDelete').disabled = !(presetRef && presetRef.startsWith('u:'));
}

function allPresets() {
  return [
    ...FACTORY_PRESETS.map((p, i) => ({ ref: 'f:' + i, p })),
    ...userPresets.map((p, i) => ({ ref: 'u:' + i, p })),
  ];
}

function loadPresetRef(ref) {
  const [kind, idx] = ref.split(':');
  const p = kind === 'f' ? FACTORY_PRESETS[+idx] : userPresets[+idx];
  if (!p) return;
  applyState(presetToState(p), { name: p.name, ref });
  display.flash(p.name.toUpperCase().slice(0, 18));
}

function stepPreset(dir) {
  const list = allPresets();
  let i = list.findIndex((x) => x.ref === presetRef);
  if (i < 0) i = dir > 0 ? -1 : 0;
  i = (i + dir + list.length) % list.length;
  loadPresetRef(list[i].ref);
}

function currentAsPreset(name) {
  return {
    name,
    algorithm: state.algorithm,
    params: { ...state.params },
    switches: Object.fromEntries(Object.entries(state.switches).filter(([k]) => !RIG_SWITCHES.includes(k))),
  };
}

function bindPresets() {
  $('#presetSelect').addEventListener('change', (e) => {
    if (e.target.value !== 'cur') loadPresetRef(e.target.value);
  });
  $('#presetPrev').addEventListener('click', () => stepPreset(-1));
  $('#presetNext').addEventListener('click', () => stepPreset(1));

  const dlg = $('#saveDialog');
  $('#presetSave').addEventListener('click', () => {
    $('#saveName').value = presetRef && presetRef.startsWith('u:') ? presetName : '';
    dlg.showModal();
    $('#saveName').focus();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const name = $('#saveName').value.trim();
    if (!name) return;
    const existing = userPresets.findIndex((p) => p.name === name);
    const p = currentAsPreset(name);
    let idx;
    if (existing >= 0) {
      userPresets[existing] = p;
      idx = existing;
    } else {
      userPresets.push(p);
      idx = userPresets.length - 1;
    }
    store.set(LS_PRESETS, userPresets);
    presetName = name;
    presetRef = 'u:' + idx;
    modified = false;
    renderPresetSelect();
    persist();
    toast(`Preset „${name}“ gespeichert.`);
  });

  let deleteArmed = 0;
  $('#presetDelete').addEventListener('click', (e) => {
    if (!presetRef || !presetRef.startsWith('u:')) return;
    const idx = +presetRef.split(':')[1];
    const p = userPresets[idx];
    if (!p) return;
    const btn = e.currentTarget;
    if (!deleteArmed) {
      // two-step confirmation instead of confirm() (blocked in sandboxes)
      btn.textContent = 'Wirklich löschen?';
      deleteArmed = setTimeout(() => {
        deleteArmed = 0;
        btn.textContent = 'Löschen';
      }, 3000);
      return;
    }
    clearTimeout(deleteArmed);
    deleteArmed = 0;
    btn.textContent = 'Löschen';
    userPresets.splice(idx, 1);
    store.set(LS_PRESETS, userPresets);
    presetRef = null;
    modified = true;
    renderPresetSelect();
    toast('Preset gelöscht.');
  });

  $('#presetExport').addEventListener('click', () => {
    const p = currentAsPreset(presetName);
    const blob = new Blob([JSON.stringify({ format: 'damercury-preset', version: 1, preset: p }, null, 2)], {
      type: 'application/json',
    });
    download(blob, (presetName || 'preset').replace(/[^\w\- ]+/g, '').trim() + '.json').then((ok) => ok && toast('Preset exportiert.'));
  });

  $('#presetImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const list = Array.isArray(json) ? json : json.preset ? [json.preset] : json.presets || [json];
      let n = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const st = sanitizeState(raw);
        const name = String(raw.name || f.name.replace(/\.json$/i, '')).slice(0, 40);
        userPresets.push({ name, algorithm: st.algorithm, params: st.params, switches: currentSwitchesFrom(st) });
        n++;
      }
      if (!n) throw new Error('keine Presets gefunden');
      store.set(LS_PRESETS, userPresets);
      loadPresetRef('u:' + (userPresets.length - 1));
      toast(`${n} Preset(s) importiert.`);
    } catch (err) {
      toast('Import fehlgeschlagen: ' + err.message);
    }
  });
}

function currentSwitchesFrom(st) {
  return Object.fromEntries(Object.entries(st.switches).filter(([k]) => !RIG_SWITCHES.includes(k)));
}

// ======================================================================= morph (expression)
let snapA = null;
let snapB = null;

function bindMorph() {
  const slider = $('#morph');
  const update = () => {
    slider.disabled = !(snapA && snapB);
    $('#morphA').textContent = 'A: ' + (snapA ? snapA.name : '–');
    $('#morphB').textContent = 'B: ' + (snapB ? snapB.name : '–');
  };
  const take = () => ({
    name: presetName + (modified ? ' *' : ''),
    state: JSON.parse(JSON.stringify({ algorithm: state.algorithm, params: state.params, switches: state.switches })),
  });
  $('#snapA').addEventListener('click', () => {
    snapA = take();
    slider.value = 0;
    update();
    toast('Snapshot A gesetzt (Ferse).');
  });
  $('#snapB').addEventListener('click', () => {
    snapB = take();
    slider.value = 1000;
    update();
    toast('Snapshot B gesetzt (Spitze).');
  });
  slider.addEventListener('input', () => {
    if (!snapA || !snapB) return;
    const t = slider.value / 1000;
    const a = snapA.state;
    const b = snapB.state;
    const params = {};
    for (const k of Object.keys(PARAMS)) {
      if (PARAMS[k].curve === 'enum') params[k] = t < 0.5 ? a.params[k] : b.params[k];
      else params[k] = fromNorm(k, toNorm(k, a.params[k]) * (1 - t) + toNorm(k, b.params[k]) * t);
    }
    const src = t < 0.5 ? a : b;
    const switches = { ...src.switches, bypass: state.switches.bypass, freeze: state.switches.freeze, killDry: state.switches.killDry };
    state.algorithm = src.algorithm;
    Object.assign(state.params, params);
    Object.assign(state.switches, switches);
    send({ algorithm: state.algorithm, params, switches });
    for (const [k, kn] of Object.entries(knobs)) kn.set(state.params[k]);
    renderAlgo();
    renderSwitches();
    renderChain();
    markModified();
  });
  update();
}

// ======================================================================= transport
function bindTransport() {
  for (const tab of $$('.src-tab')) {
    tab.addEventListener('click', () => selectSource(tab.dataset.src));
  }
  $('#demoSelect').addEventListener('change', (e) => {
    demoId = e.target.value;
    if (playing && sourceKind === 'demo') play();
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadFile(f);
  });
  $('#playBtn').addEventListener('click', () => (playing ? stop() : play()));
  $('#panicBtn').addEventListener('click', () => {
    if (node) node.port.postMessage({ type: 'reset' });
    toast('Hall-Speicher geleert.');
  });
  $('#recBtn').addEventListener('click', toggleRecording);
  $('#renderBtn').addEventListener('click', renderOffline);

  // drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aiff?)$/i.test(x.name));
    if (f) loadFile(f);
    else toast('Bitte eine Audiodatei ablegen.');
  });
}

function selectSource(kind) {
  if (kind === sourceKind) return;
  const wasPlaying = playing;
  stop();
  if (kind !== 'mic') stopMic();
  sourceKind = kind;
  for (const t of $$('.src-tab')) t.classList.toggle('active', t.dataset.src === kind);
  for (const p of $$('.src-panel')) p.classList.toggle('hidden', p.dataset.panel !== kind);
  $('#renderBtn').disabled = kind === 'mic';
  setPlaying(false);
  if (wasPlaying && kind === 'demo') play();
  if (kind === 'file' && wasPlaying && fileBuffer) play();
}

async function loadFile(f) {
  await initAudio();
  try {
    const data = await f.arrayBuffer();
    fileBuffer = await ctx.decodeAudioData(data);
    fileLabel = f.name;
    $('#fileName').textContent = `${f.name} · ${fileBuffer.duration.toFixed(1)} s`;
    if (sourceKind !== 'file') selectSource('file');
    toast(`„${f.name}“ geladen.`);
    play();
  } catch (err) {
    toast('Datei konnte nicht dekodiert werden.');
    console.error(err);
  }
}

function toggleRecording() {
  if (!ctx) return toast('Erst Audio starten.');
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  if (!window.MediaRecorder) return toast('MediaRecorder wird von diesem Browser nicht unterstützt.');
  if (!recDest) {
    recDest = ctx.createMediaStreamDestination();
    node.connect(recDest);
  }
  const types = EMBED
    ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    : ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? (EMBED ? 'mp4' : 'm4a') : 'webm';
    $('#recBtn').classList.remove('recording');
    $('#recLabel').textContent = 'Aufnahme';
    download(new Blob(recChunks, { type }), `damercury-${Date.now()}.${ext}`).then((ok) => ok && toast('Aufnahme gespeichert.'));
  };
  recorder.start(250);
  $('#recBtn').classList.add('recording');
  $('#recLabel').textContent = 'Stopp';
}

async function renderOffline() {
  await initAudio();
  const buf = currentBuffer();
  if (!buf) return toast('Keine Quelle zum Rendern (Demo oder Datei wählen).');
  const btn = $('#renderBtn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Rendere…';
  try {
    const sr = ctx.sampleRate;
    const p = state.params;
    const tail = state.switches.freeze ? 8 : Math.min(40, p.decay * 1.4 + p.predelay / 1000 + 0.5);
    const length = Math.ceil((buf.duration + tail) * sr);
    const off = new OfflineAudioContext(2, length, sr);
    await loadWorklet(off);
    const st = JSON.parse(JSON.stringify(state));
    st.switches.bypass = false;
    const n = new AudioWorkletNode(off, 'reverb-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { state: st },
    });
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(n);
    n.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const base = sourceKind === 'file' ? fileLabel.replace(/\.[^.]+$/, '') : 'demo-' + demoId;
    if (await download(encodeWav(rendered), `${base}-${state.algorithm}.wav`)) toast('WAV (24 Bit) gerendert.');
  } catch (err) {
    console.error(err);
    toast('Rendern fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = sourceKind === 'mic';
    btn.textContent = label;
  }
}

// ======================================================================= keyboard
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#saveDialog').open) return;
    if (e.code === 'Space') {
      if (tag === 'button') return;
      e.preventDefault();
      playing ? stop() : play();
    } else if (e.key === 'b' || e.key === 'B') {
      toggleBypass();
    } else if (e.key === 'h' || e.key === 'H') {
      setSwitch('freeze', !state.switches.freeze);
    } else if (e.key === 'ArrowRight' && tag !== 'svg') {
      stepPreset(1);
    } else if (e.key === 'ArrowLeft' && tag !== 'svg') {
      stepPreset(-1);
    }
  });
}

// ======================================================================= boot
buildAlgos();
buildKnobs();
buildChain();
bindSwitches();
bindPresets();
bindMorph();
bindTransport();
bindKeys();
renderAll();
$('#renderBtn').disabled = false;
bindLiveInput();
if (EMBED) {
  document.body.classList.add('embed');
  $('#renderBtn').hidden = true;
}

$('#startBtn').addEventListener('click', async () => {
  $('#startOverlay').classList.add('gone');
  try {
    await initAudio();
    await play();
  } catch (err) {
    console.error(err);
    toast('Audio konnte nicht gestartet werden: ' + err.message);
  }
});

// expose for debugging / automated tests
window.__damercury = { state, get ctx() { return ctx; }, get node() { return node; } };
