// Both audio engines carry the EQ slots: a flat mix builds no node and keeps
// today's graph, a lane EQ lands between the lane's gain and its analyser,
// and the master chain sits between the master gain and the speakers.
//
// Run:  node tests/js/engine-fx.test.mjs

import { normalizeEq } from "../../static/js/eqMath.js";
import { FakeContext, FakeNode, FakeParam, createChecker } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const WAV_BYTES = 44 + 64 * 2;

class EngineContext extends FakeContext {
  constructor() {
    super({ sampleRate: 44100 });
    this.audioWorklet = null;
  }

  createBufferSource() {
    const node = new FakeNode(this, "source");
    node.playbackRate = new FakeParam(1);
    node.start = () => {};
    node.stop = () => {};
    return node;
  }

  async decodeAudioData() {
    return { duration: 1, numberOfChannels: 2, sampleRate: 44100, length: 44100 };
  }

  addEventListener() {}
  removeEventListener() {}
  async resume() {}
  async close() {}
}

function wavBytes() {
  const bytes = new ArrayBuffer(WAV_BYTES);
  const view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, WAV_BYTES - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, WAV_BYTES - 44, true);
  return new Uint8Array(bytes);
}

const WAV = wavBytes();
globalThis.window = { AudioContext: EngineContext };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => `bytes 0-${WAV.length - 1}/${WAV.length}` },
  arrayBuffer: async () => WAV.slice().buffer,
});

const { createAudioEngine } = await import("../../static/js/audioEngine.js");
const { createChunkedAudioEngine } = await import("../../static/js/chunkedAudioEngine.js");
const BELL = normalizeEq({ params: { bands: [{ type: "bell", f: 400, g: 5 }] } });
const stems = ["vocals", "bass"].map((name) => ({ name, url: `/${name}.wav` }));

const masterNodeOf = (ctx) => ctx.ofKind("gain").find((g) => g.feeds(ctx.destination));
const gainFeeding = (ctx, analyser) => ctx.ofKind("gain").find((g) => g.feeds(analyser));

async function verify(label, create) {
  const ctx = new EngineContext();
  const engine = create(stems, { context: ctx });
  await engine.ready;
  const [vocalsAnalyser] = engine.getAnalysers("vocals");
  check(`${label}: flat builds no filter`, ctx.ofKind("biquad").length === 0);
  check(`${label}: flat keeps gain -> analyser`, !!gainFeeding(ctx, vocalsAnalyser));
  const master = masterNodeOf(ctx);
  check(`${label}: flat keeps master -> destination`, !!master);
  check(`${label}: offers the EQ`, engine.supportsEq === true && engine.supportsMaster === true);
  check(`${label}: a lane EQ is accepted`, engine.setLaneEq("vocals", BELL) === true);
  check(`${label}: the lane gets a filter`, ctx.ofKind("biquad").length === 1 && engine.laneSectionCount("vocals") === 1);
  check(`${label}: other lanes keep gain -> analyser`, !!gainFeeding(ctx, engine.getAnalysers("bass")[0]));
  engine.setMasterEq(BELL);
  check(`${label}: the master chain follows the master gain`, !master.feeds(ctx.destination)
    && ctx.ofKind("biquad").length === 2);
  engine.destroy();
  check(`${label}: destroy disconnects the filters`, ctx.ofKind("biquad").every((node) => node.out.length === 0));
}

await verify("full-decode engine", createAudioEngine);
await verify("chunked engine", createChunkedAudioEngine);

finish();
