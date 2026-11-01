// Basic DSP building blocks. Everything here is allocation-free in the
// per-sample path so it can run inside an AudioWorklet without GC pauses.

export const TWO_PI = Math.PI * 2;

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** Deterministic PRNG so that every instance sounds identical. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Sine lookup table (phase in [0, 1))
const SIN_SIZE = 4096;
const SIN_TABLE = new Float32Array(SIN_SIZE + 1);
for (let i = 0; i <= SIN_SIZE; i++) SIN_TABLE[i] = Math.sin((i / SIN_SIZE) * TWO_PI);

export function fastSin(phase) {
  const p = phase * SIN_SIZE;
  const i = p | 0;
  const f = p - i;
  const a = SIN_TABLE[i];
  return a + f * (SIN_TABLE[i + 1] - a);
}

/** Smooth saturator, ~linear below |x| < 0.5, bounded to ±1. */
export function softClip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------
/**
 * Circular delay line. Read before write: read(d) returns x[n - d] for d >= 1.
 */
export class DelayLine {
  constructor(maxDelay) {
    this.size = nextPow2(Math.ceil(maxDelay) + 8);
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
  }

  write(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  read(d) {
    return this.buf[(this.w - d) & this.mask];
  }

  /** Linear interpolation, d >= 1 */
  readLinear(d) {
    const di = d | 0;
    const f = d - di;
    const i = this.w - di;
    const a = this.buf[i & this.mask];
    const b = this.buf[(i - 1) & this.mask];
    return a + f * (b - a);
  }

  /** 4-point, 3rd-order Hermite interpolation, d >= 2 */
  readHermite(d) {
    const di = d | 0;
    const f = d - di;
    const i = this.w - di;
    const m = this.mask;
    const b = this.buf;
    const xm1 = b[(i + 1) & m];
    const x0 = b[i & m];
    const x1 = b[(i - 1) & m];
    const x2 = b[(i - 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  clear() {
    this.buf.fill(0);
  }
}

// ---------------------------------------------------------------------------
/** Schroeder allpass built around a delay line (lossless, |H| = 1). */
export class Allpass {
  constructor(maxDelay) {
    this.line = new DelayLine(maxDelay + 4);
  }

  /** fractional delay d (>= 1), linear interpolation */
  process(x, d, g) {
    const wd = this.line.readLinear(d);
    const w = x + g * wd;
    this.line.write(w);
    return wd - g * w;
  }

  /** modulated fractional delay (d >= 2), Hermite interpolation */
  processMod(x, d, g) {
    const wd = this.line.readHermite(d);
    const w = x + g * wd;
    this.line.write(w);
    return wd - g * w;
  }

  tap(d) {
    return this.line.readLinear(d);
  }

  clear() {
    this.line.clear();
  }
}

// ---------------------------------------------------------------------------
export class OnePoleLP {
  constructor() {
    this.z = 0;
    this.a = 1;
  }
  setFreq(f, sr) {
    this.a = 1 - Math.exp((-TWO_PI * f) / sr);
  }
  process(x) {
    this.z += this.a * (x - this.z);
    return this.z;
  }
  clear() {
    this.z = 0;
  }
}

export class DCBlocker {
  constructor(sr, f = 8) {
    this.r = Math.exp((-TWO_PI * f) / sr);
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
  clear() {
    this.x1 = this.y1 = 0;
  }
}

/** RBJ biquad, transposed direct form II. */
export class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  setLowpass(f, q, sr) {
    const w = (TWO_PI * clamp(f, 10, sr * 0.49)) / sr;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    this._set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
  }

  setHighpass(f, q, sr) {
    const w = (TWO_PI * clamp(f, 10, sr * 0.49)) / sr;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    this._set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  clear() {
    this.z1 = this.z2 = 0;
  }
}

// ---------------------------------------------------------------------------
/**
 * Three band decay filter (used inside feedback loops): splits the signal with
 * two one-pole low-passes into low / mid / high and applies a separate gain to
 * each band. With identical gains the bands sum back perfectly.
 */
export class BandDecay {
  constructor() {
    this.lo = 0;
    this.hi = 0;
    this.aLo = 0.03;
    this.aHi = 0.4;
    this.gL = 0;
    this.gM = 0;
    this.gH = 0;
  }
  setCrossover(fLo, fHi, sr) {
    this.aLo = 1 - Math.exp((-TWO_PI * fLo) / sr);
    this.aHi = 1 - Math.exp((-TWO_PI * fHi) / sr);
  }
  setGains(gL, gM, gH) {
    this.gL = gL;
    this.gM = gM;
    this.gH = gH;
  }
  process(x) {
    this.lo += this.aLo * (x - this.lo);
    this.hi += this.aHi * (x - this.hi);
    return this.gL * this.lo + this.gM * (this.hi - this.lo) + this.gH * (x - this.hi);
  }
  clear() {
    this.lo = this.hi = 0;
  }
}

/** Gain per pass for a loop of `len` samples so that it decays 60 dB in rt seconds. */
export function decayGain(len, rt, sr) {
  return Math.pow(10, (-3 * len) / (Math.max(rt, 0.02) * sr));
}

/** In-place normalised fast Walsh-Hadamard transform (orthogonal mixing matrix). */
export function hadamard(a, n) {
  for (let h = 1; h < n; h <<= 1) {
    for (let i = 0; i < n; i += h << 1) {
      for (let j = i; j < i + h; j++) {
        const x = a[j];
        const y = a[j + h];
        a[j] = x + y;
        a[j + h] = x - y;
      }
    }
  }
  const s = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i++) a[i] *= s;
}

/** Sign of entry (row, col) of the Sylvester Hadamard matrix. */
export function hadamardSign(row, col) {
  let v = row & col;
  let c = 0;
  while (v) {
    c ^= 1;
    v &= v - 1;
  }
  return c ? -1 : 1;
}
