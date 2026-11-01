// Rename a song's title and artist in place, in the song head or a library row.
// Saved with PATCH /api/jobs/{id}; the song is then looked up again by its new names.

import { applyRenamedState, getCurrentTrackInfo, getTrackNames, relookupTrack } from "./catalog.js";
import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { SONG_NAME_MAX_CHARS, fetchJson, iconButton, isNotFound, refusalReason, textInput } from "./libraryControls.js";
import { $ } from "./utils.js";

let editor = null; // { trackId, place: "head" | "row", close }

function nameInput(className, value, labelKey, placeholder) {
  return textInput({
    className: `rename-input ${className}`,
    value,
    label: t(labelKey),
    placeholder: placeholder || t(labelKey),
    maxLength: SONG_NAME_MAX_CHARS,
  });
}

function restoreButton(names) {
  const label = names.detectedTitle ? t("rename.restoreTitle", { title: names.detectedTitle }) : "";
  return iconButton("rename-restore", "restore", { label, text: t("rename.restore") });
}

function failureMessage(err) {
  if (isNotFound(err)) return t("rename.gone");
  const reason = refusalReason(err);
  return reason ? t("rename.rejected", { reason }) : t("rename.failed");
}

/** Only what changed is sent; an emptied field goes back to the detected name. */
function changedNames(initial, title, artist) {
  const body = {};
  if (title !== initial.title) body.title = title || null;
  if (artist !== initial.artist) body.artist = artist || null;
  return body;
}

/** Select the whole name with the caret at its start, so a long one shows its beginning. */
function selectFromStart(input) {
  input.focus();
  input.setSelectionRange(0, input.value.length, "backward");
  input.scrollLeft = 0;
}

function closeEditor() {
  editor?.close();
}

function buildForm(trackId, names, focusField) {
  const form = document.createElement("div");
  form.className = "rename-form";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", t("rename.open"));
  const title = nameInput("rename-title", names.userTitle || names.title, "rename.titleLabel", names.detectedTitle);
  const artist = nameInput("rename-artist", names.userArtist || names.artist, "rename.artistLabel");
  const foot = document.createElement("div");
  foot.className = "rename-foot";
  const hint = document.createElement("span");
  hint.className = "rename-hint";
  hint.textContent = t("rename.hint");
  const restore = names.userTitle || names.userArtist ? restoreButton(names) : null;
  foot.append(...(restore ? [restore] : []), hint);
  const error = document.createElement("p");
  error.className = "rename-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.append(title, artist, foot, error);

  const initial = { title: title.value.trim(), artist: artist.value.trim() };
  let busy = false;

  async function save(body) {
    if (busy) return;
    if (!Object.keys(body).length) {
      closeEditor();
      return;
    }
    busy = true;
    form.classList.add("busy");
    error.hidden = true;
    try {
      const state = await fetchJson(`/api/jobs/${encodeURIComponent(trackId)}`, { method: "PATCH", body });
      closeEditor();
      applyRenamedState(trackId, state);
      relookupTrack(trackId);
    } catch (err) {
      console.warn("[rename] saving the new names failed:", err);
      busy = false;
      form.classList.remove("busy");
      error.textContent = failureMessage(err);
      error.hidden = false;
      title.focus();
    }
  }

  function saveTyped() {
    save(changedNames(initial, title.value.trim(), artist.value.trim()));
  }

  form.addEventListener("keydown", function onRenameKeydown(e) {
    e.stopPropagation();
    if (e.key === "Enter" && e.target.matches?.(".rename-input")) {
      e.preventDefault();
      saveTyped();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeEditor();
    }
  });
  // Leaving the form saves; Esc cancels.
  form.addEventListener("focusout", function onRenameFocusOut(e) {
    if (!busy && !form.dataset.closed && !form.contains(e.relatedTarget)) saveTyped();
  });
  form.addEventListener("click", function onRenameClick(e) {
    e.stopPropagation();
  });
  // WebKit does not focus a clicked button, so the input's blur would save and close first.
  restore?.addEventListener("mousedown", function onRestorePress(e) {
    e.preventDefault();
  });
  restore?.addEventListener("click", function onRestoreDetectedNames() {
    save({
      ...(names.userTitle ? { title: null } : {}),
      ...(names.userArtist ? { artist: null } : {}),
    });
  });

  return { form, focus: () => selectFromStart(focusField === "artist" ? artist : title) };
}

function openEditor(trackId, host, { row = null, focusField = "title", shownTitle = "" } = {}) {
  closeEditor();
  const libraryNames = getTrackNames(trackId);
  if (!libraryNames || !host) return;
  const names = shownTitle ? { ...libraryNames, title: shownTitle } : libraryNames;
  const { form, focus } = buildForm(trackId, names, focusField);
  host.classList.add("is-renaming");
  row?.classList.add("renaming-row");
  const wasDraggable = row?.draggable;
  if (row) row.draggable = false;
  host.append(form);
  const session = {
    trackId,
    place: row ? "row" : "head",
    close() {
      if (editor !== session) return;
      editor = null;
      // Removing a focused input can fire focusout, which would save.
      form.dataset.closed = "1";
      form.remove();
      host.classList.remove("is-renaming");
      row?.classList.remove("renaming-row");
      if (row) row.draggable = wasDraggable;
    },
  };
  editor = session;
  focus();
}

/** Rename a song from its row in the library list. */
export function startRowRename(trackId) {
  const row = document.querySelector(`#catalogList .cat-item[data-id="${CSS.escape(trackId)}"]`);
  openEditor(trackId, row?.querySelector(".cat-meta"), { row });
}

function startHeadRename(focusField) {
  const info = getCurrentTrackInfo();
  if (!info || (editor?.place === "head" && editor.trackId === info.id)) return;
  const host = document.querySelector("#nowPlayingPanel .track-panel-info");
  openEditor(info.id, host, { focusField, shownTitle: info.displayTitle });
}

function onHeadTitleClick() {
  startHeadRename("title");
}

function onHeadArtistClick() {
  startHeadRename("artist");
}

function onTrackOpen() {
  if (editor?.place === "head") closeEditor();
}

export function initSongRename() {
  const headButton = $("np-rename-btn");
  if (headButton) headButton.innerHTML = icon("pencil");
  headButton?.addEventListener("click", onHeadTitleClick);
  $("title")?.addEventListener("click", onHeadTitleClick);
  $("np-artist")?.addEventListener("click", onHeadArtistClick);
  document.addEventListener("trackopen", onTrackOpen);
}
