import { plural } from "./i18n.js";
import { ADD_SONG_ID } from "./composerDrawer.js";

const BADGE_ID = "addSongReviewBadge";
const BADGE_CLASS = "add-song-badge";
const REVIEW_KEY = "batch.review";

let badge = null;

/** The count of a batch waiting behind a closed review, on Add song's corner; `onOpen` reopens the review. */
export function mountReviewBadge(onOpen) {
  const anchor = document.getElementById(ADD_SONG_ID);
  if (!anchor || badge) return;
  badge = document.createElement("button");
  badge.type = "button";
  badge.id = BADGE_ID;
  badge.className = BADGE_CLASS;
  badge.hidden = true;
  badge.addEventListener("click", onOpen);
  anchor.after(badge);
}

/** Show `count` on the badge, or hide it at 0. */
export function paintReviewBadge(count) {
  if (!badge) return;
  badge.hidden = count === 0;
  if (!count) return;
  const label = plural(REVIEW_KEY, count);
  badge.textContent = String(count);
  badge.title = label;
  badge.setAttribute("aria-label", label);
}
