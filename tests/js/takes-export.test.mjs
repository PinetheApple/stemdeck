// Which recording tracks an export carries ("Takes in the mix").
//
// Run:  node tests/js/takes-export.test.mjs

import {
  TAKE_PITCH,
  exportTakeRows,
  takeLanes,
  tickedTrackIds,
  withTakeLanes,
} from "../../static/js/takesExportModel.js";

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
const EMPTY = "k00000003";
const view = (id, name, take) => ({ id, name, activeTake: take ? { id: `t-${id}`, label: take } : null });
const VIEWS = [view(VOICE, "Voice", "Take 2"), view(GUITAR, "Guitar", "Take 1"), view(EMPTY, "Keys", null)];
const MIX = {
  [VOICE]: { volume: 0.8, muted: false, soloed: false },
  [GUITAR]: { volume: 1, muted: true, soloed: false },
  [EMPTY]: { volume: 1, muted: false, soloed: false },
};
const mixOf = (id) => MIX[id];
const STEMS = { names: ["vocals", "drums"], gains: [1, 0.5], pitches: [2, 0] };

const rows = exportTakeRows(VIEWS, mixOf, new Map());
check("a track without a take is not listed", rows.length === 2 && !rows.some((r) => r.trackId === EMPTY));
check("unmuted track ticked by default", rows[0].ticked === true && rows[0].muted === false);
check("muted track unticked by default", rows[1].ticked === false && rows[1].muted === true);
check("row names the track and its active take", rows[0].name === "Voice" && rows[0].takeLabel === "Take 2");

const flipped = exportTakeRows(VIEWS, mixOf, new Map([[VOICE, false], [GUITAR, true]]));
check("a tick overrides the mute default", flipped[0].ticked === false && flipped[1].ticked === true);

const lanes = takeLanes(rows);
check("only ticked tracks become lanes", lanes.length === 1 && lanes[0].id === VOICE);
check("a lane plays at the track volume", lanes[0].gain === 0.8);

const silent = takeLanes(exportTakeRows([view(VOICE, "Voice", "Take 2")], () => ({ volume: 0, muted: false }), new Map()));
check("a ticked track at zero volume adds no lane", silent.length === 0);

const mix = withTakeLanes(STEMS, lanes);
check("track ids follow the stems", mix.names.join() === `vocals,drums,${VOICE}`);
check("gains line up with the names", mix.gains.join() === "1,0.5,0.8");
check("a take lane is never transposed", mix.pitches.join() === `2,0,${TAKE_PITCH}` && TAKE_PITCH === 0);
check("stems keep their lists when no take is ticked", withTakeLanes(STEMS, []).names.join() === "vocals,drums");
check("the stems' lists are not mutated", STEMS.names.length === 2 && STEMS.gains.length === 2);

check("zip carries only ticked tracks", tickedTrackIds(rows).join() === VOICE);
check("zip carries a ticked muted track", tickedTrackIds(flipped).join() === GUITAR);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
