// A stem lane's key: who may move it, how it reads, and how its stepper draws.

import { KEY_LOCKED_STEM, PITCH_STEP } from "./constants.js";
import { mixerState } from "./state.js";
import { t } from "./i18n.js";
import { clampPitch, pitchBlockedKey } from "./pitchBus.js";

let laneKeysUsable = true;

export function setLaneKeysUsable(usable) {
  laneKeysUsable = usable;
}

/** Why `name`'s key cannot move, or "" when it can. */
export function laneKeyBlockedReason(name) {
  if (name === KEY_LOCKED_STEM) return t("mixer.key.drumsLocked");
  // The transport's own sentence: two answers to one question would confuse.
  return laneKeysUsable ? "" : t(pitchBlockedKey());
}

export function canStepLanePitch(name, delta) {
  const n = mixerState[name]?.pitch ?? 0;
  return !laneKeyBlockedReason(name) && clampPitch(n + delta) !== n;
}

/** `name`'s key offset as shown: "0", "+2", "-1". */
export function laneKeyText(name) {
  const n = mixerState[name]?.pitch ?? 0;
  return n > 0 ? `+${n}` : String(n);
}

/** Draw a lane's key stepper `wrap` from state, attached or not. */
export function paintLaneKey(wrap, name) {
  const signed = laneKeyText(name);
  wrap.querySelector(".lane-key-value").textContent = signed;
  wrap.classList.toggle("active", (mixerState[name]?.pitch ?? 0) !== 0);
  wrap.classList.toggle("locked", name === KEY_LOCKED_STEM);
  wrap.classList.toggle("unsupported", !laneKeysUsable);
  wrap.querySelector(".lane-key-step.up").disabled = !canStepLanePitch(name, PITCH_STEP);
  wrap.querySelector(".lane-key-step.down").disabled = !canStepLanePitch(name, -PITCH_STEP);
  wrap.title = laneKeyBlockedReason(name) || t("mixer.key.title", { n: signed });
}
