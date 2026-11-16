// Film puts the studio's panes away (film.css) and gives them back untouched,
// its arm included; it never opens over a take the studio is recording.

import { t, onLanguageChange } from "./i18n.js";
import { currentJobId, totalDuration } from "./state.js";
import { $ } from "./utils.js";
import { togglePlayPause, stopTransport, transport, setPlayheadTime } from "./transport.js";
import { isModalOpen, isStageMode, setStageMode } from "./stageMode.js";
import { getCurrentTrackInfo, isTextEditingTarget } from "./catalog.js";
import { WAVE_PEAKS_EVENT, getWavePeaks } from "./player.js";
import { refitFooter } from "./footerFit.js";
import { HTTP_NOT_FOUND, HttpError } from "./libraryControls.js";
import { EMPTY_VALUE } from "./constants.js";
import { listTakes, fetchTakePeaks } from "./takesApi.js";
import { FILM_OPEN_EVENT, openRecordingSettings } from "./takesActions.js";
import { EMPTY_LISTING, TAKES_CHANGED_EVENT, livePeaks } from "./takes.js";
import { TRACK_KIND_VIDEO } from "./takesState.js";
import { armedLevel, armedTrack } from "./recorderArm.js";
import {
  RECORD_BLOCK, STOP_REASON, onRecorderEvent, recordBlock, recordingTake, stopTake, takeElapsedSec,
} from "./recorder.js";
import { closeCamera, cameraLabel, filmSupportHere, openCamera } from "./filmCamera.js";
import { filmPrefs, loadFilmPrefs } from "./filmPrefs.js";
import { readEncoders, patchTake } from "./filmApi.js";
import { applyIPlay, releaseIPlay, renderIPlay, toggledIPlay } from "./filmIPlay.js";
import { armForFilm, rememberArm, restoreArm, saveIPlay, toggleFilmRecording } from "./filmRecord.js";
import { paintTimeline, renderTimeline } from "./filmTimeline.js";
import { loadReview, syncReview } from "./filmReview.js";
import { paintBadges, paintDevices, paintMeter, paintNote, paintProblem, wireFilmPanel } from "./filmPanel.js";
import { openVideoExport } from "./videoExport.js";

const MODE_CLASS = "film-mode";

const film = {
  open: false,
  jobId: null,
  listing: EMPTY_LISTING,
  track: null,
  iPlay: [],
  reviewId: null,
  previousArm: null,
  takePeaks: new Map(),
  stream: null,
  cameraLabel: "",
  mime: "",
  problem: null,
  encoders: null,
  preview: null,
  frameId: 0,
};

export function isFilmOpen() {
  return film.open;
}

function videoTrackOf(listing, trackId) {
  const videos = listing.tracks.filter((track) => track.kind === TRACK_KIND_VIDEO);
  return videos.find((track) => track.id === trackId) ?? videos[0] ?? null;
}

function trackTakes() {
  if (!film.track) return [];
  return film.listing.takes
    .filter((entry) => entry.track_id === film.track.id)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

function reviewTake() {
  return trackTakes().find((entry) => entry.id === film.reviewId) ?? null;
}

async function readListing(jobId) {
  try {
    return await listTakes(jobId);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === HTTP_NOT_FOUND)) console.warn("[film] could not list takes:", err);
    return EMPTY_LISTING;
  }
}

async function loadTakePeaks() {
  const missing = trackTakes().filter((entry) => !film.takePeaks.has(entry.id));
  await Promise.all(missing.map(async function peaksFor(entry) {
    film.takePeaks.set(entry.id, await fetchTakePeaks(entry.peaks_url, entry.id));
  }));
}

async function loadSong(trackId) {
  const jobId = currentJobId;
  film.jobId = jobId;
  film.listing = await readListing(jobId);
  film.track = videoTrackOf(film.listing, trackId ?? film.track?.id);
  film.iPlay = film.track?.i_play ?? film.iPlay;
  await loadTakePeaks();
}

function paintSong() {
  const info = getCurrentTrackInfo();
  $("filmTitle").textContent = info?.displayTitle || EMPTY_VALUE;
  $("filmArtist").textContent = info?.artist ?? "";
}

function render() {
  if (!film.open) return;
  const take = reviewTake();
  renderIPlay(film.iPlay, onStemToggle);
  renderTimeline({
    songSec: totalDuration,
    songPeaks: getWavePeaks() ?? [],
    take: take ?? trackTakes().at(-1) ?? null,
    takePeaks: film.takePeaks.get((take ?? trackTakes().at(-1))?.id) ?? [],
    trim: take?.trim ?? null,
    reviewing: Boolean(take),
    onSeek: setPlayheadTime,
    onTrim: onTrimChange,
    onPickTake: onTakeClipClick,
  });
  paintProblem(film.problem, film.encoders?.os ?? null);
  paintDevices({ cameraName: film.stream ? film.cameraLabel : "", micName: armedTrack()?.info?.label ?? "" });
  paintNote(noteFor(take));
  paintSong();
}

function noteFor(take) {
  if (take?.camera_dropped) return t("film.pictureDropped");
  if (take?.has_camera && film.encoders?.render_available === false) return t("film.renderUnavailable");
  return "";
}

async function startCamera() {
  closeCamera(film.stream);
  film.stream = null;
  const support = filmSupportHere();
  film.mime = support.mime;
  film.problem = support.problem;
  if (!film.problem) {
    try {
      film.stream = await openCamera(filmPrefs().cameraId);
      film.cameraLabel = cameraLabel(film.stream);
    } catch (err) {
      console.warn("[film] the camera could not open:", err);
      film.problem = err.problem;
    }
  }
  if (!film.open) {
    closeCamera(film.stream);
    film.stream = null;
    return;
  }
  film.preview.srcObject = film.stream;
  render();
}

async function openFilm(trackId = null) {
  if (film.open || !currentJobId || recordingTake()) return;
  if (isStageMode()) setStageMode(false);
  film.open = true;
  film.previousArm = rememberArm();
  film.preview = $("filmCameraVideo");
  document.querySelector(".app")?.classList.add(MODE_CLASS);
  $("filmView").hidden = false;
  $("filmBtn")?.setAttribute("aria-pressed", "true");
  refitFooter();
  await loadFilmPrefs();
  await loadSong(trackId);
  applyIPlay(film.iPlay);
  render();
  $("filmPlayBtn")?.focus();
  armForFilm(film.jobId, film.track).then(render);
  startCamera();
  readEncoders().then(keepEncoders, function noEncoderStatus(err) {
    console.warn("[film] could not read the video encoders:", err);
  });
  film.frameId = requestAnimationFrame(frame);
}

function keepEncoders(status) {
  film.encoders = status;
  render();
}

async function closeFilm() {
  if (!film.open) return;
  film.open = false;
  cancelAnimationFrame(film.frameId);
  // Film never opens over a studio take, so a take running now is Film's own.
  const stopping = recordingTake() ? stopTake(STOP_REASON.user) : null;
  releaseIPlay();
  Promise.resolve(stopping).then(function giveArmBack() {
    if (!film.open) restoreArm(film.previousArm, film.listing);
  });
  closeCamera(film.stream);
  film.stream = null;
  film.reviewId = null;
  loadReview($("filmTakeVideo"), null);
  document.querySelector(".app")?.classList.remove(MODE_CLASS);
  $("filmView").hidden = true;
  $("filmBtn")?.setAttribute("aria-pressed", "false");
  refitFooter();
  $("filmBtn")?.focus();
}

function playing() {
  return Boolean(transport()?.isPlaying?.());
}

function paintRecord(take) {
  const btn = $("filmRecBtn");
  const live = Boolean(take);
  const block = live ? null : recordBlock();
  const blocked = Boolean(film.problem) || !film.stream || (block && block !== RECORD_BLOCK.noTrack);
  btn.classList.toggle("is-live", live);
  btn.disabled = !live && blocked;
  btn.setAttribute("aria-pressed", String(live));
  const hint = live ? t("film.stopRecording") : block === RECORD_BLOCK.speed ? t("film.speedBlocked") : t("film.record");
  if (btn.title !== hint) {
    btn.title = hint;
    btn.setAttribute("aria-label", hint);
  }
}

function paintPreviewMode(take, review) {
  const reviewing = Boolean(review) && !take;
  $("filmCameraVideo").hidden = reviewing || !film.stream;
  $("filmTakeVideo").hidden = !reviewing;
  $("filmPreview").classList.toggle("is-live", Boolean(take));
  loadReview($("filmTakeVideo"), reviewing ? review.camera_url : null);
  return reviewing;
}

function frame() {
  if (!film.open) return;
  film.frameId = requestAnimationFrame(frame);
  const nowSec = transport()?.getCurrentTime?.() ?? 0;
  const take = recordingTake()?.jobId === film.jobId ? recordingTake() : null;
  const review = reviewTake();
  const reviewing = paintPreviewMode(take, review);
  if (reviewing) {
    const cameraStartSec = review.camera_start_sec ?? review.placement_sec;
    syncReview($("filmTakeVideo"), { songSec: nowSec, cameraStartSec, playing: playing() });
  }
  paintMeter(armedTrack() ? armedLevel() : 0);
  paintBadges({ recSec: take ? takeElapsedSec() : null, takeLabel: review?.label, nowSec, songSec: totalDuration });
  paintTimeline({ nowSec, songSec: totalDuration, live: take ? { startSec: take.startSec, nowSec, peaks: livePeaks(take) } : null });
  paintRecord(take);
  $("filmPlayBtn")?.classList.toggle("playing", playing());
  $("filmExportBtn").disabled = Boolean(take) || !review?.has_camera || film.encoders?.render_available === false;
}

async function onStemToggle(stem) {
  film.iPlay = toggledIPlay(film.iPlay, stem);
  applyIPlay(film.iPlay);
  render();
  await saveIPlay(film);
}

async function onTrimChange(trim) {
  const take = reviewTake();
  if (!take) return;
  try {
    const entry = await patchTake(film.jobId, take.id, { trim });
    film.listing.takes = film.listing.takes.map((other) => (other.id === entry.id ? { ...other, ...entry } : other));
  } catch (err) {
    console.warn("[film] the trim could not be saved:", err);
  }
  render();
}

function onTakeClipClick() {
  const latest = trackTakes().at(-1);
  film.reviewId = film.reviewId ? null : latest?.id ?? null;
  render();
}

async function onFilmRecordClick() {
  const wasRecording = Boolean(recordingTake());
  film.reviewId = null;
  await toggleFilmRecording(film);
  if (!wasRecording) render();
}

function onFilmExportClick() {
  const take = reviewTake();
  if (!take) return;
  openVideoExport({
    jobId: film.jobId,
    trackId: film.track.id,
    take,
    iPlay: film.iPlay,
    title: getCurrentTrackInfo()?.displayTitle ?? "",
  });
}

async function refreshFilm(reviewId = film.reviewId) {
  if (!film.open) return;
  await loadSong(film.track?.id);
  film.reviewId = reviewId;
  render();
}

function onFilmRecorderEvent(event) {
  if (!film.open) $("filmBtn").disabled = Boolean(recordingTake());
  if (!film.open || event.type === "change" || event.jobId !== film.jobId) return;
  refreshFilm(event.type === "finished" ? event.takeId : null);
}

async function onSongOpenInFilm() {
  if (!film.open) return;
  film.reviewId = null;
  film.takePeaks.clear();
  await refreshFilm(null);
  applyIPlay(film.iPlay);
  armForFilm(film.jobId, film.track).then(render);
}

/** Capture phase, so F, Esc and R mean Film's own while it is open. */
function onFilmKeydown(e) {
  if (!film.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isModalOpen() || isTextEditingTarget(e.target)) return;
  if (e.code === "KeyF") {
    e.preventDefault();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFilm();
  } else if (e.code === "KeyR") {
    e.preventDefault();
    if (!e.repeat) onFilmRecordClick();
  }
}

function onFilmButtonClick() {
  openFilm();
}

function onFilmOpenEvent(e) {
  openFilm(e.detail?.trackId ?? null);
}

function onFilmSettingsClick() {
  openRecordingSettings({ listing: film.listing }, film.track?.id ?? null);
}

function init() {
  $("filmBtn")?.addEventListener("click", onFilmButtonClick);
  $("filmExitBtn")?.addEventListener("click", closeFilm);
  $("filmPlayBtn")?.addEventListener("click", togglePlayPause);
  $("filmStopBtn")?.addEventListener("click", stopTransport);
  $("filmRecBtn")?.addEventListener("click", onFilmRecordClick);
  $("filmExportBtn")?.addEventListener("click", onFilmExportClick);
  $("filmSettingsLink")?.addEventListener("click", onFilmSettingsClick);
  wireFilmPanel(startCamera);
  window.addEventListener("keydown", onFilmKeydown, true);
  document.addEventListener(FILM_OPEN_EVENT, onFilmOpenEvent);
  document.addEventListener("trackopen", onSongOpenInFilm);
  document.addEventListener(TAKES_CHANGED_EVENT, function onTakesChangedInFilm() {
    refreshFilm();
  });
  onRecorderEvent(onFilmRecorderEvent);
  document.addEventListener(WAVE_PEAKS_EVENT, render);
  onLanguageChange(render);
}

init();
