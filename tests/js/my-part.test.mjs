// My part: which lanes are mine, what each choice mutes, and which choice the mix matches (myPart.js).
// Run:  node tests/js/my-part.test.mjs

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = { documentElement: { getAttribute: () => null }, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { PRESET, activePreset, canUsePreset, mutesFor, partLanes } = await import("../../static/js/myPart.js");

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- got ${got}, want ${want}`);
  }
}

const FOUR = ["vocals", "drums", "bass", "other"];
const WITH_ORIGINAL = ["original", "vocals", "drums", "bass", "other"];
const SPLIT = ["drums", "lead_vocals", "backing_vocals", "bass"];
const entry = (muted = false, soloed = false) => ({ volume: 1, muted, soloed, pitch: 0 });
const mixWith = (lanes, muted = [], soloed = []) =>
  Object.fromEntries(lanes.map((n) => [n, entry(muted.includes(n), soloed.includes(n))]));

check("a part the song has is its own lane", partLanes("bass", FOUR), ["bass"]);
check("a part the song lacks has no lanes", partLanes("guitar", FOUR), []);
check("vocals on a split song are both split lanes", partLanes("vocals", SPLIT), ["lead_vocals", "backing_vocals"]);
check("drums on a split song stay drums", partLanes("drums", SPLIT), ["drums"]);

check(
  "Full band unmutes every loaded lane, original included",
  mutesFor(PRESET.FULL_BAND, "bass", WITH_ORIGINAL),
  { original: false, vocals: false, drums: false, bass: false, other: false },
);
check(
  "Without me mutes only my part",
  mutesFor(PRESET.WITHOUT_ME, "bass", WITH_ORIGINAL),
  { original: false, vocals: false, drums: false, bass: true, other: false },
);
check(
  "Only me mutes everything else, original included",
  mutesFor(PRESET.ONLY_ME, "bass", WITH_ORIGINAL),
  { original: true, vocals: true, drums: true, bass: false, other: true },
);
check(
  "Only me with split vocals keeps both vocal lanes",
  mutesFor(PRESET.ONLY_ME, "vocals", SPLIT),
  { drums: true, lead_vocals: false, backing_vocals: false, bass: true },
);

check("nothing muted is Full band", activePreset("bass", FOUR, mixWith(FOUR)), PRESET.FULL_BAND);
check("my part muted is Without me", activePreset("bass", FOUR, mixWith(FOUR, ["bass"])), PRESET.WITHOUT_ME);
check(
  "all but my part muted is Only me",
  activePreset("bass", FOUR, mixWith(FOUR, ["vocals", "drums", "other"])),
  PRESET.ONLY_ME,
);
check("a manual mute that matches none is none", activePreset("bass", FOUR, mixWith(FOUR, ["drums"])), null);
check("a solo means no choice is on", activePreset("bass", FOUR, mixWith(FOUR, [], ["drums"])), null);
check("a muted original is not Full band", activePreset("bass", WITH_ORIGINAL, mixWith(WITH_ORIGINAL, ["original"])), null);

check("Full band works without my part", canUsePreset(PRESET.FULL_BAND, "guitar", FOUR), true);
check("Without me needs my part", canUsePreset(PRESET.WITHOUT_ME, "guitar", FOUR), false);
check("Only me needs my part", canUsePreset(PRESET.ONLY_ME, "guitar", FOUR), false);
check("no song loaded, nothing works", canUsePreset(PRESET.FULL_BAND, "bass", []), false);
check("no song loaded, nothing is on", activePreset("bass", [], {}), null);
check(
  "a missing part leaves only Full band able to be on",
  activePreset("guitar", FOUR, mixWith(FOUR, ["vocals", "drums", "bass", "other"])),
  null,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
