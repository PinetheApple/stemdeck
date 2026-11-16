import { fetchJson } from "./libraryControls.js";

const takeUrl = (jobId, takeId) => `/api/jobs/${encodeURIComponent(jobId)}/takes/${encodeURIComponent(takeId)}`;
const ENCODERS_URL = "/api/video-encoders";
const SETTINGS_URL = "/api/settings";

/** Resolves with the answer's status; a network failure or an abort through `signal` rejects. */
export function sendCameraPart(jobId, takeId, seq, bytes, signal) {
  return fetch(`${takeUrl(jobId, takeId)}/camera/parts?seq=${seq}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
    signal,
  }).then((res) => ({ status: res.status }));
}

export const readCameraParts = (jobId, takeId) =>
  fetchJson(`${takeUrl(jobId, takeId)}/parts`).then((state) => ({
    next_seq: state.camera?.next_seq ?? 0,
    finished: state.finished,
  }));

export const patchTake = (jobId, takeId, body) => fetchJson(takeUrl(jobId, takeId), { method: "PATCH", body });

export const startRender = (jobId, takeId, body) =>
  fetchJson(`${takeUrl(jobId, takeId)}/render`, { method: "POST", body });

export const readRender = (jobId, takeId) => fetchJson(`${takeUrl(jobId, takeId)}/render`);

export const cancelRender = (jobId, takeId) =>
  fetchJson(`${takeUrl(jobId, takeId)}/render/cancel`, { method: "POST" });

export const readEncoders = () => fetchJson(ENCODERS_URL);

export const testEncoders = () => fetchJson(`${ENCODERS_URL}/test`, { method: "POST" });

export const saveVideoEncoder = (value) =>
  fetchJson(SETTINGS_URL, { method: "POST", body: { video_encoder: value } });
