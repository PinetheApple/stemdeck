// batchImport.js — several songs at once. The bar holds the batch as a chip and a
// review list under it says what each item is before anything is queued.

import { t, plural } from "./i18n.js";
import { selectedStems } from "./state.js";
import {
  ITEM_KIND, ITEM_STATUS, MAX_BATCH_FILES, MAX_BATCH_LINKS, PATH_SEP, capEntries, capLines, fileItems, formatBytes,
  isPastedList, isTickable, isUploadable, linkItems, lookingUpItems, markUnchecked, pastedLines, previewNames,
  queueItems, queuePlan,
} from "./batchImportModel.js";
import {
  currentSplitChoice, importResponse, interceptSubmit, isQueueFull, keepSplitChoice, postFileJob, postLinkImport,
  readableError, refreshSubmitLabel, registerLinkRow, registerUploadRow, setIdleSubmitLabel,
} from "./job.js";
import { addPlaylistToLibrary } from "./catalog.js";
import { looksLikePlaylist } from "./playlist.js";
import { onResendNotQueued, recordBatch, setBatchNotQueued } from "./queue.js";
import { icon } from "./libraryIcons.js";
import { folderRow, groupRow, itemRow, moreRow, reviewShell, rowView } from "./batchReviewRows.js";
import {
  closePanel, focusFirst, focusedControl, mountPanel, placePanel, restoreFocus, returnFocus, reviewPanel,
} from "./batchReviewPanel.js";

const PREVIEW_URL = "/api/import/preview";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SOURCE = Object.freeze({ LINKS: "links", FILES: "files", FOLDER: "folder" });
const CHILDREN_SHOWN = 3;
const DURATION_READ_TIMEOUT_MS = 5000;

let batch = null;

const urlInput = () => document.getElementById("url");
const urlWrap = () => document.querySelector(".url-wrap");
const structureOn = () => document.getElementById("autoSectionsBtn")?.getAttribute("aria-pressed") === "true";
const isCurrent = (target) => batch === target;
const liveChoice = () => ({
  stems: [...selectedStems],
  autoSections: structureOn(),
  splitChoice: currentSplitChoice(),
});

// ─── the chip in the bar ───

/** The chip standing in the bar's box: a file, several files, a list or a folder (`kind`). */
export function setImportPill({ kind = null, name, size }) {
  const pill = document.getElementById("filePill");
  if (!pill) return;
  pill.classList.toggle("batch-pill", !!kind);
  if (kind) pill.dataset.kind = kind;
  else delete pill.dataset.kind;
  document.getElementById("fileName").textContent = name;
  document.getElementById("fileSize").textContent = size;
  pill.classList.remove("hidden");
  urlWrap()?.classList.add("has-file");
  urlInput().value = "";
  urlInput().removeAttribute("required");
}

const itemBytes = (items) => formatBytes(items.reduce((sum, i) => sum + i.file.size, 0));

function refreshPill() {
  if (batch.inBar) return;
  if (batch.source === SOURCE.LINKS) {
    const size = batch.loading ? "" : plural("batch.songs", batch.items.length);
    setImportPill({ kind: SOURCE.LINKS, name: plural("batch.links", batch.linkCount), size });
  } else if (batch.source === SOURCE.FOLDER) {
    setImportPill({ kind: SOURCE.FOLDER, name: batch.name, size: plural("batch.files", batch.items.length) });
  } else {
    setImportPill({ name: plural("batch.files", batch.items.length), size: itemBytes(batch.items) });
  }
}

/** Forget the batch; clearing the chip in the bar calls this. */
export function clearBatch() {
  batch = null;
  setBatchNotQueued(0);
  closePanel({ refocus: false });
  refreshSubmitLabel();
}

function finishBatch() {
  const inBar = batch?.inBar;
  document.getElementById("fileInput")?._clear?.();
  clearBatch();
  if (inBar) urlInput().value = "";
  returnFocus();
}

// ─── starting a batch ───

/** Pasted links, or one playlist link typed in the bar (`inBar`): a row per line until read. */
export function startLinkBatch(text, { inBar = false } = {}) {
  const { lines, refused } = capLines(pastedLines(text));
  const items = lookingUpItems(lines);
  batch = {
    source: SOURCE.LINKS,
    inBar,
    lines,
    refused,
    linkCount: items.length,
    items,
    groups: [],
    droppedLines: new Set(),
    loading: true,
  };
  setBatchNotQueued(0);
  begin(fetchLinkPreview);
}

/** Several files, or a folder (`folder` is its name): each with the folder it sits in. */
export function startFileBatch(entries, { folder = null } = {}) {
  const capped = capEntries(entries);
  const durations = new Map();
  batch = {
    source: folder ? SOURCE.FOLDER : SOURCE.FILES,
    name: folder,
    entries: capped.entries,
    refused: capped.refused,
    dropped: new Set(),
    durations,
    preview: null,
    items: fileItems(capped.entries, null, durations),
    groups: [],
    loading: true,
  };
  setBatchNotQueued(0);
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
  target.error = null;
  try {
    const res = await fetch(PREVIEW_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return await importResponse(res);
  } catch (err) {
    target.error = readableError(err);
    return null;
  }
}

function takePreview(target, preview) {
  target.capacity = preview.capacity_left;
  target.maxDurationSec = preview.max_duration_sec;
}

async function fetchLinkPreview(target) {
  const preview = await postPreview(target, { links: target.lines });
  if (!isCurrent(target)) return;
  if (preview) {
    const { items, groups } = linkItems(preview);
    target.items = items.filter((i) => !target.droppedLines.has(i.line));
    target.groups = groups;
    takePreview(target, preview);
  } else {
    target.items = markUnchecked(target.items);
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
    takePreview(target, preview);
  }
  target.loading = false;
  rebuildFileItems(target);
}

/** Rows again from the files, the preview and the lengths read so far, keeping the user's ticks. */
function rebuildFileItems(target) {
  const before = new Map(target.items.map((i) => [i.file, i]));
  const items = fileItems(target.entries, target.preview, target.durations)
    .filter((item) => !target.dropped.has(item.file))
    .map((item) => {
      const old = before.get(item.file);
      return old && old.status === item.status ? { ...item, ticked: old.ticked } : item;
    });
  target.items = target.error ? markUnchecked(items) : items;
  renderReview();
}

function retryPreview() {
  batch.loading = true;
  if (batch.source === SOURCE.LINKS) {
    batch.items = lookingUpItems(batch.lines).filter((i) => !batch.droppedLines.has(i.line));
    renderReview();
    fetchLinkPreview(batch);
    return;
  }
  batch.error = null;
  rebuildFileItems(batch);
  fetchFilePreview(batch);
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

/** Length is checked here: the server only sees file names until upload. */
async function readDurations(target) {
  for (const { file } of target.entries) {
    if (!isCurrent(target)) return;
    if (!isUploadable(file)) continue;
    const seconds = await readDuration(file);
    if (seconds !== null) target.durations.set(file, seconds);
    if (!target.loading && isCurrent(target)) rebuildFileItems(target);
  }
}

// ─── the review list ───

export function openReview() {
  if (!batch) return;
  mountPanel({ onChange: onReviewChange, onClick: onReviewClick, closed: onReviewClosed });
  renderReview();
  focusFirst();
}

const stemObserver = new MutationObserver(renderFooter);

function onReviewClosed() {
  stemObserver.disconnect();
}

function headText() {
  if (batch.source === SOURCE.LINKS) {
    const links = plural("batch.links", batch.linkCount);
    const songs = plural("batch.songs", batch.items.length);
    return { title: batch.loading ? links : t("batch.songsFromLinks", { songs, links }), sub: t("batch.pastedList") };
  }
  const files = plural("batch.files", batch.items.length);
  if (batch.source === SOURCE.FILES) return { title: files, sub: "" };
  const nested = batch.entries.some((e) => e.dir.includes(PATH_SEP));
  return { title: t("batch.filesIn", { files, folder: batch.name }), sub: nested ? t("batch.subfolders") : "" };
}

function notes() {
  const out = [];
  if (batch.refused && batch.source === SOURCE.LINKS) out.push(plural("batch.overCap", batch.refused, { max: MAX_BATCH_LINKS }));
  else if (batch.refused) out.push(plural("batch.overCapFiles", batch.refused, { max: MAX_BATCH_FILES }));
  return out;
}

export function renderReview() {
  const panel = reviewPanel();
  if (!panel || !batch) return;
  stemObserver.observe(
    document.getElementById("job-form"),
    { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] },
  );
  const focus = focusedControl();
  const error = batch.error && !batch.loading ? t("batch.previewFailed", { message: batch.error }) : null;
  panel.replaceChildren(...reviewShell({ ...headText(), notes: notes(), error }));
  panel.querySelector(".batch-review-list").append(...listRows());
  renderFooter();
  placePanel();
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
  const panel = reviewPanel();
  if (!panel || !batch) return;
  const plan = queuePlan(batch.items, batch.capacity);
  const choice = batch.choice ?? liveChoice();
  const structure = t(choice.autoSections ? "batch.structureOn" : "batch.structureOff");
  const stems = plural("batch.stems", choice.stems.length);
  panel.querySelector(".batch-review-summary").textContent = t("batch.forAll", { stems, structure });
  panel.querySelector(".batch-review-clamp").textContent = plan.clamped ? plural("batch.onlyFit", plan.send.length) : "";
  const queue = panel.querySelector(".batch-queue");
  queue.textContent = plural("batch.queue", plan.send.length);
  queue.disabled = batch.loading || batch.queuing || plan.send.length === 0;
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

function closeReview() {
  closePanel();
}

function retryRow(btn) {
  return queueOnly(itemOf(btn));
}

function toggleSongs(btn) {
  toggleGroup(groupOf(btn), "collapsed");
}

function showAllSongs(btn) {
  toggleGroup(groupOf(btn), "showAll");
}

const REVIEW_ACTIONS = {
  "batch-review-close": closeReview,
  "batch-cancel": closeReview,
  "batch-queue": queueTicked,
  "batch-preview-retry": retryPreview,
  "batch-item-drop": dropRow,
  "batch-item-retry": retryRow,
  "batch-group-toggle": toggleSongs,
  "batch-more-btn": showAllSongs,
};

function onReviewClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  const action = Object.keys(REVIEW_ACTIONS).find((cls) => btn.classList.contains(cls));
  if (action) REVIEW_ACTIONS[action](btn);
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
  if (group) batch.groups = batch.groups.filter((g) => g !== group);
  showWhatIsLeft(batch.items.filter((i) => (group ? i.group !== group.key : i !== item)));
}

// ─── queuing ───

/** Library rows for what was queued; a playlist's songs go in a folder named after it. */
function addLibraryRows(target, queued) {
  const { stems, splitChoice } = target.choice;
  const playlists = new Map();
  for (const { item, jobId } of queued) {
    if (item.kind === ITEM_KIND.FILE) registerUploadRow(jobId, item.file, { replaces: item.replaces, stems, splitChoice });
    else if (!item.group) registerLinkRow(jobId, item, { stems, splitChoice });
    else {
      keepSplitChoice(jobId, item.replaces, splitChoice);
      const jobs = playlists.get(item.group) ?? [];
      jobs.push({ job_id: jobId, title: item.title, source_url: item.url, replaces: item.replaces });
      playlists.set(item.group, jobs);
    }
  }
  for (const [key, jobs] of playlists) addPlaylistToLibrary(target.groups.find((g) => g.key === key)?.title, jobs);
}

/** Queue `items` of `target` with the choice the batch was first queued with; what was left out. */
async function queueSome(target, items) {
  target.choice ??= liveChoice();
  const { stems, autoSections } = target.choice;
  target.queuing = true;
  renderFooter();
  const outcome = await queueItems(items, {
    postLink: (item) => postLinkImport({ url: item.url, stems, replaces: item.replaces, title: item.title, autoSections }),
    postFile: (item) => postFileJob(item.file, { stems, autoSections, replaces: item.replaces }),
    isQueueFull,
    reasonOf: readableError,
    queueFullReason: t("upload.reasonQueueFull"),
  });
  addLibraryRows(target, outcome.queued);
  recordBatch(outcome.queued.map((q) => q.jobId));
  target.queuing = false;
  target.capacity = null;
  for (const { item, reason } of outcome.notQueued) Object.assign(item, { status: ITEM_STATUS.NOT_QUEUED, reason, ticked: true });
  return outcome.notQueued.map((n) => n.item);
}

function showWhatIsLeft(items) {
  batch.items = items;
  setBatchNotQueued(items.filter((i) => i.status === ITEM_STATUS.NOT_QUEUED).length);
  if (!items.length) {
    finishBatch();
    return;
  }
  refreshPill();
  refreshSubmitLabel();
  renderReview();
}

/** Send `items`; then the list keeps what was not queued and `kept`. */
async function send(items, kept) {
  const target = batch;
  const notQueued = await queueSome(target, items);
  if (isCurrent(target)) showWhatIsLeft(target.items.filter((i) => notQueued.includes(i) || kept.includes(i)));
}

/** Ticked items the queue had no room for stay, as not queued, beside those it refused. */
function leftOverByCapacity(sent) {
  const reason = t("upload.reasonQueueFull");
  return batch.items
    .filter((i) => i.ticked && isTickable(i) && !sent.includes(i))
    .map((item) => Object.assign(item, { status: ITEM_STATUS.NOT_QUEUED, reason }));
}

function queueTicked() {
  const { send: sent } = queuePlan(batch.items, batch.capacity);
  return send(sent, leftOverByCapacity(sent));
}

function queueOnly(item) {
  if (!item) return null;
  return send([item], batch.items.filter((i) => i !== item));
}

/** "Retry failed" in the queue view: the items the queue did not take, sent again. */
function resendLeftOut() {
  const left = batch?.items.filter((i) => i.status === ITEM_STATUS.NOT_QUEUED) ?? [];
  if (!left.length) return null;
  return send(left, batch.items.filter((i) => !left.includes(i)));
}

// ─── wiring ───

function onUrlPaste(e) {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!isPastedList(text)) return;
  e.preventDefault();
  document.getElementById("fileInput")?._clear?.();
  startLinkBatch(text);
}

function onUrlInput() {
  if (batch?.inBar) clearBatch();
}

const hasStagedFile = () => !!document.getElementById("fileInput")?._file;

/** A held batch, or a playlist link in the bar, opens the review instead of importing. */
function interceptBatchSubmit() {
  if (batch) {
    openReview();
    return true;
  }
  if (hasStagedFile() || !looksLikePlaylist(urlInput().value)) return false;
  startLinkBatch(urlInput().value, { inBar: true });
  return true;
}

const batchSubmitLabel = () => (batch ? plural("batch.review", batch.items.length) : t("process.extractStems"));

export function wireBatchImport() {
  for (const slot of document.querySelectorAll("[data-batch-icon]")) slot.innerHTML = icon(slot.dataset.batchIcon);
  urlInput()?.addEventListener("paste", onUrlPaste);
  urlInput()?.addEventListener("input", onUrlInput);
  interceptSubmit(interceptBatchSubmit);
  setIdleSubmitLabel(batchSubmitLabel);
  onResendNotQueued(resendLeftOut);
}
