// Browse library's view and layout names, apart so the modules that draw views can read them at load.

export const VIEW = Object.freeze({
  ALL: "all",
  FAVORITES: "fav",
  RECENT: "recent",
  QUEUE: "queue",
  TRASH: "trash",
  FOLDER: "folder",
  SETLIST: "setlist",
});
export const LAYOUT = Object.freeze({ GRID: "grid", LIST: "list" });
