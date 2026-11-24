import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { SORT_KEYS, SORT_LABEL_KEYS } = await import("../../static/js/librarySort.js");
const { KEY_MODE_OPTIONS, TEMPO_OPTIONS } = await import("../../static/js/libraryFilter.js");
const { BULK_ACTION, BULK_ACTION_LABEL_KEYS, SELECT_DONE_LABEL_KEY } = await import("../../static/js/librarySelection.js");

const PREFIX = "libSort.";
const LOCALE_FALLBACK = { "pt-PT": "pt" };
const PLURAL_FORMS = { pl: ["one", "few", "many"] };
const DEFAULT_PLURAL_FORMS = ["other"];
const PLACEHOLDERS = /\{\w+\}/g;
const PLURAL_STEMS = [`${PREFIX}selected.`, `${PREFIX}movedToTrash.`];
const isPluralKey = (key) => PLURAL_STEMS.some((stem) => key.startsWith(stem));
const COUNT_PLACEHOLDER = "{count}";
const en = TRANSLATIONS.en;
const ownKeys = Object.keys(en).filter((key) => key.startsWith(PREFIX));

function table(code) {
  const base = LOCALE_FALLBACK[code] ? TRANSLATIONS[LOCALE_FALLBACK[code]] : {};
  return { ...base, ...TRANSLATIONS[code] };
}

const placeholders = (text) => (text.match(PLACEHOLDERS) ?? []).sort();
const DIGIT = /\d/;
const labelKeys = () => [
  ...Object.values(SORT_LABEL_KEYS),
  ...TEMPO_OPTIONS.map((option) => option.label),
  ...KEY_MODE_OPTIONS.map((option) => option.label),
  ...Object.values(BULK_ACTION_LABEL_KEYS),
  SELECT_DONE_LABEL_KEY,
];

test("every sort key, tempo, mode and bulk action has a label key in English", () => {
  assert.deepEqual(Object.keys(SORT_LABEL_KEYS).sort(), Object.values(SORT_KEYS).sort());
  assert.deepEqual(Object.keys(BULK_ACTION_LABEL_KEYS).sort(), Object.values(BULK_ACTION).sort());
  for (const key of labelKeys()) assert.equal(typeof en[key], "string", key);
});

test("every label the library uses, reused keys included, exists in every language", () => {
  for (const { code } of LANGUAGES) {
    const own = table(code);
    for (const key of labelKeys()) assert.ok(own[key]?.trim(), `${code}: ${key} missing`);
  }
});

test("the tempo labels name no limits of their own, only the band placeholders", () => {
  for (const { code } of LANGUAGES) {
    for (const { label, vars } of TEMPO_OPTIONS.filter((option) => option.vars)) {
      const text = table(code)[label];
      assert.ok(!DIGIT.test(text), `${code}: ${label}`);
      assert.deepEqual(placeholders(text), Object.keys(vars).map((name) => `{${name}}`).sort(), `${code}: ${label}`);
    }
  }
});

test("the libSort strings sit in one block in every language", () => {
  assert.ok(ownKeys.length > 30, String(ownKeys.length));
  for (const code of Object.keys(TRANSLATIONS)) {
    const keys = Object.keys(TRANSLATIONS[code]);
    const block = keys.filter((key) => key.startsWith(PREFIX));
    const first = keys.indexOf(block[0]);
    assert.deepEqual(keys.slice(first, first + block.length), block, code);
  }
});

test("every language has every libSort string with the same placeholders", () => {
  const singleKeys = ownKeys.filter((key) => !isPluralKey(key));
  for (const { code } of LANGUAGES) {
    const own = table(code);
    for (const key of singleKeys) {
      const text = own[key];
      assert.ok(typeof text === "string" && text.trim() !== "", `${code}: ${key} missing`);
      assert.deepEqual(placeholders(text), placeholders(en[key]), `${code}: ${key}`);
    }
  }
});

test("every language has its plural forms for each counted string", () => {
  for (const { code } of LANGUAGES) {
    const own = table(code);
    const forms = PLURAL_FORMS[code] ?? DEFAULT_PLURAL_FORMS;
    for (const stem of PLURAL_STEMS) {
      for (const form of forms) assert.ok(own[`${stem}${form}`]?.includes(COUNT_PLACEHOLDER), `${code}: ${stem}${form}`);
    }
  }
});
