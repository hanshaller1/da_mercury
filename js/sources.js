// Procedurally generated demo material (no samples need to be shipped).
// Every demo leaves some silence at the end so the reverb tail can be heard.

import { mulberry32 } from './dsp/primitives.js';

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function makeBuffer(ctx, seconds) {
  const sr = ctx.sampleRate;
  const n = Math.round(seconds * sr);
  return { sr, n, L: new Float32Array(n), R: new Float32Array(n) };
}

function toAudioBuffer(ctx, b, gain = 1) {
  // normalise to a sensible peak
  let peak = 0;
  for (let i = 0; i < b.n; i++) peak = Math.max(peak, Math.abs(b.L[i]), Math.abs(b.R[i]));
  const g = peak > 0 ? (0.7 / peak) * gain : 1;
  const buf = ctx.createBuffer(2, b.n, b.sr);
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 0; i < b.n; i++) {
    l[i] = b.L[i] * g;
    r[i] = b.R[i] * g;
  }
  return buf;
}

function addMono(b, start, data, pan = 0) {
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const s0 = Math.round(start * b.sr);
  for (let i = 0; i < data.length && s0 + i < b.n; i++) {
    b.L[s0 + i] += data[i] * gl;
    b.R[s0 + i] += data[i] * gr;
  }
}

// ----------------------------------------------------------------- guitar
function pluck(sr, freq, dur, rand, bright = 0.5) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  // loop delay = L - 0.5 (two-point average) + frac (allpass) = sr / freq
  const D = sr / freq + 0.5;
  const L = Math.floor(D - 0.1);
  const frac = D - L;
  const c = (1 - frac) / (1 + frac);
  const buf = new Float32Array(L);
  // excitation: low-passed noise burst
  let lp = 0;
  for (let i = 0; i < L; i++) {
    lp += (0.25 + bright * 0.6) * (rand() * 2 - 1 - lp);
    buf[i] = lp;
  }
  const loss = Math.pow(0.001, 1 / (freq * 3.2));
  let idx = 0;
  let apY = 0;
  let apX = 0;
  let body = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx];
    const b = buf[idx + 1 < L ? idx + 1 : 0];
    const x = 0.5 * (a + b) * loss;
    const y = c * (x - apY) + apX;
    apX = x;
    apY = y;
    buf[idx] = y;
    idx = idx + 1 < L ? idx + 1 : 0;
    body += 0.35 * (a - body);
    out[i] = body;
  }
  for (let i = 0; i < 48 && i < n; i++) out[i] *= i / 48;
  const rel = Math.min(n, Math.round(sr * 0.05));
  for (let i = 0; i < rel; i++) out[n - 1 - i] *= i / rel;
  return out;
}

function guitar(ctx) {
  const b = makeBuffer(ctx, 14.5);
  const rand = mulberry32(7);
  const bpm = 92;
  const e8 = 60 / bpm / 2;
  const chords = [
    [45, 52, 57, 60, 64, 60, 57, 52], // Am
    [41, 48, 53, 57, 64, 57, 53, 48], // Fmaj7
    [48, 52, 55, 60, 64, 60, 55, 52], // C
    [43, 50, 55, 59, 62, 59, 55, 50], // G
  ];
  let t = 0.05;
  chords.forEach((ch, ci) => {
    ch.forEach((note, k) => {
      const last = ci === chords.length - 1 && k === ch.length - 1;
      const d = last ? 3 : 1.6;
      const v = 0.8 + rand() * 0.2;
      const data = pluck(b.sr, midi(note), d, rand, 0.35 + rand() * 0.3).map((x) => x * v);
      addMono(b, t + (rand() - 0.5) * 0.008, data, -0.25 + (k / 8) * 0.5);
      t += e8;
    });
  });
  return toAudioBuffer(ctx, b);
}

// ----------------------------------------------------------------- keys (FM e-piano)
function epiano(sr, freq, dur, vel) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 2.2) * (1 - Math.exp(-t * 400));
    const idx = 1.8 * vel * Math.exp(-t * 7);
    const mod = Math.sin(w * i) * idx;
    const tine = 0.18 * vel * Math.exp(-t * 14) * Math.sin(w * 7.1 * i);
    out[i] = env * (Math.sin(w * i + mod) + tine);
  }
  const rel = Math.min(n, Math.round(sr * 0.08));
  for (let i = 0; i < rel; i++) out[n - 1 - i] *= i / rel;
  return out;
}

function keys(ctx) {
  const b = makeBuffer(ctx, 13);
  const q = 60 / 84;
  // [beat, midi, length(beats)]
  const melody = [
    [0, 72, 0.9], [1, 76, 0.4], [1.5, 79, 0.4], [2, 81, 1.4], [3.5, 79, 0.4],
    [4, 76, 0.9], [5, 74, 0.9], [6, 72, 1.8],
    [8, 69, 0.9], [9, 72, 0.4], [9.5, 74, 0.4], [10, 76, 1.8], [12, 74, 0.4], [12.5, 72, 2.4],
  ];
  const bass = [[0, 48, 3.5], [4, 45, 3.5], [8, 41, 3.5], [12, 43, 3]];
  for (const [beat, note, len] of melody) addMono(b, 0.05 + beat * q, epiano(b.sr, midi(note), len * q + 0.25, 0.9), 0.15);
  for (const [beat, note, len] of bass) addMono(b, 0.05 + beat * q, epiano(b.sr, midi(note), len * q, 0.6).map((x) => x * 0.6), -0.15);
  return toAudioBuffer(ctx, b);
}

// ----------------------------------------------------------------- drums
function kick(sr) {
  const n = Math.round(0.45 * sr);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 45 + 95 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t * 7) + (i < 40 ? (1 - i / 40) * 0.5 : 0);
  }
  return out;
}

function snare(sr, rand, tone = 1) {
  const n = Math.round(0.3 * sr);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const noise = rand() * 2 - 1;
    lp += 0.12 * (noise - lp);
    const hp = noise - lp;
    const body = Math.sin(2 * Math.PI * 185 * tone * t) * Math.exp(-t * 30) * 0.8;
    out[i] = hp * Math.exp(-t * 16) * 0.9 + body;
  }
  return out;
}

function hat(sr, rand, open = false) {
  const n = Math.round((open ? 0.25 : 0.06) * sr);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const x = rand() * 2 - 1;
    const h = x - prev;
    prev = x;
    out[i] = h * Math.exp(-t * (open ? 14 : 70)) * 0.35;
  }
  return out;
}

function drums(ctx) {
  const b = makeBuffer(ctx, 12.5);
  const rand = mulberry32(11);
  const bpm = 96;
  const s16 = 60 / bpm / 4;
  const K = kick(b.sr);
  const pattern = {
    kick: [0, 6, 8, 10],
    snare: [4, 12],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
  };
  for (let bar = 0; bar < 4; bar++) {
    const t0 = 0.05 + bar * 16 * s16;
    for (const s of pattern.kick) addMono(b, t0 + s * s16, K, 0);
    for (const s of pattern.snare) addMono(b, t0 + s * s16, snare(b.sr, rand), 0.05);
    for (const s of pattern.hat) {
      if (bar === 3 && s > 8) continue;
      addMono(b, t0 + s * s16, hat(b.sr, rand, s === 14 && bar === 1), 0.3);
    }
  }
  // final hit with space for the tail
  const tEnd = 0.05 + 4 * 16 * s16;
  addMono(b, tEnd, K, 0);
  addMono(b, tEnd, snare(b.sr, rand), 0.05);
  return toAudioBuffer(ctx, b);
}

function snareHits(ctx) {
  const b = makeBuffer(ctx, 10);
  const rand = mulberry32(5);
  for (let k = 0; k < 4; k++) addMono(b, 0.05 + k * 2.4, snare(b.sr, rand), 0);
  return toAudioBuffer(ctx, b);
}

// ----------------------------------------------------------------- synth stabs
function stab(sr, notes, dur, rand) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const voices = [];
  for (const nt of notes) for (const det of [-0.08, 0.07]) voices.push({ f: midi(nt + det), ph: rand() });
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (const v of voices) {
      v.ph += v.f / sr;
      if (v.ph >= 1) v.ph -= 1;
      s += 2 * v.ph - 1;
    }
    s /= voices.length;
    const cutoff = 300 + 5200 * Math.exp(-t * 14);
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
    lp1 += a * (s - lp1);
    lp2 += a * (lp1 - lp2);
    const env = Math.min(1, t * 300) * Math.exp(-t * 5);
    out[i] = lp2 * env;
  }
  const rel = Math.min(n, Math.round(sr * 0.03));
  for (let i = 0; i < rel; i++) out[n - 1 - i] *= i / rel;
  return out;
}

function stabs(ctx) {
  const b = makeBuffer(ctx, 12);
  const rand = mulberry32(3);
  const beat = 60 / 100;
  const prog = [
    [57, 60, 64, 67],
    [53, 57, 60, 64],
    [55, 59, 62, 65],
    [52, 55, 59, 64],
  ];
  let t = 0.05;
  prog.forEach((ch) => {
    addMono(b, t, stab(b.sr, ch, 0.35, rand), -0.1);
    addMono(b, t + beat * 1.5, stab(b.sr, ch, 0.25, rand), 0.1);
    addMono(b, t + beat * 3, stab(b.sr, ch.map((x) => x + 12), 0.2, rand), 0.2);
    t += beat * 4;
  });
  return toAudioBuffer(ctx, b);
}

// ----------------------------------------------------------------- impulse
function impulse(ctx) {
  const b = makeBuffer(ctx, 6);
  // short band-limited click (Hann windowed)
  const len = 24;
  const click = new Float32Array(len);
  for (let i = 0; i < len; i++) click[i] = Math.sin((Math.PI * i) / len) ** 2 * (i < len / 2 ? 1 : -0.6);
  addMono(b, 0.05, click, 0);
  return toAudioBuffer(ctx, b, 1.2);
}

const GENERATORS = { guitar, keys, drums, stabs, snare: snareHits, impulse };
const cache = new Map();

export function getDemo(ctx, id) {
  const key = id + '@' + ctx.sampleRate;
  if (!cache.has(key)) cache.set(key, GENERATORS[id](ctx));
  return cache.get(key);
}
