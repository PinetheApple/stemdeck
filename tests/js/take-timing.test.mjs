// Where a take is placed and when its clip plays.
//
// Run:  node tests/js/take-timing.test.mjs

import { songTimeAtCtx } from "../../static/js/recorderTiming.js";
import { SCHEDULE_LEAD_SEC, planClip, scheduleFrom, sourceRate } from "../../static/js/takesSchedule.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** An engine clock: sources started at context `startCtx` from song `startSong`, at `rate`. */
function engineClock({ startCtx, startSong, rate = 1, graphDelay = 0 }) {
  const ctxToSource = (c) => startSong + (c - startCtx) * rate;
  const sourceToCtx = (s) => startCtx + (s - startSong) / rate;
  const output = (c) => Math.max(startSong, ctxToSource(c) - graphDelay * rate);
  return { ctxToSource, sourceToCtx, output };
}

{
  const GRAPH_DELAY = 0.12;
  const clock = engineClock({ startCtx: 10, startSong: 30, graphDelay: GRAPH_DELAY });
  const now = 12;
  const firstFrame = 11.5;
  const frame0 = songTimeAtCtx(clock.ctxToSource, now, clock.output(now), firstFrame);
  check("frame0 is the song leaving the graph at the first frame", near(frame0, 31.5 - GRAPH_DELAY), String(frame0));
}

{
  const COUNT_IN = 2;
  const clock = engineClock({ startCtx: 10 + COUNT_IN, startSong: 30 });
  const now = 13;
  const frame0 = songTimeAtCtx(clock.ctxToSource, now, clock.output(now), 10.5);
  check("a frame captured during the count-in lands before the start", near(frame0, 28.5), String(frame0));
}

{
  const clock = engineClock({ startCtx: 100, startSong: 0 });
  const from = scheduleFrom(clock.ctxToSource, 104, clock.output(104));
  check("scheduling starts a lead ahead of the sources", near(from, 4 + SCHEDULE_LEAD_SEC));
  const plan = planClip(2, 5, from, clock.sourceToCtx);
  check("a clip already sounding starts at the matching offset", near(plan.offset, from - 2) && near(plan.when, 100 + from));
}

{
  const seekTo = 1;
  const clock = engineClock({ startCtx: 200, startSong: seekTo });
  const plan = planClip(2, 5, scheduleFrom(clock.ctxToSource, 200, clock.output(200)), clock.sourceToCtx);
  check("after a seek before the clip it starts at its own beginning", plan.offset === 0 && near(plan.when, 201));
}

{
  const loopStart = 3;
  const clock = engineClock({ startCtx: 50, startSong: loopStart });
  const from = scheduleFrom(clock.ctxToSource, 50, clock.output(50));
  const plan = planClip(2, 5, from, clock.sourceToCtx);
  check("a loop wrap restarts the clip inside it", near(plan.offset, loopStart - 2 + SCHEDULE_LEAD_SEC));
}

{
  const SLOW = 0.75;
  const clock = engineClock({ startCtx: 10, startSong: 0, rate: SLOW });
  check("the source rate follows the speed", near(sourceRate(clock.ctxToSource, 11), SLOW));
  const plan = planClip(3, 2, 0, clock.sourceToCtx);
  check("at 0.75x the clip starts when the sources reach it", near(plan.when, 10 + 3 / SLOW) && plan.offset === 0);
}

{
  const clock = engineClock({ startCtx: 0, startSong: 0 });
  check("a clip already past plays nothing", planClip(2, 5, 7, clock.sourceToCtx) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
