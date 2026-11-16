// Settings > Export: the Video encoder choices and the Test encoders table,
// from GET /api/video-encoders and POST /api/video-encoders/test.
//
// Run:  node tests/js/video-encoder-model.test.mjs

import { ROW_STATE, encoderChoices, encoderName, testRows } from "../../static/js/videoEncoderModel.js";

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

const ok = (speed) => ({ ok: true, reason: null, detail: null, speed, transient: false, device: null });
const bad = (reason) => ({ ok: false, reason, detail: "x", speed: null, transient: false, device: null });

const STATUS = {
  policy: { value: "auto", source: "setting" },
  choices: ["auto", "cpu", "h264_nvenc", "h264_vaapi", "h264_qsv"],
  candidates: ["h264_nvenc", "h264_vaapi", "h264_qsv"],
  disabled: [],
  render_available: true,
  last_test: null,
};
const TESTED = {
  ...STATUS,
  disabled: ["h264_qsv"],
  last_test: {
    at: 1,
    rows: [
      { encoder: "h264_nvenc", family: "nvidia", disabled: false, results: { "720p30": ok(30.1), "1080p60": ok(9.2) } },
      { encoder: "h264_vaapi", family: "vaapi", disabled: false, results: { "720p30": bad("missing"), "1080p60": bad("missing") } },
      { encoder: "h264_qsv", family: "intel", disabled: true, results: { "720p30": bad("no-device"), "1080p60": bad("no-device") } },
      { encoder: "libx264", family: "cpu", disabled: false, results: { "720p30": ok(4.4), "1080p60": ok(1.3) } },
    ],
  },
};

{
  const choices = encoderChoices(STATUS);
  check("every choice is listed in order", choices.map((c) => c.value).join() === STATUS.choices.join());
  check("nothing disabled before a test", choices.every((c) => !c.disabled));
}
{
  const choices = encoderChoices(TESTED);
  const of = (v) => choices.find((c) => c.value === v);
  check("an encoder that failed its test is disabled", of("h264_vaapi").disabled && of("h264_vaapi").failed);
  check("one switched off this session is disabled", of("h264_qsv").disabled);
  check("a passing encoder stays enabled", !of("h264_nvenc").disabled);
  check("Auto and CPU are never disabled", !of("auto").disabled && !of("cpu").disabled);
}
{
  const choices = encoderChoices({ ...TESTED, policy: { value: "h264_vaapi", source: "setting" } });
  check("the chosen encoder stays selectable even after failing", !choices.find((c) => c.value === "h264_vaapi").disabled);
}

{
  const rows = testRows(STATUS, { testing: false });
  check("before a test: one row per candidate plus the CPU", rows.map((r) => r.encoder).join() === "h264_nvenc,h264_vaapi,h264_qsv,libx264");
  check("before a test the rows are idle", rows.every((r) => r.state === ROW_STATE.idle));
}
check("while testing every row says so", testRows(STATUS, { testing: true }).every((r) => r.state === ROW_STATE.testing));
{
  const rows = testRows(TESTED, { testing: false });
  const of = (e) => rows.find((r) => r.encoder === e);
  check("a passing row works, at its slowest speed", of("h264_nvenc").state === ROW_STATE.works && of("h264_nvenc").speed === 9.2);
  check("a failing row names its reason", of("h264_vaapi").state === ROW_STATE.failed && of("h264_vaapi").reason === "missing");
  check("the CPU row is last and works", rows.at(-1).encoder === "libx264" && rows.at(-1).state === ROW_STATE.works);
  check("names and makers", of("h264_nvenc").name === "NVENC" && of("h264_nvenc").maker === "NVIDIA");
}
{
  const half = {
    ...TESTED,
    last_test: {
      at: 1,
      rows: [{ encoder: "h264_nvenc", family: "nvidia", disabled: false, results: { "720p30": ok(30), "1080p60": bad("timeout") } }],
    },
  };
  check("one failed geometry fails the row", testRows(half, { testing: false })[0].state === ROW_STATE.failed);
  check("an invalid-* reason reads as invalid", testRows({
    ...half,
    last_test: { at: 1, rows: [{ encoder: "h264_nvenc", family: "nvidia", disabled: false, results: { a: bad("invalid-fps") } }] },
  }, { testing: false })[0].reason === "invalid");
}

{
  const of = (status, v) => encoderChoices(status).find((c) => c.value === v);
  const picked = { ...STATUS, auto_pick: "h264_nvenc" };
  check("Auto names what it would use when Auto is the policy", of(picked, "auto").pick === "h264_nvenc");
  check("no other choice carries the pick", of(picked, "cpu").pick === null && of(picked, "h264_nvenc").pick === null);
  check(
    "a forced CPU or encoder keeps Auto's label plain",
    of({ ...picked, policy: { value: "cpu", source: "env" } }, "auto").pick === null
      && of({ ...picked, policy: { value: "h264_vaapi", source: "setting" } }, "auto").pick === null,
  );
  check("nothing cached: plain Auto", of({ ...STATUS, auto_pick: null }, "auto").pick === null);
}

check("encoder names", encoderName("h264_vaapi") === "VAAPI" && encoderName("h264_videotoolbox") === "VideoToolbox");
check("an unknown encoder shows as it is", encoderName("h264_foo") === "h264_foo");
check("libx264 is the CPU", encoderName("libx264") === "CPU");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
