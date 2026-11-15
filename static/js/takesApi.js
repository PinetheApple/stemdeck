// The takes and tracks routes (docs/takes.md), one function each.

import { fetchJson } from "./libraryControls.js";

const jobUrl = (jobId) => `/api/jobs/${encodeURIComponent(jobId)}`;
const takeUrl = (jobId, takeId) => `${jobUrl(jobId)}/takes/${encodeURIComponent(takeId)}`;
const trackUrl = (jobId, trackId) => `${jobUrl(jobId)}/tracks/${encodeURIComponent(trackId)}`;

export const listTakes = (jobId) => fetchJson(`${jobUrl(jobId)}/takes`);

export const createTrack = (jobId, body) => fetchJson(`${jobUrl(jobId)}/tracks`, { method: "POST", body });

export const patchTrack = (jobId, trackId, body) =>
  fetchJson(trackUrl(jobId, trackId), { method: "PATCH", body });

export const deleteTrack = (jobId, trackId) => fetchJson(trackUrl(jobId, trackId), { method: "DELETE" });

export const createTake = (jobId, body) => fetchJson(`${jobUrl(jobId)}/takes`, { method: "POST", body });

export const finishTake = (jobId, takeId, body = {}) =>
  fetchJson(`${takeUrl(jobId, takeId)}/finish`, { method: "POST", body });

export const deleteTake = (jobId, takeId) => fetchJson(takeUrl(jobId, takeId), { method: "DELETE" });

export const readParts = (jobId, takeId) =>
  fetchJson(`${takeUrl(jobId, takeId)}/parts`).then((state) => ({
    next_seq: state.audio.next_seq,
    finished: state.finished,
  }));

/** Resolves with the answer's status; a network failure rejects. */
export function sendPart(jobId, takeId, seq, bytes) {
  return fetch(`${takeUrl(jobId, takeId)}/parts?seq=${seq}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  }).then((res) => ({ status: res.status }));
}

export function fetchTakePeaks(peaksUrl, takeId) {
  return fetch(peaksUrl)
    .then((res) => (res.ok ? res.json() : {}))
    .then((peaks) => peaks?.[takeId] ?? [])
    .catch((err) => {
      console.warn("[takes] peaks could not load:", err);
      return [];
    });
}
