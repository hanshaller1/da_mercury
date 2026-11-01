// AudioWorklet wrapper around the ReverbEngine.
import { ReverbEngine } from '../dsp/engine.js';

class ReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new ReverbEngine(sampleRate);
    const init = options && options.processorOptions && options.processorOptions.state;
    if (init) this.engine.setState(init, true);
    this.silent = new Float32Array(128);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'state') this.engine.setState(m.state, !!m.snap);
      else if (m.type === 'reset') this.engine.reset();
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    if (this.silent.length < n) this.silent = new Float32Array(n);
    const inL = input && input.length > 0 ? input[0] : this.silent;
    const inR = input && input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    this.engine.process(inL, inR, outL, outR, n);
    return true;
  }
}

registerProcessor('reverb-processor', ReverbProcessor);
