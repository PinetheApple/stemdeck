// Recording from the Film view: the Video track (made on the first take), its
// input armed, and a take that carries the camera beside the sound.

import { t } from "./i18n.js";
import { audioEngine, currentJobId, metronomeCountInBars } from "./state.js";
import { playWithCountIn } from "./transport.js";
import { armTrack, armedTrack, disarm } from "./recorderArm.js";
import { recordBlock, recordingTake, toggleRecording } from "./recorder.js";
import { createVideoTrack } from "./takesActions.js";
import { patchTrack } from "./takesApi.js";
import { nextName } from "./takesState.js";
import { TAKES_CHANGED_EVENT } from "./takes.js";
import { createCameraTake } from "./filmCameraTake.js";

const COUNT_IN_MIN_BARS = 1;
// Armed before the Video track exists, so the meter runs from the start.
const NO_TRACK_YET = Object.freeze({ id: null, input: null });

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

export function disarmFilm() {
  if (!recordingTake()) disarm();
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

function countIn() {
  playWithCountIn(Math.max(COUNT_IN_MIN_BARS, metronomeCountInBars));
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
