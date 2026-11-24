import { storeGet, storeSet } from "./utils.js";
import { APPEARANCE_KIND, APPEARANCE_STORE_KEYS, resolveChoice } from "./appearanceModel.js";

const ROOT_ATTRIBUTE = Object.freeze({
  [APPEARANCE_KIND.THEME]: "theme",
  [APPEARANCE_KIND.FONT]: "font",
  [APPEARANCE_KIND.WASH]: "wash",
});

export function currentAppearance(kind) {
  return document.documentElement.dataset[ROOT_ATTRIBUTE[kind]];
}

function applyChoice(kind, value) {
  document.documentElement.dataset[ROOT_ATTRIBUTE[kind]] = resolveChoice(kind, value);
}

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
