// Where a song was imported from, and why its import failed. No DOM: tests import it.

import { HTTP_NOT_FOUND } from "./libraryControls.js";
import { HTTP_CONFLICT } from "./lyricsTranscribe.js";

export const FAILED_STATUS = "error";
export const LOCAL_PREFIX = "local:";
const HTTP_QUEUE_FULL = 503;
const HTTP_GONE = 410;
const RESTORE_FIRST_DETAIL = "restore it from the Trash first";
const STEMS_FOLDER_MOVING_DETAIL = "Restart StemDeck to finish moving your stems folder before importing";

export const SOURCE_KIND = Object.freeze({ LINK: "link", FILE: "file" });

export const RETRY_OUTCOME = Object.freeze({
  QUEUED: "queued",
  REIMPORT_LINK: "reimport-link",
  FILE_GONE: "file-gone",
  REFRESH: "refresh",
  RESTORE_FIRST: "restore-first",
  QUEUE_FULL: "queue-full",
  FAILED: "failed",
});

const WEB_SCHEME = /^https?:\/\//i;
const LEADING_WWW = /^www\./i;

const UNKNOWN_REASON_KEY = "importFail.reason.unknown";
export const FILE_GONE_REASON_KEY = "importFail.reason.fileGone";
const REASON_KEYS = Object.freeze({
  "out-of-memory": "importFail.reason.outOfMemory",
  "unsupported-device": "importFail.reason.unsupportedDevice",
  "disk-full": "importFail.reason.diskFull",
  "source-blocked": "importFail.reason.sourceBlocked",
  "source-unavailable": "importFail.reason.sourceUnavailable",
  "bad-input": "importFail.reason.badInput",
  interrupted: "importFail.reason.interrupted",
  unknown: UNKNOWN_REASON_KEY,
});

/** The i18n key for a failed import's reason. No code, or one this side does not know, is unknown. */
export function failureReasonKey(errorCode) {
  return Object.hasOwn(REASON_KEYS, errorCode ?? "") ? REASON_KEYS[errorCode] : UNKNOWN_REASON_KEY;
}

/** Link or file. Tracks saved before the server said so are read from their source. */
export function sourceKindOf({ sourceKind, sourceUrl } = {}) {
  if (Object.values(SOURCE_KIND).includes(sourceKind)) return sourceKind;
  return String(sourceUrl ?? "").startsWith(LOCAL_PREFIX) ? SOURCE_KIND.FILE : SOURCE_KIND.LINK;
}

function fileSource(track) {
  const url = String(track.sourceUrl ?? "");
  const name = track.sourceName || (url.startsWith(LOCAL_PREFIX) ? url.slice(LOCAL_PREFIX.length) : url);
  return name ? { kind: SOURCE_KIND.FILE, text: name, full: name, href: null } : null;
}

/** The Source line: `text` shown, `full` copied, `href` opened (web links only); null with none. */
export function importSource(track) {
  if (!track?.sourceUrl && !track?.sourceName) return null;
  if (sourceKindOf(track) === SOURCE_KIND.FILE) return fileSource(track);
  const url = String(track.sourceUrl);
  const isWeb = WEB_SCHEME.test(url);
  return {
    kind: SOURCE_KIND.LINK,
    text: url.replace(WEB_SCHEME, "").replace(LEADING_WWW, ""),
    full: url,
    href: isWeb ? url : null,
  };
}

/** A failed upload whose file the server no longer keeps: only picking it again helps. */
export function needsFilePickedAgain(track) {
  return track?.retryable === false && sourceKindOf(track ?? {}) === SOURCE_KIND.FILE;
}

/** What the answer to POST /api/jobs/{id}/retry means for a song of this kind. */
export function retryOutcome({ ok, status, detail }, kind) {
  if (ok) return RETRY_OUTCOME.QUEUED;
  if (status === HTTP_NOT_FOUND) {
    return kind === SOURCE_KIND.LINK ? RETRY_OUTCOME.REIMPORT_LINK : RETRY_OUTCOME.FILE_GONE;
  }
  if (status === HTTP_GONE) return RETRY_OUTCOME.FILE_GONE;
  if (status === HTTP_CONFLICT && detail === RESTORE_FIRST_DETAIL) return RETRY_OUTCOME.RESTORE_FIRST;
  if (status === HTTP_CONFLICT && detail !== STEMS_FOLDER_MOVING_DETAIL) return RETRY_OUTCOME.REFRESH;
  if (status === HTTP_QUEUE_FULL) return RETRY_OUTCOME.QUEUE_FULL;
  return RETRY_OUTCOME.FAILED;
}

/** The i18n key, and the server's reason for job.startFailed, for a retry or replacement import that did not start. */
export function retryErrorText(status, detail) {
  if (status === HTTP_QUEUE_FULL) return { key: "playlist.queueFull" };
  if (status === HTTP_CONFLICT && detail !== STEMS_FOLDER_MOVING_DETAIL) return { key: "job.reimportBusy" };
  return { key: "job.startFailed", message: detail };
}
