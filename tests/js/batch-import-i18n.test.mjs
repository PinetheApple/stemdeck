// Every language has the batch import's words with English's placeholders;
// t() falls back to English, so a gap would not show on screen.
// Run:  node tests/js/batch-import-i18n.test.mjs

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

const PREFIX = "batch.";
const PLURAL_FORM = /\.(one|other|few|many)$/;
const PLURAL_FORMS = { pl: ["one", "few", "many"] };
const FALLBACK = { "pt-PT": "pt" };
const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();

const english = Object.keys(TRANSLATIONS.en).filter((k) => k.startsWith(PREFIX));
const singles = english.filter((k) => !PLURAL_FORM.test(k));
const plurals = [...new Set(english.filter((k) => PLURAL_FORM.test(k)).map((k) => k.replace(PLURAL_FORM, "")))];
check("the English table has the batch keys", singles.length > 0 && plurals.length > 0);

for (const { code } of LANGUAGES) {
  const table = { ...(FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {}), ...TRANSLATIONS[code] };
  for (const key of singles) {
    const ok = typeof table[key] === "string" && table[key] !== "";
    check(`${code} has ${key}`, ok);
    if (ok) check(`${code} ${key} keeps its placeholders`, placeholders(table[key]) === placeholders(TRANSLATIONS.en[key]));
  }
  for (const key of plurals) {
    for (const form of PLURAL_FORMS[code] ?? ["other"]) {
      const text = table[`${key}.${form}`];
      check(`${code} has ${key}.${form}`, typeof text === "string" && text !== "");
      if (text) check(`${code} ${key}.${form} keeps its placeholders`, placeholders(text) === placeholders(TRANSLATIONS.en[`${key}.other`]));
    }
  }
}

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
