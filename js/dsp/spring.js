// Spring reverb: three "springs", each a feedback loop around a long cascade
// of first-order allpass filters. The allpass chain delays low frequencies
// more than high ones (dispersion), which turns every echo into the typical
// descending "chirp" of a real spring tank. Each round trip passes through the
// chain again, so later echoes get more and more smeared – like the real thing.

import { DelayLine, BandDecay, OnePoleLP, decayGain, clamp, fastSin, mulberry32 } from './primitives.js';

const STAGES = 48;
const SCALE_MIN = 0.5;
const SCALE_RANGE = 1.0;

class SpringLine {
  constructor(sr, lenMs, seed) {
    this.sr = sr;
    this.baseLen = (lenMs * sr) / 1000;
    this.line = new DelayLine(this.baseLen * (SCALE_MIN + SCALE_RANGE) + sr * 0.004 + 8);
    this.z = new Float64Array(STAGES);
    this.a = -0.65;
    this.fb = 0;
    this.frozen = false;
    this.lp = new OnePoleLP();
    this.lp.setFreq(4300, sr);
    this.hpZ = 0;
    this.hpA = 1 - Math.exp((-2 * Math.PI * 90) / sr);
    this.decay = new BandDecay();
    this.decay.setCrossover(250, 2500, sr);
    const r = mulberry32(seed);
    this.lfoPhase = r();
    this.lfoRate = 0.25 + r() * 0.5;
    this.lfoDepth = sr * 0.00035;
  }

  setControls(rt, loMult, hiMult, a, scale, freeze) {
    this.a = a;
    this.frozen = freeze;
    // effective loop length: delay + low frequency group delay of the chain
    const len = this.baseLen * scale + (STAGES * (1 - a)) / (1 + a) * 0.5;
    if (freeze) {
      this.decay.setGains(0.99999, 0.99999, 0.99999);
    } else {
      const sr = this.sr;
      this.decay.setGains(
        decayGain(len, clamp(rt * loMult, 0.05, 200), sr),
        decayGain(len, rt, sr),
        decayGain(len, clamp(rt * hiMult, 0.05, 200), sr),
      );
    }
  }

  process(x, scale, inc) {
    let v = x + this.fb;
    // dispersion: cascade of 1st order allpasses (TDF-II)
    const a = this.a;
    const z = this.z;
    for (let m = 0; m < STAGES; m++) {
      const y = a * v + z[m];
      z[m] = v - a * y;
      v = y;
    }
    if (!this.frozen) {
      v = this.lp.process(v);
      // a little high-pass in the loop: springs do not carry deep bass
      this.hpZ += this.hpA * (v - this.hpZ);
      v -= this.hpZ;
    }
    this.line.write(v);

    let ph = this.lfoPhase + inc * this.lfoRate;
    if (ph >= 1) ph -= 1;
    this.lfoPhase = ph;
    const out = this.line.readHermite(this.baseLen * scale + this.lfoDepth * (1.2 + fastSin(ph)));
    let fb = this.decay.process(out);
    if (fb > 3) fb = 3 + Math.tanh(fb - 3);
    else if (fb < -3) fb = -3 + Math.tanh(fb + 3);
    this.fb = fb;
    return out;
  }

  clear() {
    this.line.clear();
    this.z.fill(0);
    this.fb = 0;
    this.lp.clear();
    this.hpZ = 0;
    this.decay.clear();
  }
}

export class Spring {
  constructor(sr) {
    this.sr = sr;
    this.springs = [new SpringLine(sr, 33.1, 1), new SpringLine(sr, 41.3, 2), new SpringLine(sr, 37.7, 3)];
    this.scale = 1;
    this.scaleTarget = 1;
    this.scaleCoef = 1 - Math.exp(-1 / (0.2 * sr));
    this.inc = 0;
    this.oL = 0;
    this.oR = 0;
    this.baseGain = 0.76;
    this.gain = this.baseGain;
  }

  setControls(c) {
    this.scaleTarget = SCALE_MIN + c.size * SCALE_RANGE;
    const a = -(0.5 + 0.32 * c.diffusion); // more "diffusion" = more chirp
    this.inc = (0.2 + c.modRate) / this.sr;
    this.gain = this.baseGain * Math.sqrt(this.scale / 1.05);
    for (const s of this.springs) {
      s.lfoDepth = this.sr * 0.0006 * c.modDepth;
      // the loop filters add some extra loss, compensate so the decay time matches
      s.setControls(c.rt * 1.3, c.loMult, c.hiMult, a, this.scale, c.freeze);
    }
  }

  process(xL, xR) {
    const scale = (this.scale += this.scaleCoef * (this.scaleTarget - this.scale));
    const x = 0.5 * (xL + xR);
    const s1 = this.springs[0].process(x, scale, this.inc);
    const s2 = this.springs[1].process(x, scale, this.inc);
    const s3 = this.springs[2].process(x, scale, this.inc);
    this.oL = (s1 + 0.55 * s3) * this.gain;
    this.oR = (s2 - 0.55 * s3) * this.gain;
  }

  clear() {
    for (const s of this.springs) s.clear();
    this.oL = this.oR = 0;
  }
}
