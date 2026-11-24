import { getPlayingTrackInfo } from "./catalog.js";
import { setPlayheadTime } from "./transport.js";
import { fillLine, tagLang, vocalEnvelope } from "./lyrics.js";
import { wordFill } from "./lyricsLookup.js";
import { lineText } from "./stageLyricLine.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

const LINE_CLASS = "sing-line";
const NOW_CLASS = "now";
const PAST_CLASS = "past";
const WAITING_CLASS = "waiting";
const SUNG_CLASS = "sung";
const SINGING_CLASS = "singing";
const FILL_PROPERTY = "--fill";
const SIDES_OF_ROW = 2;

let listed = null;
let rows = [];
let nowIndex = -1;
let nowLine = null;

function makeRow(line, index) {
  const row = document.createElement("p");
  row.className = LINE_CLASS;
  row.dataset.index = String(index);
  row.title = t("stage.jumpLine");
  writeRowText(row, line);
  return row;
}

function writeRowText(row, line) {
  row.textContent = lineText(line);
  row.removeAttribute("lang");
  tagLang(row, row.textContent);
}

function buildList(lines) {
  listed = lines;
  rows = lines.map(makeRow);
  nowIndex = -1;
  nowLine = null;
  $("singLyrics")?.replaceChildren(...rows);
}

function centre(row, smooth) {
  const list = $("singLyrics");
  if (!list || !row) return;
  const spare = list.clientHeight - row.offsetHeight;
  const top = row.offsetTop - spare / SIDES_OF_ROW;
  list.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

function markNow(index) {
  if (index === nowIndex) return;
  if (nowLine) writeRowText(rows[nowLine.index], listed[nowLine.index]);
  const smooth = nowIndex >= 0;
  nowIndex = index;
  nowLine = null;
  rows.forEach((row, i) => {
    row.classList.toggle(PAST_CLASS, i < index);
    row.classList.toggle(NOW_CLASS, i === index);
  });
  centre(rows[index], smooth);
}

function fillNow(time) {
  const row = rows[nowIndex];
  const envelope = vocalEnvelope(getPlayingTrackInfo()?.id);
  if (!nowLine || nowLine.envelope !== envelope) {
    const words = fillLine(row, listed[nowIndex], listed[nowIndex + 1]?.time ?? null);
    nowLine = { index: nowIndex, envelope, words };
  }
  for (const word of nowLine.words) {
    const { sung, singing, fill } = wordFill(word, time);
    word.el.classList.toggle(SUNG_CLASS, sung);
    word.el.classList.toggle(SINGING_CLASS, singing);
    if (singing) word.el.style.setProperty(FILL_PROPERTY, `${fill}%`);
  }
}

export function paintSingLyrics(lines, view, time) {
  if (lines !== listed) buildList(lines);
  markNow(view.now);
  rows[nowIndex]?.classList.toggle(WAITING_CLASS, view.intro != null);
  if (rows[nowIndex]) fillNow(time);
}

export function forgetSingLyrics() {
  listed = null;
}

function onLineClick(e) {
  const row = e.target.closest(`.${LINE_CLASS}`);
  const line = row && listed?.[Number(row.dataset.index)];
  if (line) setPlayheadTime(line.time);
}

export function initSingLyrics() {
  $("singLyrics")?.addEventListener("click", onLineClick);
}
