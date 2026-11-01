// The "LCD": live spectrum, decay time per frequency (RT60 curve), wet EQ,
// output envelope history, status flags and in/out meters.

import { ALGORITHMS, PARAMS, PITCH_INTERVALS, formatValue } from '../params.js';

const F_MIN = 20;
const F_MAX = 20000;
const RT_MIN = 0.1;
const RT_MAX = 60;

const COL = {
  bg0: '#071014',
  bg1: '#0a161b',
  grid: 'rgba(127, 227, 224, 0.07)',
  gridText: 'rgba(160, 200, 205, 0.38)',
  spec: 'rgba(73, 184, 201, 0.55)',
  specFill0: 'rgba(73, 184, 201, 0.28)',
  specFill1: 'rgba(73, 184, 201, 0.0)',
  rt: '#ffb547',
  text: '#d9f6f4',
  dim: 'rgba(200, 235, 235, 0.55)',
  accent: '#7fe3e0',
  warn: '#ff6b5e',
  hist: 'rgba(127, 227, 224, 0.75)',
};

function freqToX(f, x0, w) {
  return x0 + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
}

function rtToY(rt, y0, h) {
  const t = Math.log(rt / RT_MIN) / Math.log(RT_MAX / RT_MIN);
  return y0 + h - Math.min(1, Math.max(0, t)) * h;
}

/** magnitude of the 3-band loop filter at f (analog one-pole approximation) */
function loopGain(f, gL, gM, gH, fLo, fHi) {
  const la = 1 / (1 + (f / fLo) ** 2);
  const lb = 1 / (1 + (f / fHi) ** 2);
  // complex one-pole: 1/(1+jx) = (1 - jx)/(1+x²)
  const xa = f / fLo;
  const xb = f / fHi;
  const laR = la;
  const laI = -xa * la;
  const lbR = lb;
  const lbI = -xb * lb;
  const re = gL * laR + gM * (lbR - laR) + gH * (1 - lbR);
  const im = gL * laI + gM * (lbI - laI) + gH * -lbI;
  return Math.hypot(re, im);
}

export class Display {
  constructor(canvas, getState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.analyserOut = null;
    this.analyserIn = null;
    this.freqData = null;
    this.timeData = null;
    this.smoothSpec = null;
    this.touched = null; // {key, t}
    this.message = null; // {text, t}
    this.hist = new Float32Array(240);
    this.histPos = 0;
    this.lastHist = 0;
    this.peak = { in: 0, out: 0, inHold: 0, outHold: 0 };
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setAnalysers(inA, outA) {
    this.analyserIn = inA;
    this.analyserOut = outA;
    this.freqData = new Float32Array(outA.frequencyBinCount);
    this.smoothSpec = new Float32Array(outA.frequencyBinCount).fill(-120);
    this.timeData = new Float32Array(outA.fftSize);
  }

  touch(key) {
    this.touched = { key, t: performance.now() };
  }

  flash(text) {
    this.message = { text, t: performance.now() };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _peak(an) {
    an.getFloatTimeDomainData(this.timeData);
    let p = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = Math.abs(this.timeData[i]);
      if (v > p) p = v;
    }
    return p;
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (!this.w) return;
    this._draw(now);
  }

  _draw(now) {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    const st = this.getState();
    const p = st.params;
    const sw = st.switches;

    // background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, COL.bg1);
    bg.addColorStop(1, COL.bg0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const meterW = 34;
    const gx = 12;
    const gw = W - gx - meterW - 18;
    const gy = 54;
    const histH = 30;
    const gh = H - gy - histH - 22;

    // --- frequency grid
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(freqToX(f, gx, gw)) + 0.5;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x, gy + gh);
      ctx.stroke();
      ctx.fillStyle = COL.gridText;
      ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 3, gy + gh - 4);
    }
    for (const rt of [0.5, 1, 2, 5, 10, 30]) {
      const y = Math.round(rtToY(rt, gy, gh)) + 0.5;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx + gw, y);
      ctx.stroke();
      ctx.fillStyle = COL.gridText;
      ctx.textAlign = 'right';
      ctx.fillText(rt + 's', gx + gw - 3, y - 3);
      ctx.textAlign = 'left';
    }

    // --- wet EQ: shade what is cut
    if (sw.eqOn) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      const xl = freqToX(p.lowCut, gx, gw);
      const xh = freqToX(p.highCut, gx, gw);
      ctx.fillRect(gx, gy, Math.max(0, xl - gx), gh);
      ctx.fillRect(xh, gy, Math.max(0, gx + gw - xh), gh);
    }

    // --- live spectrum
    if (this.analyserOut) {
      const an = this.analyserOut;
      an.getFloatFrequencyData(this.freqData);
      const sr = an.context.sampleRate;
      const n = this.freqData.length;
      const sm = this.smoothSpec;
      for (let i = 0; i < n; i++) {
        const v = this.freqData[i];
        sm[i] = v > sm[i] ? v : sm[i] * 0.9 + v * 0.1;
      }
      ctx.beginPath();
      ctx.moveTo(gx, gy + gh);
      const cols = Math.floor(gw / 2);
      for (let c = 0; c <= cols; c++) {
        const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / cols);
        const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / cols);
        let b0 = Math.floor((f0 / sr) * 2 * n);
        let b1 = Math.max(b0 + 1, Math.floor((f1 / sr) * 2 * n));
        b0 = Math.min(b0, n - 1);
        b1 = Math.min(b1, n);
        let m = -140;
        for (let b = b0; b < b1; b++) if (sm[b] > m) m = sm[b];
        // gentle pink-ish tilt so the display is not dominated by the bass
        const db = m + 3 * Math.log2(f0 / 1000);
        const t = Math.min(1, Math.max(0, (db + 100) / 85));
        ctx.lineTo(gx + (c / cols) * gw, gy + gh - t * gh);
      }
      ctx.lineTo(gx + gw, gy + gh);
      ctx.closePath();
      const fg = ctx.createLinearGradient(0, gy, 0, gy + gh);
      fg.addColorStop(0, COL.specFill0);
      fg.addColorStop(1, COL.specFill1);
      ctx.fillStyle = fg;
      ctx.fill();
      ctx.strokeStyle = COL.spec;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // --- RT60 curve
    ctx.lineWidth = 2;
    ctx.strokeStyle = COL.rt;
    ctx.shadowColor = 'rgba(255,181,71,0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    if (sw.freeze) {
      const y = gy + 2;
      ctx.moveTo(gx, y);
      ctx.lineTo(gx + gw, y);
    } else {
      const len = 0.05;
      const gL = Math.pow(10, (-3 * len) / (p.decay * p.loDecay));
      const gM = Math.pow(10, (-3 * len) / p.decay);
      const gH = Math.pow(10, (-3 * len) / (p.decay * p.hiDecay));
      for (let c = 0; c <= 120; c++) {
        const f = F_MIN * Math.pow(F_MAX / F_MIN, c / 120);
        const g = loopGain(f, gL, gM, gH, 280, 3200);
        const rt = (-3 * len) / Math.log10(Math.max(1e-9, Math.min(g, 0.999999)));
        const x = gx + (c / 120) * gw;
        const y = rtToY(rt, gy, gh);
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // --- meters
    let pin = 0;
    let pout = 0;
    if (this.analyserIn) pin = this._peak(this.analyserIn);
    if (this.analyserOut) pout = this._peak(this.analyserOut);
    const pk = this.peak;
    pk.in = Math.max(pin, pk.in * 0.92);
    pk.out = Math.max(pout, pk.out * 0.92);
    pk.inHold = pin > pk.inHold ? pin : pk.inHold * 0.995;
    pk.outHold = pout > pk.outHold ? pout : pk.outHold * 0.995;
    const mx = W - meterW - 8;
    const my = 14;
    const mh = H - my - 22;
    this._meter(mx, my, 12, mh, pk.in, pk.inHold, 'IN');
    this._meter(mx + 18, my, 12, mh, pk.out, pk.outHold, 'OUT');

    // --- output envelope history
    if (now - this.lastHist > 25) {
      this.lastHist = now;
      this.hist[this.histPos] = pk.out;
      this.histPos = (this.histPos + 1) % this.hist.length;
    }
    const hy = gy + gh + 8;
    ctx.strokeStyle = COL.grid;
    ctx.strokeRect(gx + 0.5, hy + 0.5, gw - 1, histH);
    ctx.beginPath();
    const N = this.hist.length;
    for (let i = 0; i < N; i++) {
      const v = this.hist[(this.histPos + i) % N];
      const db = v > 0 ? 20 * Math.log10(v) : -90;
      const t = Math.min(1, Math.max(0, (db + 60) / 60));
      const x = gx + (i / (N - 1)) * gw;
      const y = hy + histH - t * (histH - 3);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = COL.hist;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // --- header: algorithm + preset
    const algo = ALGORITHMS.find((a) => a.id === st.algorithm);
    ctx.fillStyle = COL.text;
    ctx.font = '600 22px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(algo ? algo.name.toUpperCase() : '', gx, 10);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = COL.dim;
    ctx.fillText(st.presetName || '', gx, 36);

    // status flags
    const flags = [];
    if (sw.freeze) flags.push(['HOLD', COL.accent]);
    if (sw.bypass) flags.push(['BYPASS', COL.warn]);
    if (sw.pitchOn) {
      const iv = PITCH_INTERVALS[Math.round(p.pitchInterval)];
      flags.push([(sw.pitchMode === 0 ? 'SHIM ' : 'PITCH ') + (iv > 0 ? '+' : '') + iv, COL.text]);
    }
    if (sw.swellOn) flags.push(['SWELL', COL.text]);
    if (sw.driveOn) flags.push(['DRIVE', COL.text]);
    if (sw.duckOn) flags.push(['DUCK', COL.text]);
    let fx = gx + 170;
    ctx.font = '600 10px "JetBrains Mono", monospace';
    for (const [txt, col] of flags) {
      const tw = ctx.measureText(txt).width + 12;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.strokeRect(fx + 0.5, 13.5, tw, 16);
      ctx.fillStyle = col;
      ctx.fillText(txt, fx + 6, 17);
      ctx.globalAlpha = 1;
      fx += tw + 6;
      if (fx > gx + gw - 200) break;
    }

    // right side readout: last touched parameter or decay
    let label = 'DECAY';
    let value = sw.freeze ? '∞' : formatValue('decay', p.decay);
    if (this.touched && now - this.touched.t < 1800) {
      label = PARAMS[this.touched.key].label.toUpperCase();
      value = formatValue(this.touched.key, p[this.touched.key]);
    }
    if (this.message && now - this.message.t < 1800) {
      label = '';
      value = this.message.text;
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = COL.dim;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(label, gx + gw, 10);
    ctx.fillStyle = COL.accent;
    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillText(value, gx + gw, 24);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // legend
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = COL.rt;
    ctx.fillText('— RT60', gx + 4, gy + 12);
    ctx.fillStyle = COL.spec;
    ctx.fillText('— Spektrum', gx + 60, gy + 12);
  }

  _meter(x, y, w, h, v, hold, label) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x, y, w, h);
    const toT = (a) => {
      const db = a > 0 ? 20 * Math.log10(a) : -90;
      return Math.min(1, Math.max(0, (db + 54) / 54));
    };
    const t = toT(v);
    const g = ctx.createLinearGradient(0, y + h, 0, y);
    g.addColorStop(0, '#2e8f99');
    g.addColorStop(0.7, '#7fe3e0');
    g.addColorStop(0.9, '#ffb547');
    g.addColorStop(1, '#ff6b5e');
    ctx.fillStyle = g;
    ctx.fillRect(x, y + h - t * h, w, t * h);
    const th = toT(hold);
    ctx.fillStyle = hold > 0.98 ? '#ff6b5e' : '#d9f6f4';
    ctx.fillRect(x, y + h - th * h - 1, w, 2);
    ctx.fillStyle = COL.gridText;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, y + h + 13);
    ctx.textAlign = 'left';
  }
}
