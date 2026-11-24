// My order: a song dropped onto another goes before it, with the other picks when it is picked.

import { t } from "./i18n.js";
import { getLibraryTrack, libraryTrackIds } from "./catalog.js";
import { wireDropTarget } from "./songDrag.js";
import { myOrderAfterMove } from "./myOrder.js";
import { movedIdsFor } from "./libraryArrange.js";
import { libraryView, saveNewMyOrder, selection } from "./libraryView.js";
import { notifyFailure } from "./notifications.js";

const FAILURE_KIND = "library";

async function moveBeforeSong(draggedId, beforeId) {
  const moved = movedIdsFor(draggedId, selection.ids());
  if (moved.includes(beforeId)) return;
  const songs = libraryTrackIds().map(getLibraryTrack);
  const order = myOrderAfterMove(songs, libraryView().myOrderIds, moved, beforeId);
  if (!(await saveNewMyOrder(order))) notifyFailure({ kind: FAILURE_KIND, message: t("libSort.myOrderSaveFailed") });
}

export function wireMyOrderDrop(el) {
  wireDropTarget(el, function onMyOrderDrop(draggedId) {
    moveBeforeSong(draggedId, el.dataset.id);
  });
}
