// The footer's Up Next button: shows Up Next in the song tools, pressed while it is showing.

import { openInspectorTab } from "./inspector.js";
import { $ } from "./utils.js";

const UP_NEXT_TAB = "upnext";
const INSPECTOR_HIDDEN_CLASS = "inspector-hidden";

function upNextShowing() {
  const pane = document.querySelector(`.inspector-pane[data-pane="${UP_NEXT_TAB}"]`);
  const app = document.querySelector(".app");
  return Boolean(pane && !pane.hidden && !app?.classList.contains(INSPECTOR_HIDDEN_CLASS));
}

export function initUpNextButton() {
  const button = $("t-upnext");
  const pane = document.querySelector(`.inspector-pane[data-pane="${UP_NEXT_TAB}"]`);
  if (!button || !pane) return;
  const paint = () => button.setAttribute("aria-pressed", String(upNextShowing()));
  button.addEventListener("click", function onUpNextButtonClick() {
    openInspectorTab(UP_NEXT_TAB);
  });
  const watch = new MutationObserver(paint);
  watch.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  watch.observe(document.querySelector(".app"), { attributes: true, attributeFilter: ["class"] });
  paint();
}
