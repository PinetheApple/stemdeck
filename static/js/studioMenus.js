// The Sections and View buttons over the lanes, each opening its popover below it, and
// View > Beat grid, a stored preference for the grid lines the click draws.

import { PLACEMENT, wirePopover } from "./footerPopover.js";
import { setBeatGridViewOn } from "./beatgrid.js";
import { $, storeGet, storeSet } from "./utils.js";

const BEAT_GRID_STORE_KEY = "stemdeck:beat-grid-view";
const TOOLS_WIDTH_VAR = "--studio-tools-w";
const BELOW = { placement: PLACEMENT.BELOW };

let beatGridOn = true;

function paintBeatGridView() {
  $("beatGridViewBtn")?.setAttribute("aria-pressed", String(beatGridOn));
  setBeatGridViewOn(beatGridOn);
}

function onBeatGridViewClick() {
  beatGridOn = !beatGridOn;
  storeSet(BEAT_GRID_STORE_KEY, beatGridOn);
  paintBeatGridView();
}

async function initBeatGridView() {
  const button = $("beatGridViewBtn");
  if (!button) return;
  button.addEventListener("click", onBeatGridViewClick);
  beatGridOn = (await storeGet(BEAT_GRID_STORE_KEY, true)) !== false;
  paintBeatGridView();
}

// The part picker shares the buttons' row, so it is told how much of the row they take.
function shareRowWithPicker(tools) {
  const row = tools.parentElement;
  const publish = () => row.style.setProperty(TOOLS_WIDTH_VAR, `${tools.offsetWidth}px`);
  new ResizeObserver(publish).observe(tools);
  publish();
}

export function initStudioMenus() {
  const tools = document.querySelector(".studio-tools");
  if (tools) shareRowWithPicker(tools);
  const trigger = $("sectionsMenuBtn");
  const panel = $("sectionsPanel");
  if (trigger && panel) {
    const sections = wirePopover(trigger, panel, BELOW);
    // Add opens Edit section on the new section, which is where the eye goes next.
    $("sectionsAddBtn")?.addEventListener("click", sections.close);
  }
  if ($("viewMenuBtn") && $("viewPanel")) wirePopover($("viewMenuBtn"), $("viewPanel"), BELOW);
  initBeatGridView();
}
