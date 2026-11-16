// What the Film view says around the picture: a problem in plain words with
// its one action, the devices in use, the input level and the badges.

import { t } from "./i18n.js";
import { $, fmtTime } from "./utils.js";
import { vuLevel } from "./vuScale.js";
import { PERCENT } from "./stageModel.js";
import { CAMERA_PROBLEM, installCommand } from "./filmSupport.js";

const COPIED_MS = 1500;
const PROBLEM_TEXT = {
  [CAMERA_PROBLEM.noCamera]: "film.problem.noCamera",
  [CAMERA_PROBLEM.denied]: "film.problem.denied",
  [CAMERA_PROBLEM.packages]: "film.problem.packages",
  [CAMERA_PROBLEM.noEncoder]: "film.problem.noEncoder",
};
// A browser without an encoder has nothing to retry or copy.
const NO_ACTION = new Set([CAMERA_PROBLEM.noEncoder]);

let onRetry = null;

function onProblemAction(e) {
  const code = $("filmProblemCode");
  if (code?.hidden === false) {
    copyCommand(e.currentTarget, code.textContent);
    return;
  }
  onRetry?.();
}

async function copyCommand(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t("film.copied");
    setTimeout(function restoreCopyLabel() {
      button.textContent = t("film.copyCommand");
    }, COPIED_MS);
  } catch (err) {
    console.warn("[film] could not copy the command:", err);
  }
}

export function wireFilmPanel(retry) {
  onRetry = retry;
  $("filmProblemBtn")?.addEventListener("click", onProblemAction);
}

/** Show `problem` (a CAMERA_PROBLEM) in place of the picture, or clear it. */
export function paintProblem(problem, os) {
  const box = $("filmProblem");
  if (!box) return;
  box.hidden = !problem;
  if (!problem) return;
  $("filmProblemText").textContent = t(PROBLEM_TEXT[problem]);
  const packages = problem === CAMERA_PROBLEM.packages;
  const code = $("filmProblemCode");
  code.hidden = !packages;
  code.textContent = packages ? installCommand(os) : "";
  const btn = $("filmProblemBtn");
  btn.hidden = NO_ACTION.has(problem);
  btn.textContent = t(packages ? "film.copyCommand" : "film.tryAgain");
}

export function paintDevices({ cameraName, micName }) {
  $("filmCameraName").textContent = cameraName || t("film.noCamera");
  $("filmCameraName").closest(".film-device")?.classList.toggle("is-missing", !cameraName);
  $("filmMicName").textContent = micName || t("rec.defaultInput");
}

export function paintMeter(rms) {
  const level = Math.round(vuLevel(rms) * PERCENT);
  $("filmMeter")?.style.setProperty("--level", `${level}%`);
  $("filmMeter")?.parentElement.setAttribute("aria-valuenow", String(level));
}

function setBadge(id, text) {
  const badge = $(id);
  if (!badge) return;
  badge.hidden = !text;
  if (text && badge.textContent !== text) badge.textContent = text;
}

/** The REC time while recording, the take's name while reviewing, and the song time. */
export function paintBadges({ recSec, takeLabel, nowSec, songSec }) {
  setBadge("filmRecBadge", recSec === null ? "" : t("rec.stageMark", { time: fmtTime(recSec) }));
  setBadge("filmTakeBadge", recSec === null ? takeLabel ?? "" : "");
  setBadge("filmTimeBadge", `${fmtTime(nowSec)} / ${fmtTime(songSec)}`);
}

/** A short line over the picture, such as a take that kept its sound only. */
export function paintNote(text) {
  setBadge("filmNote", text);
}
