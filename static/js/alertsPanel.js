import { hasOpenDialog } from "./dialogLayer.js";
import { keepInWindow } from "./shellFloat.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";

const OPEN_CLASS = "open";
const WRAP_SELECTOR = ".daw-notif-wrap";
const PANEL_SELECTOR = ".daw-notif-panel";
const CLOSE_SELECTOR = ".daw-notif-close";
const BELL_ID = "notifBtn";

let wrap = null;
let panel = null;
let trigger = null;

export function alertsOpen() {
  return Boolean(wrap?.classList.contains(OPEN_CLASS));
}

function placePanel() {
  keepInWindow(panel, trigger);
}

function markTrigger(expanded) {
  trigger?.setAttribute("aria-expanded", String(expanded));
}

export function openAlerts(from) {
  if (!wrap || !from) return;
  if (trigger !== from) markTrigger(false);
  trigger = from;
  wrap.classList.add(OPEN_CLASS);
  markTrigger(true);
  placePanel();
}

export function closeAlerts({ refocus = true } = {}) {
  if (!alertsOpen()) return;
  wrap.classList.remove(OPEN_CLASS);
  markTrigger(false);
  if (refocus) trigger?.focus();
}

export function toggleAlerts(from) {
  if (alertsOpen() && trigger === from) closeAlerts();
  else openAlerts(from);
}

function onBellClick(e) {
  toggleAlerts(e.currentTarget);
}

function onCloseClick() {
  closeAlerts();
}

// A dialog opened from a card sits over the panel; the panel waits under it.
function onPressOutside(e) {
  if (!alertsOpen() || hasOpenDialog()) return;
  if (panel.contains(e.target) || trigger?.contains(e.target)) return;
  closeAlerts({ refocus: false });
}

function onAlertsKeydown(e) {
  if (e.key !== ESCAPE_KEY || !alertsOpen() || !escapeIsFor(LAYER.FLOAT)) return;
  e.preventDefault();
  closeAlerts();
}

function onWindowResize() {
  if (alertsOpen()) placePanel();
}

export function initAlertsPanel() {
  wrap = document.querySelector(WRAP_SELECTOR);
  panel = wrap?.querySelector(PANEL_SELECTOR);
  if (!wrap || !panel) return;
  document.getElementById(BELL_ID)?.addEventListener("click", onBellClick);
  panel.querySelector(CLOSE_SELECTOR)?.addEventListener("click", onCloseClick);
  document.addEventListener("click", onPressOutside);
  document.addEventListener("keydown", onAlertsKeydown);
  window.addEventListener("resize", onWindowResize);
}
