// Trash and re-import decisions (librarySync.js).
// Run:  node tests/js/library-sync.test.mjs

import {
  REINSTATE_REPLACED,
  RELEASE_REPLACED,
  migrationTrashIds,
  replacedJobIds,
  replacementOutcome,
  serverTrashMoves,
} from "../../static/js/librarySync.js";

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

const job = (id, trashed = false) => ({ job_id: id, trashed_at: trashed ? 1 : null });

check(
  "migration pushes local Trash the server does not have",
  same(migrationTrashIds([job("a"), job("b", true), job("c")], new Set(["a", "b"])), ["a"]),
);
check(
  "migration never restores what the server trashed",
  same(migrationTrashIds([job("a", true)], new Set()), []),
);
check(
  "migration skips jobs the server does not list",
  same(migrationTrashIds([], new Set(["gone"])), []),
);

const moves = (jobs, { known = ["a", "b", "c"], trash = [], skip = [] } = {}) =>
  serverTrashMoves(jobs, { knownIds: new Set(known), trashIds: new Set(trash), skipIds: new Set(skip) });

check(
  "a job trashed on the server moves into the Trash",
  same(moves([job("a", true)]), { toTrash: ["a"], toRestore: [] }),
);
check(
  "a job restored on the server leaves the Trash",
  same(moves([job("a")], { trash: ["a"] }), { toTrash: [], toRestore: ["a"] }),
);
check(
  "agreeing states move nothing",
  same(moves([job("a", true), job("b")], { trash: ["a"] }), { toTrash: [], toRestore: [] }),
);
check(
  "a change still on its way up is left alone",
  same(moves([job("a"), job("b", true)], { trash: ["a"], skip: ["a", "b"] }), { toTrash: [], toRestore: [] }),
);
check(
  "an unknown job is not moved",
  same(moves([job("z", true)]), { toTrash: [], toRestore: [] }),
);

check("a finished replacement lets the old copy go to the server", replacementOutcome("done") === RELEASE_REPLACED);
check("a cancelled replacement puts the old copy back", replacementOutcome("cancelled") === REINSTATE_REPLACED);
check("a failed replacement puts the old copy back", replacementOutcome("error") === REINSTATE_REPLACED);
check("a replacement left unavailable puts the old copy back", replacementOutcome("unavailable") === REINSTATE_REPLACED);
for (const status of ["queued", "downloading", "separating", "processing", "stopped", undefined]) {
  check(`a replacement ${status} settles nothing`, replacementOutcome(status) === null);
}

check(
  "replaced jobs are the ones still waiting on their replacement",
  same([...replacedJobIds({ n1: { replaced: { id: "o1" } }, n2: {}, n3: { replaced: null } })], ["o1"]),
);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
