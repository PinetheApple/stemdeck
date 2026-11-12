// t() falls back to English for a missing key, so a gap in one table still looks
// fine on screen; this reads each table's own keys for the import and queue text.
//
// Run:  node tests/js/import-queue-i18n.test.mjs

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");

let pass = 0,
  fail = 0;
const check = (name, cond) => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

const KEYS = [
  "job.networkError",
  "job.unexpectedError",
  "import.itemReason",
  "upload.reasonOversized",
  "upload.reasonQueueFull",
  "upload.skippedNamed",
  "upload.someNotAdded",
  "notif.queueStartFailed",
  "playlist.allInLibrary",
  "playlist.notAdded",
  "playlist.reason.inLibrary",
  "playlist.reason.tooLong",
  "playlist.reason.noCapacity",
  "reimport.title",
  "reimport.body",
  "reimport.confirm",
];
const PLURAL_KEYS = ["playlist.skip.inLibrary"];
const PLURAL_FORMS = { pl: ["one", "few", "many"] };
const FALLBACK = { "pt-PT": "pt" };

function ownTable(code) {
  const base = FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {};
  return { ...base, ...TRANSLATIONS[code] };
}

for (const { code } of LANGUAGES) {
  const table = ownTable(code);
  for (const key of KEYS) check(`${code} has ${key}`, typeof table[key] === "string" && table[key] !== "");
  for (const key of PLURAL_KEYS) {
    const forms = PLURAL_FORMS[code] ?? ["other"];
    for (const form of forms) check(`${code} has ${key}.${form}`, typeof table[`${key}.${form}`] === "string");
  }
  for (const key of ["upload.someNotAdded", "import.itemReason", "playlist.notAdded"]) {
    const english = TRANSLATIONS.en[key].match(/\{\w+\}/g).sort().join();
    check(`${code} ${key} keeps its placeholders`, (table[key].match(/\{\w+\}/g) ?? []).sort().join() === english);
  }
}

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
