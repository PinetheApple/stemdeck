// A song's import source and a failed import's reason and next step.
//
// Run:  node tests/js/import-source.test.mjs

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const {
  FILE_GONE_REASON_KEY, RETRY_OUTCOME, SOURCE_KIND, failureReasonKey, importSource,
  needsFilePickedAgain, retryErrorText, retryOutcome, sourceKindOf,
} = await import("../../static/js/importSource.js");

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};

const CODES = ["out-of-memory", "unsupported-device", "disk-full", "source-blocked", "source-unavailable", "bad-input", "unknown"];
const UNKNOWN_KEY = failureReasonKey("unknown");
const LINK = "https://www.youtube.com/watch?v=Fv3QH1nvJ0E";
const FALLBACK = { "pt-PT": "pt" };

const keys = CODES.map(failureReasonKey);
check("every error code has its own reason", new Set(keys).size === CODES.length, keys.join(", "));
check("no code reads as unknown", failureReasonKey(null) === UNKNOWN_KEY);
check("a code this side does not know reads as unknown", failureReasonKey("gpu-on-fire") === UNKNOWN_KEY);
check("a prototype name is not a code", failureReasonKey("constructor") === UNKNOWN_KEY);

const UI_KEYS = [
  ...keys, FILE_GONE_REASON_KEY, "importFail.retry", "importFail.retryTitle", "importFail.pickAgain",
  "importFail.pickAgainTitle", "importFail.restoreFirst", "source.copyLink", "source.openLink", "source.copied",
];
for (const { code } of LANGUAGES) {
  const table = { ...(FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {}), ...TRANSLATIONS[code] };
  const missing = UI_KEYS.filter((key) => typeof table[key] !== "string" || !table[key].trim());
  check(`${code}: every import-source string exists`, !missing.length, missing.join(", "));
  if (code === "en") continue;
  const untranslated = UI_KEYS.filter((key) => table[key] === TRANSLATIONS.en[key]);
  check(`${code}: every import-source string is translated`, !untranslated.length, untranslated.join(", "));
}

const link = importSource({ sourceUrl: LINK });
check("a link shows without its scheme and www", link.text === "youtube.com/watch?v=Fv3QH1nvJ0E", link.text);
check("a link copies and opens in full", link.full === LINK && link.href === LINK);
check("a link that is not a web address does not open", importSource({ sourceUrl: "ftp://x/y" }).href === null);
check("an upload shows its original file name",
  importSource({ sourceKind: "file", sourceUrl: "local:Hollow Veins", sourceName: "Hollow Veins.wav" }).text === "Hollow Veins.wav");
check("an older upload shows its title without the local: prefix",
  importSource({ sourceUrl: "local:Hollow Veins", sourceName: null }).text === "Hollow Veins");
check("an upload never opens", importSource({ sourceUrl: "local:x" }).href === null);
check("no source, no line", importSource({ sourceUrl: "" }) === null);
check("the server's kind wins", sourceKindOf({ sourceKind: "file", sourceUrl: LINK }) === SOURCE_KIND.FILE);

check("a kept-file upload retries", !needsFilePickedAgain({ sourceUrl: "local:x", retryable: true }));
check("an upload whose file is gone is picked again", needsFilePickedAgain({ sourceUrl: "local:x", retryable: false }));
check("a link is never picked again", !needsFilePickedAgain({ sourceUrl: LINK, retryable: false }));

const answer = (status, detail = "") => ({ ok: status < 300, status, detail });
check("a 2xx follows the same job", retryOutcome(answer(200), "link") === RETRY_OUTCOME.QUEUED);
check("404 on a link re-imports the link", retryOutcome(answer(404), "link") === RETRY_OUTCOME.REIMPORT_LINK);
check("404 on an upload asks for the file", retryOutcome(answer(404), "file") === RETRY_OUTCOME.FILE_GONE);
check("410 asks for the file", retryOutcome(answer(410), "file") === RETRY_OUTCOME.FILE_GONE);
check("409 job has not failed refreshes the state", retryOutcome(answer(409, "job has not failed"), "link") === RETRY_OUTCOME.REFRESH);
check("409 in the Trash says restore it first",
  retryOutcome(answer(409, "restore it from the Trash first"), "link") === RETRY_OUTCOME.RESTORE_FIRST);
const STEMS_MOVING = "Restart StemDeck to finish moving your stems folder before importing";
check("409 while the stems folder moves is a refusal, not a refresh",
  retryOutcome(answer(409, STEMS_MOVING), "link") === RETRY_OUTCOME.FAILED);
check("the stems-folder refusal is shown in words", retryErrorText(409, STEMS_MOVING).key === "job.startFailed"
  && retryErrorText(409, STEMS_MOVING).message === STEMS_MOVING);
check("a replacement already importing says so", retryErrorText(409, "busy").key === "job.reimportBusy");
check("a full queue says so", retryErrorText(503, "x").key === "playlist.queueFull");
check("anything else names the server's reason", retryErrorText(500, "boom").message === "boom");
check("503 says the queue is full", retryOutcome(answer(503), "link") === RETRY_OUTCOME.QUEUE_FULL);
check("anything else failed", retryOutcome(answer(500), "link") === RETRY_OUTCOME.FAILED);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
