// Which band a track keeps when job state arrives, which bands the browser owes the
// server, and which it holds back from a later lookup. The network comes in as
// arguments, so this runs under node.

import { artistMatchesCredit, lookupCredit, taggedArtistName } from "./artistLookup.js";

const WIKIDATA_ITEM = /^Q\d+$/;
const HTTP_NOT_FOUND = 404;
export const HTTP_UNPROCESSABLE = 422;

export const HELD_DROP = "drop";
export const HELD_SEND = "send";
export const HELD_KEEP = "keep";

/**
 * A band as the library keeps it: { id, name, englishName } with id a Wikidata
 * item. Null for anything else, so a malformed answer never reaches the artist box.
 */
export function libraryArtist(artist) {
  if (!artist || typeof artist !== "object" || !WIKIDATA_ITEM.test(String(artist.id || ""))) return null;
  return { id: artist.id, name: String(artist.name || ""), englishName: String(artist.englishName || "") };
}

/**
 * The band to keep when `source` (job state, or a track built from one) arrives.
 * The server's wins, except that `holdLocal` keeps a local band over one not marked
 * saved. Built tracks and audio-tags answers carry no user_band, so over those a
 * local band, guess or not, stays until the next sync.
 */
export function mergedBand(localBand, source, holdLocal) {
  const server = libraryArtist(source?.artist);
  if (!server) return localBand;
  return holdLocal && !source.user_band && libraryArtist(localBand) ? localBand : server;
}

/**
 * Whether `band` is what looking the track's tag up would find, so a guess rather
 * than a pick. A stored band has lost its native name and aliases, hence the lookup.
 * Throws when `lookup` does: unknown is not an answer.
 */
export async function isGuessedBand(track, band, lookup) {
  const name = taggedArtistName(track.userArtist || track.audioTags?.artist);
  if (!name) return false;
  if (artistMatchesCredit(band, name)) return true;
  return (await lookupCredit(name, lookup))?.id === band.id;
}

function statesById(jobs) {
  return new Map(jobs.map((state) => [state.job_id, state]));
}

/** The tracks that may owe the server a band, given GET /api/jobs?trashed=include. */
export function bandUploadIds(tracks, jobs) {
  const states = statesById(jobs);
  return Object.keys(tracks).filter((trackId) => {
    const band = libraryArtist(tracks[trackId]?.artist);
    const state = states.get(trackId);
    return band && !state?.user_band && state?.artist?.id !== band.id;
  });
}

/** The tracks whose local band is the one the server found, unsaved: nothing to send. */
export function foundBandIds(tracks, jobs) {
  const states = statesById(jobs);
  return Object.keys(tracks).filter((trackId) => {
    const band = libraryArtist(tracks[trackId]?.artist);
    const state = states.get(trackId);
    return band && !state?.user_band && state?.artist?.id === band.id;
  });
}

/**
 * The name a held band is judged against: the user's artist, else the file's tag.
 * The library's tag comes first because it is kept once read, so a state can only
 * change this name by renaming the artist.
 */
export function bandTagName(track, state) {
  const userArtist = state ? state.user_artist : track.userArtist;
  return taggedArtistName(userArtist || track.audioTags?.artist || state?.audio_tags?.artist);
}

function heldEntry(track, band, state) {
  return { band, tagName: bandTagName(track, state) };
}

/**
 * What a held band's entry does when a full job state arrives. No band on the server
 * is not a differing one: sending then would save every guess at the next boot. A
 * `refused` entry, one whose save failed this run, is kept unsent until the next run.
 */
export function heldBandAction(entry, track, state, refused = false) {
  if (state.user_band) return HELD_DROP;
  if (bandTagName(track, state) !== entry.tagName) return HELD_DROP;
  const server = libraryArtist(state.artist);
  return server && server.id !== entry.band.id && !refused ? HELD_SEND : HELD_KEEP;
}

/**
 * Save a held band. Answers the job state, or null when there is none to take: a 404
 * or 422 drops the entry, any other failure keeps it and passes it to `refuse`.
 */
export async function sendHeldBand(trackId, entry, { send, drop, refuse }) {
  try {
    const state = await send(trackId, entry.band);
    drop(trackId);
    return state;
  } catch (err) {
    if (err?.status === HTTP_NOT_FOUND || err?.status === HTTP_UNPROCESSABLE) {
      drop(trackId);
      return null;
    }
    console.warn("[catalog] a held band is left for the next run:", trackId, err);
    refuse(trackId);
    return null;
  }
}

async function settleTrackBand(tracks, trackId, state, { lookup, send, hold }) {
  const track = tracks[trackId];
  const band = libraryArtist(track?.artist);
  if (!band) return;
  const entry = heldEntry(track, band, state);
  const guessed = await isGuessedBand(track, band, lookup);
  // The lookup can take seconds, and a band chosen meanwhile has been saved already.
  if (libraryArtist(tracks[trackId]?.artist)?.id !== band.id) return;
  if (guessed) hold(trackId, entry);
  else await send(trackId, band);
}

/**
 * Check and send each owed band, one at a time; true once every track is settled.
 * A band left unsent goes to `hold`, since this browser cannot tell it from a guess.
 * A throw from `lookup` or `send` leaves that track for the next boot, not the rest.
 */
export async function uploadBands(tracks, jobs, deps) {
  const states = statesById(jobs);
  for (const trackId of foundBandIds(tracks, jobs)) {
    deps.hold(trackId, heldEntry(tracks[trackId], libraryArtist(tracks[trackId].artist), states.get(trackId)));
  }
  let finished = true;
  for (const trackId of bandUploadIds(tracks, jobs)) {
    try {
      await settleTrackBand(tracks, trackId, states.get(trackId), deps);
    } catch (err) {
      finished = false;
      console.warn("[catalog] a band upload is left for the next boot:", trackId, err);
    }
  }
  return finished;
}
