// A setlist in Browse library: its head's actions, then its songs in order.
// A song in the Trash keeps its place, greyed.

import { t } from "./i18n.js";
import { isInTrash } from "./catalog.js";
import {
  canPlaySetlist, getSetlist, makeFolderOf, moveSetlistSongDown, moveSetlistSongUp, playSetlist, removeSetlist,
  removeSetlistSong, setlistsError,
} from "./setlists.js";
import { ARM_TEXT_CLASS, confirmOnSecondClick } from "./armConfirm.js";
import { icon } from "./libraryIcons.js";
import { songRowEl } from "./songRow.js";
import { esc, labelledButton } from "./songRowParts.js";
import { closeBrowse, openBrowse } from "./browseLibrary.js";
import { VIEW } from "./browseViewNames.js";
import { emptyStateEl, viewHeadEl } from "./browseViews.js";
import { openSetlistRename } from "./setlistRenameDialog.js";

const SONG_BUTTONS = [
  [".setlist-song-up", moveSetlistSongUp],
  [".setlist-song-down", moveSetlistSongDown],
  [".setlist-song-remove", removeSetlistSong],
];

function headButton(className, iconName, label, text = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `${icon(iconName, { filled: iconName === "play" })}${text ? `<span>${esc(text)}</span>` : ""}`;
  return btn;
}

async function onPlayFromTopClick(e) {
  if (await playSetlist(e.currentTarget.dataset.id)) closeBrowse();
}

function onRenameClick(e) {
  openSetlistRename(e.currentTarget.dataset.id);
}

function onMakeFolderClick(e) {
  const folderId = makeFolderOf(e.currentTarget.dataset.id);
  if (folderId) openBrowse(`${VIEW.FOLDER}:${folderId}`);
}

function onDeleteClick(e) {
  const btn = e.currentTarget;
  confirmOnSecondClick(btn, {
    label: btn.querySelector(`.${ARM_TEXT_CLASS}`),
    armedText: t("setlists.deleteConfirm"),
    onConfirm: () => removeSetlist(btn.dataset.id),
  });
}

function headActions(setlist) {
  const play = headButton("browse-btn browse-btn-accent browse-setlist-play", "play", t("setlists.playTitle", { name: setlist.name }), t("lib.playFromTop"));
  play.disabled = !canPlaySetlist(setlist);
  play.addEventListener("click", onPlayFromTopClick);
  const rename = headButton("browse-iconbtn browse-setlist-rename", "pencil", t("setlists.renameTitle", { name: setlist.name }));
  rename.addEventListener("click", onRenameClick);
  const folder = headButton("browse-iconbtn browse-setlist-folder", "folderPlus", t("setlists.makeFolderTitle", { name: setlist.name }));
  folder.disabled = !setlist.song_ids.length;
  folder.addEventListener("click", onMakeFolderClick);
  const remove = headButton("browse-btn browse-btn-quiet browse-setlist-delete", "trash", t("setlists.deleteTitle", { name: setlist.name }));
  const armText = document.createElement("span");
  armText.className = ARM_TEXT_CLASS;
  remove.append(armText);
  remove.addEventListener("click", onDeleteClick);
  const buttons = [play, rename, folder, remove];
  for (const btn of buttons) btn.dataset.id = setlist.id;
  return buttons;
}

function songActionsHtml(title, index, count) {
  const up = labelledButton("setlist-song-up", t("setlists.moveUp", { title }), t("setlists.moveUp", { title }), icon("up"), index === 0 ? "disabled" : "");
  const down = labelledButton("setlist-song-down", t("setlists.moveDown", { title }), t("setlists.moveDown", { title }), icon("down"), index === count - 1 ? "disabled" : "");
  const remove = labelledButton("setlist-song-remove", t("setlists.removeSong", { title }), t("setlists.removeSong", { title }), icon("x"));
  return up + down + remove;
}

function setlistSongEl(setlist, trackId, index) {
  const trashed = isInTrash(trackId);
  const row = songRowEl(trackId, {
    inTrash: trashed,
    lead: `<span class="setlist-song-index num">${index + 1}</span>`,
    actions: "",
    sub: trashed ? t("setlists.inTrash") : null,
  });
  if (!row) return null;
  const title = row.querySelector(".cat-title")?.textContent ?? "";
  row.querySelector(".cat-actions").innerHTML = songActionsHtml(title, index, setlist.song_ids.length);
  row.classList.add("setlist-song");
  row.addEventListener("click", function onSetlistSongButton(e) {
    const hit = SONG_BUTTONS.find(([selector]) => e.target.closest(selector));
    if (!hit) return;
    e.stopPropagation();
    hit[1](setlist.id, trackId);
  });
  return row;
}

function errorEl() {
  const error = document.createElement("p");
  error.className = "setlists-error";
  error.setAttribute("role", "alert");
  error.textContent = setlistsError();
  return error;
}

export function drawSetlistView(id) {
  const setlist = getSetlist(id);
  const lead = `<span class="set-tile set-tile-lg">${icon("listMusic")}</span>`;
  const head = viewHeadEl(setlist.name, setlist.song_ids.length, { lead, actions: headActions(setlist) });
  const error = setlistsError() ? [errorEl()] : [];
  if (!setlist.song_ids.length) {
    return [head, ...error, emptyStateEl("listMusic", t("lib.setlistEmptyTitle"), t("lib.setlistEmptyHint"))];
  }
  const list = document.createElement("div");
  list.className = "browse-list";
  list.append(...setlist.song_ids.map((trackId, i) => setlistSongEl(setlist, trackId, i)).filter(Boolean));
  return [head, ...error, list];
}
