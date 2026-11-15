// The filmed-take export: what the dialog asks the server for, and what it
// shows for each state of the render.
//
// Run:  node tests/js/video-export-model.test.mjs

import {
  DEFAULT_EXPORT_PREFS,
  EXPORT_PHASE,
  encoderLabel,
  exportPrefs,
  exportState,
  minutesLeft,
  renderBody,
  videoFilename,
} from "../../static/js/videoExportModel.js";

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check("1080p at 30 fps by default", DEFAULT_EXPORT_PREFS.size === "1080" && DEFAULT_EXPORT_PREFS.fps === 30);
check("stored prefs are kept", same(exportPrefs({ size: "720", fps: 60 }), { size: "720", fps: 60 }));
check("a stored value the server refuses falls back", same(exportPrefs({ size: "2160", fps: 25 }), DEFAULT_EXPORT_PREFS));
check("nothing stored", same(exportPrefs(null), DEFAULT_EXPORT_PREFS));

{
  const lanes = { names: ["vocals", "drums", "trk_video"], gains: [1, 0.5, 1], pitches: [0, 0, 0] };
  const body = renderBody({ lanes, takeTrackId: "trk_video", prefs: { size: "720", fps: 24 } });
  check("the take's own track is left out of the backing", same(body.stems, ["vocals", "drums"]) && same(body.gains, [1, 0.5]), JSON.stringify(body));
  check("size and fps go as asked", body.size === "720" && body.fps === 24);
  check("no pitch list when nothing is transposed", !("pitches" in body));
}
{
  const lanes = { names: ["bass"], gains: [1], pitches: [2] };
  check("a transposed lane sends its pitch", same(renderBody({ lanes, takeTrackId: "x", prefs: DEFAULT_EXPORT_PREFS }).pitches, [2]));
}

check("idle before any render", exportState({ status: "none" }).phase === EXPORT_PHASE.options);
check("queued waits", exportState({ status: "queued", progress: 0 }).phase === EXPORT_PHASE.waiting);
{
  const state = exportState({ status: "running", progress: 0.42 });
  check("running shows its percent", state.phase === EXPORT_PHASE.running && state.percent === 42, JSON.stringify(state));
}
{
  const state = exportState({ status: "done", encoder: "h264_nvenc", family: "nvidia", fallback_reason: null });
  check("done names the encoder", state.phase === EXPORT_PHASE.done && state.encoder === "NVENC" && !state.cpuFallback, JSON.stringify(state));
}
{
  const state = exportState({ status: "done", encoder: "libx264", family: "cpu", fallback_reason: "invalid-fps" });
  check("a GPU failure redone on the CPU says so", state.cpuFallback === true, JSON.stringify(state));
}
check("a full disk has its own words", exportState({ status: "error", error: "disk-full" }).diskFull === true);
check("any other error fails", exportState({ status: "error", error: "timeout" }).phase === EXPORT_PHASE.failed);
check("a cancelled render goes back to the options", exportState({ status: "cancelled" }).phase === EXPORT_PHASE.options);

check("encoder labels", encoderLabel("h264_vaapi") === "VAAPI" && encoderLabel("h264_videotoolbox") === "VideoToolbox");
check("an unknown encoder shows as it is", encoderLabel("h264_foo") === "h264_foo");
check("libx264 is the CPU", encoderLabel("libx264") === "CPU");

check("no estimate before any progress", minutesLeft(0, 5000) === null);
check("about one minute left at 50% after a minute", minutesLeft(0.5, 60_000) === 1);
check("never less than one minute", minutesLeft(0.99, 60_000) === 1);

check("file name from the song and take", videoFilename("Morning Light", "Take 1") === "Morning_Light_Take_1.mp4");
check("file name with no title", videoFilename("", "Take 1") === "Take_1.mp4");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
