import { t, plural } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { fmtTickLabel } from "./utils.js";
import { exportMixLanes, triggerDownload } from "./player.js";
import { el, settingsButton, settingsRow } from "./recorderSettings.js";
import { cancelRender, readRender, startRender } from "./filmApi.js";
import { filmPrefs, setFilmPrefs } from "./filmPrefs.js";
import {
  EXPORT_PHASE, RENDER_ERROR, RENDER_FPS, RENDER_SIZES, exportState, failedView, minutesLeft, renderBody, videoFilename,
} from "./videoExportModel.js";

const POLL_MS = 500;
// Ten reads in a row, about five seconds, before the dialog stops waiting.
const POLL_FAILURES_MAX = 10;
const SIZE_SUFFIX = "p";

let dialog = null;

function rangeText(take) {
  const span = take.trim ?? { in_sec: take.span.start_sec, out_sec: take.span.end_sec };
  return `${fmtTickLabel(span.in_sec)} – ${fmtTickLabel(span.out_sec)}`;
}

function segmented(label, options, current, onPick) {
  const group = el("div", "export-format-toggle");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const option of options) {
    const on = option.value === current;
    const item = el("button", `export-fmt${on ? " active" : ""}`, option.text);
    item.type = "button";
    item.setAttribute("role", "radio");
    item.setAttribute("aria-checked", String(on));
    item.addEventListener("click", function onSegmentPick() {
      onPick(option.value);
    });
    group.append(item);
  }
  return group;
}

function foot(...buttons) {
  const node = el("div", "settings-foot");
  node.append(...buttons);
  return node;
}

function pickSize(size) {
  setFilmPrefs({ size });
  paint();
}

function pickFps(fps) {
  setFilmPrefs({ fps });
  paint();
}

function optionsBody() {
  const { size, fps } = filmPrefs();
  const sizes = RENDER_SIZES.map((value) => ({ value, text: `${value}${SIZE_SUFFIX}` }));
  const rates = RENDER_FPS.map((value) => ({ value, text: String(value) }));
  const range = el("span", "settings-stat", rangeText(dialog.take));
  return [
    settingsRow(t("videoExport.resolution"), null, [segmented(t("videoExport.resolution"), sizes, size, pickSize)]),
    settingsRow(t("videoExport.frameRate"), null, [segmented(t("videoExport.frameRate"), rates, fps, pickFps)]),
    settingsRow(t("videoExport.range"), null, [range]),
    foot(
      settingsButton(t("videoExport.cancel"), false, closeVideoExport),
      settingsButton(t("videoExport.export"), true, onExportClick),
    ),
  ];
}

function progressBody(state) {
  const box = el("div", "vid-progress");
  box.setAttribute("role", "status");
  const waiting = state.phase === EXPORT_PHASE.waiting;
  const top = el("div", "vid-progress-line");
  top.append(el("span", "", t(waiting ? "videoExport.waiting" : "videoExport.making")), el("span", "num", `${state.percent}%`));
  const bar = el("div", "vid-progress-bar");
  const fill = el("i");
  fill.style.setProperty("--done", `${state.percent}%`);
  bar.append(fill);
  const { size, fps } = dialog.request;
  const left = minutesLeft(state.progress, performance.now() - dialog.startedAt);
  const bottom = el("div", "vid-progress-line");
  bottom.append(
    el("span", "", `${size}${SIZE_SUFFIX} · ${fps} fps · ${rangeText(dialog.take)}`),
    el("span", "", left && !waiting ? plural("videoExport.minLeft", left, { n: left }) : ""),
  );
  box.append(top, bar, bottom);
  return [box, foot(settingsButton(t("videoExport.cancel"), false, onCancelRenderClick))];
}

function resultBox(ok, line, sub) {
  const box = el("div", `vid-result${ok ? "" : " is-failed"}`);
  box.setAttribute("role", "status");
  box.innerHTML = icon(ok ? "check" : "alert");
  const text = el("div");
  text.append(el("p", "", line), el("p", "vid-sub", sub));
  box.append(text);
  return box;
}

function doneBody(state) {
  const sub = state.cpuFallback ? t("videoExport.madeWithCpu") : t("videoExport.madeWith", { encoder: state.encoder ?? "" });
  const line = dialog.savedAs ? t("videoExport.saved", { name: dialog.savedAs }) : t("videoExport.ready");
  const buttons = dialog.savedAs ? [] : [settingsButton(t("videoExport.save"), false, saveRender)];
  return [resultBox(true, line, sub), foot(...buttons, settingsButton(t("videoExport.done"), true, closeVideoExport))];
}

function noAnswerBody() {
  return [
    resultBox(false, t("videoExport.noAnswer"), ""),
    foot(
      settingsButton(t("videoExport.close"), false, closeVideoExport),
      settingsButton(t("film.tryAgain"), true, onExportClick),
    ),
  ];
}

function failedBody(state) {
  if (state.noAnswer) return noAnswerBody();
  const sub = state.diskFull ? t("videoExport.diskFull") : t("videoExport.failedHint");
  return [
    resultBox(false, t("videoExport.failed"), sub),
    foot(
      settingsButton(t("videoExport.openSettings"), false, openExportSettings),
      settingsButton(t("film.tryAgain"), true, onExportClick),
    ),
  ];
}

const BODIES = {
  [EXPORT_PHASE.options]: optionsBody,
  [EXPORT_PHASE.waiting]: progressBody,
  [EXPORT_PHASE.running]: progressBody,
  [EXPORT_PHASE.done]: doneBody,
  [EXPORT_PHASE.failed]: failedBody,
};

function paint() {
  if (!dialog) return;
  const state = exportState(dialog.view);
  const busy = state.phase === EXPORT_PHASE.waiting || state.phase === EXPORT_PHASE.running;
  dialog.close.hidden = busy;
  dialog.body.replaceChildren(...BODIES[state.phase](state));
}

async function onExportClick() {
  const { jobId, take, trackId, iPlay } = dialog;
  const prefs = filmPrefs();
  dialog.request = { size: prefs.size, fps: prefs.fps };
  dialog.savedAs = null;
  dialog.pollFailures = 0;
  dialog.startedAt = performance.now();
  try {
    dialog.view = await startRender(jobId, take.id, renderBody({ lanes: exportMixLanes(), takeTrackId: trackId, prefs, iPlay }));
  } catch (err) {
    console.warn("[film] the export could not start:", err);
    dialog.view = failedView(RENDER_ERROR.failed);
  }
  paint();
  poll();
}

function poll() {
  clearTimeout(dialog?.timer);
  const phase = exportState(dialog?.view).phase;
  if (phase !== EXPORT_PHASE.waiting && phase !== EXPORT_PHASE.running) {
    if (phase === EXPORT_PHASE.done) saveRender();
    return;
  }
  dialog.timer = setTimeout(readAgain, POLL_MS);
}

async function readAgain() {
  if (!dialog) return;
  const current = dialog;
  try {
    current.view = await readRender(current.jobId, current.take.id);
    current.pollFailures = 0;
  } catch (err) {
    console.warn("[film] could not read the export:", err);
    current.pollFailures += 1;
    if (current.pollFailures >= POLL_FAILURES_MAX) current.view = failedView(RENDER_ERROR.noAnswer);
  }
  if (dialog !== current) return;
  paint();
  poll();
}

async function saveRender() {
  const current = dialog;
  if (!current?.view?.url) return;
  const name = videoFilename(current.title, current.take.label);
  try {
    const saved = await triggerDownload(current.view.url, name);
    if (saved && dialog === current) current.savedAs = name;
  } catch (err) {
    console.warn("[film] the video could not be saved:", err);
  }
  paint();
}

async function onCancelRenderClick() {
  try {
    dialog.view = await cancelRender(dialog.jobId, dialog.take.id);
  } catch (err) {
    console.warn("[film] the export could not be cancelled:", err);
  }
  paint();
}

function openExportSettings() {
  closeVideoExport();
  document.getElementById("settingsBtn")?.click();
  document.querySelector('.settings-tab[data-tab="export"]')?.click();
}

function onExportKeydown(e) {
  e.stopPropagation();
  if (e.key === "Escape" && !dialog.close.hidden) closeVideoExport();
}

export function closeVideoExport() {
  if (!dialog) return;
  clearTimeout(dialog.timer);
  dialog.overlay.remove();
  dialog.opener?.focus?.();
  dialog = null;
}

function dialogFrame() {
  const overlay = el("div", "library-editor-backdrop");
  const box = el("div", "library-editor vid-export");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", t("videoExport.title"));
  const head = el("div", "library-editor-head");
  const close = el("button", "library-editor-close");
  close.type = "button";
  close.setAttribute("aria-label", t("videoExport.close"));
  close.innerHTML = icon("x");
  close.addEventListener("click", closeVideoExport);
  head.append(el("span", "", t("videoExport.title")), close);
  const body = el("div", "vid-export-body");
  box.append(head, body);
  overlay.append(box);
  overlay.addEventListener("keydown", onExportKeydown);
  return { overlay, close, body };
}

/** Open the export for a filmed `take` of `trackId` on song `jobId`, with the stems the player plays. */
export function openVideoExport({ jobId, trackId, take, iPlay, title }) {
  closeVideoExport();
  const parts = dialogFrame();
  dialog = { ...parts, jobId, trackId, take, iPlay, title, view: null, pollFailures: 0, opener: document.activeElement };
  document.body.append(parts.overlay);
  paint();
  parts.body.querySelector("button")?.focus();
}
