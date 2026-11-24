// Edit section: rename a section, lock its position or delete it, in the shared dialog card.

import {
  SECTIONS_CHANGED_EVENT,
  SECTION_EDIT_EVENT,
  deleteSection,
  findSection,
  getSections,
  renameSection,
  sectionDisplayName,
  setSectionLocked,
} from "./sections.js";
import { openDialogLayer } from "./dialogLayer.js";
import { dialogHead } from "./dialogHead.js";
import { icon } from "./libraryIcons.js";
import { t } from "./i18n.js";

const ENTER_KEY = "Enter";
const KEY = Object.freeze({
  TITLE: "studio.sectionEdit.title",
  NAME: "studio.sectionEdit.name",
  HINT: "studio.sectionEdit.hint",
  LOCKED_HINT: "studio.sectionEdit.lockedHint",
  LOCK: "sections.lockAria",
  LOCK_HINT: "studio.sectionEdit.lockHint",
  DELETE: "sections.deleteAria",
  CANCEL: "resetConfirm.cancel",
  SAVE: "studio.sectionEdit.save",
});
const ID = Object.freeze({
  NAME: "sectionEditName",
  HINT: "sectionEditHint",
  LOCK: "sectionEditLock",
  DELETE: "sectionEditDelete",
  CANCEL: "sectionEditCancel",
  SAVE: "sectionEditSave",
});

let editing = null;

function cardMarkup() {
  return `
    <div class="dialog-card section-edit-card" role="dialog" aria-modal="true">
      <div class="dialog-body">
        <label class="section-edit-field"><span>${t(KEY.NAME)}</span>
          <input id="${ID.NAME}" class="section-edit-name" type="text" autocomplete="off" spellcheck="false"></label>
        <p class="section-edit-hint" id="${ID.HINT}"></p>
        <div class="section-edit-row">
          <span class="section-edit-row-text"><b>${t(KEY.LOCK)}</b><span>${t(KEY.LOCK_HINT)}</span></span>
          <button class="settings-switch section-edit-switch" id="${ID.LOCK}" type="button" aria-label="${t(KEY.LOCK)}"><span class="settings-switch-track"><span class="settings-switch-thumb"></span></span></button>
        </div>
      </div>
      <div class="dialog-foot about-primary-links">
        <button class="about-link dialog-foot-start section-edit-delete" id="${ID.DELETE}" type="button">${icon("trash")}${t(KEY.DELETE)}</button>
        <button class="about-link" id="${ID.CANCEL}" type="button">${t(KEY.CANCEL)}</button>
        <button class="about-link about-link-primary" id="${ID.SAVE}" type="button">${t(KEY.SAVE)}</button>
      </div>
    </div>`;
}

const field = (id) => editing.overlay.querySelector(`#${id}`);

function paintLock(locked) {
  field(ID.LOCK).setAttribute("aria-pressed", String(locked));
  field(ID.NAME).disabled = locked;
  field(ID.HINT).textContent = t(locked ? KEY.LOCKED_HINT : KEY.HINT);
}

function closeEditor() {
  editing?.layer?.close();
}

function onEditorClosed() {
  document.removeEventListener(SECTIONS_CHANGED_EVENT, onSectionsChangedWhileEditing);
  editing?.overlay.remove();
  editing = null;
}

function onSectionsChangedWhileEditing() {
  if (editing && !findSection(editing.id)) closeEditor();
}

// Rename refuses a locked section, so an unlock lands before the name and a lock after it.
function onSaveSection() {
  const { id, locked } = editing;
  if (!locked) applyLock(id, false);
  renameSection(id, field(ID.NAME).value);
  if (locked) applyLock(id, true);
  closeEditor();
}

function applyLock(id, locked) {
  if (Boolean(findSection(id)?.locked) !== locked) setSectionLocked(id, locked);
}

function onNameKeydown(e) {
  if (e.key !== ENTER_KEY) return;
  e.preventDefault();
  onSaveSection();
}

function onLockToggle() {
  editing.locked = !editing.locked;
  paintLock(editing.locked);
}

function onDeleteSection() {
  deleteSection(editing.id);
  closeEditor();
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "dialog-scrim section-edit-scrim";
  overlay.innerHTML = cardMarkup();
  const card = overlay.querySelector(".section-edit-card");
  card.setAttribute("aria-label", t(KEY.TITLE));
  const head = dialogHead();
  head.querySelector(".dialog-title").textContent = t(KEY.TITLE);
  head.querySelector(".dialog-close").addEventListener("click", closeEditor);
  card.prepend(head);
  overlay.querySelector(`#${ID.NAME}`).addEventListener("keydown", onNameKeydown);
  overlay.querySelector(`#${ID.LOCK}`).addEventListener("click", onLockToggle);
  overlay.querySelector(`#${ID.DELETE}`).addEventListener("click", onDeleteSection);
  overlay.querySelector(`#${ID.CANCEL}`).addEventListener("click", closeEditor);
  overlay.querySelector(`#${ID.SAVE}`).addEventListener("click", onSaveSection);
  return overlay;
}

function openEditor(id) {
  const section = findSection(id);
  if (!section) return;
  closeEditor();
  const opener = document.activeElement;
  const overlay = buildOverlay();
  document.body.append(overlay);
  editing = { id, overlay, layer: null, locked: section.locked === true };
  editing.layer = openDialogLayer(overlay, { onClose: onEditorClosed, opener });
  document.addEventListener(SECTIONS_CHANGED_EVENT, onSectionsChangedWhileEditing);
  const name = field(ID.NAME);
  name.value = sectionDisplayName(section, getSections());
  paintLock(editing.locked);
  if (editing.locked) field(ID.LOCK).focus();
  else name.select();
}

function onSectionEditRequest(e) {
  openEditor(e.detail?.id);
}

export function initSectionEdit() {
  document.addEventListener(SECTION_EDIT_EVENT, onSectionEditRequest);
}
