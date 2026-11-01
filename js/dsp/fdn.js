// Feedback Delay Network reverb core (Room / Hall / Cathedral / Cloud).
//
//  in L/R -> input diffusers -> [N modulated delay lines] -> in-loop allpass
//         -> 3-band decay filter -> Hadamard mixing -> back into the lines
//
// The delay lengths are spread exponentially between minMs and maxMs and are
// scaled continuously by the "size" control (per-sample smoothing, so turning
// the size knob glides instead of clicking).

import {
  DelayLine,
  Allpass,
  decayGain,
  hadamard,
  hadamardSign,
  mulberry32,
  fastSin,
  clamp,
} from './primitives.js';

export const FDN_CONFIGS = {
  room: {
    lines: 8,
    minMs: 7,
    maxMs: 41,
    inDiff: [1.1, 1.7, 2.9, 4.1],
    loopAp: [0.9, 2.7],
    loopApG: 0.4,
    modMs: 0.25,
    gain: 0.93,
    seed: 3,
  },
  hall: {
    lines: 16,
    minMs: 21,
    maxMs: 97,
    inDiff: [1.3, 2.3, 3.7, 5.9],
    loopAp: [1.9, 6.7],
    loopApG: 0.5,
    modMs: 0.6,
    gain: 1.81,
    seed: 7,
  },
  cathedral: {
    lines: 16,
    minMs: 47,
    maxMs: 211,
    inDiff: [2.1, 3.3, 5.6, 8.9, 13.1],
    loopAp: [3.7, 11.3],
    loopApG: 0.55,
    modMs: 1.0,
    gain: 2.4,
    seed: 11,
  },
  cloud: {
    lines: 16,
    minMs: 37,
    maxMs: 173,
    inDiff: [4.7, 7.9, 12.3, 19.1, 27.7, 41.3],
    loopAp: [5.3, 17.9],
    loopApG: 0.62,
    modMs: 3.2,
    gain: 2.44,
    seed: 19,
  },
};

export const SIZE_MIN = 0.35;
export const SIZE_RANGE = 1.25; // scale = SIZE_MIN + size * SIZE_RANGE  (0.35 .. 1.6)
const SCALE_MAX = SIZE_MIN + SIZE_RANGE;

export class FDN {
  constructor(sr, cfg) {
    this.sr = sr;
    this.cfg = cfg;
    const N = (this.N = cfg.lines);
    const rand = mulberry32(cfg.seed);
    const ms = sr / 1000;

    // --- main delay lines
    this.baseLen = new Float64Array(N);
    this.lines = [];
    const modMax = cfg.modMs * 2 * ms;
    for (let i = 0; i < N; i++) {
      const t = N === 1 ? 0 : i / (N - 1);
      const jitter = 1 + (rand() - 0.5) * 0.1;
      const lenMs = cfg.minMs * Math.pow(cfg.maxMs / cfg.minMs, t) * jitter;
      this.baseLen[i] = lenMs * ms;
      this.lines.push(new DelayLine(this.baseLen[i] * SCALE_MAX + modMax + 8));
    }
    // interleave short and long lines so both inputs/outputs see the full spread
    const order = [];
    for (let i = 0; i < N / 2; i++) order.push(i, N - 1 - i);
    const tmpLen = order.map((k) => this.baseLen[k]);
    const tmpLines = order.map((k) => this.lines[k]);
    for (let i = 0; i < N; i++) {
      this.baseLen[i] = tmpLen[i];
      this.lines[i] = tmpLines[i];
    }

    // --- in-loop allpasses (density)
    this.apLen = new Float64Array(N);
    this.loopAps = [];
    for (let i = 0; i < N; i++) {
      const lenMs = cfg.loopAp[0] + rand() * (cfg.loopAp[1] - cfg.loopAp[0]);
      this.apLen[i] = lenMs * ms;
      this.loopAps.push(new Allpass(this.apLen[i] * SCALE_MAX + 4));
    }

    // --- input diffusers (per channel, slightly different lengths)
    this.inDiffLen = [[], []];
    this.inDiffL = [];
    this.inDiffR = [];
    for (const d of cfg.inDiff) {
      const l = d * ms;
      const r = d * ms * (1.07 + rand() * 0.06);
      this.inDiffLen[0].push(l);
      this.inDiffLen[1].push(r);
      this.inDiffL.push(new Allpass(l * SCALE_MAX + 4));
      this.inDiffR.push(new Allpass(r * SCALE_MAX + 4));
    }

    // --- state
    this.lo = new Float64Array(N);
    this.hi = new Float64Array(N);
    this.gL = new Float64Array(N);
    this.gM = new Float64Array(N);
    this.gH = new Float64Array(N);
    this.tmp = new Float64Array(N);
    this.lfoPhase = new Float64Array(N);
    this.lfoRateMul = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.lfoPhase[i] = rand();
      this.lfoRateMul[i] = 0.62 + rand() * 0.76;
    }

    // orthogonal in/out vectors (rows of the Hadamard matrix)
    this.injL = new Float64Array(N);
    this.injR = new Float64Array(N);
    this.outLv = new Float64Array(N);
    this.outRv = new Float64Array(N);
    const inNorm = 1 / Math.sqrt(N);
    const outNorm = 1 / Math.sqrt(N);
    for (let i = 0; i < N; i++) {
      this.injL[i] = hadamardSign(1, i) * inNorm;
      this.injR[i] = hadamardSign(2, i) * inNorm;
      this.outLv[i] = hadamardSign(N - 1, i) * outNorm;
      this.outRv[i] = hadamardSign(N - 2, i) * outNorm;
    }

    this.aLo = 1 - Math.exp((-2 * Math.PI * 280) / sr);
    this.aHi = 1 - Math.exp((-2 * Math.PI * 3200) / sr);

    // controls
    this.scale = 1;
    this.scaleTarget = 1;
    this.scaleCoef = 1 - Math.exp(-1 / (0.18 * sr));
    this.diffG = 0.6;
    this.loopG = 0.4;
    this.modDepth = 0;
    this.lfoInc = 0;
    this.inputGain = 1;

    this.oL = 0;
    this.oR = 0;
    this.gain = cfg.gain;
    this.refScale = SIZE_MIN + 0.55 * SIZE_RANGE;
  }

  /** c = {rt, loMult, hiMult, size, diffusion, modRate, modDepth, freeze} */
  setControls(c) {
    this.scaleTarget = SIZE_MIN + c.size * SIZE_RANGE;
    this.diffG = 0.72 * c.diffusion;
    this.loopG = this.cfg.loopApG * (0.25 + 0.75 * c.diffusion);
    this.modDepth = this.cfg.modMs * (this.sr / 1000) * c.modDepth;
    this.lfoInc = c.modRate / this.sr;

    const N = this.N;
    const sr = this.sr;
    const scale = this.scale;
    // output level normalisation: IR energy is proportional to rt / loop length
    this.gain = this.cfg.gain * Math.sqrt(scale / this.refScale);
    if (c.freeze) {
      for (let i = 0; i < N; i++) {
        this.gL[i] = this.gM[i] = this.gH[i] = 0.99999;
      }
    } else {
      const rt = c.rt;
      const rtLo = clamp(rt * c.loMult, 0.05, 200);
      const rtHi = clamp(rt * c.hiMult, 0.05, 200);
      for (let i = 0; i < N; i++) {
        const len = (this.baseLen[i] + this.apLen[i]) * scale;
        this.gM[i] = decayGain(len, rt, sr);
        this.gL[i] = decayGain(len, rtLo, sr);
        this.gH[i] = decayGain(len, rtHi, sr);
      }
    }
  }

  process(xL, xR) {
    // per-sample size smoothing
    const scale = (this.scale += this.scaleCoef * (this.scaleTarget - this.scale));
    const dScale = 0.5 + 0.5 * scale;

    // input diffusion
    const dg = this.diffG;
    for (let k = 0; k < this.inDiffL.length; k++) {
      xL = this.inDiffL[k].process(xL, this.inDiffLen[0][k] * dScale, dg);
      xR = this.inDiffR[k].process(xR, this.inDiffLen[1][k] * dScale, dg);
    }

    const N = this.N;
    const tmp = this.tmp;
    const lines = this.lines;
    const aLo = this.aLo;
    const aHi = this.aHi;
    const depth = this.modDepth;
    const inc = this.lfoInc;
    const lg = this.loopG;
    let oL = 0;
    let oR = 0;

    for (let i = 0; i < N; i++) {
      let ph = this.lfoPhase[i] + inc * this.lfoRateMul[i];
      if (ph >= 1) ph -= 1;
      this.lfoPhase[i] = ph;
      const d = this.baseLen[i] * scale + depth * (1 + fastSin(ph));
      let s = lines[i].readHermite(d < 2 ? 2 : d);
      s = this.loopAps[i].processMod(s, this.apLen[i] * scale, lg);

      oL += s * this.outLv[i];
      oR += s * this.outRv[i];

      const lo = (this.lo[i] += aLo * (s - this.lo[i]));
      const hi = (this.hi[i] += aHi * (s - this.hi[i]));
      tmp[i] = this.gL[i] * lo + this.gM[i] * (hi - lo) + this.gH[i] * (s - hi);
    }

    hadamard(tmp, N);

    for (let i = 0; i < N; i++) {
      let v = tmp[i] + xL * this.injL[i] + xR * this.injR[i];
      // safety: gentle limiting far above normal operating level
      if (v > 4) v = 4 + Math.tanh(v - 4);
      else if (v < -4) v = -4 + Math.tanh(v + 4);
      lines[i].write(v);
    }

    this.oL = oL * this.gain;
    this.oR = oR * this.gain;
  }

  clear() {
    for (const l of this.lines) l.clear();
    for (const a of this.loopAps) a.clear();
    for (const a of this.inDiffL) a.clear();
    for (const a of this.inDiffR) a.clear();
    this.lo.fill(0);
    this.hi.fill(0);
    this.oL = this.oR = 0;
  }
}
