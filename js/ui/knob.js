// Rotary knob (SVG). Drag vertically (Shift = fine), mouse wheel, arrow keys,
// double click resets to default. Works with mouse, touch and pen.

import { PARAMS, toNorm, fromNorm, formatValue } from '../params.js';

const SWEEP = 270;
const START = -135;
const NS = 'http://www.w3.org/2000/svg';

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class Knob {
  /**
   * @param {string} key parameter key from PARAMS
   * @param {{big?: boolean, onChange: (key, value) => void, onTouch?: (key) => void}} opts
   */
  constructor(key, opts) {
    this.key = key;
    this.def = PARAMS[key];
    this.onChange = opts.onChange;
    this.onTouch = opts.onTouch || (() => {});
    this.value = this.def.def;
    this.norm = toNorm(key, this.value);

    const size = opts.big ? 96 : 58;
    const c = size / 2;
    const rTrack = c - (opts.big ? 5 : 4);
    const rFace = rTrack - (opts.big ? 10 : 7);
    this.geom = { c, rTrack, size };

    const root = (this.el = document.createElement('div'));
    root.className = 'knob' + (opts.big ? ' big' : '');

    const svg = (this.svg = el('svg', {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      tabindex: 0,
      role: 'slider',
      'aria-label': this.def.label,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
    }));

    const gradId = `kg-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const defs = el('defs', {});
    const grad = el('radialGradient', { id: gradId, cx: '40%', cy: '32%', r: '75%' });
    grad.append(
      el('stop', { offset: '0%', 'stop-color': '#5d6873' }),
      el('stop', { offset: '55%', 'stop-color': '#2b333c' }),
      el('stop', { offset: '100%', 'stop-color': '#171c21' }),
    );
    defs.append(grad);
    svg.append(defs);

    svg.append(
      el('path', {
        class: 'knob-track',
        d: arcPath(c, c, rTrack, START, START + SWEEP),
        'stroke-width': opts.big ? 5 : 3.5,
      }),
    );
    this.arc = el('path', { class: 'knob-arc', 'stroke-width': opts.big ? 5 : 3.5 });
    svg.append(this.arc);

    // tick marks for the big knobs
    if (opts.big) {
      for (let i = 0; i <= 10; i++) {
        const a = START + (SWEEP * i) / 10;
        const [x0, y0] = polar(c, c, rFace + 3.5, a);
        const [x1, y1] = polar(c, c, rFace + 6, a);
        svg.append(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#3b4650', 'stroke-width': 1 }));
      }
    }

    svg.append(el('circle', { class: 'knob-face', cx: c, cy: c, r: rFace, fill: `url(#${gradId})` }));
    svg.append(el('circle', { cx: c, cy: c, r: rFace - 3, fill: 'none', stroke: 'rgba(255,255,255,0.05)' }));
    this.pointer = el('line', { class: 'knob-pointer', 'stroke-width': opts.big ? 3 : 2.2 });
    this.pointerGeom = { r0: rFace * 0.35, r1: rFace - 3 };
    svg.append(this.pointer);

    const label = document.createElement('div');
    label.className = 'knob-label';
    label.textContent = this.def.label;
    this.valueEl = document.createElement('div');
    this.valueEl.className = 'knob-value';

    root.append(svg, label, this.valueEl);
    this._bind();
    this._render();
  }

  set(value, silent = true) {
    this.value = value;
    this.norm = toNorm(this.key, value);
    this._render();
    if (!silent) this.onChange(this.key, value);
  }

  setDisabled(d) {
    this.el.classList.toggle('disabled', d);
  }

  _setNorm(n) {
    n = Math.min(1, Math.max(0, n));
    const v = fromNorm(this.key, n);
    this.norm = this.def.curve === 'enum' ? toNorm(this.key, v) : n;
    if (v !== this.value) {
      this.value = v;
      this.onChange(this.key, v);
    }
    this._render();
  }

  _render() {
    const { c, rTrack } = this.geom;
    const a = START + SWEEP * this.norm;
    this.arc.setAttribute('d', this.norm > 0.002 ? arcPath(c, c, rTrack, START, a) : '');
    const [x0, y0] = polar(c, c, this.pointerGeom.r0, a);
    const [x1, y1] = polar(c, c, this.pointerGeom.r1, a);
    this.pointer.setAttribute('x1', x0);
    this.pointer.setAttribute('y1', y0);
    this.pointer.setAttribute('x2', x1);
    this.pointer.setAttribute('y2', y1);
    const txt = formatValue(this.key, this.value);
    this.valueEl.textContent = txt;
    this.svg.setAttribute('aria-valuenow', Math.round(this.norm * 100));
    this.svg.setAttribute('aria-valuetext', txt);
  }

  _bind() {
    const svg = this.svg;
    let startY = 0;
    let startNorm = 0;
    let enumAcc = 0;
    const isEnum = this.def.curve === 'enum';
    const steps = this.def.max - this.def.min;

    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      svg.focus({ preventScroll: true });
      startY = e.clientY;
      startNorm = this.norm;
      enumAcc = 0;
      this.onTouch(this.key);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!svg.hasPointerCapture(e.pointerId)) return;
      const dy = startY - e.clientY;
      const range = e.shiftKey ? 900 : 200;
      if (isEnum) {
        enumAcc = dy / 22;
        this._setNorm(startNorm + Math.round(enumAcc) / steps);
      } else {
        this._setNorm(startNorm + dy / range);
      }
    });
    const end = (e) => {
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onTouch(this.key);
        const dir = e.deltaY < 0 ? 1 : -1;
        const step = isEnum ? 1 / steps : e.shiftKey ? 0.002 : 0.02;
        this._setNorm(this.norm + dir * step);
      },
      { passive: false },
    );

    svg.addEventListener('dblclick', () => {
      this.onTouch(this.key);
      this.set(this.def.def, false);
    });

    svg.addEventListener('keydown', (e) => {
      const step = isEnum ? 1 / steps : e.shiftKey ? 0.005 : 0.025;
      let handled = true;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this._setNorm(this.norm + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this._setNorm(this.norm - step);
      else if (e.key === 'Home') this._setNorm(0);
      else if (e.key === 'End') this._setNorm(1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        this.onTouch(this.key);
      }
    });
  }
}
