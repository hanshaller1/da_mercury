// Plate reverb after the classic figure-of-eight tank topology described by
// J. Dattorro ("Effect Design Part 1", JAES 1997), extended with 3-band decay
// filters, continuous size scaling and stereo input.

import { Allpass, DelayLine, BandDecay, decayGain, fastSin, clamp } from './primitives.js';

const DS = 29761; // reference sample rate of the original tap table
const SCALE_MIN = 0.45;
const SCALE_RANGE = 1.0; // 0.45 .. 1.45
const SCALE_MAX = SCALE_MIN + SCALE_RANGE;

export class Plate {
  constructor(sr) {
    this.sr = sr;
    const k = (this.k = sr / DS);
    const m = k * SCALE_MAX;
    this.inLen = [142, 107, 379, 277];
    this.inAp = this.inLen.map((l) => new Allpass(l * m + 4));
    this.preL = new DelayLine(64 * m + 8); // small offset so L/R inputs differ

    this.exc = 16 * k; // modulation excursion
    this.ap1 = new Allpass((672 + 90) * m);
    this.d1 = new DelayLine(4453 * m + 8);
    this.ap2 = new Allpass(1800 * m + 8);
    this.d2 = new DelayLine(3720 * m + 8);
    this.ap3 = new Allpass((908 + 90) * m);
    this.d3 = new DelayLine(4217 * m + 8);
    this.ap4 = new Allpass(2656 * m + 8);
    this.d4 = new DelayLine(3163 * m + 8);

    this.dampL = new BandDecay();
    this.dampR = new BandDecay();
    this.dampL.setCrossover(300, 4200, sr);
    this.dampR.setCrossover(300, 4200, sr);

    this.scale = 1;
    this.scaleTarget = 1;
    this.scaleCoef = 1 - Math.exp(-1 / (0.18 * sr));
    this.inG1 = 0.75;
    this.inG2 = 0.625;
    this.dd2 = 0.5;
    this.depth = 1;
    this.lfoPhase = 0;
    this.lfoInc = 0;
    this.oL = 0;
    this.oR = 0;
    this.baseGain = 1.42;
    this.gain = this.baseGain;
  }

  setControls(c) {
    this.scaleTarget = SCALE_MIN + c.size * SCALE_RANGE;
    const dn = 0.15 + 0.85 * c.diffusion;
    this.inG1 = 0.75 * dn;
    this.inG2 = 0.625 * dn;
    this.depth = c.modDepth * 2.2;
    this.lfoInc = c.modRate / this.sr;

    this.gain = this.baseGain * Math.sqrt(this.scale);
    const halfA = (672 + 4453 + 1800 + 3720) * this.k * this.scale;
    const halfB = (908 + 4217 + 2656 + 3163) * this.k * this.scale;
    if (c.freeze) {
      this.dampL.setGains(0.99999, 0.99999, 0.99999);
      this.dampR.setGains(0.99999, 0.99999, 0.99999);
      this.dd2 = 0.5;
    } else {
      const rt = c.rt;
      const rtLo = clamp(rt * c.loMult, 0.05, 200);
      const rtHi = clamp(rt * c.hiMult, 0.05, 200);
      const sr = this.sr;
      this.dampL.setGains(decayGain(halfA, rtLo, sr), decayGain(halfA, rt, sr), decayGain(halfA, rtHi, sr));
      this.dampR.setGains(decayGain(halfB, rtLo, sr), decayGain(halfB, rt, sr), decayGain(halfB, rtHi, sr));
      this.dd2 = clamp(decayGain(halfA, rt, sr) + 0.15, 0.25, 0.5);
    }
  }

  process(xL, xR) {
    const s = (this.scale += this.scaleCoef * (this.scaleTarget - this.scale)) * this.k;

    // stereo-ish input: R gets a tiny pre-offset before summing
    const rDel = this.preL.readLinear(37 * s + 1);
    this.preL.write(xR);
    let v = 0.5 * (xL + rDel);

    v = this.inAp[0].process(v, 142 * s, this.inG1);
    v = this.inAp[1].process(v, 107 * s, this.inG1);
    v = this.inAp[2].process(v, 379 * s, this.inG2);
    v = this.inAp[3].process(v, 277 * s, this.inG2);

    let ph = this.lfoPhase + this.lfoInc;
    if (ph >= 1) ph -= 1;
    this.lfoPhase = ph;
    const ex = this.exc * this.depth;
    const m1 = ex * fastSin(ph);
    const m2 = ex * fastSin(ph < 0.25 ? ph + 0.75 : ph - 0.25); // quadrature

    const d1out = this.d1.readHermite(4453 * s);
    const d2out = this.d2.readHermite(3720 * s);
    const d3out = this.d3.readHermite(4217 * s);
    const d4out = this.d4.readHermite(3163 * s);

    // left half of the tank
    let a = v + d4out;
    a = this.ap1.processMod(a, 672 * s + m1 + ex + 2, -0.7);
    this.d1.write(a);
    let b = this.dampL.process(d1out);
    b = this.ap2.processMod(b, 1800 * s, this.dd2);
    this.d2.write(b);

    // right half
    let c = v + d2out;
    c = this.ap3.processMod(c, 908 * s + m2 + ex + 2, -0.7);
    this.d3.write(c);
    let e = this.dampR.process(d3out);
    e = this.ap4.processMod(e, 2656 * s, this.dd2);
    this.d4.write(e);

    const yL =
      this.d1.readLinear(266 * s + 1) +
      this.d1.readLinear(2974 * s) -
      this.ap2.tap(1913 * s) +
      this.d2.readLinear(1996 * s) -
      this.d3.readLinear(1990 * s) -
      this.ap4.tap(187 * s + 1) -
      this.d4.readLinear(1066 * s);
    const yR =
      this.d3.readLinear(353 * s + 1) +
      this.d3.readLinear(3627 * s) -
      this.ap4.tap(1228 * s) +
      this.d4.readLinear(2673 * s) -
      this.d1.readLinear(2111 * s) -
      this.ap2.tap(335 * s) -
      this.d2.readLinear(121 * s + 1);

    this.oL = yL * 0.6 * this.gain;
    this.oR = yR * 0.6 * this.gain;
  }

  clear() {
    for (const a of this.inAp) a.clear();
    this.preL.clear();
    [this.ap1, this.ap2, this.ap3, this.ap4].forEach((x) => x.clear());
    [this.d1, this.d2, this.d3, this.d4].forEach((x) => x.clear());
    this.dampL.clear();
    this.dampR.clear();
    this.oL = this.oR = 0;
  }
}
