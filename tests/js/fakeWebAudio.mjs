// A minimal Web Audio graph for node tests: nodes record their edges and
// params record their automation, so a test can walk the graph and read the
// values the code scheduled.

export class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }

  cancelScheduledValues() { this.events.push("cancel"); }
  cancelAndHoldAtTime() { this.events.push("hold"); }
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }

  linearRampToValueAtTime(value, time) {
    this.events.push(["ramp", value, time]);
    this.value = value;
  }
}

export class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.out = [];
    ctx.nodes.push(this);
  }

  connect(destination, output = 0, input = 0) {
    this.out.push({ destination, output, input });
    return destination;
  }

  disconnect(destination, output = 0, input = 0) {
    if (destination === undefined) { this.out = []; return; }
    const before = this.out.length;
    this.out = this.out.filter((edge) =>
      !(edge.destination === destination && edge.output === output && edge.input === input));
    if (this.out.length === before) throw new Error("InvalidAccessError");
  }

  feeds(destination) {
    return this.out.some((edge) => edge.destination === destination);
  }
}

function withParams(node, names, value) {
  for (const name of names) node[name] = new FakeParam(value);
  return node;
}

export class FakeContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.nodes = [];
    this.currentTime = 1;
    this.sampleRate = sampleRate;
    this.state = "running";
    this.destination = new FakeNode(this, "destination");
  }

  createGain() { return withParams(new FakeNode(this, "gain"), ["gain"], 1); }
  createDelay() { return withParams(new FakeNode(this, "delay"), ["delayTime"], 0); }

  createBiquadFilter() {
    const node = withParams(new FakeNode(this, "biquad"), ["frequency", "Q", "gain"], 0);
    node.type = "lowpass";
    return node;
  }

  createDynamicsCompressor() {
    const node = withParams(
      new FakeNode(this, "compressor"),
      ["threshold", "knee", "ratio", "attack", "release"],
      0,
    );
    node.reduction = 0;
    return node;
  }

  createAnalyser() {
    const node = new FakeNode(this, "analyser");
    node.fftSize = 2048;
    return node;
  }

  ofKind(kind) {
    return this.nodes.filter((node) => node.kind === kind);
  }
}

export function createChecker() {
  const counts = { passed: 0, failed: 0 };
  function check(name, condition, detail = "") {
    if (condition) {
      counts.passed++;
      console.log(`PASS  ${name}`);
    } else {
      counts.failed++;
      console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
    }
  }
  function finish() {
    console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
    process.exit(counts.failed ? 1 : 0);
  }
  return { check, finish };
}

export const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
