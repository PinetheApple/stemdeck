// Where a library song came from, why its import failed, and what Retry does
// next, as the library and the Details tab say them. No DOM: tests import it.

export const SOURCE_KIND = Object.freeze({ LINK: "link", FILE: "file" });

export const RETRY_OUTCOME = Object.freeze({
  QUEUED: "queued",
  REIMPORT_LINK: "reimport-link",
  FILE_GONE: "file-gone",
  REFRESH: "refresh",
  QUEUE_FULL: "queue-full",
  FAILED: "failed",
});

const HTTP = Object.freeze({ OK: 200, NOT_FOUND: 404, CONFLICT: 409, GONE: 410, UNAVAILABLE: 503 });
const LOCAL_PREFIX = "local:";
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

/**
 * What a song's Source line shows: `text` on screen, `full` to copy and as the
 * tooltip, `href` to open (web links only). Null when it has no source.
 */
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
export function retryOutcome(status, kind) {
  if (status === HTTP.OK) return RETRY_OUTCOME.QUEUED;
  if (status === HTTP.NOT_FOUND) {
    return kind === SOURCE_KIND.LINK ? RETRY_OUTCOME.REIMPORT_LINK : RETRY_OUTCOME.FILE_GONE;
  }
  if (status === HTTP.GONE) return RETRY_OUTCOME.FILE_GONE;
  if (status === HTTP.CONFLICT) return RETRY_OUTCOME.REFRESH;
  if (status === HTTP.UNAVAILABLE) return RETRY_OUTCOME.QUEUE_FULL;
  return RETRY_OUTCOME.FAILED;
}

// Lucide (ISC), drawn like libraryIcons.js's icon().
const ICON_PATHS = Object.freeze({
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="10" cy="16" r="2"/><path d="M12 16v-5l3 1"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
});

export function sourceIcon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}
