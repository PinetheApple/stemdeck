// Each failure kind is named for what failed, and a kind with no label of its
// own reads as a generic failure rather than borrowing another kind's.
//
// Run:  node tests/js/notification-kinds.test.mjs

globalThis.window = {};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };

const { notifyFailure, clearFailures, getFailures, buildReportUrl } = await import(
  "../../static/js/notifications.js"
);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const titleOf = (record) => new URL(buildReportUrl(record)).searchParams.get("title");

const EXPECTED = {
  settings: "Settings not saved",
  favorite: "Favorite not saved",
  storage: "Library not saved",
  trash: "Trash not emptied",
  cancel: "Cancel failed",
  sections: "Sections not saved",
  beatgrid: "Beat grid not saved",
  tempo: "Tempo not saved",
};

for (const [kind, label] of Object.entries(EXPECTED)) {
  clearFailures();
  const record = notifyFailure({ kind, message: "it broke" });
  check(`kind "${kind}" is kept`, record.kind === kind, record.kind);
  check(`kind "${kind}" is labelled "${label}"`, titleOf(record) === `[Bug]: ${label}`, titleOf(record));
}

clearFailures();
const unknown = notifyFailure({ kind: "not-a-kind", message: "it broke" });
check("an unknown kind is not filed as an import", unknown.kind !== "import", unknown.kind);
check("an unknown kind reads as a generic failure", titleOf(unknown) === "[Bug]: Something failed", titleOf(unknown));
check("the record is kept", getFailures().length === 1);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
