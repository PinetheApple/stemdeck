// The footer's Up Next button: shows Up Next in the song tools, pressed while it is showing.

import { INSPECTOR_TABS, openInspectorTab } from "./inspector.js";
import { TOOLS_HIDDEN_CLASS } from "./shellEdges.js";
import { $ } from "./utils.js";

const UP_NEXT_TAB = INSPECTOR_TABS.UP_NEXT;

export function initUpNextButton() {
  const button = $("t-upnext");
  const pane = document.querySelector(`.inspector-pane[data-pane="${UP_NEXT_TAB}"]`);
  const app = document.querySelector(".app");
  if (!button || !pane || !app) return;
  function paintUpNextButton() {
    const showing = !pane.hidden && !app.classList.contains(TOOLS_HIDDEN_CLASS);
    button.setAttribute("aria-pressed", String(showing));
  }
  button.addEventListener("click", function onUpNextButtonClick() {
    openInspectorTab(UP_NEXT_TAB);
  });
  const watch = new MutationObserver(paintUpNextButton);
  watch.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  watch.observe(app, { attributes: true, attributeFilter: ["class"] });
  paintUpNextButton();
}
