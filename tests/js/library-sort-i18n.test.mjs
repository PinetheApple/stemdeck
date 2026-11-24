// Library sort, filter and select strings (#235) in every language.

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { SORT_KEYS, SORT_LABEL_KEYS } = await import("../../static/js/librarySort.js");
const { KEY_MODE_OPTIONS, TEMPO_OPTIONS } = await import("../../static/js/libraryFilter.js");
const { BULK_ACTION, BULK_ACTION_LABEL_KEYS } = await import("../../static/js/librarySelection.js");

const PREFIX = "libSort.";
const LOCALE_FALLBACK = { "pt-PT": "pt" };
const PLURAL_FORMS = { pl: ["one", "few", "many"] };
const DEFAULT_PLURAL_FORMS = ["other"];
const PLACEHOLDERS = /\{\w+\}/g;
const en = TRANSLATIONS.en;
const ownKeys = Object.keys(en).filter((key) => key.startsWith(PREFIX));

function table(code) {
  const base = LOCALE_FALLBACK[code] ? TRANSLATIONS[LOCALE_FALLBACK[code]] : {};
  return { ...base, ...TRANSLATIONS[code] };
}

const placeholders = (text) => (text.match(PLACEHOLDERS) ?? []).sort();

test("every sort key, tempo, mode and bulk action has a label key in English", () => {
  assert.deepEqual(Object.keys(SORT_LABEL_KEYS).sort(), Object.values(SORT_KEYS).sort());
  assert.deepEqual(Object.keys(BULK_ACTION_LABEL_KEYS).sort(), Object.values(BULK_ACTION).sort());
  const labels = [
    ...Object.values(SORT_LABEL_KEYS),
    ...TEMPO_OPTIONS.map((option) => option.label),
    ...KEY_MODE_OPTIONS.map((option) => option.label),
    ...Object.values(BULK_ACTION_LABEL_KEYS),
  ];
  for (const key of labels) assert.equal(typeof en[key], "string", key);
});

test("the libSort strings sit in one block in English", () => {
  const keys = Object.keys(en);
  const first = keys.indexOf(ownKeys[0]);
  assert.ok(ownKeys.length > 30, String(ownKeys.length));
  assert.deepEqual(keys.slice(first, first + ownKeys.length), ownKeys);
});

test("every language has every libSort string with the same placeholders", () => {
  for (const { code } of LANGUAGES) {
    const own = table(code);
    for (const key of ownKeys) {
      const text = own[key];
      assert.ok(typeof text === "string" && text.trim() !== "", `${code}: ${key} missing`);
      assert.deepEqual(placeholders(text), placeholders(en[key]), `${code}: ${key}`);
    }
  }
});

test("every language has its plural forms for the selected count", () => {
  for (const { code } of LANGUAGES) {
    const own = table(code);
    const forms = PLURAL_FORMS[code] ?? DEFAULT_PLURAL_FORMS;
    for (const form of forms) assert.equal(typeof own[`${PREFIX}selected.${form}`], "string", `${code}: ${form}`);
  }
});
