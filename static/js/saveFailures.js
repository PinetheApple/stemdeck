// How a section, beat-grid or tempo save that failed is told apart and reported.
import { t } from "./i18n.js";
import { notifyFailure, dismissFailuresByJobId } from "./notifications.js";
import { CONNECTION_RESTORED_EVENT } from "./connection.js";

export const SAVE_KIND = { sections: "sections", beatgrid: "beatgrid", tempo: "tempo" };
export const SAVE_REFUSED = "refused";
export const SAVE_LOST = "lost";
export const RESET_FAILED = "reset";

const MESSAGE_KEYS = {
  [SAVE_KIND.sections]: { [SAVE_REFUSED]: "notif.sectionsSaveFailed", [SAVE_LOST]: "notif.sectionsSavePending" },
  [SAVE_KIND.beatgrid]: {
    [SAVE_REFUSED]: "notif.beatGridSaveFailed",
    [SAVE_LOST]: "notif.beatGridSavePending",
    [RESET_FAILED]: "notif.beatGridResetFailed",
  },
  [SAVE_KIND.tempo]: { [SAVE_REFUSED]: "notif.tempoSaveFailed", [SAVE_LOST]: "notif.tempoSavePending" },
};

/** The server answered a save with an error status. */
export class SaveRefusedError extends Error {
  constructor(status) {
    super(`save refused: ${status}`);
    this.status = status;
  }
}

/** A save that never got an answer: fetch rejects those with a TypeError. */
export const wasLost = (error) => error instanceof TypeError;

/** One card per song and kind: a later failure of the same save replaces it. */
export function notifySaveFailure(kind, how, jobId) {
  notifyFailure({
    kind,
    message: t(MESSAGE_KEYS[kind][how]),
    context: { jobId },
  });
}

/** The song's saves of this kind reached the server, so its card is moot. */
export const clearSaveFailure = (kind, jobId) => dismissFailuresByJobId(jobId, kind);

/** Run `retry` each time the server answers again after requests went unanswered. */
export function onConnectionRestored(retry) {
  globalThis.document?.addEventListener?.(CONNECTION_RESTORED_EVENT, retry);
}
