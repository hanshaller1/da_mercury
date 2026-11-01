import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReverbEngine } from '../js/dsp/engine.js';
import { ALGORITHMS, PARAMS, PITCH_INTERVALS, toNorm, fromNorm, defaultState } from '../js/params.js';
import { FACTORY_PRESETS } from '../js/presets.js';
import { mulberry32 } from '../js/dsp/primitives.js';

const SR = 48000;
const B = 128;

function run(engine, seconds, input) {
  const n = Math.round(seconds * SR);
  const inL = new Float32Array(B);
  const inR = new Float32Array(B);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i += B) {
    for (let j = 0; j < B; j++) {
      const v = input ? input(i + j) : 0;
      inL[j] = Array.isArray(v) ? v[0] : v;
      inR[j] = Array.isArray(v) ? v[1] : v;
    }
    engine.process(inL, inR, oL, oR, B);
    outL.set(oL.subarray(0, Math.min(B, n - i)), i);
    outR.set(oR.subarray(0, Math.min(B, n - i)), i);
  }
  return [outL, outR];
}

function wetOnly(algorithm, extra = {}) {
  const e = new ReverbEngine(SR);
  e.setState(
    {
      algorithm,
      params: { mix: 1, early: 0, predelay: 0, loDecay: 1, hiDecay: 1, ...extra },
      switches: { eqOn: false },
    },
    true,
  );
  return e;
}

function energy(a, from = 0, to = a.length) {
  let e = 0;
  for (let i = from; i < to; i++) e += a[i] * a[i];
  return e;
}

function allFinite(...arrs) {
  for (const a of arrs) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

/** T20 based reverberation time from the Schroeder decay curve */
function measureRT([l, r]) {
  const n = l.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += l[i] * l[i] + r[i] * r[i];
    edc[i] = acc;
  }
  const db = (i) => 10 * Math.log10(edc[i] / edc[0]);
  let i5 = -1;
  for (let i = 0; i < n; i++) {
    if (i5 < 0 && db(i) < -5) i5 = i;
    if (db(i) < -25) return ((i - i5) / SR) * 3;
  }
  return NaN;
}

const impulse = (i) => (i === 0 ? 1 : 0);

test('every algorithm produces a finite, decaying, decorrelated tail', () => {
  for (const { id } of ALGORITHMS) {
    const e = wetOnly(id, { decay: 1.5 });
    const out = run(e, 6, impulse);
    assert.ok(allFinite(...out), `${id}: non-finite output`);
    const early = energy(out[0], 0, SR) + energy(out[1], 0, SR);
    const late = energy(out[0], 5 * SR) + energy(out[1], 5 * SR);
    assert.ok(early > 0.05, `${id}: tail too quiet (${early})`);
    assert.ok(late < early * 1e-4, `${id}: tail does not decay`);
    // stereo decorrelation
    let c = 0;
    for (let i = 0; i < out[0].length; i++) c += out[0][i] * out[1][i];
    const corr = c / Math.sqrt(energy(out[0]) * energy(out[1]));
    assert.ok(Math.abs(corr) < 0.4, `${id}: L/R too correlated (${corr.toFixed(2)})`);
  }
});

test('decay time follows the Decay control', () => {
  for (const id of ['room', 'hall', 'plate', 'cathedral', 'cloud', 'spring']) {
    for (const rt of [1, 3]) {
      const e = wetOnly(id, { decay: rt });
      const measured = measureRT(run(e, rt * 2.2 + 1, impulse));
      const ratio = measured / rt;
      assert.ok(ratio > 0.7 && ratio < 1.3, `${id}: decay ${rt}s measured ${measured.toFixed(2)}s`);
    }
  }
});

test('output level is consistent between algorithms', () => {
  const levels = ALGORITHMS.map(({ id }) => {
    const out = run(wetOnly(id, { decay: 2 }), 5, impulse);
    return energy(out[0]) + energy(out[1]);
  });
  const max = Math.max(...levels);
  const min = Math.min(...levels);
  assert.ok(10 * Math.log10(max / min) < 3, `level spread ${levels.map((x) => x.toFixed(2))}`);
});

test('freeze sustains the tail without blowing up', () => {
  for (const id of ['hall', 'plate', 'cloud', 'spring']) {
    const e = wetOnly(id, { decay: 2 });
    const rand = mulberry32(5);
    run(e, 0.5, () => (rand() - 0.5) * 0.5);
    e.setState({ switches: { freeze: true } });
    const out = run(e, 12, () => (rand() - 0.5) * 0.5); // input keeps playing, must be ignored
    const e1 = energy(out[0], 1 * SR, 2 * SR);
    const e2 = energy(out[0], 11 * SR, 12 * SR);
    assert.ok(allFinite(...out), `${id}: non-finite`);
    assert.ok(e2 > e1 * 0.5, `${id}: frozen tail decays (${e1} -> ${e2})`);
    assert.ok(e2 < e1 * 2, `${id}: frozen tail grows (${e1} -> ${e2})`);
  }
});

test('shimmer feedback stays bounded for every interval', () => {
  for (const idx of PITCH_INTERVALS.keys()) {
    const e = wetOnly('cloud', { decay: 40, pitchAmount: 1, pitchInterval: idx });
    e.setState({ switches: { pitchOn: true } }, true);
    const rand = mulberry32(idx + 1);
    const out = run(e, 15, () => (rand() - 0.5) * 0.8);
    assert.ok(allFinite(...out));
    assert.ok(Math.abs(e.lastWetL) < 3 && Math.abs(e.lastWetR) < 3, `interval ${PITCH_INTERVALS[idx]} runs away`);
    const rms = Math.sqrt(energy(out[0], 13 * SR, 15 * SR) / (2 * SR));
    assert.ok(rms < 0.6, `interval ${PITCH_INTERVALS[idx]}: rms ${rms}`);
  }
});

test('random parameter automation never produces NaN', () => {
  const rand = mulberry32(99);
  const e = new ReverbEngine(SR);
  const keys = Object.keys(PARAMS);
  const inL = new Float32Array(B);
  const inR = new Float32Array(B);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  let peak = 0;
  for (let blk = 0; blk < (20 * SR) / B; blk++) {
    if (blk % 40 === 0) {
      const params = {};
      for (const k of keys) params[k] = fromNorm(k, rand());
      params.output = 0;
      params.inputGain = 0;
      e.setState({
        algorithm: ALGORITHMS[Math.floor(rand() * ALGORITHMS.length)].id,
        params,
        switches: {
          freeze: rand() < 0.15,
          driveOn: rand() < 0.5,
          swellOn: rand() < 0.5,
          swellDry: rand() < 0.5,
          pitchOn: rand() < 0.5,
          pitchMode: rand() < 0.5 ? 0 : 1,
          duckOn: rand() < 0.5,
          eqOn: rand() < 0.8,
          bypass: rand() < 0.1,
        },
      });
    }
    for (let j = 0; j < B; j++) {
      inL[j] = (rand() - 0.5) * 0.6;
      inR[j] = (rand() - 0.5) * 0.6;
    }
    e.process(inL, inR, oL, oR, B);
    for (let j = 0; j < B; j++) {
      assert.ok(Number.isFinite(oL[j]) && Number.isFinite(oR[j]), `NaN in block ${blk}`);
      peak = Math.max(peak, Math.abs(oL[j]), Math.abs(oR[j]));
    }
  }
  assert.ok(peak <= 1.0, `peak ${peak}`);
});

test('bypass without trails is transparent; mix 0 passes dry', () => {
  const e = new ReverbEngine(SR);
  e.setState({ switches: { bypass: true, trails: false } }, true);
  const sig = (i) => Math.sin(i * 0.01) * 0.5;
  const [l] = run(e, 0.5, sig);
  for (let i = SR * 0.25; i < SR * 0.5; i++) assert.ok(Math.abs(l[i] - sig(i)) < 1e-4);

  const e2 = new ReverbEngine(SR);
  e2.setState({ params: { mix: 0 } }, true);
  const [l2] = run(e2, 0.5, sig);
  for (let i = SR * 0.25; i < SR * 0.5; i++) assert.ok(Math.abs(l2[i] - sig(i)) < 1e-4);
});

test('trails keep ringing after bypass', () => {
  const e = new ReverbEngine(SR);
  e.setState({ params: { decay: 4, mix: 0.5 }, switches: { trails: true } }, true);
  const rand = mulberry32(3);
  run(e, 0.5, () => (rand() - 0.5) * 0.5);
  e.setState({ switches: { bypass: true } });
  const [l] = run(e, 1);
  assert.ok(energy(l, SR * 0.5, SR) > 1e-3);
});

test('runs comfortably faster than real time', () => {
  for (const { id } of ALGORITHMS) {
    const e = new ReverbEngine(SR);
    e.setState({ algorithm: id, params: { early: 0.5 }, switches: { pitchOn: true, driveOn: true, duckOn: true } }, true);
    const rand = mulberry32(1);
    const t0 = performance.now();
    run(e, 4, () => (rand() - 0.5) * 0.3);
    const factor = 4000 / (performance.now() - t0);
    assert.ok(factor > 4, `${id}: only ${factor.toFixed(1)}x real time`);
  }
});

test('parameter mapping round-trips', () => {
  for (const k of Object.keys(PARAMS)) {
    if (PARAMS[k].curve === 'enum') continue;
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(toNorm(k, fromNorm(k, t)) - t) < 1e-9, k);
    }
  }
});

test('factory presets are complete and valid', () => {
  const def = defaultState();
  assert.ok(FACTORY_PRESETS.length >= 10);
  for (const p of FACTORY_PRESETS) {
    assert.ok(ALGORITHMS.some((a) => a.id === p.algorithm), p.name);
    for (const [k, v] of Object.entries(p.params)) {
      assert.ok(k in def.params, `${p.name}: unknown param ${k}`);
      assert.ok(v >= PARAMS[k].min && v <= PARAMS[k].max, `${p.name}: ${k}=${v} out of range`);
    }
    for (const k of Object.keys(p.switches || {})) assert.ok(k in def.switches, `${p.name}: unknown switch ${k}`);
  }
});
