// Names for library folders and setlists: what a folder name may hold, and a
// free name when one is taken.

// Folder names accept letters (any language), digits, spaces, and a small safe
// punctuation set — markup/symbols are rejected so names like the XSS probe or
// "±!@£$%^&*" can't be created (#170 follow-up).
export const FOLDER_NAME_RE = /^[\p{L}\p{M}\p{N} '’&().,_-]+$/u;
export const MAX_FOLDER_NAME_LEN = 100;
export const isValidFolderName = (s) => FOLDER_NAME_RE.test(s);

const RUN_OF_SPACES = /\s+/g;
const FIRST_COPY_NUMBER = 2;

/** `text` cut to `maxChars`, never splitting a character in two. */
function clip(text, maxChars) {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > maxChars) break;
    out += ch;
  }
  return out;
}

/** `base`, or "base (2)", "(3)"…, whichever is not taken, trimmed to `maxChars`. */
export function uniqueName(base, takenNames, maxChars) {
  const taken = new Set(takenNames);
  const whole = clip(base, maxChars).trim();
  if (!taken.has(whole)) return whole;
  for (let n = FIRST_COPY_NUMBER; ; n += 1) {
    const suffix = ` (${n})`;
    const name = `${clip(base, maxChars - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/** `name` without the characters a folder name can't hold, or `fallback` when none are left. */
export function folderNameFrom(name, fallback) {
  const kept = [...name].filter(isValidFolderName).join("");
  return kept.replace(RUN_OF_SPACES, " ").trim() || fallback;
}
