// The Details pane's Lead and backing vocals card: splits a finished song on
// demand and follows the split, with Cancel, and a failure says why with Try again.

import { t, getLanguage, onLanguageChange } from "./i18n.js";
import { loadTrackIntoStudio } from "./catalog.js";
import {
  SPLIT_STATE,
  SPLIT_PHASE,
  failureKey,
  hasVocalsStem,
  wantsAutoSplit,
  fetchSplitView,
  startSplit,
  followSplit,
  cancelSplit,
} from "./vocalSplit.js";

const JOB_DONE = "done";
const PHASE_KEYS = {
  [SPLIT_PHASE.QUEUED]: "vocalSplit.queued",
  [SPLIT_PHASE.SPLITTING]: "vocalSplit.running",
};
const START_KEY = "vocalSplit.start";
const RETRY_KEY = "job.tryAgain";
// States that leave the card offering a split.
const OFFERED_STATES = new Set([SPLIT_STATE.NONE, SPLIT_STATE.CANCELLED, SPLIT_STATE.ERROR]);
const FAILED_START_VIEW = Object.freeze({ state: SPLIT_STATE.ERROR, error: null });

let ui = null;
let shownFor = null; // the song the card is about
let shownView = null;
let token = 0; // another song or a new run makes every answer under way stale

const isCurrent = (mine) => () => mine === token;

async function fetchJob(jobId) {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (res.ok) return await res.json();
    console.warn("[vocalSplit] song refused", res.status);
  } catch (err) {
    console.warn("[vocalSplit] song not read", err);
  }
  return null;
}

/** The split view a song's job state implies, or null when there is nothing to offer. */
function viewForJob(job) {
  if (job?.status !== JOB_DONE || !hasVocalsStem(job)) return null;
  return { state: job.vocal_split, error: job.vocal_split_error ?? null };
}

function formatPercent(share) {
  return new Intl.NumberFormat(getLanguage(), { style: "percent" }).format(share);
}

function paintProgress({ phase, progress }) {
  const share = Number(progress);
  const measured = phase === SPLIT_PHASE.SPLITTING && Number.isFinite(share);
  if (measured) ui.bar.value = Math.min(1, Math.max(0, share));
  else ui.bar.removeAttribute("value");
  ui.percent.textContent = measured ? formatPercent(ui.bar.value) : "";
}

function messageFor(view) {
  if (view.state === SPLIT_STATE.RUNNING) return t(PHASE_KEYS[view.phase] ?? PHASE_KEYS[SPLIT_PHASE.SPLITTING]);
  if (view.state === SPLIT_STATE.ERROR) return t(failureKey(view.error));
  return "";
}

/** Show `view`: the split's state, or null for a song with nothing to offer. */
function paint(view) {
  shownView = view;
  const running = view?.state === SPLIT_STATE.RUNNING;
  ui.card.hidden = !running && !OFFERED_STATES.has(view?.state);
  if (ui.card.hidden) return;
  ui.message.textContent = messageFor(view);
  ui.progress.hidden = !running;
  ui.start.hidden = running;
  ui.start.removeAttribute("aria-busy");
  ui.start.textContent = t(view.state === SPLIT_STATE.ERROR ? RETRY_KEY : START_KEY);
  if (running) paintProgress(view);
  else ui.cancel.removeAttribute("aria-busy");
}

/** A split that ended reopens its song, so the lead and backing lanes come in. */
function showEnded(jobId, view) {
  if (view.state !== SPLIT_STATE.DONE) return paint(view);
  paint(null);
  loadTrackIntoStudio(jobId);
}

async function follow(jobId, mine) {
  const final = await followSplit(jobId, { onView: paint, isCurrent: isCurrent(mine) });
  if (final && mine === token) showEnded(jobId, final);
}

/** Show the card for `jobId`, following a split under way or starting one the song asked for. */
async function showFor(jobId) {
  const mine = ++token;
  shownFor = jobId;
  paint(null);
  if (!jobId) return;
  const job = await fetchJob(jobId);
  if (mine !== token) return;
  if (wantsAutoSplit(job)) return runSplit(jobId);
  const view = viewForJob(job);
  paint(view);
  if (view?.state === SPLIT_STATE.RUNNING) follow(jobId, mine);
}

async function runSplit(jobId) {
  const mine = ++token;
  // Busy rather than disabled: a disabled button drops focus to the page.
  ui.start.setAttribute("aria-busy", "true");
  let view = FAILED_START_VIEW;
  try {
    view = await startSplit(jobId);
  } catch (err) {
    console.warn("[vocalSplit] split not started", err);
  }
  if (mine !== token) return;
  if (view.state !== SPLIT_STATE.RUNNING) return showEnded(jobId, view);
  paint(view);
  follow(jobId, mine);
}

async function onStartClick() {
  if (!shownFor || ui.start.getAttribute("aria-busy") === "true") return;
  await runSplit(shownFor);
  if (!ui.progress.hidden) ui.cancel.focus();
}

async function onCancelClick() {
  const jobId = shownFor;
  if (!jobId || ui.cancel.getAttribute("aria-busy") === "true") return;
  ui.cancel.setAttribute("aria-busy", "true");
  if (!(await cancelSplit(jobId))) ui.cancel.removeAttribute("aria-busy");
}

function onTrackOpen(event) {
  const jobId = event.detail?.id ?? null;
  if (jobId === shownFor && shownView?.state === SPLIT_STATE.RUNNING) return;
  showFor(jobId);
}

/** A finished import plays without a trackopen; a track already shown needs no second look. */
function onPlaybackReady(event) {
  const jobId = event.detail?.id ?? null;
  if (jobId !== shownFor) showFor(jobId);
}

function onLanguageChanged() {
  if (shownView) paint(shownView);
}

function initVocalSplitPanel() {
  const card = document.getElementById("vocalSplitCard");
  if (!card) return;
  ui = {
    card,
    message: document.getElementById("vocalSplitMessage"),
    progress: document.getElementById("vocalSplitProgress"),
    bar: document.getElementById("vocalSplitBar"),
    percent: document.getElementById("vocalSplitPercent"),
    cancel: document.getElementById("vocalSplitCancel"),
    start: document.getElementById("vocalSplitStart"),
  };
  ui.start.addEventListener("click", onStartClick);
  ui.cancel.addEventListener("click", onCancelClick);
  document.addEventListener("trackopen", onTrackOpen);
  document.addEventListener("playbackready", onPlaybackReady);
  onLanguageChange(onLanguageChanged);
}

initVocalSplitPanel();
