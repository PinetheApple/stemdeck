// Clear Up Next, with an Undo that puts the list back in its order.

import { clearUpNext, insertUpNext } from "./upNext.js";
import { showUndo } from "./undoToast.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

function onClearUpNextClick() {
  const removed = clearUpNext();
  if (!removed.length) return;
  showUndo(t("lib.upNextCleared"), function onUndoClearUpNext() {
    removed.forEach((trackId, at) => insertUpNext(trackId, at));
  });
}

export function initUpNextUndo() {
  $("upNextClear")?.addEventListener("click", onClearUpNextClick);
}
