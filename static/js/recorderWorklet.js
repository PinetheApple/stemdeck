// Audio worklet that captures the input in the playback context.
//
// It stamps the context frame of the first captured sample, so the take can be
// placed against the song on the same clock, and fills any render quantum the
// browser skipped with silence, so sample n of the take is always frame0 + n.
// Captured audio goes to the page in interleaved batches.

const BATCH_FRAMES = 2048;
const QUANTUM_FRAMES = 128;

class StemdeckRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.pick = options.processorOptions.channels;
    this.batch = new Float32Array(BATCH_FRAMES * this.pick.length);
    this.filled = 0;
    this.nextFrame = null;
    this.dropped = 0;
    this.peak = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data !== "stop") return;
      this.send();
      this.port.postMessage({ type: "stopped", dropped: this.dropped });
      this.stopped = true;
    };
  }

  send() {
    if (!this.filled) return;
    const samples = this.batch.slice(0, this.filled * this.pick.length);
    this.port.postMessage({ type: "audio", samples, peak: this.peak }, [samples.buffer]);
    this.filled = 0;
    this.peak = 0;
  }

  push(input, frames) {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.pick.length; c++) {
        const channel = input ? input[Math.min(this.pick[c], input.length - 1)] : null;
        const v = channel ? channel[f] : 0;
        this.batch[this.filled * this.pick.length + c] = v;
        if (Math.abs(v) > this.peak) this.peak = Math.abs(v);
      }
      this.filled += 1;
      if (this.filled === BATCH_FRAMES) this.send();
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    if (this.nextFrame === null) {
      this.port.postMessage({ type: "start", frame: currentFrame, rate: sampleRate });
    } else if (currentFrame > this.nextFrame) {
      this.dropped += Math.round((currentFrame - this.nextFrame) / QUANTUM_FRAMES);
      this.push(null, currentFrame - this.nextFrame);
    }
    const frames = input[0].length;
    this.push(input, frames);
    this.nextFrame = currentFrame + frames;
    return true;
  }
}

registerProcessor("stemdeck-recorder", StemdeckRecorder);
