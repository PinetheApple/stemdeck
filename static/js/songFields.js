import { libraryArtist } from "./trackBand.js";

export const KEY_MODES = Object.freeze({ MAJOR: "major", MINOR: "minor" });

// Identities checked against a catalogue. "tags" only repeats what the file
// says, which the card and the box already read from the tags themselves.
export const CONFIDENT_SOURCES = new Set(["musicbrainz", "acoustid", "lrclib"]);
const WORK_KINDS = new Set(["musical", "film", "tv", "other"]);

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
export const trimmed = (value) => String(value || "").trim();

/** The musical, film or series a soundtrack is from, as { id, kind, name, englishName }
 *  with id a Wikidata item; null for anything else. */
export function libraryWork(work) {
  const artist = libraryArtist(work);
  if (!artist || !WORK_KINDS.has(work.kind)) return null;
  return { ...artist, kind: work.kind };
}

export function confidentIdentity(track) {
  const identity = track?.identity;
  return identity && CONFIDENT_SOURCES.has(identity.source) ? identity : null;
}

// For the card only (lists use libraryTitle): the job title is often a filename or
// video name ("... Official Video"), so the identified song or the title tag comes first.
export function nowPlayingTitle(track) {
  return trimmed(track?.userTitle)
    || trimmed(confidentIdentity(track)?.title)
    || trimmed(track?.audioTags?.title)
    || track?.title
    || "";
}

export function nowPlayingArtist(track) {
  if (trimmed(track?.userArtist)) return trimmed(track.userArtist);
  let work = trimmed(libraryWork(track?.work)?.name);
  if (work.toLowerCase() === nowPlayingTitle(track).toLowerCase()) work = "";
  return trimmed(work || track?.artist?.name || track?.displayArtist);
}

const NATURAL_PITCHES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTALS = { "": 0, "#": 1, "♯": 1, b: -1, "♭": -1 };
const PITCH_CLASSES = 12;
const TONIC = /^([A-G])([#♯b♭]?)$/;
const MAJOR_WORD = /^maj/i;
const MINOR_WORD = /^min|minor/i;

function modeOf(suffix, scale) {
  if (MAJOR_WORD.test(suffix)) return KEY_MODES.MAJOR;
  if (MINOR_WORD.test(suffix)) return KEY_MODES.MINOR;
  if (MINOR_WORD.test(scale)) return KEY_MODES.MINOR;
  return MAJOR_WORD.test(scale) ? KEY_MODES.MAJOR : null;
}

export const SONG_FIELDS = Object.freeze({
  id: (song) => song.id,
  added: (song) => positive(song.createdAt),
  title: (song) => text(song.userTitle) ?? text(song.title),
  artist: (song) => text(nowPlayingArtist(song)),
  length: (song) => positive(song.duration),
  tempo: (song) => positive(song.bpm),
  key: (song) => text(song.key),
  scale: (song) => text(song.scale),
});

export function songKey(song) {
  const [tonic = "", suffix = ""] = (SONG_FIELDS.key(song) ?? "").split(/\s+/);
  const match = TONIC.exec(tonic);
  const mode = modeOf(suffix, SONG_FIELDS.scale(song) ?? "");
  if (!match || !mode) return null;
  const pitch = (NATURAL_PITCHES[match[1]] + ACCIDENTALS[match[2]] + PITCH_CLASSES) % PITCH_CLASSES;
  return { pitch, mode };
}

export function newestFirst(a, b) {
  return (SONG_FIELDS.added(b) ?? 0) - (SONG_FIELDS.added(a) ?? 0);
}
