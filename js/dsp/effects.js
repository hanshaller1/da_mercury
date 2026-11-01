// Auxiliary processors: pitch shifter (shimmer), reverse buffer, early
// reflections and envelope followers.

import { DelayLine, OnePoleLP, mulberry32 } from './primitives.js';

/**
 * Two-head delay-line pitch shifter with Hann cross-fades (sum of windows = 1).
 */
export class PitchShifter {
  constructor(sr, windowMs = 70) {
    this.win = (windowMs * sr) / 1000;
    this.line = new DelayLine(this.win + 8);
    this.phase = 0;
    this.ratio = 2;
  }

  process(x) {
    this.line.write(x);
    let p = this.phase + (1 - this.ratio) / this.win;
    p -= Math.floor(p);
    this.phase = p;
    let p2 = p + 0.5;
    if (p2 >= 1) p2 -= 1;
    const w1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
    const w2 = 1 - w1;
    return w1 * this.line.readHermite(p * this.win + 2) + w2 * this.line.readHermite(p2 * this.win + 2);
  }

  clear() {
    this.line.clear();
  }
}

/**
 * Plays the incoming signal back in reversed chunks (two overlapping heads).
 * Applied to a reverb tail this produces swelling, "backwards" reverb.
 */
export class ReverseBuffer {
  constructor(sr, maxChunkSec = 1.6) {
    this.sr = sr;
    this.line = new DelayLine(2 * maxChunkSec * sr + 8);
    this.maxChunk = maxChunkSec * sr;
    this.nextChunk = 0.5 * sr;
    // two heads, each with its own chunk length (only updated when the head
    // wraps, i.e. while its window is silent -> length changes never click)
    this.T = new Float64Array([this.nextChunk, this.nextChunk]);
    this.pos = new Float64Array([0, this.nextChunk * 0.5]);
  }

  setChunk(sec) {
    this.nextChunk = Math.min(Math.max(sec * this.sr, 0.05 * this.sr), this.maxChunk);
  }

  process(x) {
    this.line.write(x);
    let y = 0;
    for (let h = 0; h < 2; h++) {
      const T = this.T[h];
      const p = this.pos[h];
      // head reads backwards: delay grows by 2 samples per sample
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * p) / T);
      y += w * this.line.readLinear(2 * p + 1);
      if (p + 1 >= T) {
        this.pos[h] = 0;
        this.T[h] = this.nextChunk;
      } else {
        this.pos[h] = p + 1;
      }
    }
    return y;
  }

  clear() {
    this.line.clear();
    this.pos[0] = 0;
    this.pos[1] = this.T[1] * 0.5;
  }
}

/**
 * Tapped-delay early reflections. Tap pattern is fixed, timing scales with
 * the room size and the per-algorithm spread.
 */
export class EarlyReflections {
  constructor(sr) {
    this.sr = sr;
    this.lineL = new DelayLine(0.35 * sr);
    this.lineR = new DelayLine(0.35 * sr);
    const rand = mulberry32(42);
    const n = 14;
    this.tapT = new Float64Array(n * 2); // ms at scale 1
    this.tapG = new Float64Array(n * 2);
    let norm = 0;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < n; i++) {
        const t = 3 + 70 * Math.pow((i + rand() * 0.8) / n, 1.4);
        const g = Math.exp(-t / 45) * (0.6 + 0.4 * rand()) * (rand() < 0.25 ? -1 : 1);
        this.tapT[ch * n + i] = t;
        this.tapG[ch * n + i] = g;
        norm += g * g;
      }
    }
    norm = 1 / Math.sqrt(norm / 2);
    for (let i = 0; i < n * 2; i++) this.tapG[i] *= norm;
    this.n = n;
    this.tapD = new Float64Array(n * 2);
    this.lpL = new OnePoleLP();
    this.lpR = new OnePoleLP();
    this.lpL.setFreq(7500, sr);
    this.lpR.setFreq(7500, sr);
    this.scale = 1;
    this.target = 1;
    this.coef = 1 - Math.exp(-1 / (0.15 * sr));
    this.oL = 0;
    this.oR = 0;
  }

  setScale(s) {
    this.target = Math.min(Math.max(s, 0.1), 4.5);
  }

  process(xL, xR) {
    this.lineL.write(xL);
    this.lineR.write(xR);
    this.scale += this.coef * (this.target - this.scale);
    const k = (this.scale * this.sr) / 1000;
    const n = this.n;
    let l = 0;
    let r = 0;
    for (let i = 0; i < n; i++) {
      // each side mostly hears its own channel plus a little cross-talk
      const dl = this.tapT[i] * k + 1;
      const dr = this.tapT[n + i] * k + 1;
      l += this.tapG[i] * (0.8 * this.lineL.readLinear(dl) + 0.2 * this.lineR.readLinear(dl));
      r += this.tapG[n + i] * (0.8 * this.lineR.readLinear(dr) + 0.2 * this.lineL.readLinear(dr));
    }
    this.oL = this.lpL.process(l);
    this.oR = this.lpR.process(r);
  }

  clear() {
    this.lineL.clear();
    this.lineR.clear();
    this.lpL.clear();
    this.lpR.clear();
    this.oL = this.oR = 0;
  }
}

export class EnvelopeFollower {
  constructor(sr, attackMs, releaseMs) {
    this.a = 1 - Math.exp(-1 / ((attackMs / 1000) * sr));
    this.r = 1 - Math.exp(-1 / ((releaseMs / 1000) * sr));
    this.env = 0;
  }
  process(x) {
    const c = x > this.env ? this.a : this.r;
    this.env += c * (x - this.env);
    return this.env;
  }
}
