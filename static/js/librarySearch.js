// What the Browse library search box matches: a song's title, artist, source,
// stems and tags; a query starting with # matches tags only.

export const TAG_PREFIX = "#";

const normalize = (value) => String(value ?? "").trim().toLowerCase();
const includes = (value, needle) => normalize(value).includes(needle);

/** Whether `song` ({ title, artist, source, stems, tags }) matches the typed `query`. */
export function songMatches(song, query) {
  const needle = normalize(query);
  if (!needle) return true;
  const tags = song?.tags ?? [];
  if (needle.startsWith(TAG_PREFIX)) {
    const tag = needle.slice(TAG_PREFIX.length);
    return !tag || tags.some((value) => includes(value, tag));
  }
  const fields = [song?.title, song?.artist, song?.source, ...(song?.stems ?? []), ...tags];
  return fields.some((value) => includes(value, needle));
}

/** The library's tags, each once, in the order the songs carry them, at most `limit`. */
export function libraryTags(songs, limit) {
  const tags = new Set(songs.flatMap((song) => song.tags ?? []));
  return [...tags].slice(0, limit);
}

/** Each tag with how many songs carry it, most used first. */
export function tagCounts(songs) {
  const counts = new Map();
  for (const tag of songs.flatMap((song) => song.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort(([, a], [, b]) => b - a);
}

/** The query a tag chip leaves: its #tag, or nothing when that tag was the query. */
export function toggleTagQuery(query, tag) {
  const tagQuery = `${TAG_PREFIX}${tag}`;
  return normalize(query) === normalize(tagQuery) ? "" : tagQuery;
}
