// The markup pieces of a library song's row: cover, sub-line, row buttons and
// a failed import's panel. songRow.js puts them together and wires them.

import { t as i18nT } from "./i18n.js";
import { PROCESSING_STATUSES, displayTitle, libraryArtistName, libraryTitle, sourceBlockHtml } from "./catalog.js";
import { trackFormat, formatIconSvg } from "./formatIcon.js";
import { FILE_GONE_REASON_KEY, failureReasonKey, needsFilePickedAgain } from "./importSource.js";
import { icon } from "./libraryIcons.js";
import { hasVersionRows } from "./versionModel.js";
import { versionToggleHtml } from "./versions.js";
import { fmtTime } from "./utils.js";

const MUSIC_NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const titleOf = (track) => displayTitle(libraryTitle(track));

export function thumbHtml(track) {
  if (track.thumb) return `<img src="${esc(track.thumb)}" alt="" loading="lazy" />`;
  const format = trackFormat(track);
  return format ? formatIconSvg(format) : MUSIC_NOTE_SVG;
}

// A URL-sourced song can be rebuilt by importing it again; an upload only by uploading it again.
const canReimportTrack = (track) => Boolean(track.sourceUrl) && !track.sourceUrl.startsWith("local:");

function unavailableWarningHtml(track) {
  const label = i18nT(canReimportTrack(track) ? "track.unavailableReimport" : "track.unavailableReupload");
  return `<span class="cat-unavailable-warning">${esc(label)}</span>`;
}

export function showsVersionRows(track, inTrash = false) {
  return !inTrash && track.status === "done" && hasVersionRows(track);
}

function sublineParts(track, inTrash) {
  if (PROCESSING_STATUSES.has(track.status)) return [i18nT("job.processing")];
  if (track.status === "error") return [i18nT("notifKind.importFailed")];
  if (track.status === "stopped") return [i18nT("track.stopped")];
  const timeShown = track.duration && !showsVersionRows(track, inTrash);
  return [libraryArtistName(track), timeShown ? fmtTime(track.duration) : ""];
}

/** The line under a song's title, built from what is true of it now; HTML, since an unavailable song's is a warning. */
export function trackSublineHtml(track, { inTrash = false } = {}) {
  if (track.status === "unavailable") return unavailableWarningHtml(track);
  const parts = sublineParts(track, inTrash);
  if (inTrash) parts.push(i18nT("track.removed"));
  return [
    ...parts.filter(Boolean).map((part) => `<span>${esc(part)}</span>`),
    ...(showsVersionRows(track, inTrash) ? [versionToggleHtml(track)] : []),
  ].join(' <span class="dot">·</span> ');
}

export function labelledButton(className, tip, label, content, extra = "") {
  return `<button class="${className}" type="button" title="${esc(tip)}" aria-label="${esc(label)}" ${extra}>${content}</button>`;
}

function favButtonHtml(track) {
  const on = Boolean(track.favorite);
  const label = i18nT(on ? "track.unfavoriteTitle" : "track.favoriteTitle", { title: titleOf(track) });
  const heart = icon("heart", { filled: on });
  return labelledButton(`cat-fav${on ? " active" : ""}`, i18nT(on ? "track.unfavorite" : "track.favorite"), label, heart, `aria-pressed="${on}"`);
}

export const isDone = (track) => track.status === "done";

function upNextButtonHtml(track) {
  if (!isDone(track)) return "";
  return labelledButton("cat-upnext", i18nT("upNext.add"), i18nT("upNext.addTitle", { title: titleOf(track) }), icon("listPlus"));
}

function moreButtonHtml(track) {
  if (!isDone(track)) return "";
  const label = i18nT("trackMenu.openTitle", { title: titleOf(track) });
  return labelledButton("cat-more", i18nT("trackMenu.open"), label, icon("more"), 'aria-haspopup="menu"');
}

// A song stopped by the Trash keeps its files; this is the one way to run it again.
function extractButtonHtml(track) {
  if (track.status !== "stopped") return "";
  const text = i18nT("track.extractAgain");
  return labelledButton("cat-extract", text, i18nT("track.extractAgainOf", { title: displayTitle(track.title) }), esc(text));
}

function trashButtonHtml(track) {
  return labelledButton("cat-del", i18nT("track.moveToTrash"), i18nT("track.moveTitleToTrash", { title: titleOf(track) }), icon("trash"));
}

export function restoreButtonHtml(track) {
  const label = i18nT("lib.restoreTitle", { title: titleOf(track) });
  return labelledButton("cat-restore", label, label, icon("restore"));
}

export function songActionsHtml(track) {
  return `${extractButtonHtml(track)}${upNextButtonHtml(track)}${moreButtonHtml(track)}${favButtonHtml(track)}${trashButtonHtml(track)}`;
}

export function failedRowHtml(track) {
  const pickAgain = needsFilePickedAgain(track);
  const title = titleOf(track);
  const label = i18nT(pickAgain ? "importFail.pickAgainTitle" : "importFail.retryTitle", { title });
  const tip = i18nT(pickAgain ? "importFail.pickAgain" : "importFail.retry");
  return `<div class="cat-actions">${labelledButton("cat-retry", tip, label, icon("restore"))}</div>${failedPanelHtml(track, pickAgain)}`;
}

function failedPanelHtml(track, pickAgain) {
  const reasonKey = pickAgain ? FILE_GONE_REASON_KEY : failureReasonKey(track.errorCode);
  const primaryKey = pickAgain ? "importFail.pickAgain" : "importFail.retry";
  return `<div class="import-fail-panel">
      <p class="import-fail-reason">${icon("alert")}<span>${esc(i18nT(reasonKey))}</span></p>
      ${sourceBlockHtml(track)}
      <div class="import-fail-actions">
        <button class="import-fail-btn import-fail-primary" type="button">${icon(pickAgain ? "folderOpen" : "restore")}<span>${esc(i18nT(primaryKey))}</span></button>
        <button class="import-fail-btn import-fail-trash" type="button">${icon("trash")}<span>${esc(i18nT("nav.trash"))}</span></button>
      </div>
    </div>`;
}
