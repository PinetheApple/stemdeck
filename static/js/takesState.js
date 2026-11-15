// The recording tracks' rows and clips, worked out from the server's take
// listing; pure, so the take folder's rules can be tested under node.

export const ROW_TAKE = "take";
export const ROW_UNFINISHED = "unfinished";
export const ROW_ELSEWHERE = "elsewhere";
export const TRACK_KIND_AUDIO = "audio";
export const TRACK_KIND_VIDEO = "video";

function byOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || (a.created_at ?? 0) - (b.created_at ?? 0);
}

function takeRow(entry, track, ui) {
  return {
    kind: ROW_TAKE,
    id: entry.id,
    label: entry.label,
    durationSec: entry.duration_sec,
    active: entry.id === track.active_take_id,
    review: entry.id === ui.review,
    entry,
  };
}

// A take the server has not heard from lately was cut off; one it has is still
// being recorded somewhere else, and must not be finished or deleted from here.
function openRow(open) {
  const kind = open.recoverable ? ROW_UNFINISHED : ROW_ELSEWHERE;
  return { kind, id: open.id, label: open.label, bytes: open.bytes };
}

/**
 * @param {{tracks:object[], takes:object[], open:object[]}} listing  GET /takes
 * @param {{openFolders?:Set<string>, review?:string|null, ownTakeIds?:Set<string>}} ui
 */
export function buildTrackViews(listing, ui = {}) {
  const openFolders = ui.openFolders ?? new Set();
  const own = ui.ownTakeIds ?? new Set();
  const tracks = [...(listing?.tracks ?? [])].sort(byOrder);
  return tracks.map(function trackView(track) {
    const finished = (listing.takes ?? []).filter((take) => take.track_id === track.id);
    const open = (listing.open ?? []).filter((take) => take.track_id === track.id && !own.has(take.id));
    const rows = [
      ...finished.map((entry) => takeRow(entry, track, ui)),
      ...open.map(openRow),
    ];
    const needsAnswer = rows.some((row) => row.review || row.kind === ROW_UNFINISHED);
    return {
      id: track.id,
      name: track.name,
      kind: track.kind ?? TRACK_KIND_AUDIO,
      input: track.input ?? null,
      activeTake: finished.find((entry) => entry.id === track.active_take_id) ?? null,
      takeCount: finished.length,
      rows,
      folderOpen: rows.length > 0 && (openFolders.has(track.id) || needsAnswer),
    };
  });
}

/** Full-height lanes for the tracks; short rows for open folders and the add row. */
export function laneSpace(views, shortRowPx) {
  const shortRows = views.reduce((n, view) => n + (view.folderOpen ? view.rows.length : 0), 0);
  return { lanes: views.length, fixedPx: (shortRows + 1) * shortRowPx };
}

/** The first "<template> n" not already used, counting up from one past the existing names. */
export function nextName(existing, makeName) {
  const taken = new Set(existing);
  let n = existing.length + 1;
  while (taken.has(makeName(n))) n += 1;
  return makeName(n);
}

/** Where a take's audio is on the song, as fractions of the song's length. */
export function clipSpan(entry, songSec) {
  if (!(songSec > 0)) return null;
  const start = Math.max(0, entry.placement_sec);
  const end = Math.min(songSec, entry.placement_sec + entry.duration_sec);
  if (end <= start) return null;
  return { start: start / songSec, end: end / songSec };
}

/** The peak points that fall inside a clip span. */
export function slicePeaks(points, span) {
  if (!points?.length || !span) return [];
  const from = Math.floor(span.start * points.length);
  const to = Math.max(from + 1, Math.ceil(span.end * points.length));
  return points.slice(from, to);
}
