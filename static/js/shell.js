// The top bar's own controls: Add song, Importing N and the song-tools toggle's
// state. The sidebar toggle is catalog.js's; the edges are shellEdges.js's.

import { t, onLanguageChange } from "./i18n.js";
import { getQueueSnapshot, onQueueChange, queueCount } from "./queue.js";
import { showQueueView } from "./catalog.js";
import { wireComposerDrawer } from "./composerDrawer.js";

const TOOLS_HIDDEN_CLASS = "inspector-hidden";
const HIDDEN_CLASS = "hidden";

function paintImporting(snap = getQueueSnapshot()) {
  const btn = document.getElementById("importingBtn");
  const label = document.getElementById("importingLabel");
  if (!btn || !label) return;
  const count = snap ? queueCount(snap) : 0;
  btn.classList.toggle(HIDDEN_CLASS, count === 0);
  label.textContent = t("shell.importing", { count });
}

function onImportingClick() {
  showQueueView();
}

// inspector.js owns the panel; this shows its state on the top-bar toggle.
function paintToolsToggle() {
  const shown = !document.querySelector(".app")?.classList.contains(TOOLS_HIDDEN_CLASS);
  document.getElementById("inspectorToggleBtn")?.setAttribute("aria-pressed", String(shown));
}

function watchToolsToggle() {
  const app = document.querySelector(".app");
  if (!app) return;
  new MutationObserver(paintToolsToggle).observe(app, { attributes: true, attributeFilter: ["class"] });
  paintToolsToggle();
}

export function initShell() {
  wireComposerDrawer();
  document.getElementById("importingBtn")?.addEventListener("click", onImportingClick);
  onQueueChange(paintImporting);
  onLanguageChange(() => paintImporting());
  paintImporting();
  watchToolsToggle();
}
