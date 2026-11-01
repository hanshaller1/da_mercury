// Parameter definitions shared by the UI and the audio engine.

export const ALGORITHMS = [
  { id: 'room', name: 'Room', desc: 'Kleiner bis mittlerer Raum mit deutlichen frühen Reflexionen.' },
  { id: 'hall', name: 'Hall', desc: 'Weicher, dichter Konzertsaal. Der Allrounder.' },
  { id: 'plate', name: 'Plate', desc: 'Klassische Hallplatte: hell, dicht, sofortige Diffusion.' },
  { id: 'spring', name: 'Spring', desc: 'Federhall mit dispersiven "Chirps" – Surf & Vintage Amp.' },
  { id: 'cathedral', name: 'Cathedral', desc: 'Riesige Steinhalle mit langen Wegen und spärlichen Echos.' },
  { id: 'cloud', name: 'Cloud', desc: 'Ambient-Wolke: extrem diffus, stark moduliert, endlos.' },
  { id: 'reverse', name: 'Reverse', desc: 'Rückwärts laufende Hallfahnen, die zum Ton hin anschwellen.' },
];

export const PITCH_INTERVALS = [-24, -12, -7, -5, 3, 4, 5, 7, 12, 19, 24];

// curve: 'lin' | 'log' | 'pow' (pow uses `k` as exponent)
export const PARAMS = {
  decay: { label: 'Decay', min: 0.1, max: 60, def: 2.6, curve: 'log', unit: 's', group: 'main' },
  mix: { label: 'Mix', min: 0, max: 1, def: 0.35, curve: 'lin', unit: '%', group: 'main' },
  predelay: { label: 'Pre-Delay', min: 0, max: 1000, def: 18, curve: 'pow', k: 2.5, unit: 'ms', group: 'main' },
  size: { label: 'Size', min: 0, max: 1, def: 0.55, curve: 'lin', unit: '%', group: 'main' },
  diffusion: { label: 'Diffusion', min: 0, max: 1, def: 0.8, curve: 'lin', unit: '%', group: 'tank' },
  loDecay: { label: 'Lo Decay', min: 0.25, max: 2.5, def: 1.1, curve: 'log', unit: 'x', group: 'tank' },
  hiDecay: { label: 'Hi Decay', min: 0.08, max: 1.5, def: 0.55, curve: 'log', unit: 'x', group: 'tank' },
  early: { label: 'Early', min: 0, max: 1, def: 0.25, curve: 'lin', unit: '%', group: 'tank' },
  modRate: { label: 'Mod Rate', min: 0.05, max: 6, def: 0.7, curve: 'log', unit: 'Hz', group: 'mod' },
  modDepth: { label: 'Mod Depth', min: 0, max: 1, def: 0.35, curve: 'lin', unit: '%', group: 'mod' },
  pitchInterval: { label: 'Interval', min: 0, max: PITCH_INTERVALS.length - 1, def: 8, curve: 'enum', unit: 'st', group: 'pitch' },
  pitchAmount: { label: 'Shimmer', min: 0, max: 1, def: 0.4, curve: 'lin', unit: '%', group: 'pitch' },
  drive: { label: 'Drive', min: 0, max: 1, def: 0.3, curve: 'lin', unit: '%', group: 'pre' },
  swell: { label: 'Swell', min: 30, max: 4000, def: 700, curve: 'log', unit: 'ms', group: 'pre' },
  duck: { label: 'Ducking', min: 0, max: 1, def: 0.5, curve: 'lin', unit: '%', group: 'dyn' },
  lowCut: { label: 'Low Cut', min: 20, max: 1200, def: 90, curve: 'log', unit: 'Hz', group: 'eq' },
  highCut: { label: 'High Cut', min: 800, max: 20000, def: 9500, curve: 'log', unit: 'Hz', group: 'eq' },
  width: { label: 'Width', min: 0, max: 1.5, def: 1, curve: 'lin', unit: '%', group: 'out' },
  output: { label: 'Output', min: -24, max: 12, def: 0, curve: 'lin', unit: 'dB', group: 'out' },
  inputGain: { label: 'Input', min: -24, max: 24, def: 0, curve: 'lin', unit: 'dB', group: 'in' },
};

// Boolean switches
export const SWITCHES = {
  bypass: false,
  trails: true,
  freeze: false,
  driveOn: false,
  swellOn: false,
  swellDry: false, // true: swell also on the dry signal (classic volume swell)
  pitchOn: false,
  pitchMode: 0, // 0 = in the feedback loop (shimmer), 1 = on the input only
  duckOn: false,
  eqOn: true,
};

export function defaultState() {
  const params = {};
  for (const [k, p] of Object.entries(PARAMS)) params[k] = p.def;
  return { algorithm: 'hall', params, switches: { ...SWITCHES } };
}

/** value -> normalised knob position 0..1 */
export function toNorm(key, v) {
  const p = PARAMS[key];
  const t = (() => {
    switch (p.curve) {
      case 'log':
        return Math.log(v / p.min) / Math.log(p.max / p.min);
      case 'pow':
        return Math.pow((v - p.min) / (p.max - p.min), 1 / p.k);
      default:
        return (v - p.min) / (p.max - p.min);
    }
  })();
  return Math.min(1, Math.max(0, t));
}

/** normalised 0..1 -> value */
export function fromNorm(key, t) {
  const p = PARAMS[key];
  t = Math.min(1, Math.max(0, t));
  switch (p.curve) {
    case 'log':
      return p.min * Math.pow(p.max / p.min, t);
    case 'pow':
      return p.min + (p.max - p.min) * Math.pow(t, p.k);
    case 'enum':
      return Math.round(p.min + (p.max - p.min) * t);
    default:
      return p.min + (p.max - p.min) * t;
  }
}

export function formatValue(key, v) {
  const p = PARAMS[key];
  switch (key) {
    case 'pitchInterval': {
      const st = PITCH_INTERVALS[Math.round(v)];
      return (st > 0 ? '+' : '') + st;
    }
    case 'decay':
      return v < 10 ? v.toFixed(2) + ' s' : v.toFixed(1) + ' s';
    case 'predelay':
      return v < 10 ? v.toFixed(1) + ' ms' : Math.round(v) + ' ms';
    case 'swell':
      return v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(2) + ' s';
    case 'lowCut':
    case 'highCut':
      return v < 1000 ? Math.round(v) + ' Hz' : (v / 1000).toFixed(v < 10000 ? 2 : 1) + ' kHz';
    case 'modRate':
      return v.toFixed(2) + ' Hz';
    case 'loDecay':
    case 'hiDecay':
      return '×' + v.toFixed(2);
    case 'output':
    case 'inputGain':
      return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
    default:
      if (p.unit === '%') return Math.round(v * 100) + '%';
      return v.toFixed(2) + ' ' + p.unit;
  }
}
