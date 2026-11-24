import { t, plural } from "./i18n.js";
import { MAX_BATCH_FILES, MAX_BATCH_LINKS, PATH_SEP, isTickable } from "./batchImportModel.js";
import { folderRow, groupRow, itemRow, moreRow, rowView } from "./batchReviewRows.js";

export const SOURCE = Object.freeze({ LINKS: "links", FILES: "files", FOLDER: "folder" });
const CHILDREN_SHOWN = 3;

export function headText(batch) {
  if (batch.source === SOURCE.LINKS) {
    const links = plural("batch.links", batch.linkCount);
    const songs = plural("batch.songs", batch.items.length);
    return { title: batch.loading ? links : t("batch.songsFromLinks", { songs, links }), sub: t("batch.pastedList") };
  }
  const files = plural("batch.files", batch.items.length);
  if (batch.source === SOURCE.FILES) return { title: files, sub: "" };
  const nested = batch.entries.some((e) => e.dir.includes(PATH_SEP));
  return { title: t("batch.filesIn", { files, folder: batch.name }), sub: nested ? t("batch.subfolders") : "" };
}

export function notes(batch) {
  const out = [];
  if (batch.refused && batch.source === SOURCE.LINKS) out.push(plural("batch.overCap", batch.refused, { max: MAX_BATCH_LINKS }));
  else if (batch.refused) out.push(plural("batch.overCapFiles", batch.refused, { max: MAX_BATCH_FILES }));
  return out;
}

export function listRows(batch) {
  const rows = [];
  const seenGroups = new Set();
  let lastDir = null;
  for (const item of batch.items) {
    if (batch.source === SOURCE.FOLDER && item.dir !== lastDir) {
      rows.push(folderRow(item.dir));
      lastDir = item.dir;
    }
    if (!item.group) rows.push(itemRow(item, rowView(item, batch.maxDurationSec)));
    else if (!seenGroups.has(item.group)) {
      seenGroups.add(item.group);
      rows.push(...groupRows(batch, batch.groups.find((g) => g.key === item.group)));
    }
  }
  return rows;
}

function groupRows(batch, group) {
  const children = batch.items.filter((i) => i.group === group.key);
  const tickable = children.filter(isTickable);
  const ticked = tickable.filter((i) => i.ticked).length;
  const rows = [groupRow(group, { count: children.length, ticked, tickable: tickable.length })];
  if (group.collapsed) return rows;
  const shown = group.showAll ? children : children.slice(0, CHILDREN_SHOWN);
  for (const child of shown) rows.push(itemRow(child, { ...rowView(child, batch.maxDurationSec), child: true }));
  if (shown.length < children.length) rows.push(moreRow(group.key, children.length - shown.length));
  return rows;
}
