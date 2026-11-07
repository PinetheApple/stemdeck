// Transcribe lyrics on demand (#30): offers a run of .../lyrics/transcribe for a
// song with none, and follows it in the Lyrics toolbar; lyrics.js draws the result.

import { t, getLanguage } from "./i18n.js";
import { toolButton, setToolLabel, TOOL_QUIET } from "./lyricsToolbar.js";
import { RUN_STATE } from "./lyricsRunState.js";

const POLL_MS = 1000;
// Polls in a row that got no answer before the run is given up for failed.
const MAX_FAILED_POLLS = 3;
const HTTP_CONFLICT = 409;
const DEVICE_CPU = "cpu";
const FAILED_VIEW = { state: RUN_STATE.FAILED, available: true };
const PHASE_KEYS = {
  queued: "lyrics.transcribe.queued",
  load: "lyrics.transcribe.loading",
  download: "lyrics.transcribe.downloading",
  transcribe: "lyrics.transcribe.running",
};
// Only these phases report how far they are; the others stay at 0.
const MEASURED_PHASES = new Set(["download", "transcribe"]);
const OUTCOME_KEYS = {
  [RUN_STATE.NO_SINGING]: "lyrics.transcribe.noSinging",
  [RUN_STATE.FAILED]: "lyrics.transcribe.failed",
};
// A run that ended with lyrics on the server: its own, or ones that came meanwhile.
const LYRICS_STATES = new Set([RUN_STATE.DONE, RUN_STATE.HAS_LYRICS]);

let deps = null;
let ui = null;
let token = 0; // a redraw or another song makes every answer under way stale
let shownFor = null; // the song the option and progress are for
let pollTimer = 0;

const jobUrl = (trackId) => `/api/jobs/${encodeURIComponent(trackId)}`;
const transcribeUrl = (trackId) => `${jobUrl(trackId)}/lyrics/transcribe`;

async function fetchState(trackId) {
  try {
    const res = await fetch(transcribeUrl(trackId));
    if (res.ok) return await res.json();
    console.warn("lyrics transcription state refused", res.status);
  } catch (err) {
    console.warn("lyrics transcription state failed", err);
  }
  return null;
}

function formatPercent(share) {
  return new Intl.NumberFormat(getLanguage(), { style: "percent" }).format(share);
}

function messageFor(state) {
  if (state.state === RUN_STATE.RUNNING) return t(PHASE_KEYS[state.phase] ?? PHASE_KEYS.transcribe);
  const outcome = OUTCOME_KEYS[state.state];
  if (outcome) return t(outcome);
  return state.device === DEVICE_CPU ? t("lyrics.transcribe.cpuNote") : "";
}

function paintProgress({ phase, progress }) {
  const share = Number(progress);
  const measured = MEASURED_PHASES.has(phase) && Number.isFinite(share);
  if (measured) ui.bar.value = Math.min(1, Math.max(0, share));
  else ui.bar.removeAttribute("value");
  ui.percent.textContent = measured ? formatPercent(ui.bar.value) : "";
}

const canTakeFocus = (node) => !node.closest("[hidden]") && !node.disabled;

/** Focus leaving a control that went away goes to Cancel while the run
 * goes on, else to the first toolbar button still there. */
function refocus(running) {
  const target = running ? ui.cancel : [ui.start, ...ui.toolbar.querySelectorAll(".lyrics-tool")].find(canTakeFocus);
  target?.focus();
}

/** Show `state` (the server's answer, or null for nothing to offer). */
function paint(state) {
  const focusWasOurs = ui.start.contains(document.activeElement) || ui.panel.contains(document.activeElement);
  const running = state?.state === RUN_STATE.RUNNING;
  const offered = running || Boolean(state?.available);
  ui.start.hidden = !state?.available || running;
  ui.start.removeAttribute("aria-busy");
  ui.progress.hidden = !running;
  if (!running) ui.cancel.removeAttribute("aria-busy");
  ui.message.textContent = offered ? messageFor(state) : "";
  ui.panel.hidden = !offered || (!running && !ui.message.textContent);
  if (running) paintProgress(state);
  const focusLost = document.activeElement === document.body || document.activeElement?.closest("[hidden], :disabled");
  if (focusWasOurs && focusLost) refocus(running);
}

function schedulePoll(trackId, mine, failures = 0) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => poll(trackId, mine, failures), POLL_MS);
}

async function poll(trackId, mine, failures) {
  const state = await fetchState(trackId);
  if (mine !== token) return;
  if (!state) {
    if (failures + 1 >= MAX_FAILED_POLLS) paint(FAILED_VIEW);
    else schedulePoll(trackId, mine, failures + 1);
    return;
  }
  if (state.state === RUN_STATE.RUNNING) {
    paint(state);
    schedulePoll(trackId, mine);
    return;
  }
  if (LYRICS_STATES.has(state.state)) {
    deps.onLyrics(trackId);
    return;
  }
  paint(state);
}

/** Hide the option and stop following a run: other lyrics or another song are on screen. */
export function resetTranscribe() {
  token++;
  shownFor = null;
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (!ui) return;
  // Every redraw comes here, so the labels follow a change of language.
  setToolLabel(ui.start, t("lyrics.transcribe.open"));
  setToolLabel(ui.cancel, t("lyrics.edit.cancel"));
  paint(null);
}

/** For `trackId`, open with no lyrics: offer a transcription, or follow one under way. */
export async function checkTranscribe(trackId) {
  resetTranscribe();
  if (!trackId) return;
  const mine = token;
  const state = await fetchState(trackId);
  if (mine !== token) return;
  shownFor = trackId;
  paint(state);
  if (state?.state === RUN_STATE.RUNNING) schedulePoll(trackId, mine);
}

async function onStartClick() {
  const trackId = shownFor;
  if (!trackId || ui.start.getAttribute("aria-busy") === "true") return;
  const mine = token;
  // Busy rather than disabled: a disabled button drops focus to the page.
  ui.start.setAttribute("aria-busy", "true");
  let res = null;
  try {
    res = await fetch(transcribeUrl(trackId), { method: "POST" });
  } catch (err) {
    console.warn("lyrics transcription start failed", err);
  }
  if (mine !== token) return;
  // Refused for a reason the view was too old to know: draw it afresh.
  if (res?.status === HTTP_CONFLICT) return deps.onStale(trackId);
  const state = res?.ok ? await res.json().catch(() => null) : null;
  if (mine !== token) return;
  if (!state) {
    if (res) console.warn("lyrics transcription refused", res.status);
    paint(FAILED_VIEW);
    return;
  }
  paint(state);
  if (state.state === RUN_STATE.RUNNING) schedulePoll(trackId, mine);
}

/** The job's own cancel stops its lyrics runs; the next poll says cancelled. */
async function onCancelClick() {
  const trackId = shownFor;
  if (!trackId || ui.cancel.getAttribute("aria-busy") === "true") return;
  ui.cancel.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(`${jobUrl(trackId)}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn("lyrics transcription cancel failed", err);
    ui.cancel.removeAttribute("aria-busy");
  }
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.className = "lyrics-transcribe";
  const message = document.createElement("p");
  message.className = "lyrics-transcribe-message";
  message.id = "lyricsTranscribeMessage";
  message.setAttribute("aria-live", "polite");
  const progress = document.createElement("div");
  progress.className = "lyrics-transcribe-progress";
  const bar = document.createElement("progress");
  bar.max = 1;
  bar.setAttribute("aria-labelledby", message.id);
  const percent = document.createElement("span");
  percent.className = "lyrics-transcribe-percent";
  const cancel = toolButton(`${TOOL_QUIET} lyrics-transcribe-cancel`, "x", t("lyrics.edit.cancel"), onCancelClick);
  progress.append(bar, percent, cancel);
  panel.append(message, progress);
  return { panel, message, progress, bar, percent, cancel };
}

/**
 * Put the Transcribe lyrics button and its progress in `toolbar`.
 * `dependencies`: onLyrics(trackId) when a run left lyrics on the
 * server; onStale(trackId) when the server refused a start the view allowed.
 */
export function initLyricsTranscribe(toolbar, dependencies) {
  deps = dependencies;
  const start = toolButton("lyrics-transcribe-open", "mic", t("lyrics.transcribe.open"), onStartClick);
  ui = { toolbar, start, ...buildPanel() };
  toolbar.append(start, ui.panel);
  paint(null);
}
