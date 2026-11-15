// Every EQ and master string exists in every language; t() would fall back to
// English silently, so each table is read on its own.
//
// Run:  node tests/js/eq-i18n.test.mjs

import { readFileSync } from "node:fs";
import { createChecker, installPageStubs } from "./fakeWebAudio.mjs";

installPageStubs();
const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { KNOB_IDS } = await import("../../static/js/eq/eqPanelModel.js");
const { EQ_TYPES } = await import("../../static/js/eqMath.js");
const { check, finish } = createChecker();

const FALLBACK = { "pt-PT": "pt" };
const OWN_PREFIXES = ["eq.", "help.eq", "help.inspectorEq", "help.exportMaster", "export.master", "inspector.eq"];
const en = TRANSLATIONS.en;
const keys = Object.keys(en).filter((k) => OWN_PREFIXES.some((p) => k.startsWith(p)));
const table = (code) => ({ ...(FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {}), ...TRANSLATIONS[code] });

check("the EQ strings are in English", keys.length > 50, String(keys.length));
for (const id of KNOB_IDS) check(`knob ${id} has a name`, typeof en[`eq.knob.${id}`] === "string");
for (const type of EQ_TYPES) check(`band type ${type} has a name`, typeof en[`eq.type.${type}`] === "string");

for (const { code } of LANGUAGES) {
  const own = table(code);
  const missing = keys.filter((k) => typeof own[k] !== "string" || own[k].trim() === "");
  check(`${code}: every EQ string is there`, missing.length === 0, missing.join(", "));
}

const used = new Set();
for (const file of ["eqLaneView.js", "eqMasterView.js", "eqGraph.js", "eqLaneMark.js", "eqPanelModel.js", "eqSuggest.js"]) {
  const src = readFileSync(new URL(`../../static/js/eq/${file}`, import.meta.url), "utf8");
  for (const m of src.matchAll(/"((?:eq|help)\.[a-zA-Z.]+)"/g)) used.add(m[1]);
}
const html = readFileSync(new URL("../../static/index.html", import.meta.url), "utf8");
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="((?:eq|export\.master|inspector\.eq)[a-zA-Z.]*)"/g)) used.add(m[1]);
const unknown = [...used].filter((k) => !(k in en));
check("every key the EQ code and markup use exists", used.size > 20 && unknown.length === 0, unknown.join(", "));

finish();
