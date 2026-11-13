// playlist.js — which links are playlists. A playlist opens the batch review,
// which lists its songs as a group and files them in a folder named after it.

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
