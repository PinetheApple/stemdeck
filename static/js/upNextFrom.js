import { icon } from "./libraryIcons.js";
import { PLAY_CONTEXT_CHANGE_EVENT, contextSongsAhead, playContextLabel } from "./playContext.js";
import { UP_NEXT_CHANGE_EVENT, firstInUpNext, playNow, queueUpNext, songTitle, upNextButton, upNextRowEl } from "./upNext.js";
import { wireRovingRows } from "./rovingRows.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

const SHOWN_AHEAD = 8;
const FROM_ROW = ".upnext-row";
const FROM_ROW_ACTIONS = ".upnext-play, .upnext-add";
const FROM_ROW_CLASS = "upnext-from-row";
const HAS_LIST_AHEAD_CLASS = "has-list-ahead";

let fromRows = null;

function fromRow(trackId) {
  const add = upNextButton("upnext-add", t("upNext.add"), t("upNext.addTitle", { title: songTitle(trackId) }));
  add.innerHTML = icon("listPlus");
  add.addEventListener("click", function onQueueListSong() {
    queueUpNext(trackId);
  });
  const row = upNextRowEl(trackId, {
    onPlay: function onPlayListSong() {
      playNow(trackId);
    },
    action: add,
  });
  row.classList.add(FROM_ROW_CLASS);
  return row;
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
