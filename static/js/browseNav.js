// Browse library's left column: All songs, Favorites, Recently added, Import
// queue while importing, each setlist, the folder tree and Trash, with counts.
// Songs dropped on a folder, setlist or Trash go there; folders keep today's
// gestures: a double-click or F2 renames, dragging one reorders or nests it.

import { t } from "./i18n.js";
import {
  createFolder, dropTrackOnFolder, folderTrackIds, libraryFolderTree, libraryTrackIds, moveTrackToTrash,
  openFolderEditor, getLibraryTrack, trashTrackIds, wireFolderRenameKey,
} from "./catalog.js";
import { queueCount, getQueueSnapshot } from "./queue.js";
import { addSongToSetlist, getSetlists, newSetlist } from "./setlists.js";
import { icon } from "./libraryIcons.js";
import { esc } from "./songRowParts.js";
import { wireDropTarget } from "./songDrag.js";
import { wireFolderDrag } from "./folderDrag.js";
import { VIEW, browseState, openBrowse } from "./browseLibrary.js";
import { $ } from "./utils.js";

const RENAME_TITLE_KEY = "folderEditor.renameTitle";

function navButton(view, iconHtml, label, count = null) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "browse-nav-btn";
  btn.dataset.view = view;
  btn.innerHTML = `${iconHtml}<span class="browse-nav-label"></span>${count === null ? "" : `<span class="browse-nav-count num">${count}</span>`}`;
  btn.querySelector(".browse-nav-label").textContent = label;
  btn.title = label;
  if (browseState().view === view) btn.setAttribute("aria-current", "page");
  return btn;
}

function groupHead(label, addId, addLabel) {
  const head = document.createElement("div");
  head.className = "browse-nav-group";
  head.innerHTML = `<span>${esc(label)}</span><button class="browse-nav-add" id="${addId}" type="button" title="${esc(addLabel)}" aria-label="${esc(addLabel)}">${icon("plus")}</button>`;
  return head;
}

function viewButtons() {
  const favorites = libraryTrackIds().filter((id) => getLibraryTrack(id).favorite).length;
  const buttons = [
    navButton(VIEW.ALL, icon("music"), t("lib.allSongs"), libraryTrackIds().length),
    navButton(VIEW.FAVORITES, icon("heart"), t("nav.favorites"), favorites),
    navButton(VIEW.RECENT, icon("clock"), t("lib.recentlyAdded")),
  ];
  const importing = queueCount(getQueueSnapshot());
  if (importing) buttons.push(navButton(VIEW.QUEUE, icon("download"), t("shell.importQueue"), importing));
  return buttons;
}

function setlistButtons() {
  return getSetlists().map((setlist) => {
    const btn = navButton(`${VIEW.SETLIST}:${setlist.id}`, icon("listMusic"), setlist.name, setlist.song_ids.length);
    wireDropTarget(btn, function onSongDroppedOnSetlist(trackId) {
      addSongToSetlist(setlist.id, trackId);
    });
    return btn;
  });
}

function folderButton(folder) {
  const dot = `<span class="folder-dot" style="background: ${folder.color}"></span>`;
  const btn = navButton(`${VIEW.FOLDER}:${folder.id}`, dot, folder.name, folderTrackIds(folder.id).length);
  btn.classList.add("browse-nav-folder");
  btn.dataset.folder = folder.id;
  btn.style.setProperty("--folder-depth", String(folder.depth));
  btn.addEventListener("dblclick", function onFolderRowDoubleClick() {
    openFolderEditor(folder.id, RENAME_TITLE_KEY);
  });
  wireFolderRenameKey(btn, folder.id);
  wireFolderDrag(btn, folder);
  wireDropTarget(btn, function onSongDroppedOnFolder(trackId) {
    dropTrackOnFolder(folder.id, trackId);
  });
  return btn;
}

function trashButton() {
  const btn = navButton(VIEW.TRASH, icon("trash"), t("nav.trash"), trashTrackIds().length);
  btn.classList.add("browse-nav-trash");
  wireDropTarget(btn, moveTrackToTrash);
  return btn;
}

/** Mark the nav row of the view shown. */
export function paintCurrentView() {
  for (const btn of $("browseNav")?.querySelectorAll(".browse-nav-btn") ?? []) {
    if (btn.dataset.view === browseState().view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
}

export function drawBrowseNav() {
  const nav = $("browseNav");
  if (!nav) return;
  const spacer = document.createElement("div");
  spacer.className = "browse-nav-spacer";
  nav.replaceChildren(
    ...viewButtons(),
    groupHead(t("setlists.title"), "browseNewSetlist", t("setlists.new")),
    ...setlistButtons(),
    groupHead(t("lib.folders"), "browseNewFolder", t("library.newFolder")),
    ...libraryFolderTree().map(folderButton),
    spacer,
    trashButton(),
  );
}

function onNavClick(e) {
  const btn = e.target.closest(".browse-nav-btn");
  if (btn) {
    openBrowse(btn.dataset.view);
    return;
  }
  if (e.target.closest("#browseNewSetlist")) newSetlist();
  else if (e.target.closest("#browseNewFolder")) createFolder();
}

export function wireBrowseNav() {
  $("browseNav")?.addEventListener("click", onNavClick);
}
