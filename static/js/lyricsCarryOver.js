// Lyrics a browser kept for its tracks before the server kept the user's choice
// with the song (#41): each `stemdeck.lyrics.<trackId>` entry goes up once, and
// the server keeps any decision it already holds. The network and the store
// come in as arguments, so this runs under node.

import { libraryArtist } from "./trackBand.js";
import { keptForAnotherSong, toServerKept } from "./lyricsLookup.js";

const HTTP_OK_MIN = 200;
const HTTP_OK_END = 300;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;

export const lyricsStoreKey = (trackId) => `stemdeck.lyrics.${trackId}`;

/** A job's state (GET /api/jobs) as the track names keptForAnotherSong reads. */
export function songInfo(state) {
  const identity = state.identity?.title
    ? {
      title: state.identity.title,
      titleAliases: Array.isArray(state.identity.title_aliases) ? state.identity.title_aliases : [],
    }
    : null;
  return {
    title: state.title || "",
    userTitle: state.user_title || null,
    userArtist: state.user_artist || null,
    audioTags: state.audio_tags || null,
    identity,
  };
}

/** The request that carries `saved`, a browser entry, over to the job of
 * `state`: { method, body? }, or null when there is nothing worth carrying. */
export function carryOverRequest(saved, state) {
  if (saved?.dismissed === true) return { method: "DELETE" };
  const entry = saved?.entry;
  if (!entry || typeof entry !== "object") return null;
  if (keptForAnotherSong(entry, songInfo(state), libraryArtist(state.artist))) return null;
  return { method: "PUT", body: toServerKept(entry) };
}

/** Whether a carry-over answered with `status` (null: no answer) may succeed
 * at a later boot: the job not done yet, the server failing or unreachable. */
export const retryLater = (status) => status == null || status === HTTP_CONFLICT || status >= HTTP_SERVER_ERROR;

const succeeded = (status) => status >= HTTP_OK_MIN && status < HTTP_OK_END;

async function carryOverTrack(state, { read, drop, send, carried }) {
  const trackId = state.job_id;
  const saved = await read(trackId);
  if (saved == null) return true;
  const request = carryOverRequest(saved, state);
  if (request) {
    const status = await send(trackId, request);
    if (retryLater(status)) return false;
    if (succeeded(status)) carried(trackId);
  }
  await drop(trackId);
  return true;
}

/**
 * Carry each job's browser entry over, one at a time; true once none is left
 * for a later boot. `read(trackId)` the entry or null; `send(trackId, request)`
 * the HTTP status, null when the server cannot be reached; `drop(trackId)`
 * forgets the entry; `carried(trackId)` follows a request the server took.
 */
export async function carryOverLyrics(jobs, deps) {
  let finished = true;
  for (const state of jobs) {
    if (!(await carryOverTrack(state, deps))) finished = false;
  }
  return finished;
}
