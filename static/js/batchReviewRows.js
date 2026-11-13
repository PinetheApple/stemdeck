// batchReviewRows.js — the review list's elements: the panel's frame, one row
// per item, a playlist's group row and a folder's label. Built with DOM calls,
// so a title from a link or a file name is only ever text.

import { t, plural } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { ITEM_KIND, ITEM_STATUS, isTickable } from "./batchImportModel.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const FOLDER_SEP = " / ";
const FLAG_DUP = "dup";
const FLAG_BLOCK = "block";

// Lucide (ISC), for the two glyphs libraryIcons.js does not carry.
const EXTRA_ICONS = {
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
};

function iconHtml(name, extraClass = "") {
  if (!EXTRA_ICONS[name]) return icon(name);
  return `<svg class="ic${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA_ICONS[name]}</svg>`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(className, label, iconName, extra = {}) {
  const btn = el("button", className);
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", extra.ariaLabel ?? label);
  btn.insertAdjacentHTML("beforeend", iconHtml(iconName));
  return btn;
}

const BLOCK_FLAGS = {
  [ITEM_STATUS.NOT_A_LINK]: "batch.flag.notALink",
  [ITEM_STATUS.UNAVAILABLE]: "batch.flag.unavailable",
  [ITEM_STATUS.NOT_AUDIO]: "batch.flag.notAudio",
  [ITEM_STATUS.TOO_LARGE]: "batch.flag.tooLarge",
  [ITEM_STATUS.NOT_QUEUED]: "batch.flag.notQueued",
};

/** The flag an item's status shows, or null for one that is fine. */
export function flagFor(item, maxDurationSec) {
  if (item.status === ITEM_STATUS.IN_LIBRARY) {
    return { kind: FLAG_DUP, text: t("batch.flag.inLibrary"), title: t("batch.flag.inLibraryTitle") };
  }
  if (item.status === ITEM_STATUS.TOO_LONG) {
    const minutes = Math.round((maxDurationSec ?? 0) / SECONDS_PER_MINUTE);
    return { kind: FLAG_BLOCK, text: t("batch.flag.tooLong", { minutes }), title: t("batch.flag.tooLongTitle", { minutes }) };
  }
  const key = BLOCK_FLAGS[item.status];
  return key ? { kind: FLAG_BLOCK, text: t(key), title: "" } : null;
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
  const slot = el("span", "batch-item-ic");
  slot.insertAdjacentHTML("beforeend", iconHtml(busy ? "loader" : name, busy ? " batch-spin" : ""));
  return slot;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const whole = Math.round(seconds);
  const h = Math.floor(whole / SECONDS_PER_HOUR);
  const m = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(whole % SECONDS_PER_MINUTE)}` : `${m}:${pad(whole % SECONDS_PER_MINUTE)}`;
}

/** What a row shows for an item: title, sub line, icon and flag. */
export function rowView(item, maxDurationSec) {
  const lookingUp = item.status === ITEM_STATUS.LOOKING_UP;
  const isFile = item.kind === ITEM_KIND.FILE;
  return {
    title: isFile ? item.name : item.title || item.input,
    mono: !isFile && !item.title,
    sub: subText(item),
    icon: rowIcon(item),
    busy: lookingUp,
    flag: flagFor(item, maxDurationSec),
    retry: item.status === ITEM_STATUS.NOT_QUEUED,
  };
}

function subText(item) {
  if (item.status === ITEM_STATUS.LOOKING_UP) return t("batch.lookingUp");
  if (item.status === ITEM_STATUS.NOT_QUEUED) return item.reason;
  if (item.kind === ITEM_KIND.LINK && !item.title) return t("batch.line", { line: item.line });
  return [item.artist, formatDuration(item.durationSec)].filter(Boolean).join(" · ");
}

function rowIcon(item) {
  if (item.kind === ITEM_KIND.FILE) return "file";
  if (item.status === ITEM_STATUS.NOT_A_LINK) return "alert";
  return item.group ? "music" : "link";
}

/** One item: tick, icon, title and sub line, its flag, Retry when it was not queued, and ×. */
export function itemRow(item, view) {
  const blocked = view.flag?.kind === FLAG_BLOCK && !view.retry;
  const li = el("li", `batch-item${blocked ? " is-blocked" : ""}${view.child ? " is-child" : ""}`);
  li.dataset.key = item.key;
  li.append(
    checkbox(t("batch.import", { title: view.title }), { checked: item.ticked && isTickable(item) || item.status === ITEM_STATUS.LOOKING_UP, disabled: !isTickable(item) }),
    iconSlot(view.icon, view.busy),
    meta(view.title, view.sub, view.mono),
  );
  if (view.flag) li.append(flagEl(view.flag));
  if (view.retry) li.append(iconButton("batch-item-retry", t("importFail.retry"), "restore", { ariaLabel: t("batch.retryTitle", { title: view.title }) }));
  li.append(iconButton("batch-item-drop", t("batch.remove"), "x", { ariaLabel: t("batch.removeTitle", { title: view.title }) }));
  return li;
}

/** A playlist: tick-all, its name and size, show or hide its songs, and ×. */
export function groupRow(group, { count, ticked, tickable }) {
  const li = el("li", "batch-item batch-group");
  li.dataset.key = group.key;
  const box = checkbox(t("batch.importAll", { title: group.title }), { checked: tickable > 0 && ticked === tickable, disabled: tickable === 0 });
  box.indeterminate = ticked > 0 && ticked < tickable;
  const toggleLabel = t(group.collapsed ? "batch.showSongs" : "batch.hideSongs");
  const toggle = iconButton("batch-group-toggle", toggleLabel, "down");
  toggle.setAttribute("aria-expanded", String(!group.collapsed));
  li.append(
    box,
    iconSlot("listMusic", false),
    meta(group.title, t("batch.playlistSub", { songs: plural("batch.songs", count) }), false),
    toggle,
    iconButton("batch-item-drop", t("batch.remove"), "x", { ariaLabel: t("batch.removeTitle", { title: group.title }) }),
  );
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
  li.append(el("span", null, dir.split("/").join(FOLDER_SEP)));
  return li;
}

function textButton(className, text) {
  const btn = el("button", `batch-btn ${className}`, text);
  btn.type = "button";
  return btn;
}

/** The panel's frame: heading, notes, the (empty) list and the footer. */
export function reviewShell({ title, sub, notes }) {
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

  return [head, ...notes.map((note) => el("p", "batch-review-note", note)), list, foot];
}
