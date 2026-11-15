// Feeds one graph the live spectrum of a lane (or the master) after its EQ.

import { TAP_SIDE } from "../fxChain.js";
import { getAnalyser, liveSampleRate, releaseAnalyser } from "../eqEngine.js";
import { SPEC_MIN_DB, SPEC_TILT_DB_OCT, columnBins, spectrumFrame } from "./eqGraphMath.js";

const COLUMN_PX = 2;
const FALL_DB_PER_FRAME = 1.5;

export class EqSpectrum {
  #graph;
  #host;
  #lane = null;
  #analyser = null;
  #data = null;
  #columns = null;
  #bins = null;
  #binsKey = "";

  constructor(graph, host) {
    this.#graph = graph;
    this.#host = host;
  }

  get lane() { return this.#lane; }

  /** Follow `lane`'s sound; null stops. Ask again after a song load (a new engine). */
  follow(lane) {
    this.#release();
    this.#lane = lane;
    this.#analyser = lane === null ? null : getAnalyser(lane, TAP_SIDE.post);
    this.#data = this.#analyser ? new Float32Array(this.#analyser.frequencyBinCount) : null;
    this.#columns = null;
    this.#graph.drawSpectrum(null);
  }

  frame() {
    if (!this.#analyser) return;
    const count = Math.max(2, Math.floor(this.#host.clientWidth / COLUMN_PX));
    if (!this.#columns || this.#columns.length !== count) this.#columns = new Float32Array(count).fill(SPEC_MIN_DB);
    this.#analyser.getFloatFrequencyData(this.#data);
    spectrumFrame(this.#binsFor(count), this.#data, this.#columns, FALL_DB_PER_FRAME);
    this.#graph.drawSpectrum(this.#columns);
  }

  #binsFor(count) {
    const key = `${count}|${this.#data.length}|${this.#host.clientWidth}`;
    if (key !== this.#binsKey) {
      const r = { x: 0, y: 0, w: this.#host.clientWidth, h: this.#host.clientHeight };
      this.#bins = columnBins(count, this.#data.length, liveSampleRate(), r, SPEC_TILT_DB_OCT);
      this.#binsKey = key;
    }
    return this.#bins;
  }

  #release() {
    if (this.#lane !== null && this.#analyser) releaseAnalyser(this.#lane, TAP_SIDE.post);
    this.#analyser = null;
  }
}
