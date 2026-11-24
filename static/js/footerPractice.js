// The footer's Loop options, and Speed and Key as - value + steppers whose value
// opens their options on a click and does their quick action on a double-click.

import { wirePopover } from "./popover.js";
import { $ } from "./utils.js";

const STEP_DOWN = -1;
const STEP_UP = 1;

/** `actions` comes from transport.js, which imports this module and so cannot be imported back. */
export function initFooterPractice({ stepSpeed, toggleSlowSpeed, resetAllKeys, stepKey, paintKey }) {
  wirePopover($("t-loop-more"), $("t-loop-panel"));
  wirePopover($("t-speed-btn"), $("t-speed-panel"), { waitForDoubleClick: true });
  // Painted on opening too: the key name follows the language and the song's key, not only the steps.
  wirePopover($("t-key-btn"), $("t-key-panel"), { waitForDoubleClick: true, onOpen: paintKey });

  $("t-speed-down").addEventListener("click", function onSpeedDownClick() {
    stepSpeed(STEP_DOWN);
  });
  $("t-speed-up").addEventListener("click", function onSpeedUpClick() {
    stepSpeed(STEP_UP);
  });
  $("t-speed-btn").addEventListener("dblclick", function onSpeedValueDoubleClick() {
    toggleSlowSpeed();
  });
  $("t-key-panel-down").addEventListener("click", function onKeyPanelDown() {
    stepKey(STEP_DOWN);
  });
  $("t-key-panel-up").addEventListener("click", function onKeyPanelUp() {
    stepKey(STEP_UP);
  });
  $("t-key-btn").addEventListener("dblclick", function onKeyValueDoubleClick() {
    if (!$("t-pitch-reset").disabled) resetAllKeys();
  });
}
