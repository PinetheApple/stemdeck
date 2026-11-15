// Recording tracks and takes for the open song: loads them, draws the tracks,
// runs the Record button and keeps takes playing with the song.

import {
  audioEngine, currentJobId, metronomeCountInBars, mixerEl, titleEl, totalDuration,
} from "./state.js";
import { t, onLanguageChange } from "./i18n.js";
import { playWithCountIn } from "./transport.js";
import { HTTP_NOT_FOUND, HttpError } from "./libraryControls.js";
import { buildTrackViews, laneSpace, nextName } from "./takesState.js";
import { renderTakeRows, paintTrackMeter } from "./takesRows.js";
import { renderTakeLanes, paintLiveClip } from "./takesLanes.js";
import { setTakeLaneSpace } from "./takesLayout.js";
import { loadTakeMix, setMixTracks, takeMixEntry } from "./takesMix.js";
import { setExportTakes } from "./takesExport.js";
import { applyMix } from "./mixer.js";
import { setTakeLanes } from "./takesPlayback.js";
import { fetchTakePeaks, listTakes } from "./takesApi.js";
import * as actions from "./takesActions.js";
import { armedLevel, armedTrack, disarm, onArmChange } from "./recorderArm.js";
import { loadRecorderPrefs } from "./recorderPrefs.js";
import {
  REC_PHASE, STOP_REASON, isLostUpload, onRecorderEvent, recordBlock, recordingTake, takeElapsedSec, toggleRecording,
} from "./recorder.js";
import { paintCountIn, paintRecordButton, paintStageMark, showRecNotice, wireRecordButton } from "./recorderUi.js";

const EMPTY_LISTING = Object.freeze({ tracks: [], takes: [], open: [] });
const LIVE_BARS_MAX = 200;
const COUNT_IN_MIN_BARS = 1;

const session = {
  jobId: null,
  listing: EMPTY_LISTING,
  ui: { openFolders: new Set(), review: null },
  views: [],
  peaks: new Map(),
  countInClicks: [],
  songTitle: "",
  refresh,
  render,
  startRename,
};

// The add row is drawn at --rec-take-h, a calc() that only layout resolves.
function shortRowPx() {
  return mixerEl.querySelector(".rec-add-row")?.offsetHeight ?? 0;
}

function renderContext() {
  const take = recordingTake();
  return {
    mixOf: takeMixEntry,
    inputLabelOf: actions.inputLabelOf,
    armedTrackId: armedTrack()?.jobId === session.jobId ? armedTrack()?.trackId : null,
    recordingTrackId: take?.jobId === session.jobId ? take.trackId : null,
    problem: armedTrack()?.problem ?? null,
    songSec: totalDuration,
    peaksOf: (takeId) => session.peaks.get(takeId) ?? [],
    on: handlers,
  };
}

const handlers = {
  add: (anchor) => actions.addTrack(session, anchor),
  folder: toggleFolder,
  input: (trackId, anchor) => actions.chooseInput(session, trackId, anchor),
  arm: (trackId) => actions.toggleArm(session, trackId),
  volume: actions.setVolume,
  mute: (trackId) => actions.toggleMute(session, trackId),
  solo: (trackId) => actions.toggleSolo(session, trackId),
  trackMenu: (trackId, anchor) => actions.trackMenu(session, trackId, anchor),
  pick: (trackId, takeId) => actions.pickTake(session, trackId, takeId),
  keep: (row) => actions.keepTake(session, row),
  discard: (row) => actions.discardTake(session, row),
  problem: (problem, anchor) => actions.answerProblem(session, problem, anchor),
  latency: (trackId) => actions.openRecordingSettings(session, trackId),
};

function toggleFolder(trackId) {
  const open = session.ui.openFolders;
  if (open.has(trackId)) open.delete(trackId);
  else open.add(trackId);
  render();
}

function render() {
  if (!session.jobId) return;
  const own = new Set([recordingTake()?.takeId].filter(Boolean));
  session.views = buildTrackViews(session.listing, { ...session.ui, ownTakeIds: own });
  setMixTracks(session.views.map((view) => view.id));
  setExportTakes(session.jobId, session.views);
  const ctx = renderContext();
  renderTakeRows(mixerEl, session.views, ctx);
  renderTakeLanes(session.views, ctx);
  setTakeLaneSpace(laneSpace(session.views, shortRowPx()));
  paintFooter();
}

function playingTakes() {
  return session.views
    .filter((view) => view.activeTake)
    .map((view) => ({ trackId: view.id, entry: view.activeTake }));
}

async function loadPeaks(listing) {
  const missing = listing.takes.filter((entry) => !session.peaks.has(entry.id));
  await Promise.all(missing.map(async function peaksFor(entry) {
    session.peaks.set(entry.id, await fetchTakePeaks(entry.peaks_url, entry.id));
  }));
}

async function readListing(jobId) {
  try {
    return await listTakes(jobId);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === HTTP_NOT_FOUND)) console.warn("[takes] could not list takes:", err);
    return EMPTY_LISTING;
  }
}

async function refresh() {
  const jobId = session.jobId;
  if (!jobId) return;
  const listing = await readListing(jobId);
  if (jobId !== session.jobId) return;
  session.listing = listing;
  await loadPeaks(listing);
  if (jobId !== session.jobId) return;
  render();
  setTakeLanes(playingTakes());
  applyMix();
}

async function openSong(jobId) {
  if (jobId === session.jobId) return;
  if (armedTrack()) disarm();
  session.jobId = jobId;
  session.listing = EMPTY_LISTING;
  session.ui = { openFolders: new Set(), review: null };
  session.peaks.clear();
  setTakeLanes([]);
  await loadTakeMix(jobId);
  await refresh();
}

function onTrackOpen(e) {
  const id = e.detail?.id;
  if (id) openSong(id);
}

function startRename(trackId) {
  const name = mixerEl.querySelector(`.rec-row[data-rec-track="${trackId}"] .mx-name`);
  if (!name) return;
  const field = document.createElement("input");
  field.type = "text";
  field.className = "rec-rename";
  field.value = name.textContent;
  field.setAttribute("aria-label", t("rec.rename"));
  field.addEventListener("keydown", function onRenameKeydown(e) {
    e.stopPropagation();
    if (e.key === "Enter") field.blur();
    if (e.key === "Escape") render();
  });
  field.addEventListener("blur", function onRenameDone() {
    if (field.isConnected) actions.renameTrack(session, trackId, field.value);
  });
  name.replaceWith(field);
  field.focus();
  field.select();
}

function countIn() {
  const bars = Math.max(COUNT_IN_MIN_BARS, metronomeCountInBars);
  session.countInClicks = playWithCountIn(bars).clicks;
}

function takeLabel(trackId) {
  const labels = [
    ...session.listing.takes.filter((entry) => entry.track_id === trackId),
    ...session.listing.open.filter((open) => open.track_id === trackId),
  ].map((take) => take.label);
  return nextName(labels, (n) => t("rec.takeDefault", { n }));
}

function onRecordClick() {
  const trackId = recordingTake()?.trackId ?? armedTrack()?.trackId;
  if (!trackId) return;
  session.songTitle = titleEl?.textContent ?? "";
  toggleRecording({ label: takeLabel(trackId), countIn });
}

function noticeAfterSwitch(event) {
  const title = session.songTitle;
  const label = session.listing.takes.find((entry) => entry.id === event.takeId)?.label ?? event.entry?.label ?? "";
  showRecNotice(t("rec.notice.switched", { take: label, song: title }), {
    text: t("rec.notice.open", { song: title }),
    onClick: function onOpenRecordedSong() {
      document.querySelector(`.cat-item[data-id="${event.jobId}"]`)?.click();
    },
  });
}

function onRecorder(event) {
  if (event.type === "change") {
    render();
    return;
  }
  if (event.type === "failed" && !isLostUpload(event.error)) showRecNotice(t("rec.notice.failed"));
  if (event.type === "finished" && event.reason === STOP_REASON.switched) noticeAfterSwitch(event);
  if (event.type === "finished" && event.jobId === session.jobId) session.ui.review = event.takeId;
  if (event.jobId === session.jobId) refresh();
}

function countInBeatsLeft() {
  const eng = audioEngine;
  if (!eng || !session.countInClicks.length) return 0;
  const now = eng.audioContext.currentTime;
  return session.countInClicks.filter((click) => eng.sourceTimeToCtxTime(click.time) > now).length;
}

function paintFooter() {
  const take = recordingTake();
  const elapsed = take ? takeElapsedSec() : null;
  paintRecordButton({
    hasTracks: session.views.length > 0,
    canDiscard: take?.canDiscard ?? false,
    phase: take?.phase ?? null,
    block: recordBlock(),
    elapsedSec: elapsed ?? 0,
  });
  paintStageMark(take ? elapsed : null);
}

function paintLive(take) {
  const eng = audioEngine;
  if (!eng || take.jobId !== session.jobId) return;
  const step = Math.max(1, Math.ceil(take.peaks.length / LIVE_BARS_MAX));
  const peaks = take.peaks.filter((_, i) => i % step === 0);
  paintLiveClip(take.trackId, {
    startSec: take.startSec,
    nowSec: eng.getCurrentTime(),
    songSec: totalDuration,
    peaks,
    label: take.phase === REC_PHASE.finishing ? t("rec.saving") : takeLabel(take.trackId),
  });
}

function frame() {
  requestAnimationFrame(frame);
  const arm = armedTrack();
  if (arm) paintTrackMeter(mixerEl, arm.trackId, armedLevel());
  const take = recordingTake();
  if (take) paintLive(take);
  paintCountIn(take ? countInBeatsLeft() : 0);
  paintFooter();
}

function init() {
  loadRecorderPrefs();
  document.addEventListener("trackopen", onTrackOpen);
  onRecorderEvent(onRecorder);
  onArmChange(render);
  onLanguageChange(render);
  wireRecordButton(onRecordClick);
  if (currentJobId) openSong(currentJobId);
  requestAnimationFrame(frame);
}

init();
