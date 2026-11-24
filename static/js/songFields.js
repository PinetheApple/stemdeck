const CONFIDENT_IDENTITY_SOURCES = new Set(["musicbrainz", "acoustid", "lrclib"]);

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function cardTitle(song) {
  const identity = CONFIDENT_IDENTITY_SOURCES.has(song.identity?.source) ? song.identity : null;
  return text(song.userTitle) ?? text(identity?.title) ?? text(song.audioTags?.title) ?? text(song.title) ?? "";
}

// Same priority as catalog.js nowPlayingArtist, which cannot load outside the browser,
// so the artist sort follows the names the library shows.
function shownArtist(song) {
  const work = text(song.work?.name);
  const showsWork = work !== null && work.toLowerCase() !== cardTitle(song).toLowerCase();
  return text(song.userArtist) ?? (showsWork ? work : null) ?? text(song.artist?.name) ?? text(song.displayArtist);
}

export const SONG_FIELDS = Object.freeze({
  id: (song) => song.id,
  added: (song) => positive(song.createdAt),
  title: (song) => text(song.userTitle) ?? text(song.title),
  artist: shownArtist,
  length: (song) => positive(song.duration),
  tempo: (song) => positive(song.bpm),
  key: (song) => text(song.key),
  scale: (song) => text(song.scale),
});

export function newestFirst(a, b) {
  return (SONG_FIELDS.added(b) ?? 0) - (SONG_FIELDS.added(a) ?? 0);
}
