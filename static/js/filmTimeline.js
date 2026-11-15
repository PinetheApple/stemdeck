// The Film view's take timeline: the song above, the take below with its trim
// handles, a playhead on both. Clicking the song seeks; dragging a handle trims.

import { t } from "./i18n.js";
import { fmtTickLabel } from "./utils.js";
import { tickStepAt } from "./rulerTicks.js";
import { barsSvg, peakAmps } from "./takesLanes.js";
import { TRIM_IN, TRIM_OUT, dragTrim, secAtFraction, songFraction } from "./filmTiming.js";

const SONG_BARS = 200;
const TAKE_BARS_PER_SHARE = 160;
const MIN_TAKE_BARS = 12;
const WHOLE_ZOOM = 1;

const pct = (fraction) => `${(fraction * 100).toFixed(3)}%`;
const $ = (id) => document.getElementById(id);

let view = null;

function rows() {
  return { ruler: $("filmRuler"), song: $("filmSongRow"), take: $("filmTakeRow") };
}

function playheadOf(row) {
  let head = row.querySelector(".film-playhead");
  if (!head) {
    head = document.createElement("span");
    head.className = "film-playhead";
    row.append(head);
  }
  return head;
}

function paintRuler(ruler, songSec) {
  const step = tickStepAt(songSec, ruler.clientWidth || 1, WHOLE_ZOOM);
  const ticks = [];
  for (let sec = 0; songSec > 0 && sec <= songSec; sec += step) {
    const tick = document.createElement("span");
    tick.style.left = pct(songFraction(sec, songSec));
    tick.textContent = fmtTickLabel(sec);
    ticks.push(tick);
  }
  ruler.replaceChildren(...ticks);
}

function onSongRowClick(e) {
  if (!view?.songSec) return;
  const rect = e.currentTarget.getBoundingClientRect();
  view.onSeek(secAtFraction((e.clientX - rect.left) / rect.width, view.songSec));
}

function clipEl(className, startSec, endSec, amps) {
  const clip = document.createElement("div");
  clip.className = className;
  const from = songFraction(startSec, view.songSec);
  clip.style.left = pct(from);
  clip.style.width = pct(songFraction(endSec, view.songSec) - from);
  clip.insertAdjacentHTML("beforeend", barsSvg(amps));
  return clip;
}

function takeBars(span) {
  const share = (span.end_sec - span.start_sec) / view.songSec;
  return Math.max(MIN_TAKE_BARS, Math.round(TAKE_BARS_PER_SHARE * share));
}

function takeClip(take) {
  const clip = clipEl("film-take", take.span.start_sec, take.span.end_sec, peakAmps(view.takePeaks, takeBars(take.span)));
  clip.classList.toggle("is-review", view.reviewing);
  clip.setAttribute("role", "button");
  clip.tabIndex = 0;
  clip.setAttribute("aria-pressed", String(view.reviewing));
  clip.setAttribute("aria-label", take.label);
  clip.addEventListener("click", view.onPickTake);
  return clip;
}

/** Draw the rows for `state`: `{songSec, songPeaks, take, takePeaks, trim, reviewing, onSeek, onTrim, onPickTake}`. */
export function renderTimeline(state) {
  view = state;
  const { ruler, song, take } = rows();
  if (!ruler || !song || !take) return;
  paintRuler(ruler, state.songSec);
  song.replaceChildren();
  song.insertAdjacentHTML("beforeend", barsSvg(peakAmps(state.songPeaks, SONG_BARS)));
  song.addEventListener("click", onSongRowClick);
  take.replaceChildren();
  if (state.take?.span) take.append(takeClip(state.take));
  if (state.take?.span && state.reviewing) take.append(...trimParts(state.take.span, state.trim));
}

function trimParts(span, trim) {
  const inSec = trim?.in_sec ?? span.start_sec;
  const outSec = trim?.out_sec ?? span.end_sec;
  return [
    shade(span.start_sec, inSec),
    shade(outSec, span.end_sec),
    handle(TRIM_IN, inSec, t("film.trimStart")),
    handle(TRIM_OUT, outSec, t("film.trimEnd")),
  ];
}

function shade(fromSec, toSec) {
  const el = document.createElement("div");
  el.className = "film-trim-out";
  const from = songFraction(fromSec, view.songSec);
  el.style.left = pct(from);
  el.style.width = pct(Math.max(0, songFraction(toSec, view.songSec) - from));
  return el;
}

function handle(edge, sec, label) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "film-handle";
  el.dataset.edge = edge;
  el.style.left = pct(songFraction(sec, view.songSec));
  el.setAttribute("aria-label", label);
  const time = document.createElement("span");
  time.className = "film-handle-time";
  time.textContent = fmtTickLabel(sec);
  el.append(time);
  el.addEventListener("pointerdown", onHandleDown);
  return el;
}

function trimAtPointer(e, edge) {
  const rect = rows().take.getBoundingClientRect();
  const sec = secAtFraction((e.clientX - rect.left) / rect.width, view.songSec);
  return dragTrim({ span: view.take.span, trim: view.trim, edge, sec });
}

function onHandleDown(e) {
  e.preventDefault();
  const edge = e.currentTarget.dataset.edge;
  function onHandleMove(move) {
    view.trim = trimAtPointer(move, edge);
    rows().take.replaceChildren(takeClip(view.take), ...trimParts(view.take.span, view.trim));
  }
  function onHandleUp() {
    window.removeEventListener("pointermove", onHandleMove);
    window.removeEventListener("pointerup", onHandleUp);
    view.onTrim(view.trim);
  }
  window.addEventListener("pointermove", onHandleMove);
  window.addEventListener("pointerup", onHandleUp);
}

/** Per frame: the playheads, and the take being recorded growing from where it started. */
export function paintTimeline({ nowSec, songSec, live }) {
  const { song, take } = rows();
  if (!song || !take) return;
  const at = pct(songFraction(nowSec, songSec));
  playheadOf(song).style.left = at;
  playheadOf(take).style.left = at;
  let clip = take.querySelector(".film-take.is-live");
  if (!live) {
    clip?.remove();
    return;
  }
  if (!clip) {
    take.querySelectorAll(".film-take, .film-trim-out, .film-handle").forEach((el) => el.remove());
    clip = document.createElement("div");
    clip.className = "film-take is-live";
    take.prepend(clip);
  }
  const from = songFraction(live.startSec, songSec);
  clip.style.left = pct(from);
  clip.style.width = pct(Math.max(0, songFraction(live.nowSec, songSec) - from));
  clip.innerHTML = barsSvg(live.peaks.map((peak) => Math.min(1, peak)));
}
