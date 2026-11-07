// The Lyrics tab's editor: line edits, paste or file load, and going back.
// An unsaved edit is kept per track until a reload; lyrics.js owns what is shown.

import { t, getLanguage } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import {
  ACCEPTED_FILE_TYPES,
  LYRICS_MAX_CHARS,
  PROBLEM_READ_FAILED,
  decodeLyricsBytes,
  decodedTextProblem,
  deleteUserText,
  fileProblem,
  putUserText,
  splitLine,
} from "./lyricsUserText.js";

const KIND_LINES = "lines";
const KIND_PASTE = "paste";
const ROW_SPLIT = "split";
const ROW_ADD = "add";
const ROW_DELETE = "delete";

// Lucide "scissors" (ISC); the rest of the row's icons are the library pane's.
const SPLIT_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>';

let deps = null;
let panelEl = null;
let barEl = null;
let editLink = null;
let supplyLink = null;
let hostEl = null;
let session = null; // the edit open on screen
let ui = null; // its elements
const drafts = new Map(); // edits put aside, by track
let restoringFor = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function describe(problem) {
  if (problem.text) return problem.text;
  const max = new Intl.NumberFormat(getLanguage()).format(LYRICS_MAX_CHARS);
  return t(problem.key, { max, status: problem.status ?? "" });
}

function retag(field) {
  field.removeAttribute("lang");
  deps.tagLang(field, field.value);
}

/** Show the links for what is on screen now; lyrics.js calls it on each draw. */
export function refreshEditBar() {
  if (!barEl) return;
  barEl.hidden = !deps.trackId() || Boolean(session);
  editLink.textContent = t("lyrics.edit.open");
  editLink.title = t("lyrics.edit.openTitle");
  editLink.hidden = !deps.editable().rows.length;
  supplyLink.textContent = t("lyrics.supply.open");
  supplyLink.title = t("lyrics.supply.openTitle");
}

function onEditLinkClick() {
  openEditor(KIND_LINES);
}

function onSupplyLinkClick() {
  openEditor(KIND_PASTE);
}

function openEditor(kind) {
  deps.closeTools();
  const { rows, seedText } = deps.editable();
  showSession({
    trackId: deps.trackId(),
    kind,
    rows: kind === KIND_LINES ? rows.slice() : [],
    text: "",
    baseText: rows.join("\n"),
    seedText,
    busy: false,
    dirty: false,
    problem: null,
    notice: "",
  });
  focusFirstField();
}

function showSession(next) {
  session = next;
  panelEl.classList.add("lyrics-editing");
  hostEl.hidden = false;
  render();
  refreshEditBar();
}

function closeEditor() {
  const hadFocus = hostEl.contains(document.activeElement);
  session = null;
  ui = null;
  hostEl.hidden = true;
  hostEl.replaceChildren();
  panelEl.classList.remove("lyrics-editing");
  refreshEditBar();
  if (hadFocus) (editLink.hidden ? supplyLink : editLink).focus();
}

/** Another track was opened: the edit on screen goes aside, and one put aside
 * for this track comes back. An edit with no changes is simply closed. */
export function editorTrackChanged(trackId) {
  if (session) {
    if (session.dirty || session.busy) drafts.set(session.trackId, session);
    closeEditor();
  }
  const draft = drafts.get(trackId);
  if (!draft) return;
  drafts.delete(trackId);
  deps.closeTools();
  if (!draft.problem) draft.notice = t("lyrics.edit.draftKept");
  showSession(draft);
}

function onCancelClick() {
  if (session && !session.busy) closeEditor();
}

function render() {
  const fields = el("fieldset", "lyrics-editor-fields");
  const message = el("p", "lyrics-align-message");
  message.setAttribute("aria-live", "polite");
  const cancel = button("lyrics-align-btn", t("lyrics.edit.cancel"), onCancelClick);
  const save = button("lyrics-align-btn lyrics-align-done", t("lyrics.edit.save"), onSaveClick);
  const actions = el("div", "lyrics-editor-actions");
  actions.append(cancel, save);
  ui = { fields, message, save, list: null };

  const isLines = session.kind === KIND_LINES;
  const title = t(isLines ? "lyrics.edit.title" : "lyrics.supply.title");
  hostEl.setAttribute("aria-label", title);
  fields.append(
    el("h3", "lyrics-sync-title", title),
    ...(isLines ? linesFields() : pasteFields()),
    message,
    actions,
  );
  hostEl.replaceChildren(fields);
  paintState();
  fitRows();
}

function paintState() {
  ui.fields.disabled = session.busy;
  ui.save.textContent = t(session.busy ? "lyrics.edit.saving" : "lyrics.edit.save");
  ui.message.textContent = session.problem ? describe(session.problem) : session.notice;
  ui.message.classList.toggle("error", Boolean(session.problem));
}

function focusFirstField() {
  hostEl.querySelector("input:not([type=file]), textarea")?.focus();
}

function linesFields() {
  ui.list = el("ol", "lyrics-edit-rows");
  ui.list.addEventListener("input", onRowInput);
  ui.list.addEventListener("click", onRowClick);
  drawRows();
  return [ui.list, button("lyrics-align-btn", t("lyrics.edit.addLine"), onAddLineClick)];
}

function rowButton(action, label, markup) {
  const node = button("lyrics-edit-btn");
  node.dataset.action = action;
  node.title = label;
  node.setAttribute("aria-label", label);
  node.innerHTML = markup;
  return node;
}

function fitRow(area) {
  area.style.height = "auto";
  if (area.scrollHeight) area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}

function fitRows() {
  ui?.list?.querySelectorAll(".lyrics-edit-input").forEach(fitRow);
}

function drawRows() {
  ui.list.replaceChildren(...session.rows.map((text, index) => {
    const row = el("li", "lyrics-edit-row");
    row.dataset.row = String(index);
    const input = el("textarea", "lyrics-edit-input");
    input.rows = 1;
    input.value = text;
    input.setAttribute("aria-label", t("lyrics.edit.lineAria", { n: index + 1 }));
    retag(input);
    const actions = el("div", "lyrics-edit-row-actions");
    actions.append(
      rowButton(ROW_SPLIT, t("lyrics.edit.split"), SPLIT_ICON),
      rowButton(ROW_ADD, t("lyrics.edit.addBelow"), icon("plus")),
      rowButton(ROW_DELETE, t("lyrics.edit.delete"), icon("trash")),
    );
    row.append(input, actions);
    return row;
  }));
  fitRows();
}

function rowIndexOf(node) {
  return Number(node.closest("[data-row]").dataset.row);
}

function rowsChanged(focusIndex, caret = 0) {
  session.dirty = true;
  session.problem = null;
  session.notice = "";
  paintState();
  drawRows();
  // Focus must stay in the editor: on the page, Backspace trashes the track.
  const input = ui.list.children[focusIndex]?.querySelector(".lyrics-edit-input");
  if (input) {
    input.focus();
    input.setSelectionRange(caret, caret);
  } else {
    hostEl.focus();
  }
}

function splitRow(index, caret) {
  session.rows.splice(index, 1, ...splitLine(session.rows[index], caret));
  rowsChanged(index + 1);
}

/** A newline that arrived by paste or drop starts a row of its own. */
function spreadRow(index, area) {
  const caretLines = area.value.slice(0, area.selectionStart).split("\n");
  session.rows.splice(index, 1, ...area.value.split("\n"));
  rowsChanged(index + caretLines.length - 1, caretLines.at(-1).length);
}

function onRowInput(e) {
  const index = rowIndexOf(e.target);
  if (e.target.value.includes("\n")) {
    spreadRow(index, e.target);
    return;
  }
  session.rows[index] = e.target.value;
  session.dirty = true;
  retag(e.target);
  fitRow(e.target);
}

function onRowClick(e) {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const index = rowIndexOf(e.target);
  if (action === ROW_SPLIT) {
    const input = ui.list.children[index].querySelector(".lyrics-edit-input");
    splitRow(index, input.selectionStart ?? input.value.length);
  } else if (action === ROW_ADD) {
    session.rows.splice(index + 1, 0, "");
    rowsChanged(index + 1);
  } else if (action === ROW_DELETE) {
    session.rows.splice(index, 1);
    rowsChanged(Math.min(index, session.rows.length - 1));
  }
}

function onAddLineClick() {
  session.rows.push("");
  rowsChanged(session.rows.length - 1);
  ui.list.lastElementChild?.scrollIntoView({ block: "nearest" });
}

/** The app's keys stay out of the editor: Space would play on a focused
 * button and Backspace would trash the track. Enter in a line splits it, but
 * not while an input method is using it to confirm a word. */
function onEditorKeydown(e) {
  e.stopPropagation();
  if (e.key !== "Enter" || e.isComposing || !e.target.matches?.(".lyrics-edit-input")) return;
  e.preventDefault();
  splitRow(rowIndexOf(e.target), e.target.selectionStart ?? e.target.value.length);
}

function pasteFields() {
  const area = el("textarea", "lyrics-paste");
  area.value = session.text;
  area.placeholder = t("lyrics.supply.placeholder");
  area.setAttribute("aria-label", t("lyrics.supply.aria"));
  area.addEventListener("input", onPasteInput);
  retag(area);
  const file = el("input", "lyrics-supply-file");
  file.type = "file";
  file.accept = ACCEPTED_FILE_TYPES;
  file.hidden = true;
  file.addEventListener("change", onFileChosen);
  const hint = el("p", "lyrics-align-hint", t("lyrics.supply.hint"));
  return [hint, area, file, button("lyrics-align-btn", t("lyrics.supply.loadFile"), onLoadFileClick)];
}

function onLoadFileClick() {
  hostEl.querySelector(".lyrics-supply-file")?.click();
}

function onPasteInput(e) {
  session.text = e.target.value;
  session.dirty = true;
  session.problem = null;
  session.notice = "";
  retag(e.target);
  paintState();
}

function refuseFile(owner, problem) {
  owner.problem = problem;
  owner.notice = "";
  if (owner === session) paintState();
}

/** What a file holds goes in the box for a look before it is saved. */
async function onFileChosen(e) {
  const owner = session;
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const problem = fileProblem(file);
  if (problem) return refuseFile(owner, problem);
  let text = null;
  try {
    text = decodeLyricsBytes(await file.arrayBuffer());
  } catch (err) {
    console.warn("lyrics file read failed", err);
    return refuseFile(owner, { key: PROBLEM_READ_FAILED });
  }
  const textProblem = decodedTextProblem(text);
  if (textProblem) return refuseFile(owner, textProblem);
  owner.text = text;
  owner.dirty = true;
  owner.problem = null;
  owner.notice = t("lyrics.supply.loaded", { name: file.name });
  if (owner !== session) return;
  render();
  focusFirstField();
}

/** Lyrics kept in this browser are not the server's to carry timing from, so
 * they go up as they are first; what that answers is on screen behind the edit. */
async function saveLineEdit(owner, text) {
  if (owner.seedText) {
    const seeded = await putUserText(owner.trackId, { text: owner.seedText });
    if (!seeded.ok) return seeded;
    owner.seedText = "";
    deps.onSaved(owner.trackId, seeded.data);
  }
  return putUserText(owner.trackId, { text, keep_timing: true });
}

function setBusy(owner, busy) {
  owner.busy = busy;
  if (owner !== session) return;
  // A disabled field drops focus to the page, where Backspace trashes the track.
  if (busy) hostEl.focus();
  paintState();
  if (!busy && document.activeElement === hostEl) ui.save.focus();
}

async function onSaveClick() {
  const owner = session;
  if (!owner || owner.busy) return;
  const isLines = owner.kind === KIND_LINES;
  const text = isLines ? owner.rows.join("\n") : owner.text;
  if (isLines && text === owner.baseText) {
    closeEditor();
    return;
  }
  owner.problem = null;
  owner.notice = "";
  setBusy(owner, true);
  await deps.flush();
  const answer = isLines ? await saveLineEdit(owner, text) : await putUserText(owner.trackId, { text });
  if (answer.ok) {
    owner.busy = false;
    drafts.delete(owner.trackId);
    deps.onSaved(owner.trackId, answer.data);
    if (owner === session) closeEditor();
    return;
  }
  owner.problem = answer.problem;
  setBusy(owner, false);
}

/** Drop the user's lyrics for what they replaced, or for nothing. */
export async function restoreOriginal() {
  const trackId = deps.trackId();
  if (!trackId || restoringFor === trackId) return;
  restoringFor = trackId;
  deps.setStatus(t("lyrics.edit.restoring"), "loading");
  await deps.flush();
  const answer = await deleteUserText(trackId);
  restoringFor = null;
  if (answer.ok) {
    await deps.onRestored(trackId, Boolean(answer.nothingLeft));
    return;
  }
  console.warn("lyrics restore refused", answer.status);
  if (trackId === deps.trackId()) deps.setStatus(describe(answer.problem), "error");
}

/**
 * `dependencies`: trackId() the open track; editable() { rows, seedText } what
 * can be edited now; closeTools() leave Sync lines and Align; flush() save what
 * is waiting; tagLang(node, text); setStatus(text, kind); onSaved(trackId, data)
 * and onRestored(trackId, nothingLeft) to draw the answer.
 */
export function initLyricsEdit(panel, versionsEl, dependencies) {
  deps = dependencies;
  panelEl = panel;
  barEl = el("div", "lyrics-supply");
  editLink = button("lyrics-link lyrics-edit-open", "", onEditLinkClick);
  supplyLink = button("lyrics-link lyrics-supply-open", "", onSupplyLinkClick);
  barEl.append(editLink, supplyLink);
  barEl.hidden = true;
  versionsEl.after(barEl);
  hostEl = el("div", "lyrics-editor");
  hostEl.id = "lyricsEditor";
  hostEl.tabIndex = -1;
  hostEl.hidden = true;
  hostEl.setAttribute("role", "group");
  hostEl.addEventListener("keydown", onEditorKeydown);
  panel.append(hostEl);
  // Wrapping depends on the width, and a hidden tab measures as nothing.
  new ResizeObserver(fitRows).observe(hostEl);
}
