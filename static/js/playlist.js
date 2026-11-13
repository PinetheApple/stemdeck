// playlist.js — importing a whole playlist as one queued batch.
//
// Two steps by design. Expanding a playlist is a network round trip whose
// result the user has to agree to ("this is 47 tracks, still want it?"), and
// queueing 47 jobs from a single click with no warning is not a thing to do to
// someone's machine. The track list is never sent from here: the server expands
// the URL again when creating, so nothing outside its allowlist can be
// smuggled in between the two calls.

import { addPlaylistToLibrary } from "./catalog.js";
import { importResponse, readableError, showError } from "./job.js";
import { notifyFailure } from "./notifications.js";
import { confirmDialog } from "./confirmDialog.js";
import { t, plural } from "./i18n.js";

/** Does this URL look like a playlist we should offer to expand? Deliberately
 *  permissive -- the server is the authority, this only decides which flow the
 *  submit button takes. */
export function looksLikePlaylist(url) {
  const text = String(url || "").trim();
  if (!/^https?:\/\//i.test(text)) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "soundcloud.com") return /^\/[^/]+\/sets\/[^/]+\/?$/.test(parsed.pathname);
  if (!/^(youtube\.com|youtube-nocookie\.com)$/.test(host)) return false;
  const list = parsed.searchParams.get("list");
  // RD* is algorithmic radio: endless and per-viewer, so there is no set to
  // import. Let it fall through to the single-track path instead.
  return !!list && !/^RD/i.test(list);
}

const SKIP_REASON_KEYS = {
  in_library: "playlist.reason.inLibrary",
  too_long: "playlist.reason.tooLong",
  no_capacity: "playlist.reason.noCapacity",
};

function countLine(preview) {
  const parts = [];
  if (preview.skipped_in_library) parts.push(plural("playlist.skip.inLibrary", preview.skipped_in_library));
  if (preview.skipped_unavailable) parts.push(plural("playlist.skip.unavailable", preview.skipped_unavailable));
  if (preview.skipped_too_long) parts.push(plural("playlist.skip.tooLong", preview.skipped_too_long));
  const overflow =
    preview.total_found -
    preview.skipped_unavailable -
    preview.skipped_too_long -
    (preview.skipped_in_library || 0) -
    preview.will_queue;
  if (overflow > 0) parts.push(plural("playlist.skip.overflow", overflow));
  if (preview.truncated) parts.push(t("playlist.skip.truncated", { cap: preview.cap }));
  if (!parts.length) return "";
  return t("playlist.skippingPrefix", { list: parts.join(t("playlist.listSep")) });
}

/** One line per track the import left out, saying why, plus the unavailable
 *  ones, which the playlist lists without names. */
export function skipLines(result) {
  const lines = (result.skipped || []).map((item) =>
    t("import.itemReason", { name: item.title || item.source_url, reason: t(SKIP_REASON_KEYS[item.reason]) }),
  );
  if (result.skipped_unavailable) lines.push(plural("playlist.skip.unavailable", result.skipped_unavailable));
  return lines;
}

function reportSkipped(result) {
  const lines = skipLines(result);
  if (!lines.length) return;
  const heading = t("playlist.notAdded", { name: result.playlist_title });
  notifyFailure({ kind: "import", message: `${heading} ${lines.join(t("playlist.listSep"))}` });
}

function confirmImport(preview) {
  const skipped = countLine(preview);
  return confirmDialog({
    title: t("playlist.confirmTitle"),
    name: preview.playlist_title,
    body: plural("playlist.confirmBody", preview.will_queue, { skipped: skipped ? ` ${skipped}` : "" }),
    confirmLabel: plural("playlist.import", preview.will_queue),
    ariaLabel: t("playlist.importAriaLabel"),
    className: "playlist-confirm",
    titleClass: "playlist-confirm-title",
    nameClass: "playlist-name",
    confirmClass: "playlist-confirm-go",
  });
}

async function postPlaylist(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return importResponse(res);
}

function nothingToQueueMessage(preview) {
  if (preview.capacity_left === 0) return t("playlist.queueFull");
  return t(preview.skipped_in_library ? "playlist.allInLibrary" : "playlist.nothingImportable");
}

/** Expand, confirm, queue, and file the results under a folder named after the
 *  playlist. Returns the number of tracks queued (0 if cancelled or refused). */
export async function importPlaylist(url, stems) {
  let preview;
  try {
    preview = await postPlaylist("/api/playlist/preview", { url });
  } catch (err) {
    showError(t("playlist.couldNotRead", { message: readableError(err) }));
    return 0;
  }

  if (!preview.will_queue) {
    showError(nothingToQueueMessage(preview), countLine(preview) || null, { onRetry: null });
    return 0;
  }

  if (!(await confirmImport(preview))) return 0;

  let result;
  try {
    result = await postPlaylist("/api/playlist", { url, stems });
  } catch (err) {
    showError(t("playlist.couldNotImport", { message: readableError(err) }));
    return 0;
  }

  if (result.jobs?.length) addPlaylistToLibrary(result.playlist_title, result.jobs);
  reportSkipped(result);
  return result.queued || 0;
}
