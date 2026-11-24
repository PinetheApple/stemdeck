// Browse library's views: All songs, Favorites, Recently added, a folder, the
// Trash and the Import queue, each as a grid of covers or a list with columns.

import { t, plural, getLanguage } from "./i18n.js";
import {
  armEmptyTrash, folderErrorEl, folderNameOf, folderTrackIds, folderTreeTrackIds, getLibraryTrack, libraryFolderTree, libraryTrackIds,
  librarySearchFields, makeSetlistFromFolder, renderImportQueue, trashTrackIds, wireFolderMenuButton,
} from "./catalog.js";
import { songMatches } from "./librarySearch.js";
import { songCells } from "./songColumns.js";
import { formatKey } from "./keyLabel.js";
import { fmtTime } from "./utils.js";
import { icon } from "./libraryIcons.js";
import { ARM_TEXT_CLASS } from "./armConfirm.js";
import { songCardEl, songRowEl } from "./songRow.js";
import { esc } from "./songRowParts.js";
import { versionExtras } from "./versions.js";
import { browseState, openBrowse, viewParts } from "./browseLibrary.js";
import { LAYOUT, VIEW } from "./browseViewNames.js";
import { drawSetlistView } from "./browseSetlist.js";
import { getSetlist } from "./setlists.js";
import { LIST_KIND } from "./playContext.js";
import { queueCount, getQueueSnapshot } from "./queue.js";

const RECENT_LIMIT = 12;
const COLUMNS = [
  ["c-title", "lib.colTitle"],
  ["c-artist", "lib.colArtist"],
  ["c-key", "lib.colKey"],
  ["c-tempo", "lib.colTempo"],
  ["c-length", "lib.colLength"],
  ["c-folder", "lib.colFolder"],
  ["c-added", "lib.colAdded"],
];
const CELL_CLASSES = [["key", "c-key"], ["tempo", "c-tempo"], ["length", "c-length"], ["folder", "c-folder"], ["added", "c-added"]];
const DATE_FORMAT = { day: "numeric", month: "short", year: "numeric" };

const matching = (ids) => ids.filter((id) => songMatches(librarySearchFields(id), browseState().query));

export function emptyStateEl(iconName, heading, hint) {
  const el = document.createElement("div");
  el.className = "browse-empty";
  el.innerHTML = `${icon(iconName)}<strong>${esc(heading)}</strong><span>${esc(hint)}</span>`;
  return el;
}

const noMatchEl = () => emptyStateEl("search", t("library.noSearchMatch"), t("search.noMatchHint"));

/** A view's head: `lead` markup, its title, how many songs, then `actions`. */
export function viewHeadEl(title, count, { lead = "", actions = [] } = {}) {
  const head = document.createElement("div");
  head.className = "browse-head";
  head.innerHTML = `${lead}<h2></h2><span class="browse-head-count"></span><span class="browse-head-spacer"></span>`;
  head.querySelector("h2").textContent = title;
  head.querySelector(".browse-head-count").textContent = plural("setlists.songCount", count);
  head.append(...actions);
  return head;
}

const ADDED_WORDS = () => ({
  today: t("lib.today"),
  yesterday: t("lib.yesterday"),
  daysAgo: (days) => plural("lib.daysAgo", days),
  dated: (ms) => new Date(ms).toLocaleDateString(getLanguage(), DATE_FORMAT),
});

function cellsHtml(trackId) {
  const cells = songCells(getLibraryTrack(trackId), {
    now: Date.now(),
    words: ADDED_WORDS(),
    folderName: folderNameOf(trackId),
    keyLabel: (key, scale) => formatKey(key, scale, t),
    time: fmtTime,
  });
  return CELL_CLASSES.map(([field, cls]) => `<span class="cell ${cls}">${esc(cells[field])}</span>`).join("");
}

function tableHeadEl() {
  const head = document.createElement("div");
  head.className = "browse-thead";
  head.innerHTML = COLUMNS.map(([cls, key]) => `<span class="cell ${cls}">${esc(t(key))}</span>`).join("")
    + '<span class="cell c-acts"></span>';
  return head;
}

/** Songs as the chosen layout shows them: cards in a grid, or rows under column heads. */
export function songListEls(ids) {
  if (browseState().layout === LAYOUT.LIST) {
    const list = document.createElement("div");
    list.className = "browse-list is-table";
    for (const id of ids) {
      const row = songRowEl(id, { cells: cellsHtml(id) });
      if (row) list.append(row, ...versionExtras(id));
    }
    return [tableHeadEl(), list];
  }
  const grid = document.createElement("div");
  grid.className = "browse-grid";
  grid.append(...ids.map((id) => songCardEl(id)).filter(Boolean));
  return [grid];
}

function titledView(title, allIds, emptyEl = null) {
  const ids = matching(allIds);
  const empty = browseState().query ? noMatchEl() : emptyEl;
  const body = ids.length ? songListEls(ids) : [empty].filter(Boolean);
  return [viewHeadEl(title, ids.length), ...body];
}

const byAdded = (a, b) => (getLibraryTrack(b).createdAt ?? 0) - (getLibraryTrack(a).createdAt ?? 0);

function allView() {
  return titledView(t("lib.allSongs"), libraryTrackIds(), emptyStateEl("music", t("lib.startTitle"), t("lib.startHint")));
}

function favoritesView() {
  const ids = libraryTrackIds().filter((id) => getLibraryTrack(id).favorite);
  return titledView(t("nav.favorites"), ids, emptyStateEl("heart", t("favorites.emptyTitle"), t("favorites.emptyHint")));
}

function recentView() {
  const ids = [...libraryTrackIds()].sort(byAdded).slice(0, RECENT_LIMIT);
  return titledView(t("lib.recentlyAdded"), ids);
}

function onMakeSetlistClick(e) {
  makeSetlistFromFolder(e.currentTarget.dataset.folder);
}

function folderActions(folder) {
  if (folder.system) return [];
  const make = document.createElement("button");
  make.type = "button";
  make.className = "browse-btn browse-make-setlist";
  make.dataset.folder = folder.id;
  make.disabled = !folderTreeTrackIds(folder.id).length;
  make.innerHTML = `${icon("listMusic")}<span>${esc(t("folder.makeSetlist"))}</span>`;
  make.addEventListener("click", onMakeSetlistClick);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "browse-iconbtn browse-folder-more";
  more.dataset.folder = folder.id;
  more.title = t("trackMenu.open");
  more.setAttribute("aria-label", t("trackMenu.openTitle", { title: folder.name }));
  more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = `${icon("more")}<span class="${ARM_TEXT_CLASS}"></span>`;
  wireFolderMenuButton(more, folder.id);
  return [make, more];
}

function onSubfolderClick(e) {
  openBrowse(e.currentTarget.dataset.view);
}

function subfolderChips(tree, folderId) {
  const chips = document.createElement("div");
  chips.className = "browse-chips";
  for (const child of tree.filter((f) => f.parentId === folderId)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "browse-subfolder";
    chip.dataset.view = `${VIEW.FOLDER}:${child.id}`;
    chip.innerHTML = `<span class="folder-dot" style="background: ${child.color}"></span><span></span>`;
    chip.lastChild.textContent = child.name;
    chip.addEventListener("click", onSubfolderClick);
    chips.append(chip);
  }
  return chips.children.length ? [chips] : [];
}

function folderView(folderId) {
  const tree = libraryFolderTree();
  const folder = tree.find((f) => f.id === folderId);
  if (!folder) return null;
  const ids = matching(folderTrackIds(folderId));
  const lead = `<span class="folder-dot folder-dot-lg" style="background: ${folder.color}"></span>`;
  const error = folderErrorEl(folderId);
  const empty = emptyStateEl("folder", t("library.emptyFolder"), t("lib.folderEmptyHint"));
  return [
    viewHeadEl(folder.name, ids.length, { lead, actions: folderActions(folder) }),
    ...(error ? [error] : []),
    ...subfolderChips(tree, folderId),
    ...(ids.length ? songListEls(ids) : [browseState().query ? noMatchEl() : empty]),
  ];
}

function onEmptyTrashClick(e) {
  armEmptyTrash(e.currentTarget, e.currentTarget.querySelector("span"));
}

// The Trash lists plain rows with Restore whatever the layout.
function trashListEl(ids) {
  const list = document.createElement("div");
  list.className = "browse-list";
  list.append(...ids.map((id) => songRowEl(id, { inTrash: true })).filter(Boolean));
  return list;
}

function trashView() {
  const ids = matching(trashTrackIds());
  const empty = document.createElement("button");
  empty.type = "button";
  empty.id = "browseEmptyTrash";
  empty.className = "browse-btn";
  empty.disabled = !trashTrackIds().length;
  empty.innerHTML = `${icon("trash")}<span>${esc(t("trash.empty"))}</span>`;
  empty.addEventListener("click", onEmptyTrashClick);
  const body = ids.length
    ? [trashListEl(ids)]
    : [browseState().query ? noMatchEl() : emptyStateEl("trash", t("trash.isEmptyState"), t("trash.emptyHint"))];
  return [viewHeadEl(t("nav.trash"), ids.length, { actions: [empty] }), ...body];
}

function queueView() {
  if (!queueCount(getQueueSnapshot())) return null;
  const host = document.createElement("section");
  host.id = "browseImportQueue";
  host.className = "browse-queue";
  return [host];
}

const VIEWS = {
  [VIEW.ALL]: allView,
  [VIEW.FAVORITES]: favoritesView,
  [VIEW.RECENT]: recentView,
  [VIEW.FOLDER]: folderView,
  [VIEW.TRASH]: trashView,
  [VIEW.QUEUE]: queueView,
  [VIEW.SETLIST]: (id) => (getSetlist(id) ? drawSetlistView(id) : null),
};

const PLAY_LIST_KINDS = Object.freeze({
  [VIEW.ALL]: LIST_KIND.ALL,
  [VIEW.FAVORITES]: LIST_KIND.FAVORITES,
  [VIEW.FOLDER]: LIST_KIND.FOLDER,
  [VIEW.SETLIST]: LIST_KIND.SETLIST,
});

function playListName(kind, id) {
  if (kind === VIEW.FOLDER) return libraryFolderTree().find((folder) => folder.id === id)?.name ?? "";
  if (kind === VIEW.SETLIST) return getSetlist(id)?.name ?? "";
  return "";
}

// The list a song played from here becomes the one Next follows.
function markPlayList(container, view) {
  const [kind, id] = viewParts(view);
  const listKind = PLAY_LIST_KINDS[kind];
  if (!listKind) {
    delete container.dataset.playList;
    delete container.dataset.playListName;
    return;
  }
  container.dataset.playList = listKind;
  container.dataset.playListName = playListName(kind, id);
}

/** Draw the current view into `container`; a view that is gone falls back to All songs. Returns the view drawn. */
export function drawBrowseResults(container) {
  if (!container) return browseState().view;
  const [kind, id] = viewParts();
  let view = browseState().view;
  let children = VIEWS[kind]?.(id) ?? null;
  if (!children) {
    view = VIEW.ALL;
    children = allView();
  }
  container.replaceChildren(...children);
  markPlayList(container, view);
  const queueHost = container.querySelector("#browseImportQueue");
  if (queueHost) renderImportQueue(queueHost);
  return view;
}
