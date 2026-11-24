// appearance.js — applies this device's theme, font and cover wash to <html>
// as data-theme / data-font / data-wash, at load and whenever one is chosen.

import { storeGet, storeSet } from "./utils.js";
import { APPEARANCE_STORE_KEYS, resolveChoice } from "./appearanceModel.js";

const ROOT_ATTRIBUTE = Object.freeze({ theme: "theme", font: "font", wash: "wash" });

export function currentAppearance(kind) {
  return document.documentElement.dataset[ROOT_ATTRIBUTE[kind]];
}

function applyChoice(kind, value) {
  document.documentElement.dataset[ROOT_ATTRIBUTE[kind]] = resolveChoice(kind, value);
}

/** Applies at once and is remembered on this device. */
export function chooseAppearance(kind, value) {
  applyChoice(kind, value);
  return storeSet(APPEARANCE_STORE_KEYS[kind], currentAppearance(kind));
}

async function applyStoredAppearance() {
  for (const kind of Object.keys(APPEARANCE_STORE_KEYS)) applyChoice(kind, null);
  const stored = await Promise.all(
    Object.entries(APPEARANCE_STORE_KEYS).map(async ([kind, key]) => [kind, await storeGet(key)]),
  );
  for (const [kind, value] of stored) applyChoice(kind, value);
}

applyStoredAppearance();
