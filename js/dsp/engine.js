// The complete stereo signal chain. Runs inside the AudioWorklet but has no
// Web-Audio dependencies, so it can be unit-tested and benchmarked in Node.
//
//  input ─┬───────────────────────────────────────────────────────┐ dry
//         └─ swell ─ drive ─ pre-delay ─ pitch ─┬─ early refl. ─┐  │
//                    ▲                          └──► reverb ◄───┘  │
//                    └──── shimmer feedback ◄──────── │            │
//                                          EQ ─ width ─ ducking ─ mix ─ output

import { FDN, FDN_CONFIGS } from './fdn.js';
import { Plate } from './plate.js';
import { Spring } from './spring.js';
import { PitchShifter, ReverseBuffer, EarlyReflections, EnvelopeFollower } from './effects.js';
import { DelayLine, Biquad, OnePoleLP, softClip, dbToGain } from './primitives.js';
import { defaultState, PITCH_INTERVALS } from '../params.js';

class ReverseReverb {
  constructor(sr) {
    this.fdn = new FDN(sr, { ...FDN_CONFIGS.hall, seed: 23, gain: 1 });
    this.revL = new ReverseBuffer(sr, 1.6);
    this.revR = new ReverseBuffer(sr, 1.6);
    this.oL = 0;
    this.oR = 0;
    this.gain = 2.22;
  }
  setControls(c) {
    this.fdn.setControls(c);
    const sec = 0.22 + c.size * 1.3;
    this.revL.setChunk(sec);
    this.revR.setChunk(sec * 1.03);
  }
  process(xL, xR) {
    this.fdn.process(xL, xR);
    this.oL = this.revL.process(this.fdn.oL) * this.gain;
    this.oR = this.revR.process(this.fdn.oR) * this.gain;
  }
  clear() {
    this.fdn.clear();
    this.revL.clear();
    this.revR.clear();
    this.oL = this.oR = 0;
  }
}

// how far apart the early reflections are spread for each algorithm
const ER_SPREAD = { room: 1.0, hall: 1.5, plate: 0.55, spring: 0.4, cathedral: 2.6, cloud: 2.0, reverse: 1.4 };

const SMOOTH_FAST = 0.012; // seconds
const SMOOTH_SLOW = 0.12;

export class ReverbEngine {
  constructor(sr) {
    this.sr = sr;
    this.algos = {
      room: new FDN(sr, FDN_CONFIGS.room),
      hall: new FDN(sr, FDN_CONFIGS.hall),
      plate: new Plate(sr),
      spring: new Spring(sr),
      cathedral: new FDN(sr, FDN_CONFIGS.cathedral),
      cloud: new FDN(sr, FDN_CONFIGS.cloud),
      reverse: new ReverseReverb(sr),
    };
    const st = defaultState();
    this.algorithm = st.algorithm;
    this.p = st.params;
    this.sw = st.switches;

    this.cur = this.algos[this.algorithm];
    this.curFade = 1;
    this.curFadeInc = 1 / (0.03 * sr);
    this.prev = null;
    this.prevGain = 0;
    this.prevDecay = Math.exp(-1 / (0.7 * sr));

    this.er = new EarlyReflections(sr);
    this.pdL = new DelayLine(1.05 * sr);
    this.pdR = new DelayLine(1.05 * sr);

    this.shL = new PitchShifter(sr, 73);
    this.shR = new PitchShifter(sr, 89);
    this.shHpL = new Biquad();
    this.shHpR = new Biquad();
    this.shLpL = new OnePoleLP();
    this.shLpR = new OnePoleLP();
    this.shHpL.setHighpass(220, 0.707, sr);
    this.shHpR.setHighpass(220, 0.707, sr);
    this.shLpL.setFreq(7000, sr);
    this.shLpR.setFreq(7000, sr);
    this.shEnv = new EnvelopeFollower(sr, 5, 250);
    this.lastWetL = 0;
    this.lastWetR = 0;

    this.driveLpL = new OnePoleLP();
    this.driveLpR = new OnePoleLP();
    this.driveLpL.setFreq(6000, sr);
    this.driveLpR.setFreq(6000, sr);

    this.hpL = new Biquad();
    this.hpR = new Biquad();
    this.lpL = new Biquad();
    this.lpR = new Biquad();
    this.eqLow = -1;
    this.eqHigh = -1;
    this.curLowCut = this.p.lowCut;
    this.curHighCut = this.p.highCut;

    this.envFast = new EnvelopeFollower(sr, 0.5, 40);
    this.envSlow = new EnvelopeFollower(sr, 60, 400);
    this.envDuck = new EnvelopeFollower(sr, 4, 280);
    this.swellPos = 1;
    this.swellArmed = true;

    // smoothed values: [current, target]
    this.s = {
      inGain: [1, 1],
      dry: [1, 1],
      wet: [0, 0],
      send: [1, 1],
      byp: [0, 0],
      out: [1, 1],
      width: [1, 1],
      pd: [1, 1],
      early: [0, 0],
      drive: [0, 0],
      driveAmt: [0, 0],
      swellOn: [0, 0],
      pitch: [0, 0],
      pitchRatio: [2, 2],
      duck: [0, 0],
      freeze: [0, 0],
      rtComp: [1, 1],
      thru: [1, 1],
    };
    this.kFast = 1 - Math.exp(-1 / (SMOOTH_FAST * sr));
    this.kSlow = 1 - Math.exp(-1 / (SMOOTH_SLOW * sr));
    this.kPd = 1 - Math.exp(-1 / (0.25 * sr));

    this._applyTargets(true);
  }

  // ------------------------------------------------------------------ API
  /** Partial state update. snap = true skips all parameter smoothing. */
  setState(state, snap = false) {
    if (state.params) Object.assign(this.p, state.params);
    if (state.switches) Object.assign(this.sw, state.switches);
    if (state.algorithm && state.algorithm !== this.algorithm) {
      this.setAlgorithm(state.algorithm);
      if (snap) {
        this.prev = null;
        this.curFade = 1;
      }
    }
    this._applyTargets(snap);
    if (snap) {
      this.curLowCut = this.sw.eqOn ? this.p.lowCut : 10;
      this.curHighCut = this.sw.eqOn ? this.p.highCut : Math.min(22000, this.sr * 0.45);
      for (const a of Object.values(this.algos)) {
        if (a.scaleTarget !== undefined) a.scale = a.scaleTarget;
        if (a.fdn) a.fdn.scale = a.fdn.scaleTarget;
      }
      this._updateControls();
    }
  }

  setAlgorithm(id) {
    if (!this.algos[id] || id === this.algorithm) return;
    // let the old tail ring out (spill-over) while the new one fades in
    this.prev = this.cur;
    this.prevGain = this.curFade;
    this.algorithm = id;
    this.cur = this.algos[id];
    if (this.cur === this.prev) this.prev = null;
    this.cur.clear();
    this.curFade = 0;
    this._updateControls();
  }

  /** Clears all reverb buffers (panic). */
  reset() {
    for (const a of Object.values(this.algos)) a.clear();
    this.er.clear();
    this.pdL.clear();
    this.pdR.clear();
    this.shL.clear();
    this.shR.clear();
    this.prev = null;
    this.lastWetL = this.lastWetR = 0;
  }

  // ------------------------------------------------------------- internals
  _applyTargets(snap) {
    const p = this.p;
    const sw = this.sw;
    const s = this.s;
    const mix = p.mix;
    s.inGain[1] = dbToGain(p.inputGain);
    s.dry[1] = sw.killDry ? 0 : Math.min(1, 2 * (1 - mix));
    s.thru[1] = sw.killDry ? 0 : 1;
    s.wet[1] = sw.bypass && !sw.trails ? 0 : Math.min(1, 2 * mix);
    s.send[1] = sw.bypass || sw.freeze ? 0 : 1;
    s.byp[1] = sw.bypass ? 1 : 0;
    s.out[1] = dbToGain(p.output);
    s.width[1] = p.width;
    s.pd[1] = Math.max(1, (p.predelay / 1000) * this.sr);
    s.early[1] = p.early;
    s.drive[1] = sw.driveOn ? 1 : 0;
    s.driveAmt[1] = 1 + p.drive * 30;
    s.swellOn[1] = sw.swellOn ? 1 : 0;
    s.pitch[1] = sw.pitchOn ? p.pitchAmount : 0;
    s.pitchRatio[1] = Math.pow(2, PITCH_INTERVALS[Math.round(p.pitchInterval)] / 12);
    s.duck[1] = sw.duckOn ? p.duck : 0;
    s.freeze[1] = sw.freeze ? 1 : 0;
    // long decays get louder by nature – tame that so the knob stays musical
    s.rtComp[1] = Math.sqrt(3.5 / (1.5 + p.decay));
    if (snap) for (const k in s) s[k][0] = s[k][1];
    this._updateControls();
  }

  _updateControls() {
    const p = this.p;
    const c = {
      rt: p.decay,
      loMult: p.loDecay,
      hiMult: p.hiDecay,
      size: p.size,
      diffusion: p.diffusion,
      modRate: p.modRate,
      modDepth: p.modDepth,
      freeze: this.sw.freeze,
    };
    this.ctl = c;
    this.prevCtl = this.prevCtl || { ...c };
    this.cur.setControls(c);
    this.er.setScale(ER_SPREAD[this.algorithm] * (0.3 + 1.0 * p.size));
  }

  _updateBlock() {
    // recompute decay gains (they depend on the smoothed size)
    this.cur.setControls(this.ctl);
    if (this.prev) {
      // spill-over tail: keep its current character but never let it grow
      const pc = this.prevCtl;
      Object.assign(pc, this.ctl);
      pc.freeze = false;
      pc.rt = Math.min(this.ctl.rt, 4);
      this.prev.setControls(pc);
    }
    // EQ (smoothed per block, recomputed only when needed)
    const sr = this.sr;
    const lowT = this.sw.eqOn ? this.p.lowCut : 10;
    const highT = this.sw.eqOn ? this.p.highCut : Math.min(22000, sr * 0.45);
    this.curLowCut += 0.25 * (lowT - this.curLowCut);
    this.curHighCut += 0.25 * (highT - this.curHighCut);
    if (Math.abs(this.curLowCut - this.eqLow) > this.eqLow * 0.002) {
      this.eqLow = this.curLowCut;
      this.hpL.setHighpass(this.eqLow, 0.707, sr);
      this.hpR.setHighpass(this.eqLow, 0.707, sr);
    }
    if (Math.abs(this.curHighCut - this.eqHigh) > this.eqHigh * 0.002) {
      this.eqHigh = this.curHighCut;
      this.lpL.setLowpass(Math.min(this.eqHigh, sr * 0.45), 0.707, sr);
      this.lpR.setLowpass(Math.min(this.eqHigh, sr * 0.45), 0.707, sr);
    }
    // pitch ratio changes once per block
    const pr = this.s.pitchRatio;
    pr[0] += 0.3 * (pr[1] - pr[0]);
    this.shL.ratio = pr[0];
    this.shR.ratio = pr[0];
  }

  /**
   * Process one block. inL/inR may be the same array (mono input).
   */
  process(inL, inR, outL, outR, n) {
    this._updateBlock();
    const s = this.s;
    const kF = this.kFast;
    const kS = this.kSlow;
    const kP = this.kPd;
    const sr = this.sr;
    const swellInc = 1 / ((this.p.swell / 1000) * sr);
    const swellDry = this.sw.swellDry;
    const pitchFeedback = this.sw.pitchMode === 0;
    const cur = this.cur;
    const er = this.er;

    for (let i = 0; i < n; i++) {
      // --- parameter smoothing
      const inGain = (s.inGain[0] += kF * (s.inGain[1] - s.inGain[0]));
      const dryG = (s.dry[0] += kF * (s.dry[1] - s.dry[0]));
      const wetG = (s.wet[0] += kF * (s.wet[1] - s.wet[0]));
      const sendG = (s.send[0] += kF * (s.send[1] - s.send[0]));
      const byp = (s.byp[0] += kF * (s.byp[1] - s.byp[0]));
      const outG = (s.out[0] += kF * (s.out[1] - s.out[0]));
      const width = (s.width[0] += kF * (s.width[1] - s.width[0]));
      const pd = (s.pd[0] += kP * (s.pd[1] - s.pd[0]));
      const early = (s.early[0] += kS * (s.early[1] - s.early[0]));
      const driveOn = (s.drive[0] += kF * (s.drive[1] - s.drive[0]));
      const driveAmt = (s.driveAmt[0] += kS * (s.driveAmt[1] - s.driveAmt[0]));
      const swellOn = (s.swellOn[0] += kF * (s.swellOn[1] - s.swellOn[0]));
      const pitch = (s.pitch[0] += kS * (s.pitch[1] - s.pitch[0]));
      const duck = (s.duck[0] += kS * (s.duck[1] - s.duck[0]));
      const freeze = (s.freeze[0] += kS * (s.freeze[1] - s.freeze[0]));
      const rtComp = (s.rtComp[0] += kS * (s.rtComp[1] - s.rtComp[0]));
      const thru = (s.thru[0] += kF * (s.thru[1] - s.thru[0]));

      const rawL = inL[i];
      const rawR = inR[i];
      let xL = rawL * inGain;
      let xR = rawR * inGain;

      // --- envelopes
      const lev = Math.max(Math.abs(xL), Math.abs(xR));
      const eF = this.envFast.process(lev);
      const eS = this.envSlow.process(lev);
      const eD = this.envDuck.process(lev);

      // --- auto swell: retrigger on note onsets, then fade in
      let swG = 1;
      if (swellOn > 0.0005) {
        if (this.swellArmed && eF > 0.02 && eF > eS * 1.6) {
          this.swellPos = 0;
          this.swellArmed = false;
        } else if (!this.swellArmed && (eF < 0.008 || eF < eS * 0.7)) {
          this.swellArmed = true;
        }
        if (this.swellPos < 1) this.swellPos = Math.min(1, this.swellPos + swellInc);
        const t = this.swellPos;
        swG = 1 - swellOn * (1 - t * t * (3 - 2 * t));
      }

      const dryL = swellDry ? xL * swG : xL;
      const dryR = swellDry ? xR * swG : xR;

      // --- reverb send
      let sL = xL * swG * sendG;
      let sR = xR * swG * sendG;

      if (driveOn > 0.0005) {
        const norm = 0.1 / softClip(0.1 * driveAmt);
        const dL = this.driveLpL.process(softClip(sL * driveAmt) * norm);
        const dR = this.driveLpR.process(softClip(sR * driveAmt) * norm);
        sL += driveOn * (dL - sL);
        sR += driveOn * (dR - sR);
      }

      // --- pre-delay
      this.pdL.write(sL);
      this.pdR.write(sR);
      sL = this.pdL.readLinear(pd);
      sR = this.pdR.readLinear(pd);

      // --- pitch (shimmer)
      if (pitch > 0.0005) {
        if (pitchFeedback) {
          let fL = this.shLpL.process(this.shHpL.process(this.shL.process(this.lastWetL)));
          let fR = this.shLpR.process(this.shHpR.process(this.shR.process(this.lastWetR)));
          // automatic gain control keeps the feedback loop from running away
          const env = this.shEnv.process(Math.max(Math.abs(fL), Math.abs(fR)));
          const agc = env > 0.2 ? 0.2 / env : 1;
          const g = pitch * 0.85 * agc * (1 - freeze);
          sL += fL * g;
          sR += fR * g;
        } else {
          const pL = this.shL.process(sL);
          const pR = this.shR.process(sR);
          sL += pitch * (pL - sL);
          sR += pitch * (pR - sR);
        }
      }

      // --- early reflections (also feed the tank for a smoother onset)
      let erL = 0;
      let erR = 0;
      if (early > 0.0005) {
        er.process(sL, sR);
        erL = er.oL * early;
        erR = er.oR * early;
      }

      // --- reverb core(s)
      cur.process(sL + erL * 0.5, sR + erR * 0.5);
      let fade = this.curFade;
      if (fade < 1) {
        fade = this.curFade = Math.min(1, fade + this.curFadeInc);
      }
      let wL = cur.oL * fade;
      let wR = cur.oR * fade;
      if (this.prev) {
        this.prev.process(0, 0);
        wL += this.prev.oL * this.prevGain;
        wR += this.prev.oR * this.prevGain;
        this.prevGain *= this.prevDecay;
        if (this.prevGain < 0.0005) this.prev = null;
      }
      wL += erL * 0.9;
      wR += erR * 0.9;
      this.lastWetL = wL;
      this.lastWetR = wR;

      // --- wet EQ
      wL = this.lpL.process(this.hpL.process(wL));
      wR = this.lpR.process(this.hpR.process(wR));

      // --- stereo width (M/S)
      const mid = 0.5 * (wL + wR);
      const side = 0.5 * (wL - wR) * width;
      wL = mid + side;
      wR = mid - side;

      // --- ducking
      const dg = 1 - duck * 0.92 * Math.min(1, eD * 5);

      // --- mix & output
      const wet = wetG * dg * outG * rtComp;
      let yL = (1 - byp) * dryL * dryG * outG + byp * xL * thru + wL * wet;
      let yR = (1 - byp) * dryR * dryG * outG + byp * xR * thru + wR * wet;

      // transparent below -1 dBFS, soft knee above
      const aL = Math.abs(yL);
      if (aL > 0.89) yL = Math.sign(yL) * (0.89 + 0.11 * Math.tanh((aL - 0.89) / 0.11));
      const aR = Math.abs(yR);
      if (aR > 0.89) yR = Math.sign(yR) * (0.89 + 0.11 * Math.tanh((aR - 0.89) / 0.11));

      outL[i] = yL;
      outR[i] = yR;
    }
  }
}

