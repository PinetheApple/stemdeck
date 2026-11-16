// Recording from the Film view: the Video track (made on the first take), its
// input armed, and a take that carries the camera beside the sound.

import { t } from "./i18n.js";
import { audioEngine, currentJobId } from "./state.js";
import { armTrack, armedTrack, disarm } from "./recorderArm.js";
import { onRecorderEvent, recordBlock, recordingTake, toggleRecording } from "./recorder.js";
import { createVideoTrack } from "./takesActions.js";
import { patchTrack } from "./takesApi.js";
import { nextName } from "./takesState.js";
import { TAKES_CHANGED_EVENT, countIn } from "./takes.js";
import { createCameraTake } from "./filmCameraTake.js";

// Armed before the Video track exists, so the meter runs from the start.
const NO_TRACK_YET = Object.freeze({ id: null, input: null });
// Past the recorder's offer to discard a save stuck behind a silent server.
const TAKE_SETTLE_MAX_MS = 30_000;

const settleWaiters = new Set();

onRecorderEvent(function onTakeSettled() {
  if (recordingTake()) return;
  for (const resolve of settleWaiters) resolve();
  settleWaiters.clear();
});

/** Resolves once no take is recording or saving, or after TAKE_SETTLE_MAX_MS. */
export function takeSettled() {
  if (!recordingTake()) return Promise.resolve();
  return new Promise(function waitForNoTake(resolve) {
    settleWaiters.add(resolve);
    setTimeout(resolve, TAKE_SETTLE_MAX_MS);
  });
}

function tellStudio() {
  document.dispatchEvent(new CustomEvent(TAKES_CHANGED_EVENT));
}

/** Arm `track` (or the input alone, before there is a track) unless it already is. */
export function armForFilm(jobId, track) {
  const id = track?.id ?? null;
  const arm = armedTrack();
  if (arm && arm.jobId === jobId && arm.trackId === id) return Promise.resolve();
  return armTrack(jobId, track ?? NO_TRACK_YET);
}

/** The studio's arm before Film took the input, to give back on close. */
export function rememberArm() {
  const arm = armedTrack();
  return arm?.trackId ? { jobId: arm.jobId, trackId: arm.trackId } : null;
}

/** Arm the studio's track again, if it is still on the open song; else leave nothing armed. */
export function restoreArm(previous, listing) {
  if (recordingTake()) return;
  const track = previous?.jobId === currentJobId ? listing.tracks.find((entry) => entry.id === previous.trackId) : null;
  if (track) armForFilm(previous.jobId, track);
  else disarm();
}

/** The Video track to record on, made now when the song has none. */
async function ensureTrack(film) {
  if (film.track) return film.track;
  const track = await createVideoTrack(film.jobId, film.listing.tracks, { i_play: film.iPlay });
  film.track = track;
  film.listing = { ...film.listing, tracks: [...film.listing.tracks, track] };
  tellStudio();
  return track;
}

export async function saveIPlay(film) {
  if (!film.track) return;
  try {
    film.track = await patchTrack(film.jobId, film.track.id, { i_play: film.iPlay });
  } catch (err) {
    console.warn("[film] I play could not be saved:", err);
  }
}

function takeLabel(film) {
  const own = film.listing.takes.filter((entry) => entry.track_id === film.track.id).map((entry) => entry.label);
  return nextName(own, (n) => t("rec.takeDefault", { n }));
}

function cameraFor(film) {
  return createCameraTake({
    stream: film.stream,
    preview: film.preview,
    ctx: audioEngine.audioContext,
    mime: film.mime,
    camera: { label: film.cameraLabel, mirror: false, offsetMs: 0 },
  });
}

/** Record or stop. Resolves once the take has started (or stopped). */
export async function toggleFilmRecording(film) {
  if (recordingTake()) return toggleRecording({});
  if (!film.stream || film.jobId !== currentJobId) return null;
  const track = await ensureTrack(film);
  await armForFilm(film.jobId, track);
  if (recordBlock()) return null;
  return toggleRecording({ label: takeLabel(film), countIn, camera: cameraFor(film) });
}
