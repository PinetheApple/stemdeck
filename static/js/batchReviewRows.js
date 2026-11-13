// batchReviewRows.js — the review list's elements, built with DOM calls so a
// title from a link or a file name is only ever text.

import { t, plural } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { FLAG, ITEM_KIND, ITEM_STATUS, PATH_SEP, isTickable, statusFlag } from "./batchImportModel.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const FOLDER_LABEL_SEP = " / ";
const SUB_SEP = " · ";
const FLAG_TITLE_KEYS = {
  [ITEM_STATUS.IN_LIBRARY]: "batch.flag.inLibraryTitle",
  [ITEM_STATUS.TOO_LONG]: "batch.flag.tooLongTitle",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(className, label, iconName, ariaLabel = label) {
  const btn = el("button", className);
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", ariaLabel);
  btn.insertAdjacentHTML("beforeend", icon(iconName));
  return btn;
}

/** The flag an item's status shows, or null for one that is fine. */
function flagFor(item, maxDurationSec) {
  const flag = statusFlag(item.status);
  if (!flag) return null;
  const vars = { minutes: Math.round((maxDurationSec ?? 0) / SECONDS_PER_MINUTE) };
  const titleKey = FLAG_TITLE_KEYS[item.status];
  return { kind: flag.kind, text: t(flag.key, vars), title: titleKey ? t(titleKey, vars) : "" };
}

function flagEl(flag) {
  const chip = el("span", `batch-flag batch-flag-${flag.kind}`, flag.text);
  if (flag.title) chip.title = flag.title;
  return chip;
}

function checkbox(label, { checked, disabled }) {
  const box = el("input", "batch-item-check");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = disabled;
  box.setAttribute("aria-label", label);
  return box;
}

function meta(title, sub, mono) {
  const wrap = el("span", "batch-item-meta");
  wrap.append(el("span", `batch-item-title${mono ? " is-mono" : ""}`, title));
  if (sub) wrap.append(el("span", "batch-item-sub", sub));
  return wrap;
}

function iconSlot(name, busy) {
  const slot = el("span", `batch-item-ic${busy ? " batch-spin" : ""}`);
  slot.insertAdjacentHTML("beforeend", icon(busy ? "loader" : name));
  return slot;
}

// h:mm:ss, unpadded minutes: utils.fmtTime pads and has no hours.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const whole = Math.round(seconds);
  const h = Math.floor(whole / SECONDS_PER_HOUR);
  const m = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(whole % SECONDS_PER_MINUTE)}` : `${m}:${pad(whole % SECONDS_PER_MINUTE)}`;
}

const SUB_KEYS = {
  [ITEM_STATUS.LOOKING_UP]: "batch.lookingUp",
  [ITEM_STATUS.UNCHECKED]: "batch.notChecked",
};

function subText(item) {
  if (SUB_KEYS[item.status]) return t(SUB_KEYS[item.status]);
  if (item.status === ITEM_STATUS.NOT_QUEUED) return item.reason;
  if (item.kind === ITEM_KIND.LINK && !item.title) return t("batch.line", { line: item.line });
  return [item.artist, formatDuration(item.durationSec)].filter(Boolean).join(SUB_SEP);
}

function rowIcon(item) {
  if (item.kind === ITEM_KIND.FILE) return "file";
  if (item.status === ITEM_STATUS.NOT_A_LINK) return "alert";
  return item.group ? "music" : "link";
}

/** What a row shows for an item: title, sub line, icon and flag. */
export function rowView(item, maxDurationSec) {
  const isFile = item.kind === ITEM_KIND.FILE;
  return {
    title: isFile ? item.name : item.title || item.input,
    mono: !isFile && !item.title,
    sub: subText(item),
    icon: rowIcon(item),
    busy: item.status === ITEM_STATUS.LOOKING_UP,
    flag: flagFor(item, maxDurationSec),
    retry: item.status === ITEM_STATUS.NOT_QUEUED,
  };
}

/** One item: tick, icon, title and sub line, its flag, Retry when it was not queued, and ×. */
export function itemRow(item, view) {
  const blocked = view.flag?.kind === FLAG.BLOCK && !view.retry;
  const li = el("li", `batch-item${blocked ? " is-blocked" : ""}${view.child ? " is-child" : ""}`);
  li.dataset.key = item.key;
  const box = checkbox(
    t("batch.import", { title: view.title }),
    { checked: item.ticked, disabled: !isTickable(item) },
  );
  li.append(box, iconSlot(view.icon, view.busy), meta(view.title, view.sub, view.mono));
  if (view.flag) li.append(flagEl(view.flag));
  if (view.retry) {
    li.append(iconButton(
      "batch-item-retry",
      t("importFail.retry"),
      "restore",
      t("batch.retryTitle", { title: view.title }),
    ));
  }
  li.append(iconButton(
    "batch-item-drop",
    t("batch.remove"),
    "x",
    t("batch.removeTitle", { title: view.title }),
  ));
  return li;
}

/** A playlist: tick-all, its name and size, show or hide its songs, and ×. */
export function groupRow(group, { count, ticked, tickable }) {
  const li = el("li", "batch-item batch-group");
  li.dataset.key = group.key;
  const box = checkbox(
    t("batch.importAll", { title: group.title }),
    { checked: tickable > 0 && ticked === tickable, disabled: tickable === 0 },
  );
  box.indeterminate = ticked > 0 && ticked < tickable;
  const toggle = iconButton(
    "batch-group-toggle",
    t(group.collapsed ? "batch.showSongs" : "batch.hideSongs"),
    "down",
  );
  toggle.setAttribute("aria-expanded", String(!group.collapsed));
  const drop = iconButton(
    "batch-item-drop",
    t("batch.remove"),
    "x",
    t("batch.removeTitle", { title: group.title }),
  );
  const parts = [t("batch.playlistSub", { songs: plural("batch.songs", count) })];
  if (group.unavailable) parts.push(plural("playlist.skip.unavailable", group.unavailable));
  if (group.truncated) parts.push(t("batch.playlistTruncated"));
  const sub = parts.join(SUB_SEP);
  li.append(box, iconSlot("listMusic", false), meta(group.title, sub, false), toggle, drop);
  return li;
}

export function moreRow(groupKey, hidden) {
  const li = el("li", "batch-more");
  li.dataset.key = groupKey;
  const btn = el("button", "batch-more-btn", plural("batch.showMore", hidden));
  btn.type = "button";
  li.append(btn);
  return li;
}

export function folderRow(dir) {
  const li = el("li", "batch-folder");
  li.insertAdjacentHTML("beforeend", icon("folder"));
  li.append(el("span", null, dir.split(PATH_SEP).join(FOLDER_LABEL_SEP)));
  return li;
}

function textButton(className, text) {
  const btn = el("button", `batch-btn ${className}`, text);
  btn.type = "button";
  return btn;
}

function errorNote(error) {
  const note = el("p", "batch-review-note batch-review-error", error);
  note.setAttribute("role", "alert");
  note.append(textButton("batch-preview-retry", t("job.tryAgain")));
  return note;
}

/** The panel's frame: heading, notes, a failed preview's reason, the (empty) list and the footer. */
export function reviewShell({ title, sub, notes, error }) {
  const head = el("header", "batch-review-head");
  const text = el("div");
  const heading = el("h2", null, title);
  heading.id = "batchReviewTitle";
  text.append(heading);
  if (sub) text.append(el("p", null, sub));
  head.append(text, iconButton("batch-review-close", t("batch.close"), "x"));

  const list = el("ul", "batch-review-list");
  list.setAttribute("aria-labelledby", "batchReviewTitle");

  const foot = el("footer", "batch-review-foot");
  const summary = el("span", "batch-review-text");
  const clamp = el("span", "batch-review-clamp");
  clamp.setAttribute("role", "status");
  summary.append(el("span", "batch-review-summary"), clamp);
  foot.append(summary, textButton("batch-cancel", t("batch.cancel")), textButton("batch-btn-primary batch-queue", ""));

  const shown = [head, ...notes.map((note) => el("p", "batch-review-note", note))];
  if (error) shown.push(errorNote(error));
  return [...shown, list, foot];
}
