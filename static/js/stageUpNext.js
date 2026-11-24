// Stage's Up Next: a chip with the count and the next song, and the studio's own Up Next list
// lent to a side panel while it is open, in either look.

import { displayTitle, getTrackNames } from "./catalog.js";
import { $ } from "./utils.js";

const BORROW_SLOT = "[data-borrow]";
const FOCUSED_ROW = "#upNextList .upnext-row[tabindex='0']";
const QUEUE_OPEN_CLASS = "queue-open";
const FOOTER_PLAY_ID = "t-play";

let upNext = { count: 0, nextId: null };
let borrowed = [];

const isPanelOpen = () => $("stageQueuePanel")?.hidden === false;

/** The title a song shows in Stage's chip and handoff. */
export function stageSongNames(id) {
  const names = getTrackNames(id);
  return { title: displayTitle(names?.title), artist: names?.artist ?? "" };
}

function paintChip() {
  const chip = $("stageQueueBtn");
  if (!chip) return;
  chip.setAttribute("aria-expanded", String(isPanelOpen()));
  $("stageQueueCount").textContent = String(upNext.count);
  $("stageQueueTitle").textContent = upNext.nextId ? stageSongNames(upNext.nextId).title : "";
}

/** Moves a studio node into the panel, leaving a marker where it goes back to. */
function borrowInto(slot) {
  const node = $(slot.dataset.borrow);
  if (!node) return;
  const marker = document.createComment(slot.dataset.borrow);
  node.replaceWith(marker);
  slot.append(node);
  borrowed.push({ node, marker });
}

function giveBack() {
  for (const { node, marker } of borrowed.splice(0)) marker.replaceWith(node);
}

function showPanel(open) {
  $("stageQueuePanel").hidden = !open;
  $("stageView")?.classList.toggle(QUEUE_OPEN_CLASS, open);
  paintChip();
}

function openPanel() {
  const panel = $("stageQueuePanel");
  if (!panel || isPanelOpen()) return;
  panel.querySelectorAll(BORROW_SLOT).forEach(borrowInto);
  showPanel(true);
  (document.querySelector(FOCUSED_ROW) ?? $("stageQueueClose"))?.focus();
}

/** Closes the Up Next panel, focus going back to the chip unless `refocus` is false; false when it was not open. */
export function closeStageQueue({ refocus = true } = {}) {
  if (!isPanelOpen()) return false;
  if (refocus) $("stageQueueBtn")?.focus();
  giveBack();
  showPanel(false);
  return true;
}

/** Where focus goes when something in Stage it sat on goes away: the footer's Play. */
export function focusStagePlay() {
  $(FOOTER_PLAY_ID)?.focus();
}

function onPanelCloseClick() {
  closeStageQueue();
}

function onChipClick() {
  if (isPanelOpen()) closeStageQueue();
  else openPanel();
}

function onUpNextChange(e) {
  upNext = { count: e.detail?.count ?? 0, nextId: e.detail?.nextId ?? null };
  paintChip();
}

export function initStageUpNext() {
  $("stageQueueBtn")?.addEventListener("click", onChipClick);
  $("stageQueueClose")?.addEventListener("click", onPanelCloseClick);
  document.addEventListener("upnext:change", onUpNextChange);
  paintChip();
}
