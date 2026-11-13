// batchImport.js — several songs at once: a pasted list of links, several files
// or a folder. The bar shows the batch as a chip; the review list under it says
// what each item is before anything is queued, and queues the ticked ones one
// POST /api/jobs at a time. The list's logic lives in batchImportModel.js.

import { t, plural } from "./i18n.js";
import { selectedStems } from "./state.js";
import {
  ITEM_KIND, ITEM_STATUS, MAX_BATCH_LINKS, capLines, fileItems, formatBytes, isPastedList, isTickable, linkItems,
  lookingUpItems, pastedLines, previewNames, queueItems, queuePlan,
} from "./batchImportModel.js";
import {
  importResponse, isQueueFull, keepSplitChoice, postFileJob, readableError,
  refreshSubmitLabel, registerLinkRow, registerUploadRow,
} from "./job.js";
import { addPlaylistToLibrary } from "./catalog.js";
import { recordBatch } from "./queue.js";
import { folderRow, groupRow, itemRow, moreRow, reviewShell, rowView } from "./batchReviewRows.js";

const PREVIEW_URL = "/api/import/preview";
const JOBS_URL = "/api/jobs";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SOURCE = Object.freeze({ LINKS: "links", FILES: "files", FOLDER: "folder" });
const PANEL_GAP_PX = 8;
const CHILDREN_SHOWN = 3;
const DURATION_READ_TIMEOUT_MS = 5000;

let batch = null;
let panel = null;
let scrim = null;

export const hasBatch = () => batch !== null;

/** How many songs the batch holds, for the bar's "Review N". */
export const reviewCount = () => batch?.items.length ?? 0;

const urlInput = () => document.getElementById("url");
const urlWrap = () => document.querySelector(".url-wrap");
const structureOn = () => document.getElementById("autoSectionsBtn")?.getAttribute("aria-pressed") === "true";
const isCurrent = (target) => batch === target;

// ─── the chip in the bar ───

function showBatchPill(kind, name, size) {
  const pill = document.getElementById("filePill");
  if (!pill) return;
  pill.dataset.kind = kind;
  document.getElementById("fileName").textContent = name;
  document.getElementById("fileSize").textContent = size;
  pill.classList.remove("hidden");
  urlWrap()?.classList.add("has-file");
  urlInput().value = "";
  urlInput().removeAttribute("required");
}

function refreshPill() {
  if (batch.source === SOURCE.LINKS) {
    const songs = batch.loading ? "" : plural("batch.songs", batch.items.length);
    showBatchPill(SOURCE.LINKS, plural("batch.links", batch.linkCount), songs);
  } else if (batch.source === SOURCE.FOLDER) {
    showBatchPill(SOURCE.FOLDER, batch.name, plural("batch.files", batch.items.length));
  } else {
    document.getElementById("fileName").textContent = plural("batch.files", batch.items.length);
    document.getElementById("fileSize").textContent = formatBytes(batch.items.reduce((sum, i) => sum + i.file.size, 0));
  }
}

/** Forget the batch. The file pill's own clear (main.js) calls this. */
export function clearBatch() {
  batch = null;
  closeReview({ refocus: false });
  delete document.getElementById("filePill")?.dataset.kind;
  refreshSubmitLabel();
}

function finishBatch() {
  const clearPill = document.getElementById("fileInput")?._clear;
  if (clearPill) clearPill();
  else clearBatch();
  focusBar();
}

// ─── starting a batch ───

/** A pasted list of links: one row per line, filled in once the server has read them. */
export function startLinkBatch(text) {
  const { lines, refused } = capLines(pastedLines(text));
  const items = lookingUpItems(lines);
  batch = {
    source: SOURCE.LINKS, lines, refused, linkCount: items.length, items, groups: [], droppedLines: new Set(), loading: true,
  };
  begin(fetchLinkPreview);
}

/** Several files, or a folder (`folder` is its name): each with the folder it sits in. */
export function startFileBatch(entries, { folder = null } = {}) {
  const durations = new Map();
  batch = {
    source: folder ? SOURCE.FOLDER : SOURCE.FILES,
    name: folder,
    entries,
    dropped: new Set(),
    durations,
    preview: null,
    items: fileItems(entries, null, durations),
    groups: [],
    loading: true,
  };
  begin(fetchFilePreview);
  readDurations(batch);
}

function begin(fetchPreview) {
  refreshPill();
  refreshSubmitLabel();
  openReview();
  fetchPreview(batch);
}

async function postPreview(target, body) {
  try {
    const res = await fetch(PREVIEW_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return await importResponse(res);
  } catch (err) {
    target.error = readableError(err);
    return null;
  }
}

async function fetchLinkPreview(target) {
  const preview = await postPreview(target, { links: target.lines });
  if (!isCurrent(target)) return;
  if (preview) {
    const { items, groups } = linkItems(preview);
    target.items = items.filter((i) => !target.droppedLines.has(i.line));
    target.groups = groups;
    target.capacity = preview.capacity_left;
    target.maxDurationSec = preview.max_duration_sec;
  }
  target.loading = false;
  refreshPill();
  refreshSubmitLabel();
  renderReview();
}

async function fetchFilePreview(target) {
  const preview = await postPreview(target, { files: previewNames(target.entries) });
  if (!isCurrent(target)) return;
  if (preview) {
    target.preview = preview;
    target.capacity = preview.capacity_left;
    target.maxDurationSec = preview.max_duration_sec;
  }
  target.loading = false;
  rebuildFileItems(target);
}

/** Rows again from the files, the preview and the lengths read so far, keeping the user's ticks. */
function rebuildFileItems(target) {
  const before = new Map(target.items.map((i) => [i.file, i]));
  target.items = fileItems(target.entries, target.preview, target.durations)
    .filter((item) => !target.dropped.has(item.file))
    .map((item) => {
      const old = before.get(item.file);
      return old && old.status === item.status ? { ...item, ticked: old.ticked } : item;
    });
  renderReview();
}

function readDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const src = URL.createObjectURL(file);
    const timer = setTimeout(onDurationSettled, DURATION_READ_TIMEOUT_MS);
    function onDurationSettled() {
      clearTimeout(timer);
      URL.revokeObjectURL(src);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.removeAttribute("src");
    }
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", onDurationSettled, { once: true });
    audio.addEventListener("error", onDurationSettled, { once: true });
    audio.src = src;
  });
}

const needsLength = (item) => item && item.status !== ITEM_STATUS.NOT_AUDIO && item.status !== ITEM_STATUS.TOO_LARGE;

/** Length is checked here: the server only sees file names until upload. */
async function readDurations(target) {
  for (const { file } of target.entries) {
    if (!isCurrent(target)) return;
    if (!needsLength(target.items.find((i) => i.file === file))) continue;
    const seconds = await readDuration(file);
    if (seconds !== null) target.durations.set(file, seconds);
    if (!target.loading && isCurrent(target)) rebuildFileItems(target);
  }
}

// ─── the review list ───

export function openReview() {
  if (!batch) return;
  if (!panel) mountReview();
  renderReview();
  panel.querySelector(".batch-review-list input:not(:disabled), .batch-review-list button, .batch-review-close")?.focus();
}

const stemObserver = new MutationObserver(renderFooter);

function mountReview() {
  scrim = document.createElement("div");
  scrim.className = "batch-scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", onScrimClick);
  panel = document.createElement("section");
  panel.className = "batch-review";
  panel.id = "batchReview";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "batchReviewTitle");
  panel.addEventListener("change", onReviewChange);
  panel.addEventListener("click", onReviewClick);
  document.body.append(scrim, panel);
  document.addEventListener("keydown", onReviewKeydown, true);
  window.addEventListener("resize", placeReview);
  stemObserver.observe(document.getElementById("job-form"), { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] });
}

function closeReview({ refocus = true } = {}) {
  if (!panel) return;
  stemObserver.disconnect();
  document.removeEventListener("keydown", onReviewKeydown, true);
  window.removeEventListener("resize", placeReview);
  panel.remove();
  scrim.remove();
  panel = null;
  scrim = null;
  if (refocus) focusBar();
}

function focusBar() {
  const input = urlInput();
  if (input && input.offsetParent !== null) input.focus();
  else document.getElementById("submit")?.focus();
}

function placeReview() {
  if (!panel) return;
  const zone = urlWrap().getBoundingClientRect();
  const composer = document.getElementById("job-form").getBoundingClientRect();
  panel.style.left = `${zone.left}px`;
  panel.style.top = `${composer.bottom + PANEL_GAP_PX}px`;
  scrim.style.top = `${document.querySelector(".daw-topbar").getBoundingClientRect().bottom}px`;
}

function headText() {
  if (batch.source === SOURCE.LINKS) {
    const links = plural("batch.links", batch.linkCount);
    const songs = plural("batch.songs", batch.items.length);
    return { title: batch.loading ? links : t("batch.songsFromLinks", { songs, links }), sub: t("batch.pastedList") };
  }
  const files = plural("batch.files", batch.items.length);
  if (batch.source === SOURCE.FILES) return { title: files, sub: "" };
  const nested = batch.entries.some((e) => e.dir.includes("/"));
  return { title: t("batch.filesIn", { files, folder: batch.name }), sub: nested ? t("batch.subfolders") : "" };
}

function notes() {
  const out = [];
  if (batch.refused) out.push(plural("batch.overCap", batch.refused, { max: MAX_BATCH_LINKS }));
  if (batch.error) out.push(t("batch.previewFailed", { message: batch.error }));
  return out;
}

export function renderReview() {
  if (!panel || !batch) return;
  const focus = focusedControl();
  panel.replaceChildren(...reviewShell({ ...headText(), notes: notes() }));
  panel.querySelector(".batch-review-list").append(...listRows());
  renderFooter();
  placeReview();
  restoreFocus(focus);
}

function listRows() {
  const rows = [];
  const seenGroups = new Set();
  let lastDir = null;
  for (const item of batch.items) {
    if (batch.source === SOURCE.FOLDER && item.dir !== lastDir) {
      rows.push(folderRow(item.dir));
      lastDir = item.dir;
    }
    if (!item.group) rows.push(itemRow(item, rowView(item, batch.maxDurationSec)));
    else if (!seenGroups.has(item.group)) {
      seenGroups.add(item.group);
      rows.push(...groupRows(batch.groups.find((g) => g.key === item.group)));
    }
  }
  return rows;
}

function groupRows(group) {
  const children = batch.items.filter((i) => i.group === group.key);
  const tickable = children.filter(isTickable);
  const ticked = tickable.filter((i) => i.ticked).length;
  const rows = [groupRow(group, { count: children.length, ticked, tickable: tickable.length })];
  if (group.collapsed) return rows;
  const shown = group.showAll ? children : children.slice(0, CHILDREN_SHOWN);
  for (const child of shown) rows.push(itemRow(child, { ...rowView(child, batch.maxDurationSec), child: true }));
  if (shown.length < children.length) rows.push(moreRow(group.key, children.length - shown.length));
  return rows;
}

function renderFooter() {
  if (!panel || !batch) return;
  const plan = queuePlan(batch.items, batch.capacity);
  const structure = t(structureOn() ? "batch.structureOn" : "batch.structureOff");
  panel.querySelector(".batch-review-summary").textContent = t("batch.forAll", { stems: plural("batch.stems", selectedStems.size), structure });
  const clamp = panel.querySelector(".batch-review-clamp");
  clamp.textContent = plan.clamped ? plural("batch.onlyFit", plan.send.length) : "";
  const queue = panel.querySelector(".batch-queue");
  queue.textContent = plural("batch.queue", plan.send.length);
  queue.disabled = batch.loading || batch.queuing || plan.send.length === 0;
}

function focusedControl() {
  const el = document.activeElement;
  const row = el && panel.contains(el) ? el.closest("[data-key]") : null;
  return row ? { key: row.dataset.key, cls: el.classList[0] } : null;
}

function restoreFocus(focus) {
  if (!focus) return;
  const row = panel.querySelector(`[data-key="${CSS.escape(focus.key)}"]`);
  (row?.querySelector(`.${focus.cls}`) ?? row?.querySelector("input, button"))?.focus();
}

// ─── review events ───

const rowKey = (el) => el.closest("[data-key]")?.dataset.key;
const itemOf = (el) => batch.items.find((i) => i.key === rowKey(el));
const groupOf = (el) => batch.groups.find((g) => g.key === rowKey(el));

function onReviewChange(e) {
  const box = e.target;
  if (box.type !== "checkbox") return;
  const group = groupOf(box);
  const targets = group ? batch.items.filter((i) => i.group === group.key && isTickable(i)) : [itemOf(box)];
  for (const item of targets) if (item) item.ticked = box.checked;
  renderReview();
}

const REVIEW_ACTIONS = {
  "batch-review-close": () => closeReview(),
  "batch-cancel": () => closeReview(),
  "batch-queue": () => queueTicked(),
  "batch-item-drop": (btn) => dropRow(btn),
  "batch-item-retry": (btn) => queueOnly(itemOf(btn)),
  "batch-group-toggle": (btn) => toggleGroup(groupOf(btn), "collapsed"),
  "batch-more-btn": (btn) => toggleGroup(groupOf(btn), "showAll"),
};

function onReviewClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  const action = Object.keys(REVIEW_ACTIONS).find((cls) => btn.classList.contains(cls));
  if (action) REVIEW_ACTIONS[action](btn);
}

function onReviewKeydown(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeReview();
}

function onScrimClick() {
  closeReview();
}

function toggleGroup(group, flag) {
  if (!group) return;
  group[flag] = !group[flag];
  renderReview();
}

function dropRow(btn) {
  const group = groupOf(btn);
  const item = group ? null : itemOf(btn);
  if (item?.file) batch.dropped.add(item.file);
  if (item?.status === ITEM_STATUS.LOOKING_UP) batch.droppedLines.add(item.line);
  batch.items = batch.items.filter((i) => (group ? i.group !== group.key : i !== item));
  if (group) batch.groups = batch.groups.filter((g) => g !== group);
  if (!batch.items.length) {
    finishBatch();
    return;
  }
  refreshPill();
  refreshSubmitLabel();
  renderReview();
}

// ─── queuing ───

async function postLinkJob(item, stems, autoSections) {
  const body = { url: item.url, stems, auto_sections: autoSections };
  if (item.title) body.title = item.title;
  if (item.replaces) body.replaces = item.replaces;
  const res = await fetch(JOBS_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return (await importResponse(res)).job_id;
}

/** Library rows for what was queued; a playlist's songs go in a folder named after it. */
function addLibraryRows(queued) {
  const playlists = new Map();
  for (const { item, jobId } of queued) {
    if (item.kind === ITEM_KIND.FILE) registerUploadRow(jobId, item.file, { replaces: item.replaces });
    else if (!item.group) registerLinkRow(jobId, item);
    else {
      keepSplitChoice(jobId, item.replaces);
      const jobs = playlists.get(item.group) ?? [];
      jobs.push({ job_id: jobId, title: item.title, source_url: item.url, replaces: item.replaces });
      playlists.set(item.group, jobs);
    }
  }
  for (const [key, jobs] of playlists) addPlaylistToLibrary(batch.groups.find((g) => g.key === key)?.title, jobs);
}

/** Queue `items` with the stems and Detect structure as they are now; what was left out, and why. */
async function queueSome(items) {
  const stems = [...selectedStems];
  const autoSections = structureOn();
  batch.queuing = true;
  renderFooter();
  const outcome = await queueItems(items, {
    postLink: (item) => postLinkJob(item, stems, autoSections),
    postFile: (item) => postFileJob(item.file, { autoSections, replaces: item.replaces }),
    isQueueFull,
    reasonOf: readableError,
  });
  addLibraryRows(outcome.queued);
  recordBatch(outcome.queued.map((q) => q.jobId));
  batch.queuing = false;
  for (const { item, reason } of outcome.notQueued) Object.assign(item, { status: ITEM_STATUS.NOT_QUEUED, reason, ticked: true });
  batch.capacity = null;
  return outcome.notQueued.map((n) => n.item);
}

function showWhatIsLeft(items) {
  batch.items = items;
  if (!items.length) {
    finishBatch();
    return;
  }
  refreshPill();
  refreshSubmitLabel();
  renderReview();
}

/** Ticked items the queue had no room for stay, as not queued, beside those it refused. */
function leftOverByCapacity(send) {
  const reason = t("upload.reasonQueueFull");
  return batch.items
    .filter((i) => i.ticked && isTickable(i) && !send.includes(i))
    .map((item) => Object.assign(item, { status: ITEM_STATUS.NOT_QUEUED, reason }));
}

async function queueTicked() {
  const target = batch;
  const { send } = queuePlan(batch.items, batch.capacity);
  const leftOver = leftOverByCapacity(send);
  const notQueued = await queueSome(send);
  if (isCurrent(target)) showWhatIsLeft(batch.items.filter((i) => notQueued.includes(i) || leftOver.includes(i)));
}

async function queueOnly(item) {
  if (!item) return;
  const target = batch;
  const notQueued = await queueSome([item]);
  if (isCurrent(target)) showWhatIsLeft(batch.items.filter((i) => i !== item || notQueued.includes(i)));
}

// ─── wiring ───

function onUrlPaste(e) {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!isPastedList(text)) return;
  e.preventDefault();
  document.getElementById("fileInput")?._clear?.();
  startLinkBatch(text);
}

export function wireBatchImport() {
  urlInput()?.addEventListener("paste", onUrlPaste);
}
