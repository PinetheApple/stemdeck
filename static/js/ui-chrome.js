// Small UI-chrome handlers extracted from inline index.html scripts / onclick
// attributes so the Content-Security-Policy can forbid inline script (#171).
// Loaded as a module (deferred), so the DOM is parsed before this runs.

import { disarmClearSections } from "./sections.js";
import { keepInWindow } from "./shellFloat.js";
import { LAYER, escapeIsFor } from "./shellEscape.js";

// Upload button → trigger the hidden file input.
document.getElementById("uploadFileBtn")?.addEventListener("click", () => {
  document.getElementById("fileInput")?.click();
});

// Notification panel: toggle / close / close-on-outside-click.
const notifBtn = document.getElementById("notifBtn");
const notifWrap = notifBtn?.closest(".daw-notif-wrap");
const notifPanel = notifWrap?.querySelector(".daw-notif-panel");

/** Under the bell, inside the window; fixed so no ancestor's overflow clips it. */
function placeNotifPanel() {
  if (notifBtn && notifPanel) keepInWindow(notifPanel, notifBtn);
}

function setNotifOpen(open) {
  notifWrap?.classList.toggle("open", open);
  notifBtn?.setAttribute("aria-expanded", String(open));
  if (open) placeNotifPanel();
}

// The bell does not move with the window, but the clamp above depends on the
// window's height, so a resize while the panel is open can strand it.
window.addEventListener("resize", () => {
  if (notifWrap?.classList.contains("open")) placeNotifPanel();
});

notifBtn?.addEventListener("click", () => {
  setNotifOpen(!notifWrap?.classList.contains("open"));
});

document
  .querySelector(".daw-notif-close")
  ?.addEventListener("click", () => setNotifOpen(false));

document.addEventListener("click", (e) => {
  if (notifWrap?.classList.contains("open") && !notifWrap.contains(e.target)) {
    setNotifOpen(false);
  }
});

function onNotifEscape(e) {
  if (e.key !== "Escape" || !notifWrap?.classList.contains("open") || !escapeIsFor(LAYER.FLOAT)) return;
  e.preventDefault();
  e.stopPropagation();
  setNotifOpen(false);
  notifBtn?.focus();
}
document.addEventListener("keydown", onNotifEscape);

// Panel toggles (#480). Each one hides a region that is useful but not useful
// all the time, and hands its height to the mixer, which is the panel that
// actually runs short: at 1366x768 with six stems the lane stack needs 432px
// and gets 370. Analysis is worth 72px and the timeline 93px, so either alone
// closes that gap.
//
// Same shape as the sidebar collapse: a class on .app, a flag in localStorage,
// no state anywhere else. The lanes re-fit on their own because the wave panel
// is already watched by a ResizeObserver.
const PANEL_STORE_PREFIX = "stemdeck.panel.";
const SECTIONS_PANEL = "sections";
const panelApp = document.querySelector(".app");
const panelToggles = [...document.querySelectorAll(".daw-panel-toggle[data-panel]")];

function applyPanel(name, shown) {
  panelApp.classList.toggle(`panel-${name}-off`, !shown);
  for (const btn of panelToggles) {
    if (btn.dataset.panel === name) btn.setAttribute("aria-pressed", String(shown));
  }
}

function setPanel(name, shown) {
  applyPanel(name, shown);
  try {
    localStorage.setItem(PANEL_STORE_PREFIX + name, shown ? "1" : "0");
  } catch (e) {
    console.warn("[panels] could not persist state:", e);
  }
}

// Focus goes to the Collapse toggle because that is the way back.
function handleSectionsHideClick() {
  disarmClearSections();
  setPanel(SECTIONS_PANEL, false);
  panelToggles.find((btn) => btn.dataset.panel === SECTIONS_PANEL)?.focus();
}

function wirePanelToggles() {
  if (!panelApp || !panelToggles.length) return;

  for (const btn of panelToggles) {
    const name = btn.dataset.panel;
    let shown = true;
    try {
      shown = localStorage.getItem(PANEL_STORE_PREFIX + name) !== "0";
    } catch (e) {
      console.warn("[panels] could not read stored state:", e);
    }
    applyPanel(name, shown);
    btn.addEventListener("click", () => {
      setPanel(name, panelApp.classList.contains(`panel-${name}-off`));
    });
  }
  document.getElementById("sectionsHideBtn")?.addEventListener("click", handleSectionsHideClick);
}

wirePanelToggles();
