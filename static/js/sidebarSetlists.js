// The sidebar's Setlists group: a row per setlist that opens it in Browse
// library, takes dropped songs and plays it from the top; + makes a new one.

import { t, plural } from "./i18n.js";
import {
  addSongToSetlist, canPlaySetlist, getSetlists, newSetlist, onSetlistsChange, playSetlist, setlistsError,
} from "./setlists.js";
import { icon } from "./libraryIcons.js";
import { iconButton } from "./libraryControls.js";
import { wireDropTarget } from "./songDrag.js";
import { openBrowse, closeBrowse } from "./browseLibrary.js";
import { $ } from "./utils.js";

const SETLIST_VIEW_PREFIX = "setlist:";

function onSetlistOpenClick(e) {
  openBrowse(`${SETLIST_VIEW_PREFIX}${e.currentTarget.closest(".sidebar-setlist").dataset.id}`);
}

async function onSetlistPlayClick(e) {
  e.stopPropagation();
  if (await playSetlist(e.currentTarget.closest(".sidebar-setlist").dataset.id)) closeBrowse();
}

function setlistRowEl(setlist) {
  const row = document.createElement("div");
  row.className = "sidebar-setlist";
  row.dataset.id = setlist.id;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "sidebar-setlist-open";
  open.innerHTML = `<span class="set-tile">${icon("listMusic")}</span><span class="cat-meta"><span class="cat-title"></span><span class="cat-sub"></span></span>`;
  open.querySelector(".cat-title").textContent = setlist.name;
  open.querySelector(".cat-sub").textContent = plural("lib.setlistCount", setlist.song_ids.length);
  open.addEventListener("click", onSetlistOpenClick);
  const play = iconButton("sidebar-setlist-play", "play", { label: t("setlists.playTitle", { name: setlist.name }), filled: true });
  play.disabled = !canPlaySetlist(setlist);
  play.addEventListener("click", onSetlistPlayClick);
  row.append(open, play);
  wireDropTarget(row, function onSongDroppedOnSetlist(trackId) {
    addSongToSetlist(setlist.id, trackId);
  });
  return row;
}

export function drawSidebarSetlists() {
  $("sidebarSetlists")?.querySelector(".sidebar-group-list")?.replaceChildren(...getSetlists().map(setlistRowEl));
  const error = $("setlistsError");
  if (!error) return;
  error.textContent = setlistsError();
  error.hidden = !setlistsError();
}

function onNewSetlistClick() {
  newSetlist();
}

export function initSidebarSetlists() {
  $("sidebarNewSetlist")?.addEventListener("click", onNewSetlistClick);
  onSetlistsChange(drawSidebarSetlists);
}
