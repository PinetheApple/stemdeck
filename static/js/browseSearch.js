// Browse library's search box and tag chips, the open song's tags first. Typing # suggests
// the library's tags; a chip or a suggestion puts its #tag in the box, a second click clears it.

import {
  TRACK_OPEN_EVENT, TRACK_SHOW_EVENT, getCurrentTrackInfo, getLibraryTrack, isInTrash, libraryTrackIds, librarySearchFields,
} from "./catalog.js";
import { TAG_PREFIX, chipTags, tagCounts, toggleTagQuery } from "./librarySearch.js";
import { browseState, setBrowseQuery } from "./browseLibrary.js";
import { $ } from "./utils.js";

const CHIP_LIMIT = 8;
const SUGGEST_LIMIT = 8;
const SUGGEST_ITEM = "tag-suggest-item";
const FOCUSED_CLASS = "focused";
// Long enough for a click on a suggestion to land before the list goes.
const BLUR_HIDE_MS = 150;
const STEP = Object.freeze({ ArrowDown: 1, ArrowUp: -1 });

const librarySongs = () => libraryTrackIds().map(librarySearchFields);

function openSongTags() {
  const id = getCurrentTrackInfo()?.id;
  if (!id || isInTrash(id)) return [];
  return getLibraryTrack(id)?.tags ?? [];
}

export function drawTagChips() {
  const row = $("browseTags");
  if (!row) return;
  const query = browseState().query.trim().toLowerCase();
  row.replaceChildren(...chipTags(openSongTags(), librarySongs(), CHIP_LIMIT).map((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "browse-tag";
    chip.dataset.tag = tag;
    chip.textContent = `${TAG_PREFIX}${tag}`;
    chip.setAttribute("aria-pressed", String(query === `${TAG_PREFIX}${tag}`.toLowerCase()));
    return chip;
  }));
}

function onTagChipClick(e) {
  const chip = e.target.closest(".browse-tag");
  if (chip) setBrowseQuery(toggleTagQuery(browseState().query, chip.dataset.tag));
}

function hideSuggestions() {
  $("tagSuggest")?.replaceChildren();
}

function onSuggestionPick(e) {
  e.preventDefault();
  setBrowseQuery(e.currentTarget.textContent);
  hideSuggestions();
}

function suggestionEl(tag) {
  const item = document.createElement("li");
  item.className = SUGGEST_ITEM;
  item.setAttribute("role", "option");
  item.textContent = `${TAG_PREFIX}${tag}`;
  item.addEventListener("mousedown", onSuggestionPick);
  return item;
}

function showSuggestions(prefix) {
  const matches = tagCounts(librarySongs()).filter(([tag]) => tag.toLowerCase().includes(prefix));
  $("tagSuggest")?.replaceChildren(...matches.slice(0, SUGGEST_LIMIT).map(([tag]) => suggestionEl(tag)));
}

function onSearchInput(e) {
  const value = e.currentTarget.value;
  setBrowseQuery(value);
  if (value.startsWith(TAG_PREFIX) && value.length > TAG_PREFIX.length) showSuggestions(value.slice(TAG_PREFIX.length).toLowerCase());
  else hideSuggestions();
}

function moveSuggestionFocus(items, step) {
  const active = items.find((item) => item.classList.contains(FOCUSED_CLASS));
  const next = items[(items.indexOf(active) + step + items.length) % items.length] ?? items[0];
  active?.classList.remove(FOCUSED_CLASS);
  next.classList.add(FOCUSED_CLASS);
}

// Esc takes back one thing at a time: the suggestions, then the text, then Browse library itself.
function onSearchEscape(e, items) {
  if (!items.length && !e.currentTarget.value) return;
  e.stopPropagation();
  if (items.length) hideSuggestions();
  else setBrowseQuery("");
}

function onSearchKeydown(e) {
  const items = [...($("tagSuggest")?.children ?? [])];
  if (e.key === "Escape") {
    onSearchEscape(e, items);
    return;
  }
  if (!items.length) return;
  if (STEP[e.key]) {
    e.preventDefault();
    moveSuggestionFocus(items, STEP[e.key]);
  } else if (e.key === "Enter") {
    const active = items.find((item) => item.classList.contains(FOCUSED_CLASS));
    if (!active) return;
    e.preventDefault();
    active.dispatchEvent(new MouseEvent("mousedown"));
  }
}

function onSearchBlur() {
  setTimeout(hideSuggestions, BLUR_HIDE_MS);
}

export function wireBrowseSearch() {
  const input = $("browseSearch");
  input?.addEventListener("input", onSearchInput);
  input?.addEventListener("keydown", onSearchKeydown);
  input?.addEventListener("blur", onSearchBlur);
  $("browseTags")?.addEventListener("click", onTagChipClick);
  document.addEventListener(TRACK_OPEN_EVENT, drawTagChips);
  document.addEventListener(TRACK_SHOW_EVENT, drawTagChips);
}
