// Rename setlist: a name field with Cancel and Save, over a dimmed page.
// Enter saves, Esc or a click outside cancels, and focus goes back to the opener.

import { getSetlist, renameSetlist } from "./setlists.js";
import { SETLIST_NAME_MAX_CHARS } from "./libraryControls.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { editorDialogEl, nameFieldHtml } from "./editorDialog.js";

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

/** Ask for a new name for the setlist `id`; an empty name changes nothing. */
export function openSetlistRename(id) {
  const setlist = getSetlist(id);
  if (!setlist) return;
  closeDialog();
  opener = document.activeElement;
  dialog = editorDialogEl({
    titleKey: "lib.renameSetlist",
    className: "setlist-rename-dialog",
    fieldsHtml: nameFieldHtml(SETLIST_NAME_MAX_CHARS),
  });
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
