// The Browse library list's cells after Title and Artist: Key, Tempo, Length,
// Folder and Added. A song still importing shows none of them.

const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86400;
const YESTERDAY_DAYS = 1;
export const DATED_AFTER_DAYS = 30;
const FINISHED_STATUS = "done";
const BLANK_CELLS = Object.freeze({ key: "", tempo: "", length: "", folder: "", added: "" });

/**
 * When a song was added (`createdAt` in seconds), as `words` say it:
 * { today, yesterday, daysAgo(n), dated(ms) }.
 */
export function addedLabel(createdAt, nowMs, words) {
  if (!Number.isFinite(createdAt)) return "";
  const days = Math.floor((nowMs / MS_PER_SECOND - createdAt) / SECONDS_PER_DAY);
  if (days < YESTERDAY_DAYS) return words.today;
  if (days === YESTERDAY_DAYS) return words.yesterday;
  if (days < DATED_AFTER_DAYS) return words.daysAgo(days);
  return words.dated(createdAt * MS_PER_SECOND);
}

/**
 * A song's cells. `format`: { now, words, folderName, keyLabel(key, scale), time(seconds) }.
 */
export function songCells(track, { now, words, folderName, keyLabel, time }) {
  if (track?.status !== FINISHED_STATUS) return { ...BLANK_CELLS };
  return {
    key: track.key ? keyLabel(track.key, track.scale) : "",
    tempo: Number.isFinite(track.bpm) ? String(Math.round(track.bpm)) : "",
    length: track.duration ? time(track.duration) : "",
    folder: folderName ?? "",
    added: addedLabel(track.createdAt, now, words),
  };
}
