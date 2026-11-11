// How a section, beat-grid or tempo save that failed is told apart and reported.
import { t } from "./i18n.js";
import { notifyFailure, dismissFailuresByJobId, getFailures } from "./notifications.js";
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

/** One card per song and kind: a different failure of the same save replaces it, the same one leaves it be. */
export function notifySaveFailure(kind, how, jobId) {
  const message = t(MESSAGE_KEYS[kind][how]);
  const shown = getFailures().some((f) => f.kind === kind && f.context?.jobId === jobId && f.message === message);
  if (shown) return;
  notifyFailure({
    kind,
    message,
    context: { jobId },
  });
}

/** The song's saves of this kind reached the server, so its card is moot. */
export const clearSaveFailure = (kind, jobId) => dismissFailuresByJobId(jobId, kind);

/** Run `retry` each time the server answers again after it was unreachable. */
export function onConnectionRestored(retry) {
  globalThis.document?.addEventListener?.(CONNECTION_RESTORED_EVENT, retry);
}

/**
 * Each song's newest save still waiting for an answer, and which of them got none: what a
 * reopened song shows, what goes out on close, and what `resend` sends once the server is back.
 * `sentOf(entry)` is what a request carried, so an answer to an older save is told apart.
 */
export class UnconfirmedSaves {
  #pending = new Map();
  #lost = new Set();

  constructor({ kind, resend, sentOf = (entry) => entry }) {
    this.kind = kind;
    this.resend = resend;
    this.sentOf = sentOf;
    onConnectionRestored(this.retryLost);
  }

  get = (id) => this.#pending.get(id);
  has = (id) => this.#pending.has(id);
  set = (id, entry) => this.#pending.set(id, entry);
  keys = () => this.#pending.keys();
  isLost = (id) => this.#lost.has(id);

  clear() {
    this.#pending.clear();
    this.#lost.clear();
  }

  #isNewest = (id, sent) => this.#pending.has(id) && this.sentOf(this.#pending.get(id)) === sent;

  #forget(id) {
    this.#pending.delete(id);
    this.#lost.delete(id);
  }

  /** The server took `sent`; when it was the newest, the song's card is moot. */
  confirm(id, sent) {
    if (!this.#isNewest(id, sent)) return;
    this.#forget(id);
    clearSaveFailure(this.kind, id);
  }

  /** The server refused `sent`. True when it was the newest, so the song goes back to what is saved. */
  refuse(id, sent) {
    const newest = this.#isNewest(id, sent);
    if (newest) this.#forget(id);
    notifySaveFailure(this.kind, SAVE_REFUSED, id);
    return newest;
  }

  /** `sent` got no answer. False when a newer save is on its way: it carries this edit and reports for itself. */
  lose(id, sent) {
    if (!this.#isNewest(id, sent)) return false;
    this.#lost.add(id);
    notifySaveFailure(this.kind, SAVE_LOST, id);
    return true;
  }

  /** A newer edit replaced the song's unsaved one, so it will not save and its card says nothing true. */
  drop(id) {
    const wasLost = this.#lost.has(id);
    this.#forget(id);
    if (wasLost) clearSaveFailure(this.kind, id);
  }

  retryLost = () => {
    for (const id of [...this.#lost]) {
      this.#lost.delete(id);
      if (this.#pending.has(id)) this.resend(id, this.#pending.get(id));
    }
  };
}
