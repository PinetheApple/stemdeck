// The take folder's rows and a take's place on the timeline.
//
// Run:  node tests/js/takes-state.test.mjs

import {
  ROW_TAKE,
  ROW_UNFINISHED,
  ROW_ELSEWHERE,
  buildTrackViews,
  clipSpan,
  laneSpace,
  nextName,
  slicePeaks,
} from "../../static/js/takesState.js";

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

const VOICE = "k00000001";
const GUITAR = "k00000002";
const entry = (id, track, extra = {}) => ({
  id,
  track_id: track,
  label: id,
  duration_sec: 10,
  placement_sec: 5,
  ...extra,
});

const LISTING = {
  tracks: [
    { id: GUITAR, name: "Guitar", order: 1, active_take_id: "t00000003" },
    { id: VOICE, name: "Voice", order: 0, active_take_id: "t00000002" },
  ],
  takes: [entry("t00000001", VOICE), entry("t00000002", VOICE), entry("t00000003", GUITAR)],
  open: [{ id: "t000000aa", track_id: VOICE, label: "Take 3", bytes: 4096, recoverable: true }],
};

{
  const [voice, guitar] = buildTrackViews(LISTING);
  check("tracks come in their order", voice.id === VOICE && guitar.id === GUITAR);
  check("the active take is the track's dot", voice.activeTake?.id === "t00000002");
  check(
    "one row per finished take, then the unfinished one",
    voice.rows.map((row) => row.kind).join() === [ROW_TAKE, ROW_TAKE, ROW_UNFINISHED].join(),
  );
  check("exactly one take row is active", voice.rows.filter((row) => row.active).length === 1);
  check("an unfinished take opens its folder", voice.folderOpen === true);
  check("a folder with nothing to answer stays closed", guitar.folderOpen === false);
}

{
  const live = { id: "t000000bb", track_id: GUITAR, label: "Take 2", bytes: 2048, recoverable: false };
  const [, guitar] = buildTrackViews({ ...LISTING, open: [live] });
  const row = guitar.rows.at(-1);
  check("a take still recording elsewhere is shown without actions", row.kind === ROW_ELSEWHERE, row.kind);
  check("a take still recording elsewhere asks nothing", guitar.folderOpen === false);
}

{
  const [voice] = buildTrackViews(LISTING, { ownTakeIds: new Set(["t000000aa"]) });
  check("the take this page is recording is not offered as unfinished", voice.rows.length === 2 && !voice.folderOpen);
}

{
  const [, guitar] = buildTrackViews(LISTING, { review: "t00000003" });
  check("the take just recorded asks keep or delete", guitar.rows[0].review && guitar.folderOpen);
}

{
  const [, guitar] = buildTrackViews(LISTING, { openFolders: new Set([GUITAR]) });
  check("an opened folder stays open", guitar.folderOpen);
}

{
  const views = buildTrackViews(LISTING);
  const space = laneSpace(views, 40);
  check("each track is a lane", space.lanes === 2);
  check("open folder rows and the add row are short rows", space.fixedPx === 4 * 40, String(space.fixedPx));
}

{
  const name = (n) => `Take ${n}`;
  check("the next name counts on", nextName(["Take 1", "Take 2"], name) === "Take 3");
  check("the next name skips one in use", nextName(["Take 2"], name) === "Take 3");
  check("the first name is one", nextName([], name) === "Take 1");
}

{
  const span = clipSpan({ placement_sec: 10, duration_sec: 20 }, 100);
  check("a clip spans its placement", span.start === 0.1 && span.end === 0.3);
  const early = clipSpan({ placement_sec: -2, duration_sec: 4 }, 100);
  check("a take placed before the song starts at zero", early.start === 0 && early.end === 0.02);
  check("a take entirely before the song has no clip", clipSpan({ placement_sec: -5, duration_sec: 4 }, 100) === null);
  const late = clipSpan({ placement_sec: 90, duration_sec: 20 }, 100);
  check("a clip stops at the song's end", late.end === 1);
}

{
  const points = Array.from({ length: 100 }, (_, i) => [-i, i]);
  const sliced = slicePeaks(points, { start: 0.1, end: 0.3 });
  check("peaks are cut to the clip", sliced.length === 20 && sliced[0][1] === 10);
  check("no peaks without a span", slicePeaks(points, null).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
