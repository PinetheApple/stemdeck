// The microphone side of recording: opening an input, metering it, hearing it,
// and capturing it through recorderWorklet.js in a given audio context.

const WORKLET_URL = "/js/recorderWorklet.js";
const WORKLET_NAME = "stemdeck-recorder";
const METER_FFT = 1024;
const STOP_TIMEOUT_MS = 1000;

export const INPUT_PROBLEM = {
  noDevice: "noDevice",
  denied: "denied",
  unsupported: "unsupported",
};

// Recording needs the raw input: these filters reshape it and add their own delay.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Opens an input; rejects with an Error whose `problem` names an INPUT_PROBLEM. */
export async function openInput(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) throw withProblem(INPUT_PROBLEM.unsupported);
  const audio = { ...RAW_AUDIO, channelCount: { ideal: 2 } };
  if (deviceId) audio.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    throw withProblem(denied ? INPUT_PROBLEM.denied : INPUT_PROBLEM.noDevice, err);
  }
}

function withProblem(problem, cause) {
  const err = new Error(problem, { cause });
  err.problem = problem;
  return err;
}

export function closeInput(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function inputInfo(stream) {
  const track = stream?.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  return {
    deviceId: settings.deviceId ?? "",
    label: track?.label ?? "",
    channelCount: settings.channelCount ?? 1,
    latencySec: Number.isFinite(settings.latency) ? settings.latency : 0,
  };
}

export async function listInputs() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
  return devices.filter((device) => device.kind === "audioinput");
}

/** The input feeding one context: a level meter and an optional monitor path. */
export function connectInput(ctx, stream) {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = METER_FFT;
  source.connect(analyser);
  const monitor = ctx.createGain();
  monitor.gain.value = 0;
  source.connect(monitor).connect(ctx.destination);
  const data = new Float32Array(METER_FFT);
  return {
    ctx,
    source,
    /** RMS amplitude of the latest block. */
    level() {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      return Math.sqrt(sum / data.length);
    },
    setMonitor(on) {
      monitor.gain.value = on ? 1 : 0;
    },
    disconnect() {
      source.disconnect();
      monitor.disconnect();
    },
  };
}

const modules = new WeakMap();

function loadWorklet(ctx) {
  if (!modules.has(ctx)) modules.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL));
  return modules.get(ctx);
}

/**
 * Capture `channels` (input channel indices) of a connected input.
 * `onStart(ctxTimeSec, rate)` fires once for the first frame; `onAudio(samples, peak)` per batch.
 */
export async function startCapture(input, channels, { onStart, onAudio }) {
  const { ctx } = input;
  await loadWorklet(ctx);
  const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { channels },
  });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  input.source.connect(node).connect(sink).connect(ctx.destination);
  let stopped = null;
  node.port.onmessage = function onCaptureMessage({ data }) {
    if (data.type === "start") onStart(data.frame / data.rate, data.rate);
    else if (data.type === "audio") onAudio(data.samples, data.peak);
    else if (data.type === "stopped") stopped?.(data.dropped);
  };
  return { stop: () => stopNode(node, sink, (resolve) => { stopped = resolve; }) };
}

function stopNode(node, sink, onStopped) {
  return new Promise(function waitForLastBatch(resolve) {
    const timer = setTimeout(() => resolve(0), STOP_TIMEOUT_MS);
    onStopped(function stoppedWith(dropped) {
      clearTimeout(timer);
      resolve(dropped);
    });
    try {
      node.port.postMessage("stop");
    } catch {
      resolve(0);
    }
  }).finally(() => {
    node.disconnect();
    sink.disconnect();
  });
}
