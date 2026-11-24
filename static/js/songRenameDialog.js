// Rename this song, from the song menu: title and artist over a dimmed page.
// Enter saves, Esc or a click outside cancels; an emptied field goes back to the detected name.

import { getTrackNames } from "./catalog.js";
import { t } from "./i18n.js";
import { SONG_NAME_MAX_CHARS } from "./libraryControls.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { editorDialogEl } from "./editorDialog.js";
import { esc } from "./songRowParts.js";
import { changedNames, renameFailureMessage, saveSongNames } from "./songRename.js";

const TITLE_KEY = "rename.open";
const BUSY_CLASS = "busy";

let dialog = null;
let opener = null;

function nameFieldHtml(className, labelKey) {
  return `<label class="folder-editor-field"><span data-i18n="${labelKey}">${esc(t(labelKey))}</span>
      <input class="folder-editor-name ${className}" type="text" maxlength="${SONG_NAME_MAX_CHARS}" autocomplete="off" spellcheck="false" />
    </label>`;
}

function fieldsHtml() {
  return `${nameFieldHtml("rename-title", "rename.titleLabel")}${nameFieldHtml("rename-artist", "rename.artistLabel")}
    <p class="song-rename-hint" data-i18n="lib.renameSongHint">${esc(t("lib.renameSongHint"))}</p>`;
}

function closeDialog() {
  dialog?.remove();
  dialog = null;
  if (opener?.isConnected) opener.focus();
  opener = null;
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
  try {
    await saveSongNames(trackId, body);
    closeDialog();
  } catch (err) {
    console.warn("[rename] saving the new names failed:", err);
    form.classList.remove(BUSY_CLASS);
    form.querySelector(".folder-editor-msg").textContent = renameFailureMessage(err);
  }
}

function fillNames(form, names) {
  const title = form.querySelector(".rename-title");
  const artist = form.querySelector(".rename-artist");
  title.value = names.userTitle || names.title || "";
  title.placeholder = names.detectedTitle || t("rename.titleLabel");
  artist.value = names.userArtist || names.artist || "";
  return { title: title.value.trim(), artist: artist.value.trim() };
}

/** Ask for a new title and artist for the song `trackId`. */
export function openSongRename(trackId) {
  const names = getTrackNames(trackId);
  if (!names) return;
  closeDialog();
  opener = document.activeElement;
  dialog = editorDialogEl({ titleKey: TITLE_KEY, className: "song-rename-dialog", fieldsHtml: fieldsHtml() });
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
