// Recording outside the lanes: the footer's Record button, the count-in number,
// the REC mark in Stage mode, and the notice after a song switch.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { fmtTime } from "./utils.js";
import { NORMAL_SPEED, RECORD_BLOCK, REC_PHASE } from "./recorder.js";
import { refitFooter } from "./footerFit.js";

const BLOCK_HINT = {
  [RECORD_BLOCK.speed]: "rec.hint.speed",
  [RECORD_BLOCK.noTrack]: "rec.hint.noTrack",
  [RECORD_BLOCK.noInput]: "rec.hint.noInput",
  [RECORD_BLOCK.noEngine]: "rec.hint.noEngine",
};
const NO_TRACK_YET_HINT = "rec.hint.addTrack";
const SPEED_DECIMALS = 2;

const recordBtn = () => document.getElementById("t-rec");

export function wireRecordButton(onClick) {
  recordBtn()?.addEventListener("click", onClick);
}

function buttonHint(phase, block, hasTracks) {
  if (phase === REC_PHASE.finishing) return t("rec.saving");
  if (phase) return t("rec.stop");
  if (!block) return t("rec.record");
  if (block === RECORD_BLOCK.noTrack && !hasTracks) return t(NO_TRACK_YET_HINT);
  return t(BLOCK_HINT[block], { speed: NORMAL_SPEED.toFixed(SPEED_DECIMALS) });
}

let painted = "";

/** `phase` is the take's REC_PHASE or null; `block` a RECORD_BLOCK or null. */
export function paintRecordButton({ hasTracks, phase, block, elapsedSec }) {
  const btn = recordBtn();
  const key = `${hasTracks}|${phase}|${block}|${Math.floor(elapsedSec)}|${document.documentElement.lang}`;
  if (!btn || key === painted) return;
  const phaseChanged = !painted.includes(`|${phase}|`);
  painted = key;
  btn.classList.toggle("is-counting", phase === REC_PHASE.counting);
  btn.classList.toggle("is-recording", phase === REC_PHASE.recording);
  btn.classList.toggle("is-saving", phase === REC_PHASE.finishing);
  btn.disabled = phase === REC_PHASE.finishing || (Boolean(block) && !phase);
  btn.setAttribute("aria-pressed", String(phase === REC_PHASE.counting || phase === REC_PHASE.recording));
  const hint = buttonHint(phase, block, hasTracks);
  btn.title = hint;
  btn.setAttribute("aria-label", hint);
  const time = btn.querySelector(".rec-btn-time");
  if (time) time.textContent = phase === REC_PHASE.recording ? fmtTime(elapsedSec) : "";
  if (phaseChanged) refitFooter();
}

let countInEl = null;

/** The beats left before the take, big over the lanes; null clears it. */
export function paintCountIn(beatsLeft) {
  if (!beatsLeft) {
    countInEl?.remove();
    countInEl = null;
    return;
  }
  if (!countInEl) {
    countInEl = document.createElement("div");
    countInEl.className = "rec-countin";
    countInEl.setAttribute("aria-live", "assertive");
    countInEl.append(document.createElement("b"));
    document.querySelector(".daw-wave-panel")?.append(countInEl);
  }
  countInEl.firstChild.textContent = String(beatsLeft);
}

export function paintStageMark(elapsedSec) {
  const mark = document.getElementById("stageRecMark");
  if (!mark) return;
  mark.hidden = elapsedSec === null;
  if (elapsedSec !== null) mark.textContent = t("rec.stageMark", { time: fmtTime(elapsedSec) });
}

let noticeEl = null;

function closeNotice() {
  noticeEl?.remove();
  noticeEl = null;
}

/** A notice over the bottom of the lanes; `action` is `{ text, onClick }` or null. */
export function showRecNotice(text, action = null) {
  closeNotice();
  noticeEl = document.createElement("div");
  noticeEl.className = "rec-notice";
  noticeEl.setAttribute("role", "status");
  noticeEl.innerHTML = icon("check");
  const p = document.createElement("p");
  p.textContent = text;
  noticeEl.append(p);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-btn";
    btn.textContent = action.text;
    btn.addEventListener("click", function onNoticeAction() {
      closeNotice();
      action.onClick();
    });
    noticeEl.append(btn);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "rec-notice-close";
  close.setAttribute("aria-label", t("rec.dismiss"));
  close.innerHTML = icon("x");
  close.addEventListener("click", closeNotice);
  noticeEl.append(close);
  document.getElementById("lanes")?.append(noticeEl);
}
