// Film view timing: the camera's first frame against the first audio frame,
// where the picture sits on the song, and the trim handles' maths.
//
// Run:  node tests/js/film-timing.test.mjs

import {
  CLOCK_CAPTURE,
  CLOCK_RECORDER_START,
  FIRST_FRAME_OFFSET_MAX_MS,
  TRIM_MIN_SEC,
  cameraTiming,
  dragTrim,
  perfToCtxSec,
  secAtFraction,
  songFraction,
} from "../../static/js/filmTiming.js";

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

// The context clock read at performance time 5000 ms said 2.0 s.
const STAMP = { contextTime: 2, performanceTime: 5000 };

check("performance time maps onto the context clock", near(perfToCtxSec(5250, STAMP), 2.25));
check("a frame before the stamp maps before it", near(perfToCtxSec(4900, STAMP), 1.9));

{
  const timing = cameraTiming({ captureMs: 5100, startMs: 5050, stamp: STAMP, c0: 2.04 });
  check("a capture time wins over the recorder start", timing.first_frame_clock === CLOCK_CAPTURE);
  check("the offset is the first frame minus the first audio frame", near(timing.first_frame_offset_ms, 60, 1e-6), String(timing.first_frame_offset_ms));
}

{
  const timing = cameraTiming({ captureMs: null, startMs: 5000, stamp: STAMP, c0: 2.05 });
  check("no capture time falls back to the recorder start", timing.first_frame_clock === CLOCK_RECORDER_START);
  check("a camera that started first gives a negative offset", near(timing.first_frame_offset_ms, -50, 1e-6), String(timing.first_frame_offset_ms));
}

check("no first audio frame gives no timing", cameraTiming({ captureMs: 5100, startMs: 5000, stamp: STAMP, c0: null }) === null);
check("no camera time gives no timing", cameraTiming({ captureMs: null, startMs: null, stamp: STAMP, c0: 2 }) === null);
check("no clock stamp gives no timing", cameraTiming({ captureMs: 5100, startMs: 5000, stamp: null, c0: 2 }) === null);
{
  const farMs = STAMP.performanceTime + FIRST_FRAME_OFFSET_MAX_MS + 1000;
  check("an offset the server would refuse gives no timing", cameraTiming({ captureMs: farMs, startMs: null, stamp: STAMP, c0: 2 }) === null);
}

const SONG = 200;
check("song fraction", near(songFraction(50, SONG), 0.25));
check("song fraction clamps", songFraction(-3, SONG) === 0 && songFraction(400, SONG) === 1);
check("song fraction of an unknown length is 0", songFraction(10, 0) === 0);
check("seconds at a fraction", near(secAtFraction(0.5, SONG), 100));
check("seconds at a fraction clamp", secAtFraction(1.4, SONG) === SONG);

const SPAN = { start_sec: 20, end_sec: 180 };
{
  const trim = dragTrim({ span: SPAN, trim: null, edge: "in", sec: 30 });
  check("dragging the start sets the trim from there to the span's end", trim?.in_sec === 30 && trim?.out_sec === 180, JSON.stringify(trim));
}
{
  const trim = dragTrim({ span: SPAN, trim: { in_sec: 30, out_sec: 150 }, edge: "out", sec: 400 });
  check("the end clamps to the span", trim?.out_sec === 180 && trim?.in_sec === 30, JSON.stringify(trim));
}
{
  const trim = dragTrim({ span: SPAN, trim: { in_sec: 30, out_sec: 150 }, edge: "in", sec: 149.8 });
  check("the start stays a minimum length before the end", near(trim.in_sec, 150 - TRIM_MIN_SEC), JSON.stringify(trim));
}
{
  const trim = dragTrim({ span: SPAN, trim: { in_sec: 30, out_sec: 150 }, edge: "out", sec: 10 });
  check("the end stays a minimum length after the start", near(trim.out_sec, 30 + TRIM_MIN_SEC), JSON.stringify(trim));
}
check(
  "handles back at both span edges clear the trim",
  dragTrim({ span: SPAN, trim: { in_sec: 20, out_sec: 150 }, edge: "out", sec: 190 }) === null,
);
check(
  "a span shorter than the minimum cannot be trimmed",
  dragTrim({ span: { start_sec: 10, end_sec: 10.5 }, trim: null, edge: "in", sec: 10.2 }) === null,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
