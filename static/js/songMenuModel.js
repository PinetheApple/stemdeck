// What a song's menu offers, in order, from what is true of the song now.
// Pure, so node can test it; songMenu.js draws it and runs the choices.

export const SONG_ACTION = Object.freeze({
  PLAY: "play",
  UP_NEXT: "upNext",
  FAVORITE: "favorite",
  RENAME: "rename",
  EXTRACT: "extract",
  STOP_EXTRACT: "stopExtract",
  ABOUT: "about",
  ADD_TO_SETLIST: "addToSetlist",
  NEW_SETLIST: "newSetlist",
  MOVE_TO_FOLDER: "moveToFolder",
  NEW_FOLDER: "newFolder",
  TRASH: "trash",
  RESTORE: "restore",
  CANCEL_IMPORT: "cancelImport",
  RETRY: "retry",
  EXTRACT_AGAIN: "extractAgain",
});

export const ROW_STATE = Object.freeze({
  DONE: "done",
  TRASHED: "trashed",
  IMPORTING: "importing",
  FAILED: "failed",
  STOPPED: "stopped",
  UNAVAILABLE: "unavailable",
});

const SEPARATOR = Object.freeze({ kind: "sep" });
const item = (action, labelKey, icon, extra = {}) => ({ kind: "item", action, labelKey, icon, ...extra });
const label = (labelKey) => ({ kind: "label", labelKey });
const trashItem = () => item(SONG_ACTION.TRASH, "track.moveToTrash", "trash", { danger: true });

function extractItems({ extracting, canExtractMore }) {
  if (extracting) return [item(SONG_ACTION.STOP_EXTRACT, "versions.extractStop", "x")];
  return canExtractMore ? [item(SONG_ACTION.EXTRACT, "versions.extractMore", "plus")] : [];
}

function setlistItems({ id, setlists }) {
  return setlists.map(function setlistItem(setlist) {
    const has = setlist.song_ids.includes(id);
    return item(SONG_ACTION.ADD_TO_SETLIST, null, has ? "check" : "listMusic", {
      text: setlist.name,
      arg: setlist.id,
      checked: has,
      disabled: has,
    });
  });
}

function folderItems({ folders }) {
  return folders.map(function folderItem(folder) {
    return item(SONG_ACTION.MOVE_TO_FOLDER, null, folder.current ? "check" : "folder", {
      text: folder.name,
      arg: folder.id,
      depth: folder.depth,
      color: folder.color,
      checked: folder.current,
      disabled: folder.current,
    });
  });
}

function fullMenu(song) {
  return [
    item(SONG_ACTION.PLAY, "upNext.playNow", "play"),
    item(SONG_ACTION.UP_NEXT, "upNext.add", "listPlus", { disabled: song.queuedIds.includes(song.id) }),
    item(SONG_ACTION.FAVORITE, song.favorite ? "track.unfavorite" : "track.favorite", "heart"),
    SEPARATOR,
    ...(song.rename ? [item(SONG_ACTION.RENAME, "trackMenu.rename", "pencil")] : []),
    ...extractItems(song),
    item(SONG_ACTION.ABOUT, "artist.openTitle", "info"),
    label("trackMenu.addToSetlist"),
    ...setlistItems(song),
    item(SONG_ACTION.NEW_SETLIST, "trackMenu.newSetlist", "plus"),
    label("trackMenu.moveToFolder"),
    ...folderItems(song),
    item(SONG_ACTION.NEW_FOLDER, "trackMenu.newFolder", "plus"),
    SEPARATOR,
    trashItem(),
  ];
}

// A song that cannot play yet offers its row's own action, then the Trash.
function shortMenu(song) {
  switch (song.state) {
    case ROW_STATE.TRASHED:
      return [item(SONG_ACTION.RESTORE, "lib.restore", "restore")];
    case ROW_STATE.IMPORTING: {
      const confirm = song.upload ? { confirmKey: "queue.cancelConfirm" } : {};
      const cancel = item(SONG_ACTION.CANCEL_IMPORT, "queue.cancelImport", "x", confirm);
      return song.inLibrary === false ? [cancel] : [cancel, SEPARATOR, trashItem()];
    }
    case ROW_STATE.FAILED: {
      const retryKey = song.pickAgain ? "importFail.pickAgain" : "importFail.retry";
      return [item(SONG_ACTION.RETRY, retryKey, "restore"), SEPARATOR, trashItem()];
    }
    case ROW_STATE.STOPPED:
      return [item(SONG_ACTION.EXTRACT_AGAIN, "track.extractAgain", "plus"), SEPARATOR, trashItem()];
    default:
      return [trashItem()];
  }
}

/**
 * The menu for one song. `queuedIds` holds the playing song and Up Next; `folders`
 * come as folderChoices() gives them; `rename` is false on the open song's head;
 * `inLibrary` is false for an import the library does not list yet.
 */
export function buildSongMenuModel(song) {
  return song.state === ROW_STATE.DONE ? fullMenu(song) : shortMenu(song);
}
