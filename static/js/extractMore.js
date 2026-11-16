import {
  ROW_PENDING, TRACK_SHOW_EVENT, applyVersionsState, getCurrentTrackInfo, getLibraryTrack, paintRunRow, redrawLibrary,
  setVersionsExpanded,
} from "./catalog.js";
import { currentJobId } from "./state.js";
import { t } from "./i18n.js";
import { fetchJson } from "./libraryControls.js";
import { notifyFailure } from "./notifications.js";
import { STEM_NAMES } from "./constants.js";
import { storeSet } from "./utils.js";
import { addedName, missingStems, mixStoreKey, openVersionOf } from "./versionModel.js";
import { esc, reportRefusal, showOpenedVersion, songSubline, versionMix, versionsUrl } from "./versions.js";
import {
  EXTRACT_OUTCOME, EXTRACT_STATE, failureKey, filelessStems, followExtract, runLabel, startExtract,
} from "./extractRun.js";

const ROW_RUNNING = "running";
const HEAD_LABEL_ID = "npExtracting";
const HEAD_LABEL_CLASS = "np-extracting";
const STAGE_LABEL_ID = "stageExtracting";

let extractFor = null; // { trackId, chosen: Set<string>, refused: boolean, versionsState }
const runs = new Map(); // trackId → { view, mix, knownIds: Set<string> }
let latestRequest = 0;

// ─── The form ───

function chipHtml(stem, pressed) {
  return `<button class="cat-extract-more-chip" type="button" data-stem="${stem}" style="--chip-color: var(--${stem})"`
    + ` aria-pressed="${pressed}">${esc(t(`stem.${stem}`))}</button>`;
}

/** Saying it takes minutes only when a chosen stem has to be made. */
function hintText({ trackId, versionsState, chosen }) {
  const fileless = filelessStems(versionsState, getLibraryTrack(trackId), [...chosen]);
  return t(fileless.length ? "versions.extractSlowHint" : "versions.extractHint");
}

function choiceHtml(track) {
  const missing = missingStems(openVersionOf(track)?.stems ?? STEM_NAMES);
  return `<div class="cat-extract-more-chips">${missing.map((s) => chipHtml(s, extractFor.chosen.has(s))).join("")}</div>`
    + `<span class="cat-extract-more-hint">${esc(hintText(extractFor))}</span>`
    + `<div class="cat-extract-more-foot"><button class="cat-extract-more-cancel" type="button">${esc(t("folderEditor.cancel"))}</button>`
    + `<button class="cat-extract-more-go" type="button">${esc(t("versions.extractGo"))}</button></div>`;
}

function refusedHtml() {
  return `<p class="cat-extract-more-error" role="alert">${esc(t("versions.sourceGone"))}</p>`
    + `<div class="cat-extract-more-foot"><button class="cat-extract-more-cancel" type="button">${esc(t("artist.close"))}</button></div>`;
}

function extractForm(track) {
  const form = document.createElement("div");
  form.className = "cat-extract-more";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", t("versions.extractTitle"));
  form.innerHTML = `<div class="cat-extract-more-title">${esc(t("versions.extractTitle"))}</div>`
    + (extractFor.refused ? refusedHtml() : choiceHtml(track));
  const go = form.querySelector(".cat-extract-more-go");
  if (go) go.disabled = extractFor.chosen.size === 0;
  form.addEventListener("click", onExtractFormClick);
  form.addEventListener("keydown", onExtractFormKeydown);
  return form;
}

/** The song's Extract more form, when it is the one open. */
export function extractFormFor(trackId, track) {
  return extractFor?.trackId === trackId ? extractForm(track) : null;
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
  const form = chip.closest(".cat-extract-more");
  form.querySelector(".cat-extract-more-go").disabled = extractFor.chosen.size === 0;
  form.querySelector(".cat-extract-more-hint").textContent = hintText(extractFor);
}

function showRefused() {
  extractFor.refused = true;
  redrawLibrary();
  document.querySelector("#catalogList .cat-extract-more-cancel")?.focus();
}

/** The source's mix with the added lanes left out, so they start at the defaults. */
async function extractedMix(jobId, from, added) {
  const mix = await versionMix(jobId, from.id);
  if (!mix) return null;
  for (const name of added) delete mix[name];
  return mix;
}

async function openAtOnce(jobId, answer, mix) {
  if (answer.created && mix) await storeSet(mixStoreKey(jobId, answer.version.id), mix);
  setVersionsExpanded(jobId, true);
  await showOpenedVersion(jobId, answer);
  closeExtractForm();
}

async function submitExtract(button) {
  const { trackId, chosen } = extractFor;
  const track = getLibraryTrack(trackId);
  const from = openVersionOf(track);
  if (!from || !chosen.size) return;
  button.disabled = true;
  const added = STEM_NAMES.filter((stem) => chosen.has(stem));
  const mix = await extractedMix(trackId, from, added);
  const started = await startExtract(trackId, { from: from.id, stems: added, name: addedName(added, t) });
  if (started.outcome === EXTRACT_OUTCOME.OPENED) return openAtOnce(trackId, started.answer, mix);
  if (started.outcome === EXTRACT_OUTCOME.SOURCE_GONE) return showRefused();
  if (started.outcome === EXTRACT_OUTCOME.REFUSED) {
    reportRefusal(started.detail);
    button.disabled = false;
    return;
  }
  closeExtractForm();
  const knownIds = new Set((started.answer?.versions ?? track.versions ?? []).map((version) => version.id));
  followRun(trackId, { view: started.view, mix, knownIds });
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

async function readVersionsState(trackId) {
  try {
    return await fetchJson(versionsUrl(trackId));
  } catch (err) {
    console.warn("[extractMore] the song's versions could not be read:", err);
    return null;
  }
}

async function onExtractRequest(e) {
  const trackId = e.detail?.id;
  const track = getLibraryTrack(trackId);
  if (!track) return;
  const request = ++latestRequest;
  const versionsState = await readVersionsState(trackId);
  if (request !== latestRequest) return;
  const chosen = new Set(missingStems(openVersionOf(track)?.stems ?? STEM_NAMES));
  extractFor = { trackId, chosen, refused: false, versionsState };
  redrawLibrary();
  document.querySelector("#catalogList .cat-extract-more-go")?.focus();
}

// ─── A run: its row, the song head and Stage ───

function paintSongHeadLabel(text) {
  const artist = document.getElementById("np-artist");
  let label = document.getElementById(HEAD_LABEL_ID);
  if (!text || !artist) {
    label?.remove();
    return;
  }
  if (!label) {
    label = document.createElement("span");
    label.id = HEAD_LABEL_ID;
    label.className = HEAD_LABEL_CLASS;
  }
  songSubline(artist).append(label);
  label.textContent = text;
}

function paintStageLabel(text) {
  const label = document.getElementById(STAGE_LABEL_ID);
  if (!label) return;
  label.textContent = text;
  label.hidden = !text;
}

function runText(trackId) {
  const run = runs.get(trackId);
  return run ? runLabel(run.view, t).text : "";
}

// The head shows the open song, which can be one shown over the player; Stage shows the player's.
function paintOpenSongLabels() {
  paintSongHeadLabel(runText(getCurrentTrackInfo()?.id));
  paintStageLabel(runText(currentJobId));
}

function paintRun(trackId, view) {
  runs.get(trackId).view = view;
  const { text, bar, progress } = runLabel(view, t);
  paintRunRow(trackId, { state: bar ? ROW_RUNNING : ROW_PENDING, label: text, progress });
  if (trackId === currentJobId || trackId === getCurrentTrackInfo()?.id) paintOpenSongLabels();
}

async function openExtracted(trackId, run, view) {
  const answer = await readVersionsState(trackId);
  if (!answer) return;
  if (run.mix && !run.knownIds.has(view.version_id)) await storeSet(mixStoreKey(trackId, view.version_id), run.mix);
  setVersionsExpanded(trackId, true);
  if (trackId === currentJobId) await showOpenedVersion(trackId, answer);
  else applyVersionsState(trackId, answer);
}

function reportFailed(trackId, view) {
  notifyFailure({
    kind: "extract",
    message: t(failureKey(view)),
    context: { jobId: trackId },
  });
}

async function endRun(trackId, run, view) {
  runs.delete(trackId);
  paintRunRow(trackId, null);
  paintOpenSongLabels();
  if (view?.state === EXTRACT_STATE.DONE) await openExtracted(trackId, run, view);
  else if (view?.state === EXTRACT_STATE.FAILED) reportFailed(trackId, view);
}

async function followRun(trackId, run) {
  runs.set(trackId, run);
  paintRun(trackId, run.view);
  const final = await followExtract(trackId, {
    onView: function onExtractView(view) { paintRun(trackId, view); },
  });
  await endRun(trackId, run, final);
}

export function initExtractMore() {
  document.addEventListener("versions:extract", onExtractRequest);
  document.addEventListener("trackopen", paintOpenSongLabels);
  document.addEventListener(TRACK_SHOW_EVENT, paintOpenSongLabels);
}
