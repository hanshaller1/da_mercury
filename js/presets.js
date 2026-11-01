// Factory presets. Each preset only lists what differs from the defaults.

export const FACTORY_PRESETS = [
  {
    name: 'Studio Plate',
    algorithm: 'plate',
    params: { decay: 2.2, mix: 0.3, predelay: 22, size: 0.6, diffusion: 0.85, hiDecay: 0.7, loDecay: 0.9, early: 0, lowCut: 140, highCut: 11000, modDepth: 0.25 },
  },
  {
    name: 'Concert Hall',
    algorithm: 'hall',
    params: { decay: 3.2, mix: 0.32, predelay: 28, size: 0.7, diffusion: 0.8, loDecay: 1.25, hiDecay: 0.5, early: 0.35, highCut: 9000, modDepth: 0.3, modRate: 0.6 },
  },
  {
    name: 'Tight Drum Room',
    algorithm: 'room',
    params: { decay: 0.6, mix: 0.28, predelay: 4, size: 0.35, diffusion: 0.7, loDecay: 0.8, hiDecay: 0.6, early: 0.7, lowCut: 160, highCut: 12000, modDepth: 0.1 },
  },
  {
    name: 'Wooden Room',
    algorithm: 'room',
    params: { decay: 1.3, mix: 0.3, predelay: 8, size: 0.6, diffusion: 0.75, loDecay: 1.2, hiDecay: 0.4, early: 0.55, highCut: 7000, modDepth: 0.2 },
  },
  {
    name: 'Surf Spring',
    algorithm: 'spring',
    params: { decay: 2.8, mix: 0.4, predelay: 0, size: 0.5, diffusion: 0.75, loDecay: 0.8, hiDecay: 0.6, early: 0, drive: 0.35, lowCut: 120, highCut: 6500, modDepth: 0.4 },
    switches: { driveOn: true },
  },
  {
    name: 'Stone Cathedral',
    algorithm: 'cathedral',
    params: { decay: 9, mix: 0.4, predelay: 45, size: 0.85, diffusion: 0.7, loDecay: 1.4, hiDecay: 0.45, early: 0.4, highCut: 8000, modDepth: 0.3, modRate: 0.3 },
  },
  {
    name: 'Shimmer Heaven',
    algorithm: 'cloud',
    params: { decay: 14, mix: 0.45, predelay: 60, size: 0.8, diffusion: 0.9, loDecay: 0.8, hiDecay: 0.7, early: 0.1, pitchInterval: 8, pitchAmount: 0.55, lowCut: 180, highCut: 12000, modDepth: 0.45, modRate: 0.35 },
    switches: { pitchOn: true },
  },
  {
    name: 'Fifth Bloom',
    algorithm: 'cathedral',
    params: { decay: 11, mix: 0.45, predelay: 30, size: 0.75, diffusion: 0.85, loDecay: 1, hiDecay: 0.6, early: 0.15, pitchInterval: 7, pitchAmount: 0.4, swell: 900, highCut: 10000, modDepth: 0.35 },
    switches: { pitchOn: true, swellOn: true },
  },
  {
    name: 'Abyss (-1 Okt.)',
    algorithm: 'cloud',
    params: { decay: 18, mix: 0.5, predelay: 20, size: 0.9, diffusion: 0.9, loDecay: 1.2, hiDecay: 0.35, early: 0, pitchInterval: 1, pitchAmount: 0.45, lowCut: 40, highCut: 5000, modDepth: 0.5, modRate: 0.2 },
    switches: { pitchOn: true },
  },
  {
    name: 'Reverse Swell',
    algorithm: 'reverse',
    params: { decay: 3, mix: 0.5, predelay: 0, size: 0.55, diffusion: 0.85, loDecay: 1, hiDecay: 0.6, early: 0, highCut: 10000, modDepth: 0.3 },
  },
  {
    name: 'Infinite Pad',
    algorithm: 'cloud',
    params: { decay: 45, mix: 0.6, predelay: 80, size: 1, diffusion: 1, loDecay: 0.9, hiDecay: 0.6, early: 0, swell: 1500, lowCut: 120, highCut: 9000, modDepth: 0.6, modRate: 0.25 },
    switches: { swellOn: true, swellDry: true },
  },
  {
    name: 'Ducked Vocal Hall',
    algorithm: 'hall',
    params: { decay: 2.6, mix: 0.4, predelay: 70, size: 0.65, diffusion: 0.85, loDecay: 0.8, hiDecay: 0.7, early: 0.2, duck: 0.7, lowCut: 220, highCut: 10000, modDepth: 0.3 },
    switches: { duckOn: true },
  },
  {
    name: 'Lo-Fi Tape Room',
    algorithm: 'room',
    params: { decay: 1.6, mix: 0.4, predelay: 15, size: 0.5, diffusion: 0.6, loDecay: 1.3, hiDecay: 0.3, early: 0.5, drive: 0.6, lowCut: 200, highCut: 3800, modDepth: 0.9, modRate: 1.4 },
    switches: { driveOn: true },
  },
  {
    name: 'Octave Up Plate',
    algorithm: 'plate',
    params: { decay: 4, mix: 0.4, predelay: 10, size: 0.7, diffusion: 0.9, hiDecay: 0.8, early: 0, pitchInterval: 8, pitchAmount: 0.6, lowCut: 150, highCut: 13000, modDepth: 0.3 },
    switches: { pitchOn: true, pitchMode: 1 },
  },
  {
    name: 'Ambient Cloud',
    algorithm: 'cloud',
    params: { decay: 8, mix: 0.45, predelay: 40, size: 0.75, diffusion: 0.95, loDecay: 1, hiDecay: 0.55, early: 0, highCut: 9000, modDepth: 0.55, modRate: 0.45 },
  },
];
