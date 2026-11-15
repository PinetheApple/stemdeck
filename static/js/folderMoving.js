import { HTTP_CONFLICT } from "./lyricsTranscribe.js";

// STEMS_FOLDER_MOVING, _SPLIT and _EDIT in app/api/jobs.py.
export const FOLDER_MOVING_DETAIL =
  "Restart StemDeck to finish moving your stems folder, then make the lyrics.";
export const SPLIT_FOLDER_MOVING_DETAIL =
  "Restart StemDeck to finish moving your stems folder, then split the vocals.";
export const EDIT_FOLDER_MOVING_DETAIL =
  "Restart StemDeck to finish moving your stems folder, then try again.";
export const FOLDER_MOVING_KEY = "folderMoving.retry";
const MOVING_DETAILS = new Set([FOLDER_MOVING_DETAIL, SPLIT_FOLDER_MOVING_DETAIL, EDIT_FOLDER_MOVING_DETAIL]);

/** Whether an answer's status and parsed body are a refusal for the move. */
export function isFolderMoving(status, data) {
  return status === HTTP_CONFLICT && MOVING_DETAILS.has(data?.detail);
}

/** Whether `res` is that refusal; reads a copy, so the body stays unread. */
export async function refusedForFolderMove(res) {
  if (res?.status !== HTTP_CONFLICT) return false;
  const data = await res.clone().json().catch(() => null);
  return isFolderMoving(res.status, data);
}

/** Whether a thrown HttpError-like `err` ({ status, detail }) is that refusal. */
export function isFolderMovingError(err) {
  return isFolderMoving(err?.status, { detail: err?.detail });
}

/** The notice for a failure: the move's when it was refused for the move, else `fallbackKey`. */
export function noticeKey(movingRefusal, fallbackKey) {
  return movingRefusal ? FOLDER_MOVING_KEY : fallbackKey;
}

/** The notice for a failed save answered `answer` ({ status, data } or null). */
export function refusalKey(answer, fallbackKey) {
  return noticeKey(isFolderMoving(answer?.status, answer?.data), fallbackKey);
}
