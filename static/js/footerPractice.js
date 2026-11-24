// The footer's Loop options, and Speed and Key as - value + steppers whose value
// opens their options on a click and does their quick action on a double-click.

import { wirePopover } from "./footerPopover.js";
import { paintKeyPanel } from "./footerKey.js";
import { $ } from "./utils.js";

const SLOWER = -1;
const FASTER = 1;
const DOWN = -1;
const UP = 1;

/** `actions` comes from transport.js, which imports this module and so cannot be imported back. */
export function initFooterPractice({ stepSpeed, toggleSlowSpeed, resetAllKeys, stepKey }) {
  wirePopover($("t-loop-more"), $("t-loop-panel"));
  wirePopover($("t-speed-btn"), $("t-speed-panel"), { waitForDoubleClick: true });
  wirePopover($("t-key-btn"), $("t-key-panel"), { waitForDoubleClick: true, onOpen: paintKeyPanel });

  $("t-speed-down").addEventListener("click", function onSpeedDownClick() {
    stepSpeed(SLOWER);
  });
  $("t-speed-up").addEventListener("click", function onSpeedUpClick() {
    stepSpeed(FASTER);
  });
  $("t-speed-btn").addEventListener("dblclick", function onSpeedValueDoubleClick() {
    toggleSlowSpeed();
  });
  $("t-key-panel-down").addEventListener("click", function onKeyPanelDown() {
    stepKey(DOWN);
  });
  $("t-key-panel-up").addEventListener("click", function onKeyPanelUp() {
    stepKey(UP);
  });
  $("t-key-btn").addEventListener("dblclick", function onKeyValueDoubleClick() {
    if (!$("t-pitch-reset").disabled) resetAllKeys();
  });
}
