// "Takes in the mix" in the export menu: the recording tracks an export
// carries, ticked by default for the unmuted ones.

import { t } from "./i18n.js";
import { takeMixEntry } from "./takesMix.js";
import {
  createTickStore,
  exportTakeRows,
  takeLanes,
  tickedTrackIds,
  withTakeLanes,
} from "./takesExportModel.js";

const SECTION_ID = "t-export-takes";
const MIX_ITEM_ID = "t-export-mix";
const ZIP_DESC_SELECTOR = "#t-export-stems .chip-item-desc";
const ZIP_DESC_KEY = "export.allStemsDesc";
const ZIP_TAKES_DESC_KEY = "rec.export.zipDesc";
const PART_SEPARATOR = " · ";

let views = [];
const tickStore = createTickStore();

/** The open song's tracks; a new song starts from the mute defaults again. */
export function setExportTakes(id, trackViews) {
  tickStore.forJob(id);
  views = trackViews;
}

function rows() {
  return exportTakeRows(views, takeMixEntry, tickStore.ticks);
}

/** The stems' mix lists with the ticked tracks appended. */
export function withExportTakes(mix) {
  return withTakeLanes(mix, takeLanes(rows(), mix.anySolo));
}

/** The tracks the stems zip carries next to the stems. */
export function exportTakeTrackIds() {
  return tickedTrackIds(rows());
}

function paintZipDesc(panel) {
  const desc = panel.querySelector(ZIP_DESC_SELECTOR);
  if (!desc) return;
  const key = exportTakeTrackIds().length ? ZIP_TAKES_DESC_KEY : ZIP_DESC_KEY;
  desc.dataset.i18n = key;
  desc.textContent = t(key);
}

function takeRow(row, panel) {
  const label = document.createElement("label");
  label.className = "export-click-opt";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = row.ticked;
  box.addEventListener("change", function onTakeTick() {
    tickStore.ticks.set(row.trackId, box.checked);
    paintZipDesc(panel);
  });
  const text = document.createElement("span");
  text.textContent = `${row.name}${PART_SEPARATOR}${row.takeLabel}`;
  if (row.muted) {
    const muted = document.createElement("span");
    muted.className = "export-takes-sub";
    muted.textContent = `${PART_SEPARATOR}${t("rec.export.muted")}`;
    text.append(muted);
  }
  label.append(box, text);
  return label;
}

function takesSection(panel) {
  const existing = panel.querySelector(`#${SECTION_ID}`);
  if (existing) return existing;
  const section = document.createElement("div");
  section.id = SECTION_ID;
  section.className = "export-takes";
  section.setAttribute("role", "group");
  panel.querySelector(`#${MIX_ITEM_ID}`)?.before(section);
  return section;
}

/** Draw the group in the open export menu; nothing when the song has no take. */
export function renderExportTakes(panel) {
  if (!panel) return;
  const list = rows();
  const section = takesSection(panel);
  section.hidden = list.length === 0;
  section.setAttribute("aria-label", t("rec.export.title"));
  const title = document.createElement("div");
  title.className = "export-takes-title";
  title.textContent = t("rec.export.title");
  section.replaceChildren(title, ...list.map((row) => takeRow(row, panel)));
  paintZipDesc(panel);
}
