// t() falls back to English for a missing key, so a gap in one table still looks
// fine; this reads each table's own keys and renders the queue rows per language.
//
// Run:  node tests/js/queue-i18n.test.mjs

import { readFileSync } from "node:fs";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS, setLanguage, t } = await import("../../static/js/i18n.js");
const { queueRowStates } = await import("../../static/js/queue.js");

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

const KEYS = ["queue.pausedStatus", "queue.positionInLine"];
const FALLBACK = { "pt-PT": "pt" };
const ENGLISH_ORDINAL = /\d(st|nd|rd|th)\b/;
const WAITING_ID = "waiting";
const running = { job_id: "running", stage: "Separating 10%", progress: 0.1 };
const waiting = { job_id: WAITING_ID };

function ownTable(code) {
  const base = FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {};
  return { ...base, ...TRANSLATIONS[code] };
}

function waitingLabel(paused) {
  return queueRowStates({ running, queued: [waiting], paused }).get(WAITING_ID).label;
}

for (const { code } of LANGUAGES) {
  const table = ownTable(code);
  for (const key of KEYS) {
    const text = table[key];
    check(`${code}: ${key} exists`, typeof text === "string" && text.trim() !== "");
    if (code !== "en" && text) check(`${code}: ${key} is translated`, text !== TRANSLATIONS.en[key]);
  }
  check(`${code}: position is a placeholder in the phrase`, table["queue.positionInLine"]?.includes("{position}"));

  await setLanguage(code);
  const inLine = waitingLabel(false);
  check(`${code}: waiting row says its place`, inLine === t("queue.positionInLine", { position: 2 }), inLine);
  check(`${code}: waiting row has no English ordinal`, !ENGLISH_ORDINAL.test(inLine), inLine);
  check(`${code}: paused row says paused`, waitingLabel(true) === t("queue.pausedStatus"), waitingLabel(true));
}

const catalogJs = readFileSync(new URL("../../static/js/catalog.js", import.meta.url), "utf8");
check("catalog.js has no English queue grip title", !/queue-grip" title="Drag/.test(catalogJs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
