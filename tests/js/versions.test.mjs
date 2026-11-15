// A song's versions: store keys, lane sets and automatic names (versionModel.js).
// Run:  node tests/js/versions.test.mjs

import {
  DEFAULT_VERSION_ID,
  addedName,
  hasVersionRows,
  missingStems,
  mixStoreKey,
  nextVersionName,
  openVersionOf,
  sameLanes,
  versionLabel,
} from "../../static/js/versionModel.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}`, detail);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const LABELS = {
  "versions.original": "Original",
  "versions.untitled": "Version {n}",
  "versions.added": "+ {stems}",
  "stem.guitar": "Guitar",
  "stem.piano": "Piano",
  "stem.bass": "Bass",
};
const t = (key, vars = {}) => (LABELS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
const version = (id, name, stems = ["vocals"]) => ({ id, name, stems, created_at: 1 });

check("the default version keeps the legacy mix key", mixStoreKey("abc123", DEFAULT_VERSION_ID) === "stemdeck:mix:abc123");
check("no version id is the default", mixStoreKey("abc123") === "stemdeck:mix:abc123");
check("another version has its own key", mixStoreKey("abc123", "1a2b3c4d") === "stemdeck:mix:abc123:1a2b3c4d");

check("same lanes in any order", sameLanes(["drums", "bass"], ["bass", "drums"]));
check("a missing lane differs", !sameLanes(["drums", "bass"], ["drums"]));
check("one swapped lane differs", !sameLanes(["drums", "bass"], ["drums", "piano"]));
check("duplicates do not make lanes the same", !sameLanes(["drums", "drums"], ["drums", "bass"]));

check(
  "missing stems keep the canonical order",
  same(missingStems(["vocals", "drums", "bass", "other"]), ["guitar", "piano"]),
);
check("a version with every stem misses none", same(missingStems(["other", "piano", "guitar", "bass", "drums", "vocals"]), []));

check("the first new version is Version 2", nextVersionName([version("main", null)], t) === "Version 2");
check(
  "a used name is skipped",
  nextVersionName([version("main", null), version("a", "Version 2"), version("b", "Version 4")], t) === "Version 3",
);

check("added stems name the version", addedName(["guitar", "piano"], t) === "+ Guitar, Piano");
check("one added stem", addedName(["bass"], t) === "+ Bass");

check("the untouched default reads Original", versionLabel(version("main", null), t) === "Original");
check("a named version reads its name", versionLabel(version("a", "No vocals"), t) === "No vocals");

const track = { versions: [version("main", null), version("a", "Two")], openVersion: "a" };
check("the open version is the one recorded", openVersionOf(track)?.id === "a");
check("an unknown open id falls back to the first", openVersionOf({ ...track, openVersion: "gone" })?.id === "main");
check("a track without versions has none open", openVersionOf({}) === null);

check("two versions get rows", hasVersionRows(track));
check("one version is a plain row", !hasVersionRows({ versions: [version("main", null)] }));
check("no versions is a plain row", !hasVersionRows({}));

console.log(`versions: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
