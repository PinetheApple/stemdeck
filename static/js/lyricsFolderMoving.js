// A lyrics change the server refuses while StemData moves to another folder.

// STEMS_FOLDER_MOVING in app/api/jobs.py.
export const FOLDER_MOVING_DETAIL =
  "Restart StemDeck to finish moving your stems folder, then make the lyrics.";
export const FOLDER_MOVING_KEY = "lyrics.folderMoving";
const HTTP_CONFLICT = 409;

/** Whether an answer's status and parsed body are that refusal. */
export function isFolderMoving(status, data) {
  return status === HTTP_CONFLICT && data?.detail === FOLDER_MOVING_DETAIL;
}

/** Whether `res` is that refusal; reads a copy, so the body stays unread. */
export async function refusedForFolderMove(res) {
  if (res?.status !== HTTP_CONFLICT) return false;
  const data = await res.clone().json().catch(() => null);
  return isFolderMoving(res.status, data);
}
