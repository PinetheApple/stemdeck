// The Tempo tab: each change PATCHes the song's tempo, then the server's grid drives the lanes and the click.

import { metronome } from "./state.js";
import { transport, updateMetronomeAvailability, setMetronomeAccentAuto } from "./transport.js";
import {
  flushBeatGrid, replaceBeatGrid, saveBeatGridTempo, loadBeatGrid, setBeatGridRate,
} from "./beatgrid.js";
import { getCurrentTrackInfo } from "./catalog.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, getLanguage, onLanguageChange } from "./i18n.js";
import { $ } from "./utils.js";

const MODE_CONSTANT = "constant";
const SOURCE_USER = "user";
const SOURCE_DETECTED = "detected";
const MIN_BPM = 30;
const MAX_BPM = 300;
const BPM_STEP = 0.1;
const BPM_DECIMALS = 1;
const MIN_BEATS_PER_BAR = 1;
const MAX_BEATS_PER_BAR = 32;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const MS_PER_MIN = SEC_PER_MIN * MS_PER_SEC;
const NUDGE_MS = 10;
const ANCHOR_DECIMALS = 6;
const ANCHOR_SHOWN_DECIMALS = 3;
const TAP_RESET_MS = 2000;
const TAP_MAX = 8;
const TAP_COMMIT_MS = 700;
const CLICK_RATE_NORMAL = 1;
const RESET_FIELDS = { mode: null, bpm: null, anchor: null, beats_per_bar: null };

let jobId = null;
let grid = null;
let tempo = null;
let unsentFields = null;
let saveInFlight = null;
let refreshSeq = 0;
let taps = [];
let tapTimer = null;
let saveFailed = false;

const roundBpm = (bpm) => Number((Math.round(bpm / BPM_STEP) * BPM_STEP).toFixed(BPM_DECIMALS));
const roundAnchor = (sec) => Number(sec.toFixed(ANCHOR_DECIMALS));
const inBpmRange = (bpm) => Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM;
const clampBeatsPerBar = (n) => Math.max(MIN_BEATS_PER_BAR, Math.min(MAX_BEATS_PER_BAR, Math.round(n)));
const isConstant = () => tempo?.mode === MODE_CONSTANT;
const isUserSet = (field) => Boolean(tempo?.user_keys?.includes(field));
const duration = () => Number(grid?.duration) || 0;
const clickRate = () => metronome?.getMultiplier?.() ?? CLICK_RATE_NORMAL;
const formatNumber = (n, digits) =>
  new Intl.NumberFormat(getLanguage(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const formatBpm = (bpm) => bpm.toFixed(BPM_DECIMALS);
const formatAnchor = (sec) => t("tempo.seconds", { value: formatNumber(sec, ANCHOR_SHOWN_DECIMALS) });

/** The tempo being clicked: the constant BPM, or in follow mode the click's own median tempo. */
export function effectiveBpm() {
  const bpm = isConstant() ? Number(tempo.bpm) : (metronome?.getEffectiveBpm?.() ?? Number(grid?.bpm));
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/** The tempo to show: the one being clicked, else the library's detected BPM. */
export function shownBpm() {
  const library = Number(getCurrentTrackInfo()?.bpm);
  return effectiveBpm() ?? (library > 0 ? library : null);
}

/** Beat 1 moved by `delta` seconds, wrapped by a bar so it stays inside the song. */
function nudgedAnchor(delta) {
  const bar = (SEC_PER_MIN / tempo.bpm) * tempo.beats_per_bar;
  let next = tempo.anchor + delta;
  if (next < 0) next += bar;
  if (next > duration()) next -= bar;
  return roundAnchor(Math.max(0, Math.min(duration(), next)));
}

/** `current` with `fields` applied as the server will: a null field returns to its detected value. */
function withFields(current, fields) {
  const next = { ...current };
  const userKeys = new Set(current.user_keys);
  for (const [field, value] of Object.entries(fields)) {
    if (value === null) {
      userKeys.delete(field);
      next[field] = current.detected?.[field] ?? current[field];
    } else {
      userKeys.add(field);
      next[field] = value;
    }
  }
  next.user_keys = [...userKeys].sort();
  return next;
}

function setClickRate(rate) {
  metronome?.setMultiplier?.(rate);
  setBeatGridRate(clickRate());
}

// ─── server round trip ──────────────────────────────────────

async function refreshGrid(forJob) {
  const seq = ++refreshSeq;
  try {
    await flushBeatGrid();
    const next = await loadBeatGrid(forJob);
    if (seq !== refreshSeq || forJob !== jobId) return;
    applyGrid(next);
  } catch (e) {
    console.warn("[tempoTools] could not reload the beat grid:", e);
  }
}

async function sendUnsentFields(forJob) {
  await flushBeatGrid();
  try {
    while (unsentFields && forJob === jobId) {
      const fields = unsentFields;
      unsentFields = null;
      await saveBeatGridTempo(forJob, fields);
    }
    saveFailed = false;
  } catch (e) {
    console.warn("[tempoTools] could not save the tempo:", e);
    unsentFields = null;
    saveFailed = true;
  } finally {
    if (forJob === jobId) saveInFlight = null;
  }
  await refreshGrid(forJob);
}

/** Optimistic: show, save, then reload the server's grid. */
function patchTempo(fields) {
  if (!jobId || !tempo) return;
  tempo = withFields(tempo, fields);
  unsentFields = { ...unsentFields, ...fields };
  render();
  saveInFlight ??= sendUnsentFields(jobId);
}

function applyGrid(next) {
  grid = next;
  tempo = next?.tempo ?? null;
  if (isConstant()) setClickRate(CLICK_RATE_NORMAL);
  replaceBeatGrid(next);
  updateMetronomeAvailability(next);
  render();
  announce();
}

function announce() {
  document.dispatchEvent(new CustomEvent("tempochange", { detail: { bpm: effectiveBpm() } }));
}

export function setTempoGrid(nextJobId, nextGrid) {
  if (nextJobId !== jobId) {
    unsentFields = null;
    saveInFlight = null;
    taps = [];
    clearTimeout(tapTimer);
    saveFailed = false;
  }
  jobId = nextGrid ? nextJobId : null;
  grid = nextGrid ?? null;
  tempo = nextGrid?.tempo ?? null;
  render();
  announce();
}

// ─── handlers ───────────────────────────────────────────────

function onModeClick(e) {
  const mode = e.target.closest("[data-tempo-mode]")?.dataset.tempoMode;
  if (!mode || mode === tempo?.mode) return;
  const fields = { mode };
  if (mode === MODE_CONSTANT && !Number.isFinite(tempo?.bpm)) fields.bpm = roundBpm(Number(grid.bpm));
  if (mode === MODE_CONSTANT && !Number.isFinite(tempo?.anchor)) fields.anchor = grid.beats?.[0] ?? 0;
  patchTempo(fields);
}

function setBpm(bpm) {
  const next = roundBpm(bpm);
  if (inBpmRange(next)) patchTempo({ bpm: next });
  else render();
}

function onBpmChange(e) {
  setBpm(parseFloat(e.target.value));
}

function onBpmStepClick(e) {
  setBpm(tempo.bpm + Number(e.currentTarget.dataset.step) * BPM_STEP);
}

function commitTaps() {
  if (tempo) patchTempo({ bpm: tempo.bpm });
}

function onTapClick() {
  const now = performance.now();
  taps = taps.filter((at) => now - at < TAP_RESET_MS).concat(now).slice(-TAP_MAX);
  if (taps.length < 2) return;
  const bpm = roundBpm((MS_PER_MIN * (taps.length - 1)) / (now - taps[0]));
  if (!inBpmRange(bpm)) return;
  tempo = { ...tempo, bpm };
  render();
  clearTimeout(tapTimer);
  tapTimer = setTimeout(commitTaps, TAP_COMMIT_MS);
}

function onScaleClick(e) {
  const factor = Number(e.currentTarget.dataset.scale);
  if (isConstant()) {
    setBpm(tempo.bpm * factor);
    return;
  }
  setClickRate(clickRate() === factor ? CLICK_RATE_NORMAL : factor);
  updateMetronomeAvailability(grid);
  render();
  announce();
}

function onNudgeClick(e) {
  const delta = (Number(e.currentTarget.dataset.nudge) * NUDGE_MS) / MS_PER_SEC;
  patchTempo({ anchor: nudgedAnchor(delta) });
}

function onBeatOneClick() {
  const at = transport()?.getCurrentTime?.() ?? 0;
  patchTempo({ anchor: roundAnchor(Math.max(0, Math.min(duration(), at))) });
}

function onBeatsPerBarChange(e) {
  const n = parseInt(e.target.value, 10);
  if (!Number.isFinite(n)) {
    render();
    return;
  }
  setMetronomeAccentAuto();
  patchTempo({ beats_per_bar: clampBeatsPerBar(n) });
}

function onFieldResetClick(e) {
  patchTempo({ [e.currentTarget.dataset.tempoField]: null });
}

function onResetClick() {
  patchTempo(RESET_FIELDS);
}

// ─── rendering ──────────────────────────────────────────────

function setValueUnlessEditing(input, value) {
  if (input && document.activeElement !== input) input.value = value;
}

function paintDetected(chip, field, format) {
  const value = tempo?.detected?.[field];
  chip.hidden = !isUserSet(field);
  chip.firstElementChild.textContent = t("tempo.detectedValue", {
    value: Number.isFinite(value) ? format(value) : EMPTY_VALUE,
  });
}

function paintStepLabels() {
  const step = formatNumber(BPM_STEP, BPM_DECIMALS);
  for (const [id, key] of [["tempoBpmDown", "tempo.slower"], ["tempoBpmUp", "tempo.faster"]]) {
    $(id).title = t(key, { step });
    $(id).setAttribute("aria-label", t(key, { step }));
  }
  const nudges = [["tempoNudgeEarlier", "tempo.nudgeEarlier"], ["tempoNudgeLater", "tempo.nudgeLater"]];
  for (const [id, key] of nudges) {
    $(id).textContent = t(key, { ms: NUDGE_MS });
    $(id).title = t(`${key}Title`, { ms: NUDGE_MS });
  }
}

function render() {
  const ready = Boolean(jobId && tempo);
  const constant = ready && isConstant();
  const bpm = shownBpm();
  $("tempoReadout").textContent = bpm ? formatBpm(bpm) : EMPTY_VALUE;

  const edited = ready && tempo.user_keys?.length > 0;
  const source = $("tempoSource");
  source.hidden = !ready;
  source.dataset.source = edited ? SOURCE_USER : SOURCE_DETECTED;
  source.textContent = t(edited ? "tempo.sourceUser" : "tempo.sourceDetected");

  for (const btn of document.querySelectorAll("[data-tempo-mode]")) {
    btn.disabled = !ready;
    btn.setAttribute("aria-checked", String(ready && btn.dataset.tempoMode === tempo.mode));
  }
  $("tempoModeHint").textContent = t(constant || !ready ? "tempo.constantHint" : "tempo.followHint");

  setValueUnlessEditing($("tempoBpm"), Number.isFinite(tempo?.bpm) ? formatBpm(tempo.bpm) : "");
  setValueUnlessEditing($("tempoBeatsPerBar"), ready ? String(tempo.beats_per_bar) : "");
  $("tempoAnchor").textContent = Number.isFinite(tempo?.anchor) ? formatAnchor(tempo.anchor) : EMPTY_VALUE;
  paintDetected($("tempoBpmDetected"), "bpm", formatBpm);
  paintDetected($("tempoAnchorDetected"), "anchor", formatAnchor);
  paintDetected($("tempoBeatsPerBarDetected"), "beats_per_bar", String);

  for (const id of ["tempoBpm", "tempoBpmDown", "tempoBpmUp", "tempoTap", "tempoNudgeEarlier", "tempoNudgeLater"]) {
    $(id).disabled = !constant;
  }
  $("tempoBeatOne").disabled = !ready;
  $("tempoBeatsPerBar").disabled = !ready;
  $("tempoReset").disabled = !edited;

  for (const btn of [$("tempoHalf"), $("tempoDouble")]) {
    const factor = Number(btn.dataset.scale);
    btn.disabled = !ready || (constant && !inBpmRange(roundBpm(tempo.bpm * factor)));
    btn.setAttribute("aria-pressed", String(ready && !constant && clickRate() === factor));
  }

  const status = $("tempoStatus");
  status.textContent = saveFailed ? t("tempo.saveFailed") : "";
  status.hidden = !saveFailed;
}

function onLanguageSwitch() {
  paintStepLabels();
  render();
}

function onBeatGridSave(e) {
  if (e.detail?.jobId !== jobId || !e.detail.tempo) return;
  tempo = e.detail.tempo;
  if (grid) grid = { ...grid, tempo };
  render();
  announce();
}

function setInputLimits() {
  Object.assign($("tempoBpm"), { min: MIN_BPM, max: MAX_BPM, step: BPM_STEP });
  Object.assign($("tempoBeatsPerBar"), { min: MIN_BEATS_PER_BAR, max: MAX_BEATS_PER_BAR });
}

export function initTempoTools() {
  if (!$("tempoTools")) return;
  setInputLimits();
  $("tempoModeSwitch").addEventListener("click", onModeClick);
  $("tempoBpm").addEventListener("change", onBpmChange);
  $("tempoBpmDown").addEventListener("click", onBpmStepClick);
  $("tempoBpmUp").addEventListener("click", onBpmStepClick);
  $("tempoTap").addEventListener("click", onTapClick);
  $("tempoHalf").addEventListener("click", onScaleClick);
  $("tempoDouble").addEventListener("click", onScaleClick);
  $("tempoNudgeEarlier").addEventListener("click", onNudgeClick);
  $("tempoNudgeLater").addEventListener("click", onNudgeClick);
  $("tempoBeatOne").addEventListener("click", onBeatOneClick);
  $("tempoBeatsPerBar").addEventListener("change", onBeatsPerBarChange);
  for (const chip of document.querySelectorAll("[data-tempo-field]")) chip.addEventListener("click", onFieldResetClick);
  $("tempoReset").addEventListener("click", onResetClick);
  document.addEventListener("beatgridsave", onBeatGridSave);
  document.addEventListener("trackopen", render);
  onLanguageChange(onLanguageSwitch);
  onLanguageSwitch();
}
