// A song's versions: the rows under its library row, their menu, rename and delete,
// Extract more stems, and the version pill in the studio head.

import {
  applyVersionsState, displayTitle, getLibraryTrack, libraryTitle, loadTrackIntoStudio, redrawLibrary,
  setVersionsExpanded,
} from "./catalog.js";
import { currentJobId, currentVersionId, mixerState, selectedStems, setCurrentVersionId } from "./state.js";
import { applyAllLanePitches, applyMix, loadMixIntoState, refreshMixerVisuals } from "./mixer.js";
import { plural, t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { fetchJson, iconButton, textInput } from "./libraryControls.js";
import { menuItem, openMenu } from "./trackMenu.js";
import { ARM_TEXT_CLASS, confirmOnSecondClick, isArmed } from "./armConfirm.js";
import { notifyFailure } from "./notifications.js";
import { OUT_OF_TAB_ORDER, ROW_PLAY_CLASS } from "./rovingRows.js";
import { STEM_NAMES } from "./constants.js";
import { storeGet, storeSet } from "./utils.js";
import {
  DEFAULT_VERSION_ID, addedName, hasVersionRows, missingStems, mixStoreKey, nextVersionName, openVersionOf,
  sameLanes, versionLabel,
} from "./versionModel.js";

// Mirrors VERSION_NAME_MAX_CHARS in app/core/config.py.
const VERSION_NAME_MAX_CHARS = 60;
const MENU_GAP_PX = 4;
const FAILURE_KEYS = {
  "this song has too many versions": "versions.tooMany",
  "this song is missing stem files; import it again": "versions.missingFiles",
  "the song is not ready": "versions.notReady",
  "restore it from the Trash first": "importFail.restoreFirst",
};
const PILL_ID = "npVersionBtn";
const SUBLINE_CLASS = "np-subline";
const ROW_SELECTOR = ".cat-version";
const SONG_ROW_SELECTOR = "#catalogList .cat-item.has-versions";

let extractFor = null; // { trackId, chosen: Set<string> }

function esc(text) {
  const span = document.createElement("span");
  span.textContent = String(text ?? "");
  return span.innerHTML.replace(/"/g, "&quot;");
}

function versionsUrl(jobId, ...parts) {
  return [`/api/jobs/${encodeURIComponent(jobId)}/versions`, ...parts.map(encodeURIComponent)].join("/");
}

/** The request's answer, or null once its failure is reported. */
async function request(url, options) {
  try {
    return await fetchJson(url, options);
  } catch (err) {
    console.warn("[versions] request failed:", err);
    notifyFailure({ kind: "storage", message: t(FAILURE_KEYS[err?.detail] ?? "versions.failed") });
    return null;
  }
}

function findVersion(track, versionId) {
  return track?.versions?.find((version) => version.id === versionId) ?? null;
}

/** The version's saved mix; the live one when it is what the studio plays. */
async function versionMix(jobId, versionId) {
  if (jobId === currentJobId && versionId === currentVersionId) return structuredClone(mixerState);
  return storeGet(mixStoreKey(jobId, versionId), null);
}

// ─── Opening ───

async function switchMix(jobId, versionId) {
  setCurrentVersionId(versionId);
  await loadMixIntoState(jobId, [...selectedStems], versionId);
  if (jobId !== currentJobId || currentVersionId !== versionId) return;
  refreshMixerVisuals();
  applyMix();
  applyAllLanePitches();
}

/** Show the version the server now has open: the same lanes only swap the mix. */
async function showOpenedVersion(jobId, state) {
  const shownStems = [...selectedStems];
  applyVersionsState(jobId, state);
  const opened = openVersionOf(getLibraryTrack(jobId));
  if (!opened) return;
  if (jobId === currentJobId && sameLanes(opened.stems, shownStems)) await switchMix(jobId, opened.id);
  else await loadTrackIntoStudio(jobId);
}

export async function openVersion(jobId, versionId) {
  const track = getLibraryTrack(jobId);
  if (!track) return;
  if (openVersionOf(track)?.id === versionId) {
    if (jobId !== currentJobId) await loadTrackIntoStudio(jobId);
    return;
  }
  const state = await request(versionsUrl(jobId, versionId, "open"), { method: "POST" });
  if (state) await showOpenedVersion(jobId, state);
}

// ─── Save as new, extract, delete, rename ───

async function saveAsNew(jobId, source) {
  const track = getLibraryTrack(jobId);
  if (!track || !source) return;
  const mix = await versionMix(jobId, source.id);
  const isOpen = openVersionOf(track)?.id === source.id;
  const body = { name: nextVersionName(track.versions, t), stems: source.stems, open: isOpen };
  const answer = await request(versionsUrl(jobId), { method: "POST", body });
  if (!answer) return;
  if (mix) await storeSet(mixStoreKey(jobId, answer.version.id), mix);
  if (isOpen && jobId === currentJobId) setCurrentVersionId(answer.version.id);
  setVersionsExpanded(jobId, true);
  applyVersionsState(jobId, answer);
  startVersionRename(jobId, answer.version.id);
}

/** The source's mix with the added lanes left out, so they start at the defaults. */
async function extractedMix(jobId, from, added) {
  const mix = await versionMix(jobId, from.id);
  if (!mix) return null;
  for (const name of added) delete mix[name];
  return mix;
}

async function extractMore(jobId, from, added) {
  const body = { from: from.id, stems: added, name: addedName(added, t) };
  const mix = await extractedMix(jobId, from, added);
  const answer = await request(versionsUrl(jobId, "extract"), { method: "POST", body });
  if (!answer) return false;
  if (answer.created && mix) await storeSet(mixStoreKey(jobId, answer.version.id), mix);
  setVersionsExpanded(jobId, true);
  await showOpenedVersion(jobId, answer);
  return true;
}

async function deleteVersion(jobId, versionId) {
  const wasOpen = openVersionOf(getLibraryTrack(jobId))?.id === versionId;
  const answer = await request(versionsUrl(jobId, versionId), { method: "DELETE" });
  if (!answer) return;
  await storeSet(mixStoreKey(jobId, versionId), null);
  if (wasOpen && jobId === currentJobId) await showOpenedVersion(jobId, answer);
  else applyVersionsState(jobId, answer);
}

/** A song gone for good: its versions' mixes go too. The default one's key is the song's own, kept as before. */
export function forgetVersionMixes(jobId, track) {
  for (const version of track?.versions ?? []) {
    if (version.id !== DEFAULT_VERSION_ID) storeSet(mixStoreKey(jobId, version.id), null);
  }
}

// ─── Library rows ───

function stemsTitle(stems) {
  if (STEM_NAMES.every((name) => stems.includes(name))) return t("versions.allStems");
  return stems.map((name) => t(`stem.${name}`)).join(", ");
}

/** The song row's disclosure, in the duration's place. */
export function versionToggleHtml(track) {
  const count = track.versions.length;
  return `<button class="cat-versions-toggle" type="button" aria-expanded="${Boolean(track.versionsExpanded)}">`
    + `${icon("down")}${esc(plural("versions.count", count, { count }))}</button>`;
}

function onVersionToggleClick(e) {
  e.stopPropagation();
  const trackId = e.currentTarget.closest(".cat-item")?.dataset.id;
  const track = getLibraryTrack(trackId);
  if (track) setVersionsExpanded(trackId, !track.versionsExpanded);
}

export function wireVersionToggle(rowEl) {
  rowEl.querySelector(".cat-versions-toggle")?.addEventListener("click", onVersionToggleClick);
}

function versionRowHtml(track, version) {
  const name = versionLabel(version, t);
  const playLabel = t("versions.play", { title: displayTitle(libraryTitle(track)), name });
  const dots = version.stems.map((stem) => `<i style="--stem: var(--${stem})"></i>`).join("");
  return `<span class="cat-version-lead"><button class="${ROW_PLAY_CLASS}" type="button" tabindex="${OUT_OF_TAB_ORDER}"`
    + ` title="${esc(playLabel)}" aria-label="${esc(playLabel)}">${icon("play", { filled: true })}</button></span>`
    + `<span class="cat-version-name">${esc(name)}</span>`
    + `<span class="cat-version-stems" title="${esc(stemsTitle(version.stems))}">${dots}</span>`
    + `<div class="cat-actions"><button class="cat-more cat-version-del" type="button" aria-haspopup="menu"`
    + ` title="${esc(t("trackMenu.open"))}" aria-label="${esc(t("versions.more", { name }))}">`
    + `${icon("more")}${icon("trash")}<span class="${ARM_TEXT_CLASS}"></span></button></div>`;
}

function versionRow(trackId, track, version) {
  const row = document.createElement("div");
  row.className = "cat-version";
  row.dataset.id = trackId;
  row.dataset.version = version.id;
  row.setAttribute("role", "listitem");
  row.tabIndex = OUT_OF_TAB_ORDER;
  row.innerHTML = versionRowHtml(track, version);
  row.querySelector(".cat-version-del").addEventListener("click", onVersionMoreClick);
  return row;
}

function versionGroup(trackId, track) {
  const group = document.createElement("div");
  group.className = "cat-versions";
  group.setAttribute("role", "list");
  group.setAttribute("aria-label", t("versions.listAria", { title: displayTitle(libraryTitle(track)) }));
  group.hidden = !track.versionsExpanded;
  group.append(...track.versions.map((version) => versionRow(trackId, track, version)));
  return group;
}

/** What goes under a song's row: its Extract more form when open, then its versions. */
export function versionExtras(trackId) {
  const track = getLibraryTrack(trackId);
  if (!track) return [];
  const extras = [];
  if (extractFor?.trackId === trackId) extras.push(extractForm(trackId, track));
  if (hasVersionRows(track)) extras.push(versionGroup(trackId, track));
  return extras;
}

/** The open song's open version wears the fill; its song row then only colours its title. */
export function paintOpenVersion(openTrackId) {
  for (const row of document.querySelectorAll(`#catalogList ${ROW_SELECTOR}`)) {
    const track = getLibraryTrack(row.dataset.id);
    row.classList.toggle("active", row.dataset.id === openTrackId && openVersionOf(track)?.id === row.dataset.version);
  }
  for (const row of document.querySelectorAll(SONG_ROW_SELECTOR)) {
    const isOpen = row.dataset.id === openTrackId;
    const groupShown = row.nextElementSibling?.matches(".cat-versions:not([hidden])") ?? false;
    row.classList.toggle("active", isOpen && !groupShown);
    row.classList.toggle("has-open-version", isOpen && groupShown);
  }
}

// ─── A version's menu, delete and rename ───

function rowVersion(el) {
  const row = el.closest(ROW_SELECTOR);
  const track = getLibraryTrack(row?.dataset.id);
  return { row, jobId: row?.dataset.id, version: findVersion(track, row?.dataset.version) };
}

function deleteOptions(button, jobId, versionId) {
  return {
    label: button.querySelector(`.${ARM_TEXT_CLASS}`),
    armedText: t("versions.deleteConfirm"),
    onConfirm: function onConfirmDeleteVersion() {
      deleteVersion(jobId, versionId);
    },
  };
}

function versionMenuItems(button, jobId, version) {
  const deleteItem = menuItem(t("versions.delete"), "trash", function onArmDeleteVersion() {
    confirmOnSecondClick(button, deleteOptions(button, jobId, version.id));
    button.focus();
  });
  deleteItem.classList.add("is-danger");
  return [
    menuItem(t("versions.open"), "play", function onOpenVersion() { openVersion(jobId, version.id); }),
    menuItem(t("trackMenu.rename"), "pencil", function onRenameVersion() { startVersionRename(jobId, version.id); }),
    menuItem(t("versions.saveAsNew"), "copy", function onSaveVersionAsNew() { saveAsNew(jobId, version); }),
    menuSeparator(),
    deleteItem,
  ];
}

function onVersionMoreClick(e) {
  e.stopPropagation();
  const button = e.currentTarget;
  const { jobId, version } = rowVersion(button);
  if (!version) return;
  if (isArmed(button)) {
    confirmOnSecondClick(button, deleteOptions(button, jobId, version.id));
    return;
  }
  openMenu(button, versionMenuItems(button, jobId, version), { label: versionLabel(version, t) });
}

function menuSeparator() {
  const sep = document.createElement("div");
  sep.className = "lib-menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

function renameForm(jobId, version, row) {
  const form = document.createElement("div");
  form.className = "rename-form";
  form.setAttribute("role", "group");
  const initial = versionLabel(version, t);
  const input = textInput({
    className: "rename-input",
    value: initial,
    label: t("versions.nameAria"),
    maxLength: VERSION_NAME_MAX_CHARS,
  });
  const foot = document.createElement("div");
  foot.className = "rename-foot";
  foot.innerHTML = `<span class="rename-hint">${esc(t("rename.hint"))}</span>`;
  form.append(input, foot);
  wireRenameForm(form, input, function onVersionRenameDone(name) {
    if (name && name !== initial) renameVersion(jobId, version.id, name);
    else closeRename(row);
  });
  return { form, input };
}

function wireRenameForm(form, input, finish) {
  let done = false;
  const end = (save) => {
    if (done) return;
    done = true;
    finish(save ? input.value.trim() : "");
  };
  form.addEventListener("keydown", function onVersionRenameKeydown(e) {
    e.stopPropagation();
    if (e.key === "Enter") end(true);
    else if (e.key === "Escape") end(false);
  });
  form.addEventListener("focusout", function onVersionRenameFocusOut(e) {
    if (!form.contains(e.relatedTarget)) end(true);
  });
  form.addEventListener("click", function onVersionRenameClick(e) { e.stopPropagation(); });
}

async function renameVersion(jobId, versionId, name) {
  const answer = await request(versionsUrl(jobId, versionId), { method: "PATCH", body: { name } });
  if (answer) applyVersionsState(jobId, answer);
  else redrawLibrary();
}

function closeRename(row) {
  row.classList.remove("renaming-row");
  redrawLibrary();
}

function startVersionRename(jobId, versionId) {
  const selector = `[data-id="${CSS.escape(jobId)}"][data-version="${CSS.escape(versionId)}"]`;
  const row = document.querySelector(`#catalogList ${ROW_SELECTOR}${selector}`);
  const version = findVersion(getLibraryTrack(jobId), versionId);
  if (!row || !version) return;
  const { form, input } = renameForm(jobId, version, row);
  row.classList.add("renaming-row");
  row.querySelector(".cat-version-name")?.replaceWith(form);
  for (const el of row.querySelectorAll(".cat-version-stems, .cat-actions")) el.remove();
  input.focus();
  input.select();
}

// ─── Extract more stems ───

function chipHtml(stem, pressed) {
  return `<button class="cat-extract-more-chip" type="button" data-stem="${stem}" style="--chip-color: var(--${stem})"`
    + ` aria-pressed="${pressed}">${esc(t(`stem.${stem}`))}</button>`;
}

function extractForm(trackId, track) {
  const missing = missingStems(openVersionOf(track)?.stems ?? STEM_NAMES);
  const form = document.createElement("div");
  form.className = "cat-extract-more";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", t("versions.extractTitle"));
  form.innerHTML = `<div class="cat-extract-more-title">${esc(t("versions.extractTitle"))}</div>`
    + `<div class="cat-extract-more-chips">${missing.map((s) => chipHtml(s, extractFor.chosen.has(s))).join("")}</div>`
    + `<span class="cat-extract-more-hint">${esc(t("versions.extractHint"))}</span>`
    + `<div class="cat-extract-more-foot"><button class="cat-extract-more-cancel" type="button">${esc(t("folderEditor.cancel"))}</button>`
    + `<button class="cat-extract-more-go" type="button">${esc(t("versions.extractGo"))}</button></div>`;
  form.querySelector(".cat-extract-more-go").disabled = extractFor.chosen.size === 0;
  form.addEventListener("click", onExtractFormClick);
  form.addEventListener("keydown", onExtractFormKeydown);
  return form;
}

function closeExtractForm() {
  const trackId = extractFor?.trackId;
  extractFor = null;
  redrawLibrary();
  document.querySelector(`#catalogList .cat-item[data-id="${CSS.escape(trackId ?? "")}"]`)?.focus();
}

function toggleChip(chip) {
  const stem = chip.dataset.stem;
  if (extractFor.chosen.has(stem)) extractFor.chosen.delete(stem);
  else extractFor.chosen.add(stem);
  chip.setAttribute("aria-pressed", String(extractFor.chosen.has(stem)));
  chip.closest(".cat-extract-more").querySelector(".cat-extract-more-go").disabled = extractFor.chosen.size === 0;
}

async function submitExtract(button) {
  const { trackId, chosen } = extractFor;
  const from = openVersionOf(getLibraryTrack(trackId));
  if (!from || !chosen.size) return;
  button.disabled = true;
  const added = STEM_NAMES.filter((stem) => chosen.has(stem));
  if (await extractMore(trackId, from, added)) closeExtractForm();
  else button.disabled = false;
}

function onExtractFormClick(e) {
  e.stopPropagation();
  const target = e.target.closest("button");
  if (!target || !extractFor) return;
  if (target.matches(".cat-extract-more-chip")) toggleChip(target);
  else if (target.matches(".cat-extract-more-cancel")) closeExtractForm();
  else if (target.matches(".cat-extract-more-go")) submitExtract(target);
}

function onExtractFormKeydown(e) {
  e.stopPropagation();
  if (e.key !== "Escape") return;
  e.preventDefault();
  closeExtractForm();
}

function onExtractRequest(e) {
  const trackId = e.detail?.id;
  const track = getLibraryTrack(trackId);
  if (!track) return;
  extractFor = { trackId, chosen: new Set(missingStems(openVersionOf(track)?.stems ?? STEM_NAMES)) };
  redrawLibrary();
  document.querySelector("#catalogList .cat-extract-more-go")?.focus();
}

// ─── The studio pill ───

function placeBelow(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + MENU_GAP_PX}px`;
}

function pillMenuItems(jobId, track) {
  const open = openVersionOf(track);
  const items = track.versions.map((version) => {
    const item = menuItem(versionLabel(version, t), "check", function onPickVersion() { openVersion(jobId, version.id); });
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(version.id === open?.id));
    return item;
  });
  const saveItem = menuItem(t("versions.saveAsNew"), "copy", function onSaveOpenAsNew() { saveAsNew(jobId, open); });
  return [...items, menuSeparator(), saveItem];
}

function onPillClick(e) {
  const track = getLibraryTrack(currentJobId);
  if (!track) return;
  openMenu(
    e.currentTarget,
    pillMenuItems(currentJobId, track),
    { label: e.currentTarget.getAttribute("aria-label"), place: placeBelow },
  );
}

function ensurePill(artist) {
  let pill = document.getElementById(PILL_ID);
  if (pill) return pill;
  pill = iconButton("np-version", "down");
  pill.id = PILL_ID;
  pill.setAttribute("aria-haspopup", "menu");
  pill.prepend(document.createElement("span"));
  pill.addEventListener("click", onPillClick);
  const subline = document.createElement("div");
  subline.className = SUBLINE_CLASS;
  artist.before(subline);
  subline.append(artist, pill);
  return pill;
}

/** The open song's version, after its artist; shown only for a song with two or more. */
export function paintVersionPill(track) {
  const artist = document.getElementById("np-artist");
  if (!artist) return;
  const open = hasVersionRows(track) ? openVersionOf(track) : null;
  if (!open) {
    document.getElementById(PILL_ID)?.setAttribute("hidden", "");
    return;
  }
  const pill = ensurePill(artist);
  const name = versionLabel(open, t);
  pill.hidden = false;
  pill.querySelector("span").textContent = name;
  pill.title = t("versions.pillAria", { name });
  pill.setAttribute("aria-label", pill.title);
}

export function initVersions() {
  document.addEventListener("versions:extract", onExtractRequest);
}
