// Setlists: named, ordered lists of library songs kept on the server
// (/api/setlists), shown in the library pane's Setlists tab. Up Next stays client-side.

import { getLibraryTrack, getTrackNames, loadTrackIntoStudio, showLibraryView } from "./catalog.js";
import { getNowAndUpNextIds, playSongs } from "./upNext.js";
import { t, plural, onLanguageChange } from "./i18n.js";
import {
  HTTP_NOT_FOUND,
  HttpError,
  SETLIST_NAME_MAX_CHARS,
  fetchJson,
  iconButton,
  isNotFound,
  refusalReason,
  textInput,
} from "./libraryControls.js";
import { $ } from "./utils.js";

const SETLISTS_URL = "/api/setlists";
const DELETE_ARM_MS = 4000;

let setlists = [];
let tab = "songs";
let creating = false;
let renamingSetlistId = null;
let armedDeleteId = null;
let armTimer = 0;

// ─── Server ───

const setlistUrl = (id) => `${SETLISTS_URL}/${encodeURIComponent(id)}`;

function showError(message = "") {
  const el = $("setlistsError");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

/** Run a change against the server; a failure is said in the pane, not thrown. */
async function attempt(change) {
  try {
    const result = await change();
    showError();
    return result;
  } catch (err) {
    console.warn("[setlists] saving failed:", err);
    if (isNotFound(err)) {
      await loadSetlists();
      showError(t("setlists.gone"));
      return null;
    }
    const reason = refusalReason(err);
    showError(reason ? t("setlists.rejected", { reason }) : t("setlists.saveFailed"));
    return null;
  } finally {
    render();
  }
}

function replaceSetlist(updated) {
  setlists = setlists.map((setlist) => (setlist.id === updated.id ? updated : setlist));
}

async function fetchSetlists() {
  const list = await fetchJson(SETLISTS_URL);
  setlists = Array.isArray(list) ? list : [];
}

async function loadSetlists() {
  try {
    await fetchSetlists();
    showError();
  } catch (err) {
    console.warn("[setlists] loading failed:", err);
    showError(t("setlists.loadFailed"));
  }
  render();
}

function updateSetlist(id, patch) {
  return attempt(async () => {
    const updated = await fetchJson(setlistUrl(id), { method: "PATCH", body: patch });
    replaceSetlist(updated);
    return updated;
  });
}

/**
 * Change a setlist's songs from what the server holds now, so a change made in
 * another window is kept. `nextIds` returns the new order, or null for no change.
 */
function changeSongs(setlistId, nextIds) {
  return attempt(async () => {
    await fetchSetlists();
    const fresh = setlists.find((setlist) => setlist.id === setlistId);
    if (!fresh) throw new HttpError(HTTP_NOT_FOUND);
    const songIds = nextIds(fresh.song_ids);
    if (!songIds) return null;
    const updated = await fetchJson(setlistUrl(setlistId), { method: "PATCH", body: { song_ids: songIds } });
    replaceSetlist(updated);
    return updated;
  });
}

function deleteSetlist(id) {
  return attempt(async () => {
    await fetchJson(setlistUrl(id), { method: "DELETE" });
    setlists = setlists.filter((setlist) => setlist.id !== id);
  });
}

function createSetlist(name, songIds = []) {
  return attempt(async () => {
    const created = await fetchJson(SETLISTS_URL, { method: "POST", body: { name, song_ids: songIds } });
    setlists = [...setlists, created];
    return created;
  });
}

// ─── Used by the track menu and Up Next ───

export function getSetlists() {
  return setlists;
}

function withSongAdded(trackId) {
  return function addSong(ids) {
    return ids.includes(trackId) ? null : [...ids, trackId];
  };
}

function withSongMoved(trackId, step) {
  return function moveSong(ids) {
    const from = ids.indexOf(trackId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= ids.length) return null;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, trackId);
    return next;
  };
}

function withSongRemoved(trackId) {
  return function removeSong(ids) {
    return ids.includes(trackId) ? ids.filter((id) => id !== trackId) : null;
  };
}

export async function addSongToSetlist(setlistId, trackId) {
  if (await changeSongs(setlistId, withSongAdded(trackId))) flashSetlistsTab();
}

/** A new setlist of these songs, shown with its name ready to type over. */
export async function createSetlistFrom(trackIds) {
  const created = await createSetlist(t("setlists.defaultName", { n: setlists.length + 1 }), trackIds);
  if (!created) return;
  renamingSetlistId = created.id;
  showLibraryView();
  showTab("setlists");
}

function flashSetlistsTab() {
  const tabEl = $("libTabSetlists");
  if (!tabEl) return;
  tabEl.classList.remove("flash");
  void tabEl.offsetWidth;
  tabEl.classList.add("flash");
}

// ─── Tabs ───

function showTab(next) {
  tab = next === "setlists" ? "setlists" : "songs";
  $("catalogPanel")?.classList.toggle("setlists-view", tab === "setlists");
  for (const [id, name] of [["libTabSongs", "songs"], ["libTabSetlists", "setlists"]]) {
    const el = $(id);
    el?.setAttribute("aria-selected", String(tab === name));
    if (el) el.tabIndex = tab === name ? 0 : -1;
  }
  if (tab === "setlists") loadSetlists();
}

function onSongsTabClick() {
  showTab("songs");
}

function onSetlistsTabClick() {
  showTab("setlists");
}

function onTabKeydown(e) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  showTab(tab === "songs" ? "setlists" : "songs");
  $(tab === "songs" ? "libTabSongs" : "libTabSetlists")?.focus();
}

function onCatalogViewChange(e) {
  if (e.detail?.view !== "library") showTab("songs");
}

function onLibrarySearch() {
  if (tab === "setlists") showTab("songs");
}

// ─── Drawing ───

/** A name field that saves on Enter or on leaving it, and cancels on Esc. */
function nameField(value, onSave, onCancel) {
  const input = textInput({
    className: "setlist-name-input",
    value,
    label: t("setlists.nameLabel"),
    maxLength: SETLIST_NAME_MAX_CHARS,
  });
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name) onSave(name);
    else onCancel();
  };
  input.addEventListener("keydown", function onNameKeydown(e) {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", function onNameBlur() {
    // A redraw removing the field is not the user leaving it.
    if (input.isConnected) finish(true);
  });
  return input;
}

function songRow(setlist, trackId, index) {
  const names = getTrackNames(trackId);
  const track = getLibraryTrack(trackId);
  const title = names?.title || t("track.unknown");
  const li = document.createElement("li");
  li.className = "setlist-song";
  li.dataset.id = trackId;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "setlist-song-open";
  open.title = t("setlists.openSong");
  const number = document.createElement("span");
  number.className = "setlist-song-index num";
  number.textContent = String(index + 1);
  const thumb = document.createElement("span");
  thumb.className = "setlist-song-thumb";
  thumb.setAttribute("aria-hidden", "true");
  if (track?.thumb) {
    const img = document.createElement("img");
    img.src = track.thumb;
    img.alt = "";
    img.loading = "lazy";
    thumb.append(img);
  } else {
    thumb.textContent = title.charAt(0).toUpperCase();
  }
  const text = document.createElement("span");
  text.className = "setlist-song-text";
  const titleEl = document.createElement("span");
  titleEl.className = "setlist-song-title";
  titleEl.textContent = title;
  const sub = document.createElement("span");
  sub.className = "setlist-song-sub";
  sub.textContent = names?.artist || "";
  text.append(titleEl, sub);
  open.append(number, thumb, text);
  open.addEventListener("click", function onOpenSetlistSong() {
    loadTrackIntoStudio(trackId);
  });

  const actions = document.createElement("span");
  actions.className = "setlist-song-actions";
  const up = iconButton("setlist-icon-btn setlist-song-up", "up", { label: t("setlists.moveUp", { title }) });
  up.disabled = index === 0;
  up.addEventListener("click", function onMoveSongUp() {
    changeSongs(setlist.id, withSongMoved(trackId, -1));
  });
  const down = iconButton("setlist-icon-btn setlist-song-down", "down", { label: t("setlists.moveDown", { title }) });
  down.disabled = index === setlist.song_ids.length - 1;
  down.addEventListener("click", function onMoveSongDown() {
    changeSongs(setlist.id, withSongMoved(trackId, 1));
  });
  const remove = iconButton("setlist-icon-btn setlist-song-remove", "x", { label: t("setlists.removeSong", { title }) });
  remove.addEventListener("click", function onRemoveSetlistSong() {
    changeSongs(setlist.id, withSongRemoved(trackId));
  });
  actions.append(up, down, remove);
  li.append(open, actions);
  return li;
}

function disarmDelete() {
  clearTimeout(armTimer);
  armedDeleteId = null;
}

function deleteButton(setlist) {
  const armed = armedDeleteId === setlist.id;
  const el = iconButton(`setlist-icon-btn setlist-delete${armed ? " armed" : ""}`, "trash", {
    label: armed ? t("setlists.deleteConfirmTitle", { name: setlist.name }) : t("setlists.deleteTitle", { name: setlist.name }),
    text: armed ? t("setlists.deleteConfirm") : "",
  });
  el.addEventListener("click", function onDeleteSetlist() {
    if (armedDeleteId === setlist.id) {
      disarmDelete();
      deleteSetlist(setlist.id);
      return;
    }
    // Deleting cannot be undone, so the first click only arms the button.
    disarmDelete();
    armedDeleteId = setlist.id;
    armTimer = setTimeout(function onDeleteArmExpired() {
      disarmDelete();
      render();
    }, DELETE_ARM_MS);
    render();
    $("setlistsList")?.querySelector(`.setlist[data-id="${CSS.escape(setlist.id)}"] .setlist-delete`)?.focus();
  });
  return el;
}

function setlistHead(setlist) {
  const head = document.createElement("div");
  head.className = "setlist-head";
  if (renamingSetlistId === setlist.id) {
    const input = nameField(
      setlist.name,
      function onRenameSetlist(name) {
        renamingSetlistId = null;
        if (name === setlist.name) render();
        else updateSetlist(setlist.id, { name });
      },
      function onCancelSetlistRename() {
        renamingSetlistId = null;
        render();
      },
    );
    head.append(input);
    queueMicrotask(function focusSetlistName() {
      input.focus();
      input.select();
    });
    return head;
  }
  const name = document.createElement("span");
  name.className = "setlist-name";
  name.textContent = setlist.name;
  name.title = setlist.name;
  const count = document.createElement("span");
  count.className = "setlist-count num";
  count.textContent = plural("setlists.songCount", setlist.song_ids.length);
  const play = iconButton("setlist-play", "play", {
    label: t("setlists.playTitle", { name: setlist.name }),
    text: t("setlists.play"),
    filled: true,
  });
  play.disabled = !setlist.song_ids.length;
  play.addEventListener("click", async function onPlaySetlist() {
    const started = await playSongs(setlist.song_ids);
    if (!started) showError(t("setlists.nothingToPlay"));
  });
  const rename = iconButton("setlist-icon-btn setlist-rename", "pencil", { label: t("setlists.renameTitle", { name: setlist.name }) });
  rename.addEventListener("click", function onStartSetlistRename() {
    renamingSetlistId = setlist.id;
    render();
  });
  const tools = document.createElement("span");
  tools.className = "setlist-tools";
  tools.append(rename, deleteButton(setlist));
  head.append(name, play, count, tools);
  return head;
}

function setlistGroup(setlist) {
  const group = document.createElement("section");
  group.className = "setlist";
  group.dataset.id = setlist.id;
  group.append(setlistHead(setlist));
  if (!setlist.song_ids.length) {
    const empty = document.createElement("p");
    empty.className = "setlist-empty";
    empty.textContent = t("setlists.noSongs");
    group.append(empty);
    return group;
  }
  const list = document.createElement("ol");
  list.className = "setlist-songs";
  list.append(...setlist.song_ids.map((id, i) => songRow(setlist, id, i)));
  group.append(list);
  return group;
}

function newSetlistField() {
  const input = nameField(
    "",
    function onCreateSetlist(name) {
      creating = false;
      createSetlist(name);
    },
    function onCancelNewSetlist() {
      creating = false;
      render();
    },
  );
  queueMicrotask(function focusNewSetlistName() {
    input.focus();
  });
  return input;
}

function renderSaveUpNext() {
  const save = $("upNextSave");
  if (save) save.hidden = !getNowAndUpNextIds().length;
}

function render() {
  const count = $("setlistsCount");
  if (count) count.textContent = String(setlists.length);
  const list = $("setlistsList");
  if (!list) return;
  const groups = setlists.map(setlistGroup);
  if (creating) groups.push(newSetlistField());
  list.replaceChildren(...groups);
  const empty = $("setlistsEmpty");
  if (empty) empty.hidden = Boolean(setlists.length) || creating;
  const newBtn = $("setlistNewBtn");
  if (newBtn) newBtn.hidden = creating;
}

function onNewSetlistClick() {
  creating = true;
  render();
}

function onSaveUpNextClick() {
  const ids = getNowAndUpNextIds();
  if (ids.length) createSetlistFrom(ids);
}

export function initSetlists() {
  $("libTabSongs")?.addEventListener("click", onSongsTabClick);
  $("libTabSetlists")?.addEventListener("click", onSetlistsTabClick);
  document.querySelector(".lib-tabs")?.addEventListener("keydown", onTabKeydown);
  $("setlistNewBtn")?.addEventListener("click", onNewSetlistClick);
  $("upNextSave")?.addEventListener("click", onSaveUpNextClick);
  $("catalogSearch")?.addEventListener("input", onLibrarySearch);
  document.addEventListener("catalogviewchange", onCatalogViewChange);
  document.addEventListener("tracknames", render);
  document.addEventListener("upnext:change", renderSaveUpNext);
  document.addEventListener("trackopen", renderSaveUpNext);
  onLanguageChange(render);
  renderSaveUpNext();
  loadSetlists();
}
