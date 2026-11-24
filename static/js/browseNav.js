// Browse library's left column: the views, setlists, folder tree and Trash with counts.
// Each row takes dropped songs; folder rows rename, fold, reorder and nest.

import { t } from "./i18n.js";
import {
  createFolder, dropTrackOnFolder, favoriteTrackIds, folderTrackIds, libraryFolderTree, libraryTrackIds, openFolderEditor,
  setFolderCollapsed, trashTrackIds, wireFolderRenameKey,
} from "./catalog.js";
import { trashWithUndo } from "./trashUndo.js";
import { queueCount, getQueueSnapshot } from "./queue.js";
import { importQueueShown } from "./importQueueView.js";
import { addSongToSetlist, getSetlists, newSetlist } from "./setlists.js";
import { icon } from "./libraryIcons.js";
import { esc } from "./songRowParts.js";
import { wireDropTarget } from "./songDrag.js";
import { wireFolderDrag } from "./folderDrag.js";
import { browseState, openBrowse } from "./browseLibrary.js";
import { VIEW } from "./browseViewNames.js";
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
  const favorites = favoriteTrackIds().length;
  const buttons = [
    navButton(VIEW.ALL, icon("music"), t("lib.allSongs"), libraryTrackIds().length),
    navButton(VIEW.FAVORITES, icon("heart"), t("nav.favorites"), favorites),
    navButton(VIEW.RECENT, icon("clock"), t("lib.recentlyAdded")),
  ];
  const importing = queueCount(getQueueSnapshot());
  if (importQueueShown()) buttons.push(navButton(VIEW.QUEUE, icon("download"), t("shell.importQueue"), importing));
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

// The nav is redrawn by the change, so focus moves to the new chevron.
function onChevronClick(e) {
  const folderId = e.currentTarget.dataset.folder;
  setFolderCollapsed(folderId, e.currentTarget.getAttribute("aria-expanded") === "true");
  $("browseNav")?.querySelector(`.browse-nav-chevron[data-folder="${CSS.escape(folderId)}"]`)?.focus();
}

// A folder with subfolders folds them away; one without keeps the chevron's room, so names line up.
function chevronEl(folder) {
  const chevron = document.createElement(folder.hasChildren ? "button" : "span");
  chevron.className = "browse-nav-chevron";
  if (!folder.hasChildren) return chevron;
  const label = t(folder.collapsed ? "lib.expandFolder" : "lib.collapseFolder", { name: folder.name });
  chevron.type = "button";
  chevron.dataset.folder = folder.id;
  chevron.title = label;
  chevron.setAttribute("aria-label", label);
  chevron.setAttribute("aria-expanded", String(!folder.collapsed));
  chevron.innerHTML = icon("down");
  chevron.addEventListener("click", onChevronClick);
  return chevron;
}

function folderItem(folder) {
  const item = document.createElement("div");
  item.className = "browse-nav-folder-item";
  item.style.setProperty("--folder-depth", String(folder.depth));
  item.append(chevronEl(folder), folderButton(folder));
  return item;
}

function shownFolders(tree) {
  let hiddenBelow = Infinity;
  return tree.filter((folder) => {
    if (folder.depth > hiddenBelow) return false;
    hiddenBelow = folder.collapsed && folder.hasChildren ? folder.depth : Infinity;
    return true;
  });
}

function folderButton(folder) {
  const dot = `<span class="folder-dot" style="background: ${folder.color}"></span>`;
  const btn = navButton(`${VIEW.FOLDER}:${folder.id}`, dot, folder.name, folderTrackIds(folder.id).length);
  btn.classList.add("browse-nav-folder");
  btn.dataset.folder = folder.id;
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
  wireDropTarget(btn, trashWithUndo);
  return btn;
}

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
    ...shownFolders(libraryFolderTree()).map(folderItem),
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
