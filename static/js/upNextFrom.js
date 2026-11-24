// "Next from: {list}" under Up Next: the songs Next goes on to once Up Next is empty,
// each to play now or to add to Up Next.

import { displayTitle, getLibraryTrack, libraryTitle } from "./catalog.js";
import { PLAY_CONTEXT_CHANGE_EVENT, contextSongsAhead, playContextLabel } from "./playContext.js";
import { UP_NEXT_CHANGE_EVENT, firstInUpNext, playNow, queueUpNext, songText, thumbEl } from "./upNext.js";
import { wireRovingRows } from "./rovingRows.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

const SHOWN_AHEAD = 8;
const FROM_ROW = ".upnext-row";
const FROM_ROW_ACTIONS = ".upnext-play, .upnext-add";
const HAS_LIST_AHEAD_CLASS = "has-list-ahead";
const ADD_ICON = '<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>';

let fromRows = null;

function rowButton(className, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  return button;
}

function fromRow(trackId) {
  const track = getLibraryTrack(trackId);
  const li = document.createElement("li");
  li.className = "upnext-row upnext-from-row";
  li.dataset.id = trackId;
  const play = rowButton("upnext-play", t("upNext.playNow"));
  play.append(thumbEl(track), songText(track));
  play.addEventListener("click", function onPlayListSong() {
    playNow(trackId);
  });
  const add = rowButton("upnext-add", t("upNext.add"));
  add.setAttribute("aria-label", t("upNext.addTitle", { title: displayTitle(libraryTitle(track)) }));
  add.innerHTML = ADD_ICON;
  add.addEventListener("click", function onQueueListSong() {
    queueUpNext(trackId);
  });
  li.append(play, add);
  return li;
}

function renderFromList(ahead) {
  const list = $("upNextFromList");
  if (!list) return;
  const saved = fromRows?.remember();
  list.replaceChildren(...ahead.slice(0, SHOWN_AHEAD).map(fromRow));
  fromRows?.restore(saved);
  const more = $("upNextFromMore");
  if (!more) return;
  more.hidden = ahead.length <= SHOWN_AHEAD;
  more.textContent = t("studio.upNext.more", { count: ahead.length - SHOWN_AHEAD });
}

// The pane's own empty state gives way to the hint; Stage borrows #upNextEmpty and keeps it.
export function renderUpNextFrom() {
  const ahead = contextSongsAhead();
  $("inspectorPaneUpNext")?.classList.toggle(HAS_LIST_AHEAD_CLASS, ahead.length > 0);
  const hint = $("upNextNothingQueued");
  if (hint) hint.hidden = !ahead.length || Boolean(firstInUpNext());
  const block = $("upNextFrom");
  if (block) block.hidden = !ahead.length;
  const label = $("upNextFromLabel");
  if (label) label.textContent = t("studio.upNext.nextFrom", { list: playContextLabel() });
  renderFromList(ahead);
}

function playFromRow(row) {
  playNow(row.dataset.id);
}

function fromRowKey(row) {
  return row.dataset.id;
}

export function initUpNextFrom() {
  const list = $("upNextFromList");
  if (list) {
    fromRows = wireRovingRows(
      list,
      { rowSelector: FROM_ROW, actionSelector: FROM_ROW_ACTIONS, keyOf: fromRowKey, openRow: playFromRow },
    );
  }
  document.addEventListener(UP_NEXT_CHANGE_EVENT, renderUpNextFrom);
  document.addEventListener(PLAY_CONTEXT_CHANGE_EVENT, renderUpNextFrom);
  renderUpNextFrom();
}
