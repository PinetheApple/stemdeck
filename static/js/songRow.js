// One library song as a row or as a Browse grid card; the cover shows Play,
// moving bars while it plays, or Resume.

import { t as i18nT } from "./i18n.js";
import {
  PROCESSING_STATUSES, extractStoppedTrack, getLibraryTrack, getPlayingTrackInfo, restoreTracksFromTrash,
  retryFailedImport, toggleFavorite, wireSourceBlock,
} from "./catalog.js";
import { trashWithUndo } from "./trashUndo.js";
import { SONG_MENU_ATTR } from "./songMenu.js";
import { FAILED_STATUS, sourceKindOf } from "./importSource.js";
import { icon } from "./libraryIcons.js";
import { OUT_OF_TAB_ORDER, ROW_PLAY_CLASS } from "./rovingRows.js";
import { queueUpNext } from "./upNext.js";
import { wireVersionToggle } from "./versions.js";
import { wireTrackDrag } from "./songDrag.js";
import { isSongPlaying } from "./playState.js";
import { togglePlayPause } from "./transport.js";
import {
  cardCoverButtonsHtml, esc, failedRowHtml, isDone, labelledButton, restoreButtonHtml, showsVersionRows,
  songActionsHtml, thumbHtml, titleOf, trackSublineHtml,
} from "./songRowParts.js";

export const SONG_ROW_CLASS = "cat-item";
export const SONG_CARD_CLASS = "song-card";
const RESUME_CLASS = "cat-resume";
const PLAYING_CLASS = "is-playing";
const TRACK_MENU_EVENT = "trackmenu";
const EQ_BARS_HTML = '<span class="eqbars" aria-hidden="true"><i></i><i></i><i></i></span>';

function onRetryButton(trackId, button) {
  button.disabled = true;
  retryFailedImport(trackId);
}

function onExtractButton(trackId, button) {
  button.disabled = true;
  extractStoppedTrack(trackId);
}

// songMenu.js draws the menu; an event, since it imports this module's importers.
function onMoreButton(trackId, button) {
  document.dispatchEvent(new CustomEvent(TRACK_MENU_EVENT, { detail: { id: trackId, anchor: button } }));
}

const ROW_BUTTONS = [
  [".song-card-fav", toggleFavorite],
  [".cat-upnext", queueUpNext],
  [".cat-more, .song-card-more", onMoreButton],
  [".import-fail-trash", trashWithUndo],
  [".cat-extract", onExtractButton],
  [".cat-retry, .import-fail-primary", onRetryButton],
  [".cat-restore", (trackId) => restoreTracksFromTrash([trackId])],
  [`.${RESUME_CLASS}`, togglePlayPause],
];

function onSongRowButtonClick(e) {
  const row = e.currentTarget;
  for (const [selector, act] of ROW_BUTTONS) {
    const button = e.target.closest(selector);
    if (!button || !row.contains(button)) continue;
    e.stopPropagation();
    act(row.dataset.id, button);
    return;
  }
}

function coverActionHtml(trackId, track, inTrash = false) {
  if (inTrash) return "";
  if (track.status === FAILED_STATUS) return icon(sourceKindOf(track));
  const title = titleOf(track);
  if (trackId === getPlayingTrackInfo()?.id) {
    if (isSongPlaying(trackId)) return EQ_BARS_HTML;
    const label = i18nT("lib.resumeTitle", { title });
    return labelledButton(RESUME_CLASS, label, label, icon("play", { filled: true }), `tabindex="${OUT_OF_TAB_ORDER}"`);
  }
  if (!isDone(track)) return "";
  const label = i18nT("track.playTitle", { title });
  return labelledButton(ROW_PLAY_CLASS, label, label, icon("play", { filled: true }), `tabindex="${OUT_OF_TAB_ORDER}"`);
}

function rowClasses(trackId, track, { inTrash = false, card = false } = {}) {
  const isFailed = !inTrash && track.status === FAILED_STATUS;
  const playing = trackId === getPlayingTrackInfo()?.id;
  return [
    SONG_ROW_CLASS,
    card ? SONG_CARD_CLASS : "srow",
    playing ? `active ${PLAYING_CLASS}` : "",
    track.status === "unavailable" ? "unavailable" : "",
    !inTrash && track.favorite ? "is-fav" : "",
    !inTrash && track.status === "stopped" ? "is-stopped" : "",
    inTrash ? "in-trash" : "",
    isFailed ? "is-failed" : "",
    !card && showsVersionRows(track, inTrash) ? "has-versions" : "",
  ].filter(Boolean).join(" ");
}

function statusClass(track) {
  if (PROCESSING_STATUSES.has(track.status)) return " processing";
  return track.status === "unavailable" ? " unavailable" : "";
}

function actionsHtml(track, { inTrash = false, actions = null } = {}) {
  if (actions !== null) return `<div class="cat-actions">${actions}</div>`;
  if (inTrash) return `<div class="cat-actions">${restoreButtonHtml(track)}</div>`;
  if (track.status === FAILED_STATUS) return failedRowHtml(track);
  return `<div class="cat-actions">${songActionsHtml(track)}</div>`;
}

function wireSongEl(el, trackId, inTrash = false) {
  el.setAttribute(SONG_MENU_ATTR, "");
  el.addEventListener("click", onSongRowButtonClick);
  wireVersionToggle(el);
  wireSourceBlock(el);
  if (!inTrash) wireTrackDrag(el, trackId);
}

/** `lead` goes before the cover, `cells` are the list's columns; `actions` and `sub` replace
 *  the row's buttons and sub-line. */
export function songRowEl(trackId, { inTrash = false, lead = "", cells = "", actions = null, sub = null } = {}) {
  const track = getLibraryTrack(trackId);
  if (!track) return null;
  const el = document.createElement("div");
  el.className = rowClasses(trackId, track, { inTrash });
  el.dataset.id = trackId;
  el.innerHTML = `${lead}
    <div class="cat-thumb">${thumbHtml(track)}${coverActionHtml(trackId, track, inTrash)}</div>
    <div class="cat-meta">
      <div class="cat-title">${esc(titleOf(track))}</div>
      <div class="cat-sub">${sub === null ? trackSublineHtml(track, { inTrash }) : esc(sub)}</div>
    </div>
    ${cells}
    <div class="cat-status${statusClass(track)}"></div>
    ${actionsHtml(track, { inTrash, actions })}`;
  wireSongEl(el, trackId, inTrash);
  return el;
}

export function songCardEl(trackId) {
  const track = getLibraryTrack(trackId);
  if (!track) return null;
  const el = document.createElement("div");
  el.className = rowClasses(trackId, track, { card: true });
  el.dataset.id = trackId;
  el.innerHTML = `
    <div class="cat-thumb">${thumbHtml(track)}${coverActionHtml(trackId, track)}${cardCoverButtonsHtml(track)}</div>
    <div class="cat-meta">
      <div class="cat-title">${esc(titleOf(track))}</div>
      <div class="cat-sub">${trackSublineHtml(track)}</div>
    </div>
    <div class="cat-status${statusClass(track)}"></div>
    ${isDone(track) ? "" : actionsHtml(track)}`;
  wireSongEl(el, trackId);
  return el;
}
