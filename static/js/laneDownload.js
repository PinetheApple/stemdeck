// Each stem lane's download: the header's Stem link and the ⋯ menu's entry are both
// a.lane-dl, which main.js saves on click and drags out of the desktop app.

export const DOWNLOAD_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/>'
  + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

const NO_TARGET = "#";
const LINK_CLASS = "lane-dl";
const LINK_SELECTOR = `a.${LINK_CLASS}[data-stem]`;
const targets = new Map();

function applyTarget(link) {
  const target = targets.get(link.dataset.stem);
  link.href = target?.url ?? NO_TARGET;
  if (target) link.download = target.filename;
  else link.removeAttribute("download");
}

/** Point every lane's download at `downloads` ({name, url, filename}); an empty list clears them. */
export function setStemDownloads(downloads) {
  targets.clear();
  for (const { name, url, filename } of downloads) targets.set(name, { url, filename });
  for (const link of document.querySelectorAll(LINK_SELECTOR)) applyTarget(link);
}

export function hasStemDownload(stemName) {
  return targets.has(stemName);
}

/** A download link for `stemName`, kept pointing at its file. */
export function stemDownloadLink(stemName) {
  const link = document.createElement("a");
  link.className = LINK_CLASS;
  link.dataset.stem = stemName;
  applyTarget(link);
  return link;
}
