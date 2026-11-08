// Each `stemdeck.lyrics.<trackId>` entry in the browser's store goes up to the
// server once; the server keeps any decision it already holds. The network and
// the store come in as arguments, so this runs under node.

import { libraryArtist } from "./trackBand.js";
import { FILE_SOURCE, keptForAnotherSong, toServerKept } from "./lyricsLookup.js";
import { HTTP_CONFLICT } from "./lyricsTranscribe.js";

const HTTP_OK_MIN = 200;
const HTTP_OK_END = 300;
const HTTP_SERVER_ERROR = 500;
// A job that ended without its stems is never ready for lyrics. "stopped" is
// not here: Extract runs a trashed job again.
const NEVER_READY_STATUSES = new Set(["error", "cancelled"]);

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
 * `state`: { method, body?, picked? }, or null when there is nothing worth carrying. */
export function carryOverRequest(saved, state) {
  if (saved?.dismissed === true) return { method: "DELETE" };
  const entry = saved?.entry;
  if (!entry || typeof entry !== "object") return null;
  if (keptForAnotherSong(entry, songInfo(state), libraryArtist(state.artist))) return null;
  // A file's own lyrics are kept without the user picking them, so they go up as no pick.
  return { method: "PUT", body: toServerKept(entry), picked: entry.source !== FILE_SOURCE };
}

/** Whether a carry-over to a job in `jobStatus` answered with `status` (null:
 * no answer) may succeed at a later boot: the job still on its way to done,
 * the server failing or unreachable. */
export const retryLater = (status, jobStatus) =>
  status == null
  || status >= HTTP_SERVER_ERROR
  || (status === HTTP_CONFLICT && !NEVER_READY_STATUSES.has(jobStatus));

const succeeded = (status) => status >= HTTP_OK_MIN && status < HTTP_OK_END;

async function carryOverTrack(state, { read, drop, send, carried }) {
  const trackId = state.job_id;
  const saved = await read(trackId);
  if (saved == null) return true;
  const request = carryOverRequest(saved, state);
  if (request) {
    const status = await send(trackId, request);
    if (retryLater(status, state.status)) return false;
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
