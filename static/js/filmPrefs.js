// What the Film view remembers in this browser: the camera, and the export's
// size and frame rate (1080p at 30 fps until changed).

import { storeGet, storeSet } from "./utils.js";
import { exportPrefs } from "./videoExportModel.js";

const PREFS_KEY = "stemdeck:film:v1";

let prefs = { cameraId: "", ...exportPrefs(null) };
let loaded = null;

export function loadFilmPrefs() {
  loaded ??= storeGet(PREFS_KEY, {}).then(function keepFilmPrefs(stored) {
    const saved = stored && typeof stored === "object" ? stored : {};
    prefs = { cameraId: typeof saved.cameraId === "string" ? saved.cameraId : "", ...exportPrefs(saved) };
    return prefs;
  });
  return loaded;
}

export function filmPrefs() {
  return prefs;
}

export function setFilmPrefs(changes) {
  prefs = { ...prefs, ...changes };
  storeSet(PREFS_KEY, prefs);
}
