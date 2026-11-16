// Names for library folders and setlists: what a folder name may hold, and a
// free name when one is taken.

// Letters, digits, spaces and safe punctuation only, so no markup or symbol soup.
const FOLDER_NAME_RE = /^[\p{L}\p{M}\p{N} '’&().,_-]+$/u;
export const MAX_FOLDER_NAME_LEN = 100;
export const isValidFolderName = (s) => FOLDER_NAME_RE.test(s);

const RUN_OF_SPACES = /\s+/g;
const FIRST_COPY_NUMBER = 2;

/** What follows a taken name: " (2)", " (3)"… */
export const copySuffix = (n) => ` (${n})`;

const sameName = (name) => name.toLowerCase();

/** `text` cut to `maxChars`, never splitting a character in two. */
function clip(text, maxChars) {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > maxChars) break;
    out += ch;
  }
  return out;
}

/** `base`, or "base (2)", "(3)"…, whichever is not taken in any letter case, trimmed to `maxChars`. */
export function uniqueName(base, takenNames, maxChars) {
  const taken = new Set(takenNames.map(sameName));
  const whole = clip(base, maxChars).trim();
  if (!taken.has(sameName(whole))) return whole;
  for (let n = FIRST_COPY_NUMBER; ; n += 1) {
    const suffix = copySuffix(n);
    const name = `${clip(base, maxChars - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(sameName(name))) return name;
  }
}

/** `name` without the characters a folder name can't hold, or `fallback` when none are left. */
export function folderNameFrom(name, fallback) {
  const kept = [...name].filter(isValidFolderName).join("");
  return kept.replace(RUN_OF_SPACES, " ").trim() || fallback;
}
