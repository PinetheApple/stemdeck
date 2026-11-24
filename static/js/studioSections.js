// The section blocks, their Edit section dialog, the Sections and View menus and the lyric line
// over the lanes. Loaded after main.js, so the studio modules they read are already in place.

import { initSectionBar } from "./sectionBar.js";
import { initSectionEdit } from "./sectionEdit.js";
import { initStudioMenus } from "./studioMenus.js";
import { initLyricTicker } from "./lyricTicker.js";

initSectionBar();
initSectionEdit();
initStudioMenus();
initLyricTicker();
