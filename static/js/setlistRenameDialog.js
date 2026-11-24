// Rename setlist: a name field with Cancel and Save, over a dimmed page.
// Enter saves, Esc or a click outside cancels, and focus goes back to the opener.

import { t } from "./i18n.js";
import { getSetlist, renameSetlist } from "./setlists.js";
import { SETLIST_NAME_MAX_CHARS } from "./libraryControls.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { esc } from "./songRowParts.js";

let dialog = null;
let opener = null;

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

function dialogMarkup() {
  const title = esc(t("lib.renameSetlist"));
  return `<form class="folder-editor setlist-rename-dialog" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="folder-editor-head"><span>${title}</span>
        <button class="folder-editor-close" type="button" aria-label="${esc(t("folderEditor.closeAria"))}" title="${esc(t("folderEditor.closeAria"))}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
      </div>
      <label class="folder-editor-field"><span>${esc(t("folderEditor.nameLabel"))}</span>
        <input class="folder-editor-name" type="text" maxlength="${SETLIST_NAME_MAX_CHARS}" autocomplete="off" spellcheck="false" />
      </label>
      <div class="folder-editor-actions">
        <button class="folder-editor-cancel" type="button">${esc(t("folderEditor.cancel"))}</button>
        <button class="folder-editor-save" type="submit">${esc(t("folderEditor.save"))}</button>
      </div>
    </form>`;
}

/** Ask for a new name for the setlist `id`; an empty name changes nothing. */
export function openSetlistRename(id) {
  const setlist = getSetlist(id);
  if (!setlist) return;
  closeDialog();
  opener = document.activeElement;
  dialog = document.createElement("div");
  dialog.className = "folder-editor-backdrop";
  dialog.innerHTML = dialogMarkup();
  const input = dialog.querySelector("input");
  input.value = setlist.name;
  dialog.querySelector("form").addEventListener("submit", function onRenameSubmit(e) {
    e.preventDefault();
    const name = input.value.trim();
    closeDialog();
    if (name) renameSetlist(id, name);
  });
  dialog.querySelector(".folder-editor-cancel").addEventListener("click", closeDialog);
  dialog.querySelector(".folder-editor-close").addEventListener("click", closeDialog);
  dialog.addEventListener("mousedown", onBackdropMousedown);
  dialog.addEventListener("keydown", onDialogKeydown);
  document.body.append(dialog);
  input.focus();
  input.select();
}
