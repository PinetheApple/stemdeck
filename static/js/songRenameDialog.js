// Rename this song, from the song menu: title and artist over a dimmed page.
// Enter saves, Esc or a click outside cancels; an emptied field goes back to the detected name.

import { getTrackNames } from "./catalog.js";
import { t } from "./i18n.js";
import { SONG_NAME_MAX_CHARS } from "./libraryControls.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { editorDialogEl } from "./editorDialog.js";
import { esc } from "./songRowParts.js";
import { changedNames, saveSongNames } from "./songRename.js";
import { focusSongRow } from "./libraryRows.js";

const TITLE_KEY = "rename.open";
const BUSY_CLASS = "busy";

let dialog = null;
let opener = null;
let songId = null;

function nameFieldHtml(className, labelKey) {
  return `<label class="folder-editor-field"><span data-i18n="${labelKey}">${esc(t(labelKey))}</span>
      <input class="folder-editor-name ${className}" type="text" maxlength="${SONG_NAME_MAX_CHARS}" autocomplete="off" spellcheck="false" />
    </label>`;
}

function fieldsHtml() {
  return `${nameFieldHtml("rename-title", "rename.titleLabel")}${nameFieldHtml("rename-artist", "rename.artistLabel")}
    <p class="rename-dialog-hint" data-i18n="lib.renameSongHint">${esc(t("lib.renameSongHint"))}</p>`;
}

// A saved rename draws the rows again, so an opener that has gone hands focus to the song's new row.
function closeDialog() {
  dialog?.remove();
  dialog = null;
  if (opener?.isConnected) opener.focus();
  else if (songId) focusSongRow(songId);
  opener = null;
  songId = null;
}

function onDialogKeydown(e) {
  if (e.key === ESCAPE_KEY && escapeIsFor(LAYER.DIALOG)) closeDialog();
}

function onBackdropMousedown(e) {
  if (e.target === dialog) closeDialog();
}

async function save(trackId, form, initial) {
  const title = form.querySelector(".rename-title").value.trim();
  const artist = form.querySelector(".rename-artist").value.trim();
  const body = changedNames(initial, title, artist);
  if (!Object.keys(body).length) return closeDialog();
  form.classList.add(BUSY_CLASS);
  const failure = await saveSongNames(trackId, body);
  if (!failure) return closeDialog();
  form.classList.remove(BUSY_CLASS);
  form.querySelector(".folder-editor-msg").textContent = failure;
}

function fillNames(form, names) {
  const title = form.querySelector(".rename-title");
  const artist = form.querySelector(".rename-artist");
  title.value = names.userTitle || names.title || "";
  title.placeholder = names.detectedTitle || t("rename.titleLabel");
  artist.value = names.userArtist || names.artist || "";
  return { title: title.value.trim(), artist: artist.value.trim() };
}

/** `returnFocus` takes focus when the dialog closes; by default, whatever had it when it opened. */
export function openSongRename(trackId, { returnFocus = document.activeElement } = {}) {
  const names = getTrackNames(trackId);
  if (!names) return;
  closeDialog();
  opener = returnFocus;
  songId = trackId;
  dialog = editorDialogEl({ titleKey: TITLE_KEY, fieldsHtml: fieldsHtml() });
  const form = dialog.querySelector("form");
  const initial = fillNames(form, names);
  form.addEventListener("submit", function onRenameSubmit(e) {
    e.preventDefault();
    save(trackId, form, initial);
  });
  dialog.querySelector(".folder-editor-cancel").addEventListener("click", closeDialog);
  dialog.querySelector(".folder-editor-close").addEventListener("click", closeDialog);
  dialog.addEventListener("mousedown", onBackdropMousedown);
  dialog.addEventListener("keydown", onDialogKeydown);
  document.body.append(dialog);
  form.querySelector(".rename-title").select();
}
