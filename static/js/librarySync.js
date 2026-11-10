// Trash and re-import decisions on server job state, kept free of IO so node can test them.

import { isReimportableSource } from "./utils.js";

export const CANCELLED_STATUS = "cancelled";
export const RELEASE_REPLACED = "release";
export const REINSTATE_REPLACED = "reinstate";

const DONE = "done";
const REINSTATE_STATUSES = new Set([CANCELLED_STATUS, "error", "unavailable"]);

export const isServerTrashed = (state) => state.trashed_at != null;

/**
 * Local Trash entries the server lists as not trashed, to push up once. Never a
 * restore, so a fresh install cannot bring back what another device threw away.
 */
export function migrationTrashIds(jobs, trashIds) {
  return jobs
    .filter((state) => trashIds.has(state.job_id) && !isServerTrashed(state))
    .map((state) => state.job_id);
}

/**
 * How the server's Trash moves the tracks this side knows. `skipIds` are
 * changes made here that the server may not have seen yet.
 */
export function serverTrashMoves(jobs, { knownIds, trashIds, skipIds }) {
  const toTrash = [];
  const toRestore = [];
  for (const state of jobs) {
    const id = state.job_id;
    if (!knownIds.has(id) || skipIds.has(id)) continue;
    const local = trashIds.has(id);
    if (isServerTrashed(state) && !local) toTrash.push(id);
    else if (!isServerTrashed(state) && local) toRestore.push(id);
  }
  return { toTrash, toRestore };
}

/**
 * What a re-import settling as `status` does with the track it replaced, or null
 * while it runs. Done releases it to the server; no playable copy brings it back.
 */
export function replacementOutcome(status) {
  if (status === DONE) return RELEASE_REPLACED;
  return REINSTATE_STATUSES.has(status) ? REINSTATE_REPLACED : null;
}

const YOUTUBE_ID = /(?:youtu\.be\/|[?&]v=)([a-zA-Z0-9_-]{11})/;

/** A source as typed, or a YouTube link reduced to its video id, so its variants match. */
export function normalizeSource(value) {
  const source = String(value || "").trim();
  const youtube = source.match(YOUTUBE_ID);
  return youtube ? `yt:${youtube[1]}` : source;
}

/**
 * The one track outside the Trash with the source of `url`, which an import of it
 * replaces; null when none or several have it, and for uploads.
 */
export function soleSourceMatch(tracks, trashIds, url) {
  const source = normalizeSource(url);
  if (!isReimportableSource(source)) return null;
  const matches = Object.entries(tracks)
    .filter(([id, track]) => !trashIds.has(id) && normalizeSource(track.sourceUrl) === source)
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The jobs an unsettled re-import stands in for, here or on the server, which a
 * sync must not adopt: the server retires one only after listing its replacement.
 */
export function replacedJobIds(tracks, jobs) {
  const local = Object.values(tracks).map((track) => track.replaced?.id);
  const listed = jobs.map((state) => state.replaces);
  return new Set([...local, ...listed].filter(Boolean));
}
