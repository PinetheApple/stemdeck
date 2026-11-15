// Settings > Recording: the input new tracks start on and whether you hear
// yourself while armed. Kept in this browser, like the latency results.

import { storeGet, storeSet } from "./utils.js";

const PREFS_KEY = "stemdeck:recording:v1";
const DEFAULTS = Object.freeze({ inputDeviceId: "", monitor: false });

let prefs = { ...DEFAULTS };
let loaded = null;
const listeners = new Set();

export function loadRecorderPrefs() {
  loaded ??= storeGet(PREFS_KEY, {}).then(function keepPrefs(stored) {
    prefs = { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
    return prefs;
  });
  return loaded;
}

export function recorderPrefs() {
  return prefs;
}

export function setRecorderPref(name, value) {
  prefs = { ...prefs, [name]: value };
  storeSet(PREFS_KEY, prefs);
  for (const fn of listeners) fn(prefs);
}

export function onRecorderPrefsChange(fn) {
  listeners.add(fn);
}
