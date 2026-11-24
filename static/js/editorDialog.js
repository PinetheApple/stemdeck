// The shell the folder editor and the setlist rename share: title, close, fields, Cancel and Save.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { esc } from "./songRowParts.js";

const CLOSE_KEY = "folderEditor.closeAria";

/** A name field limited to `maxLength` characters. */
export function nameFieldHtml(maxLength) {
  return `<label class="folder-editor-field"><span data-i18n="folderEditor.nameLabel">${esc(t("folderEditor.nameLabel"))}</span>
      <input class="folder-editor-name" type="text" maxlength="${maxLength}" autocomplete="off" spellcheck="false" />
    </label>`;
}

/** A backdrop holding the dialog titled `titleKey`, with `fieldsHtml` above its message line and buttons. */
export function editorDialogEl({ titleKey, className = "", fieldsHtml }) {
  const title = esc(t(titleKey));
  const close = esc(t(CLOSE_KEY));
  const backdrop = document.createElement("div");
  backdrop.className = "folder-editor-backdrop";
  backdrop.innerHTML = `<form class="${["folder-editor", className].filter(Boolean).join(" ")}" role="dialog" aria-modal="true" aria-label="${title}" data-i18n-aria-label="${titleKey}">
      <div class="folder-editor-head">
        <span data-i18n="${titleKey}">${title}</span>
        <button class="folder-editor-close" type="button" title="${close}" aria-label="${close}" data-i18n-title="${CLOSE_KEY}" data-i18n-aria-label="${CLOSE_KEY}">${icon("x")}</button>
      </div>
      ${fieldsHtml}
      <div class="folder-editor-msg" role="alert" aria-live="polite"></div>
      <div class="folder-editor-actions">
        <button class="folder-editor-cancel" type="button" data-i18n="folderEditor.cancel">${esc(t("folderEditor.cancel"))}</button>
        <button class="folder-editor-save" type="submit" data-i18n="folderEditor.save">${esc(t("folderEditor.save"))}</button>
      </div>
    </form>`;
  return backdrop;
}
