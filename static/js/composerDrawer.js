// The import bar, folded under the top bar; Add song opens and closes it.

const DRAWER_ID = "composerDrawer";
const ADD_SONG_ID = "addSongBtn";
const URL_FIELD_ID = "url";

const drawer = () => document.getElementById(DRAWER_ID);

export function isComposerOpen() {
  return drawer()?.hidden === false;
}

export function setComposerOpen(open) {
  const el = drawer();
  if (!el) return;
  el.hidden = !open;
  document.getElementById(ADD_SONG_ID)?.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById(URL_FIELD_ID)?.focus();
}

/** Open the bar so its field can take focus; callers that focus #url go through here. */
export function openComposer() {
  if (!isComposerOpen()) setComposerOpen(true);
}

function onAddSongClick() {
  setComposerOpen(!isComposerOpen());
}

export function wireComposerDrawer() {
  document.getElementById(ADD_SONG_ID)?.addEventListener("click", onAddSongClick);
}
