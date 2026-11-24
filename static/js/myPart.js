// My part: the stem you play, and the three ways to hear the band around it.

import { EXTRA_STEM_NAMES } from "./constants.js";

export const PRESET = Object.freeze({
  FULL_BAND: "full",
  WITHOUT_ME: "without",
  ONLY_ME: "only",
});
export const PRESETS = Object.freeze([PRESET.FULL_BAND, PRESET.WITHOUT_ME, PRESET.ONLY_ME]);
export const DEFAULT_PART = "guitar";
const SPLIT_PART = "vocals";

/** The loaded lanes that are `part`: its own lane, or both halves of a split vocal. */
export function partLanes(part, loaded) {
  if (loaded.includes(part)) return [part];
  if (part === SPLIT_PART) return EXTRA_STEM_NAMES.filter((name) => loaded.includes(name));
  return [];
}

/** Whether `preset` can be used on a song that loaded `loaded`. */
export function canUsePreset(preset, part, loaded) {
  if (!loaded.length) return false;
  return preset === PRESET.FULL_BAND || partLanes(part, loaded).length > 0;
}

/** Each loaded lane's mute under `preset`. */
export function mutesFor(preset, part, loaded) {
  const mine = new Set(partLanes(part, loaded));
  const muted = (name) => {
    if (preset === PRESET.WITHOUT_ME) return mine.has(name);
    if (preset === PRESET.ONLY_ME) return !mine.has(name);
    return false;
  };
  return Object.fromEntries(loaded.map((name) => [name, muted(name)]));
}

function matches(preset, part, loaded, mix) {
  if (!canUsePreset(preset, part, loaded)) return false;
  const mutes = mutesFor(preset, part, loaded);
  return loaded.every((name) => !mix[name]?.soloed && Boolean(mix[name]?.muted) === mutes[name]);
}

/** The preset the mix is in, or null when a manual change matches none. */
export function activePreset(part, loaded, mix) {
  return PRESETS.find((preset) => matches(preset, part, loaded, mix)) ?? null;
}
