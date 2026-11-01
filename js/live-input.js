// Live audio input: audio interfaces, synths/drum machines over USB audio
// (e.g. class-compliant grooveboxes), line-in and microphones.
//
// Opens the selected device without any voice processing, keeps as many
// channels as the browser delivers and routes a chosen stereo pair or a
// single (mono) channel into the reverb.

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export class LiveInput {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.dest = destination;
    this.stream = null;
    this.source = null;
    this.splitter = null;
    this.merger = null;
    this.channels = 0;
    this.deviceId = '';
    this.label = '';
    this.routing = '0-1';
    this.connected = false;
    this.settings = {};
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  static canSelectOutput(ctx) {
    return !!ctx && typeof ctx.setSinkId === 'function';
  }

  static async devices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { inputs: [], outputs: [] };
    const all = await navigator.mediaDevices.enumerateDevices();
    const clean = (kind) =>
      all.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    return { inputs: clean('audioinput'), outputs: clean('audiooutput') };
  }

  /** Opens (or re-opens) a device. deviceId '' = system default. */
  async open(deviceId = '') {
    const wasConnected = this.connected;
    this.close();
    const audio = {
      ...RAW,
      channelCount: { ideal: 32 },
      sampleRate: { ideal: this.ctx.sampleRate },
      latency: { ideal: 0 },
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      // some drivers reject the optional hints – retry with the bare minimum
      if (err.name !== 'OverconstrainedError' && err.name !== 'TypeError') throw err;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...RAW, deviceId: { exact: deviceId } } : RAW,
      });
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.settings = track.getSettings ? track.getSettings() : {};
    this.deviceId = this.settings.deviceId || deviceId || '';
    this.label = track.label || 'Audioeingang';
    this.source = this.ctx.createMediaStreamSource(stream);
    this.channels = Math.max(1, Math.min(32, this.settings.channelCount || this.source.channelCount || 2));
    if (!this.routingOptions().some((o) => o.value === this.routing)) this.routing = this.routingOptions()[0].value;
    this._wire();
    if (wasConnected) this.connect();
    track.addEventListener('ended', () => this.onEnded && this.onEnded());
  }

  /** Available channel assignments for the open device. */
  routingOptions() {
    const n = this.channels || 2;
    const opts = [];
    for (let i = 0; i + 1 < n; i += 2) opts.push({ value: `${i}-${i + 1}`, label: `Kanal ${i + 1}/${i + 2} · Stereo` });
    for (let i = 0; i < n; i++) opts.push({ value: `m${i}`, label: `Kanal ${i + 1} · Mono` });
    return opts;
  }

  setRouting(value) {
    this.routing = value;
    if (this.source) this._wire();
  }

  _wire() {
    if (this.splitter) this.splitter.disconnect();
    if (this.merger) this.merger.disconnect();
    this.source.disconnect();
    const n = this.channels;
    this.splitter = this.ctx.createChannelSplitter(n);
    this.merger = this.ctx.createChannelMerger(2);
    this.source.connect(this.splitter);
    if (this.routing.startsWith('m')) {
      const ch = Math.min(n - 1, Number(this.routing.slice(1)));
      this.splitter.connect(this.merger, ch, 0);
      this.splitter.connect(this.merger, ch, 1);
    } else {
      const [a, b] = this.routing.split('-').map(Number);
      this.splitter.connect(this.merger, Math.min(a, n - 1), 0);
      this.splitter.connect(this.merger, Math.min(b, n - 1), 1);
    }
    if (this.connected) this.merger.connect(this.dest);
  }

  connect() {
    if (!this.merger || this.connected) return;
    this.merger.connect(this.dest);
    this.connected = true;
  }

  disconnect() {
    if (this.merger && this.connected) this.merger.disconnect();
    this.connected = false;
  }

  close() {
    this.disconnect();
    if (this.source) this.source.disconnect();
    if (this.splitter) this.splitter.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = this.source = this.splitter = this.merger = null;
    this.channels = 0;
  }

  /** Round-trip latency estimate in milliseconds. */
  latencyMs() {
    const inLat = typeof this.settings.latency === 'number' ? this.settings.latency : 0;
    const outLat = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.round((inLat + outLat + 128 / this.ctx.sampleRate) * 1000);
  }
}
