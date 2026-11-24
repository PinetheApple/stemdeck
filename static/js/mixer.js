import {
  STEM_NAMES, TRACK_NAMES, EXTRA_STEM_NAMES, STEM_COLORS, LANE_VOLUME_MAX, KEY_LOCKED_STEM,
} from "./constants.js";

// Every lane name this session might ever need mixer state for, including
// the on-demand lead/backing vocal split (#275). Safe to iterate broadly:
// callers below all guard on the row/trackIndex entry actually existing, so
// touching state for a lane a given job doesn't have is a no-op. A function
// (not a snapshot) because STEM_NAMES/EXTRA_STEM_NAMES are reassigned once
// syncStemNamesFromAPI() resolves -- a const array here would freeze the
// fallback values from before that happens.
function allTrackNames() {
  return [...TRACK_NAMES, ...EXTRA_STEM_NAMES];
}
import {
  mixerState, mixerEl, stemListEl, currentJobId, currentVersionId, multitrack, trackIndex,
  masterVolume, audioEngine,
} from "./state.js";
import { storeGet, storeSetDebounced, storeFlushPending } from "./utils.js";
import { DEFAULT_VERSION_ID, mixStoreKey } from "./versionModel.js";
import { t } from "./i18n.js";
import {
  GLOBAL_PITCH_FIELD, clampPitch, savedGlobalPitch,
} from "./pitchBus.js";
import { applyTakeGains, clearTakeSolos, takeSoloActive } from "./takesMix.js";
import { paintLaneSilence } from "./laneSilence.js";
import { LANE_KEY_CHANGE_EVENT, lanePitch, paintLaneKey, setLaneKeysUsable } from "./laneKey.js";
import {
  bindFxStore,
  ensureFxDefaults,
  loadFxIntoState,
  resetFxState,
} from "./mixFx.js";

function defaultMixerEntry() {
  // `pitch` is the key this lane is actually in, in semitones from the
  // recording's own key. Absolute rather than an offset from the global
  // control, so the number on a lane never has to be added to another number to
  // know what you are hearing. It rides along in the same per-track store as
  // volume and mute, so a lane's key survives a reload.
  return { volume: 1, muted: false, soloed: false, pitch: 0 };
}

export function ensureMixerStateDefaults() {
  for (const name of allTrackNames()) {
    if (!mixerState[name]) mixerState[name] = defaultMixerEntry();
  }
  ensureFxDefaults(allTrackNames());
}

export const MIX_CHANGE_EVENT = "mixchange";

export const announceMixChange = () => document.dispatchEvent(new CustomEvent(MIX_CHANGE_EVENT));

let globalPitch = 0;
// Never saved: a view's silence must not leak into the song's mix.
const silencedStems = new Set();

/** Silence `stemNames` on top of the mix, leaving the mix itself alone. */
export function setSilencedStems(stemNames) {
  silencedStems.clear();
  for (const stemName of stemNames) silencedStems.add(stemName);
  applyMix();
  announceMixChange();
}

export function clearSilencedStems() {
  silencedStems.clear();
  applyMix();
  announceMixChange();
}

export function mixGlobalPitch() {
  return globalPitch;
}

export async function loadMixIntoState(jobId, loadedStemNames = STEM_NAMES, versionId = DEFAULT_VERSION_ID) {
  const key = mixStoreKey(jobId, versionId);
  silencedStems.clear();
  let stored = {};
  try {
    // Write any pending save for this song before reading it.
    await storeFlushPending(key);
    const data = await storeGet(key, {});
    if (data && typeof data === "object") stored = data;
  } catch (e) { console.warn("[mixer] failed to load mix state:", e); }
  for (const name of allTrackNames()) {
    Object.assign(mixerState[name], defaultMixerEntry(), stored[name] || {});
  }
  loadFxIntoState(stored, allTrackNames());
  // If all loaded stems are muted the session is unplayable -- unmute as recovery.
  const loadedStems = loadedStemNames.filter((n) => mixerState[n]);
  if (loadedStems.length > 0 && loadedStems.every((n) => mixerState[n].muted)) {
    for (const name of loadedStems) mixerState[name].muted = false;
  }
  globalPitch = savedGlobalPitch(stored, loadedStemNames);
}

export function resetMixerState() {
  silencedStems.clear();
  for (const name of allTrackNames()) {
    Object.assign(mixerState[name], defaultMixerEntry());
  }
  resetFxState(allTrackNames());
  globalPitch = 0;
}

function saveMix() {
  if (!currentJobId) return;
  storeSetDebounced(mixStoreKey(currentJobId, currentVersionId), { ...mixerState, [GLOBAL_PITCH_FIELD]: globalPitch });
}
bindFxStore({ save: saveMix, laneNames: allTrackNames });

/** Push one lane's transpose into whichever engine is playing. */
export function applyLanePitch(name) {
  if (!audioEngine?.setStemPitch) return;
  audioEngine.setStemPitch(name, lanePitch(name));
}

/** Re-send every lane transpose. Called once an engine finishes starting. */
export function applyAllLanePitches() {
  for (const name of allTrackNames()) {
    if (mixerState[name]) applyLanePitch(name);
    refreshLaneKeyVisual(name);
  }
}

/**
 * Move every lane by `delta` semitones.
 *
 * This is what the transport bar's global control does. It nudges rather than
 * overrides, so a lane deliberately put in a different key keeps its distance
 * from the rest instead of being flattened back in with them.
 */
export function nudgeAllLanePitches(delta) {
  if (!delta) return;
  globalPitch = clampPitch(globalPitch + delta);
  for (const name of allTrackNames()) {
    const state = mixerState[name];
    if (!state || name === KEY_LOCKED_STEM) continue;
    setLanePitch(name, state.pitch + delta);
  }
  saveMix();
}

/** Put the global key and every lane back in the recording's own key. */
export function resetAllLanePitches() {
  globalPitch = 0;
  for (const name of allTrackNames()) {
    if (mixerState[name]) setLanePitch(name, 0);
  }
  saveMix();
}

/**
 * Transpose one lane.
 *
 * Drums are refused here as well as in the engine and the worklet. Three
 * refusals sounds excessive for one rule, but each covers a different way in:
 * this one is the UI, the engine covers a caller reaching past it, and the
 * worklet covers a bus being wired wrong.
 */
export function setLanePitch(name, semitones) {
  const state = mixerState[name];
  if (!state || name === KEY_LOCKED_STEM) return;
  const next = clampPitch(semitones);
  if (state.pitch === next) return;
  state.pitch = next;
  saveMix();
  applyLanePitch(name);
  refreshLaneKeyVisual(name);
}

export function stepLanePitch(name, delta) {
  setLanePitch(name, lanePitch(name) + delta);
}

export function refreshLaneKeyVisual(name) {
  const wrap = mixerEl?.querySelector(`.lane-key[data-stem="${name}"]`);
  if (wrap) paintLaneKey(wrap, name);
  document.dispatchEvent(new CustomEvent(LANE_KEY_CHANGE_EVENT, { detail: { lane: name } }));
}

/**
 * Mark every lane's key stepper usable or not.
 *
 * Without AudioWorklet there is no pitch stage at all, and a stepper that
 * changes its own label while the sound never moves is worse than one that
 * plainly says it cannot.
 */
export function setLaneKeysAvailable(available) {
  setLaneKeysUsable(available);
  for (const wrap of mixerEl?.querySelectorAll(".lane-key") || []) paintLaneKey(wrap, wrap.dataset.stem);
}

/**
 * True when this lane is not heard: muted or silenced, or another loaded lane or a take soloed while this one is not.
 * A silenced lane's solo does not count.
 */
export function isLaneSilenced(name) {
  const s = mixerState[name];
  if (!s) return false;
  if (s.muted || silencedStems.has(name)) return true;
  return anySoloActive() && !s.soloed;
}

/** True when a take or a loaded, unsilenced lane is soloed. */
export function anySoloActive() {
  return takeSoloActive() || allTrackNames().some(
    (lane) => trackIndex[lane] !== undefined && mixerState[lane]?.soloed && !silencedStems.has(lane),
  );
}

/** The lanes this song has mounted, in lane order, without the original. */
export function loadedLaneNames() {
  return Object.keys(trackIndex).filter((n) => n !== "original");
}

const SILENT_DB_TEXT = "-∞";
const DB_PER_GAIN_DECADE = 20;

/** A lane gain as the mixer shows it: dB to one decimal, signed when above unity. */
export function laneGainDbText(gain) {
  if (gain <= 0) return SILENT_DB_TEXT;
  const db = (DB_PER_GAIN_DECADE * Math.log10(gain)).toFixed(1);
  return parseFloat(db) > 0 ? `+${db}` : db;
}

export function applyMix() {
  paintLaneSilence(isLaneSilenced);
  if (!multitrack) return;
  for (const name of allTrackNames()) {
    const s = mixerState[name];
    if (!s) continue;
    const effective = isLaneSilenced(name) ? 0 : s.volume;
    const idx = trackIndex[name];
    if (idx === undefined) continue;

    const targetGain = effective * masterVolume;

    if (audioEngine) {
      // Web Audio engine owns playback: set the per-stem gain directly (no 1.0
      // cap, so >1.0 lane boost works), and skip the streaming volume path —
      // the multitrack is mounted for visuals only and never plays.
      audioEngine.setGain(name, targetGain);
      continue;
    }

    const audioEl = multitrack.audios?.[idx];
    if (audioEl instanceof HTMLMediaElement) {
      // WKWebView does not pass audio through MediaElementSource → GainNode →
      // destination. Use the native HTMLAudioElement volume path instead and
      // cap at 1.0 (the spec limit). Boost above unity is not supported on
      // this platform but basic volume/mute works reliably.
      audioEl.volume = Math.max(0, Math.min(1, targetGain));
    } else {
      multitrack.setTrackVolume(idx, targetGain);
    }
  }
  applyTakeGains(anySoloActive());
}

export function updateLaneKnobVisual(knobEl, v) {
  const frac = Math.max(0, Math.min(1, v / LANE_VOLUME_MAX));
  knobEl.style.setProperty("--lane-pos", frac.toFixed(3));
  knobEl.setAttribute("aria-valuenow", v.toFixed(2));
  const input = knobEl.querySelector(".mx-fader-input");
  if (input) {
    input.value = String(v);
    // Set --lane-pos directly on the input so ::webkit-slider-runnable-track
    // can see it — WebKit shadow DOM pseudo-elements don't inherit vars from ancestors.
    input.style.setProperty("--lane-pos", frac.toFixed(3));
  }
  const val = knobEl.closest(".lane-header")?.querySelector(".mx-val");
  if (val) val.textContent = laneGainDbText(v);
}

export function setLaneVolume(name, v) {
  const state = mixerState[name];
  if (!state) return;
  state.volume = Math.max(0, Math.min(LANE_VOLUME_MAX, v));
  const knob = mixerEl.querySelector(`.lane-knob[data-stem="${name}"]`);
  if (knob) updateLaneKnobVisual(knob, state.volume);
  applyMix();
  saveMix();
  announceMixChange();
}

export function refreshMixerVisuals() {
  for (const name of allTrackNames()) {
    const state = mixerState[name];
    if (!state) continue;
    // Mixer-column lane header
    const row = mixerEl.querySelector(`.lane-header[data-stem="${name}"]`);
    if (row) {
      const muteBtn = row.querySelector(".mute");
      const soloBtn = row.querySelector(".solo");
      if (soloBtn) {
        soloBtn.classList.toggle("active", state.soloed);
        soloBtn.setAttribute("aria-pressed", String(state.soloed));
      }
      const iconToggle = row.querySelector(".lane-icon-toggle");
      if (iconToggle) {
        iconToggle.classList.toggle("active", state.muted);
        iconToggle.setAttribute("aria-pressed", String(state.muted));
      }
      row.querySelector(".lane-name")?.setAttribute("aria-pressed", String(state.muted));
      row.classList.toggle("muted", state.muted);
      const knob = row.querySelector(".lane-knob");
      if (knob) updateLaneKnobVisual(knob, state.volume);
    }
    // Stems-list panel row (mirrors the mixer column buttons)
    if (stemListEl) {
      const slRow = stemListEl.querySelector(`span[data-stem="${name}"]`);
      if (slRow) {
        const m = slRow.querySelector(".stem-mute");
        const s = slRow.querySelector(".stem-solo");
        const mon = slRow.querySelector(".stem-monitor");
        if (m) {
          m.classList.toggle("active", state.muted);
          m.setAttribute("aria-pressed", String(state.muted));
        }
        if (s) {
          s.classList.toggle("active", state.soloed);
          s.setAttribute("aria-pressed", String(state.soloed));
        }
        if (mon) {
          // Active when this stem is THE lone solo (the "monitor" target).
          const others = allTrackNames().filter((n) => n !== name);
          const lone = state.soloed
            && others.every((n) => !mixerState[n]?.soloed);
          mon.classList.toggle("active", lone);
        }
        slRow.classList.toggle("muted", state.muted);
      }
    }
  }
  announceMixChange();
}

export function setLaneControlsEnabled(enabled) {
  for (const b of mixerEl.querySelectorAll(".ms-btn")) b.disabled = !enabled;
  for (const b of mixerEl.querySelectorAll(".lane-icon-toggle, .lane-name, .lane-more")) b.disabled = !enabled;
  for (const a of mixerEl.querySelectorAll(".lane-dl")) {
    a.classList.toggle("disabled", !enabled);
    if (!enabled) {
      a.setAttribute("aria-disabled", "true");
      a.setAttribute("tabindex", "-1");
    } else {
      a.removeAttribute("aria-disabled");
      a.removeAttribute("tabindex");
    }
  }
  for (const k of mixerEl.querySelectorAll(".lane-knob")) {
    k.classList.toggle("disabled", !enabled);
    k.setAttribute("aria-disabled", String(!enabled));
    k.setAttribute("tabindex", enabled ? "0" : "-1");
  }
}

const MINI_WAVE_BARS = 40;
const MINI_WAVE_VIEWBOX_H = 26;

function emptyMiniWaveSvg(stemName) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "lane-mini-wave");
  svg.dataset.stem = stemName;
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("viewBox", `0 0 ${MINI_WAVE_BARS * 2} ${MINI_WAVE_VIEWBOX_H}`);
  return svg;
}

function makeMiniWaveSvg(stemName, color) {
  // Seeded placeholder bars used while real peaks haven't loaded yet.
  let s = 0;
  for (const c of stemName) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const svg = emptyMiniWaveSvg(stemName);
  for (let i = 0; i < MINI_WAVE_BARS; i++) {
    const env = Math.sin((i / MINI_WAVE_BARS) * Math.PI) * 0.7 + 0.3;
    const h = Math.max(2, env * (rng() * 0.6 + 0.25) * MINI_WAVE_VIEWBOX_H);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", `${i * 2}`);
    rect.setAttribute("y", `${(MINI_WAVE_VIEWBOX_H - h) / 2}`);
    rect.setAttribute("width", "1");
    rect.setAttribute("height", `${h}`);
    rect.setAttribute("fill", color);
    rect.setAttribute("opacity", "0.6");
    svg.appendChild(rect);
  }
  return svg;
}

export function renderRealMiniWave(stemName, audioBuffer, color) {
  const svg = mixerEl.querySelector(`.lane-mini-wave[data-stem="${stemName}"]`);
  if (!svg || !audioBuffer || typeof audioBuffer.getChannelData !== "function") return;
  const ch = audioBuffer.getChannelData(0);
  if (!ch || !ch.length) return;
  const binSize = Math.max(1, Math.floor(ch.length / MINI_WAVE_BARS));
  const peaks = new Array(MINI_WAVE_BARS);
  let max = 0;
  for (let i = 0; i < MINI_WAVE_BARS; i++) {
    const start = i * binSize;
    const end = i === MINI_WAVE_BARS - 1 ? ch.length : start + binSize;
    let p = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(ch[j]);
      if (v > p) p = v;
    }
    peaks[i] = p;
    if (p > max) max = p;
  }
  const norm = max > 0 ? 1 / max : 0;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (let i = 0; i < MINI_WAVE_BARS; i++) {
    const h = Math.max(1.5, peaks[i] * norm * MINI_WAVE_VIEWBOX_H);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", `${i * 2}`);
    rect.setAttribute("y", `${(MINI_WAVE_VIEWBOX_H - h) / 2}`);
    rect.setAttribute("width", "1");
    rect.setAttribute("height", `${h}`);
    rect.setAttribute("fill", color);
    rect.setAttribute("opacity", "0.95");
    svg.appendChild(rect);
  }
}

// Peaks-based mini-wave for the streaming/chunked engine path, where no full
// decoded buffer is available. `pts` is the backend peaks.json array for the
// stem: [[min,max], ...] (1500 points). Mirrors renderRealMiniWave's bar layout.
export function renderRealMiniWaveFromPeaks(stemName, pts, color) {
  const svg = mixerEl.querySelector(`.lane-mini-wave[data-stem="${stemName}"]`);
  if (!svg || !pts?.length) return;
  const binSize = Math.max(1, Math.floor(pts.length / MINI_WAVE_BARS));
  const peaks = new Array(MINI_WAVE_BARS);
  let max = 0;
  for (let i = 0; i < MINI_WAVE_BARS; i++) {
    const start = i * binSize;
    const end = i === MINI_WAVE_BARS - 1 ? pts.length : start + binSize;
    let p = 0;
    for (let j = start; j < end; j++) {
      const v = Math.max(Math.abs(pts[j][0]), Math.abs(pts[j][1]));
      if (v > p) p = v;
    }
    peaks[i] = p;
    if (p > max) max = p;
  }
  const norm = max > 0 ? 1 / max : 0;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (let i = 0; i < MINI_WAVE_BARS; i++) {
    const h = Math.max(1.5, peaks[i] * norm * MINI_WAVE_VIEWBOX_H);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", `${i * 2}`);
    rect.setAttribute("y", `${(MINI_WAVE_VIEWBOX_H - h) / 2}`);
    rect.setAttribute("width", "1");
    rect.setAttribute("height", `${h}`);
    rect.setAttribute("fill", color);
    rect.setAttribute("opacity", "0.95");
    svg.appendChild(rect);
  }
}

// ─── Drag preview ───
//
// What follows the cursor when a lane is dragged out to the OS.
//
// The lane's instrument glyph was the obvious choice and was wrong: these are
// 24px line icons, and at the size a drag image is drawn they stop reading as
// instruments -- the bass turns into a key, the kit into a face. A word cannot
// be misread. It is also the same word the lane is labelled with, so nothing
// has to be recognised at all.
//
// Built on demand rather than cached: it is a few canvas calls with no image
// decode, so there is nothing to save, and a cache would go stale the moment
// the language changed.

const PREVIEW_H = 64;
const PREVIEW_FONT = '700 30px system-ui, -apple-system, "Segoe UI", sans-serif';

export function laneDragIcon(stemName) {
  try {
    const label = t(`stem.${stemName}`) || stemName;
    const canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");
    ctx.font = PREVIEW_FONT;
    // Sizing the canvas resets every context property, so the font is set
    // once to measure and again to draw.
    canvas.width = Math.ceil(ctx.measureText(label).width) + 52;
    canvas.height = PREVIEW_H;
    ctx = canvas.getContext("2d");
    ctx.font = PREVIEW_FONT;

    // An opaque plate: a drag image that is transparent except for the letters
    // is close to unreadable over a DAW timeline.
    ctx.fillStyle = "rgba(15, 16, 17, 0.94)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(0, 0, canvas.width, PREVIEW_H, 14);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, canvas.width, PREVIEW_H);
    }

    ctx.fillStyle = STEM_COLORS[stemName] || STEM_COLORS.original;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, canvas.width / 2, PREVIEW_H / 2 + 1);

    return canvas.toDataURL("image/png").split(",")[1];
  } catch (e) {
    // Rust falls back to the app icon, which is a worse picture and a working
    // drag.
    console.warn("[stemdeck] could not build a drag preview for", stemName, e);
    return null;
  }
}

// ─── Stem-list panel (Stems sidebar) ───
//
// The stems-list panel renders a parallel set of M / S / Monitor controls
// that share state with the mixer-column lane-header buttons. Both UIs
// drive `mixerState`; either one updates the audio mix and both visuals
// re-render via refreshMixerVisuals().

export function toggleStemMute(name) {
  const state = mixerState[name];
  if (!state) return;
  state.muted = !state.muted;
  refreshMixerVisuals();
  applyMix();
  saveMix();
}

export function toggleStemSolo(name) {
  const state = mixerState[name];
  if (!state) return;
  state.soloed = !state.soloed;
  refreshMixerVisuals();
  applyMix();
  saveMix();
}

// "Monitor" = solo only this stem. If already the lone solo, clear all
// solos (toggle-style behavior, like Logic's "Solo Safe" / Reaper's
// solo-exclusive). Also clears mute on the target so it's audible.
export function soloOnlyStem(name) {
  const state = mixerState[name];
  if (!state) return;
  const others = allTrackNames().filter((n) => n !== name);
  const isAlreadyAlone = state.soloed && others.every((n) => !mixerState[n]?.soloed);
  if (isAlreadyAlone) {
    state.soloed = false;
  } else {
    for (const n of allTrackNames()) {
      if (!mixerState[n]) continue;
      mixerState[n].soloed = (n === name);
    }
    state.muted = false;
  }
  refreshMixerVisuals();
  applyMix();
  saveMix();
}

function commitMixChange() {
  refreshMixerVisuals();
  applyMix();
  saveMix();
}

export function resetMixer() {
  for (const name of allTrackNames()) {
    const s = mixerState[name];
    if (!s) continue;
    s.volume = 1;
    s.muted = false;
    s.soloed = false;
  }
  commitMixChange();
}

export function muteAll() {
  // Toggle direction reflects the lanes actually loaded for this job (base 6,
  // or drums/bass/lead_vocals/backing_vocals/guitar/piano/other when the
  // on-demand split, #275, is active) rather than always the fixed 6 --
  // trackIndex is the live "what's actually mounted" source of truth.
  const loadedNames = loadedLaneNames();
  const allMuted = loadedNames.length > 0 && loadedNames.every((n) => mixerState[n]?.muted);
  for (const name of allTrackNames()) {
    const s = mixerState[name];
    if (!s) continue;
    s.muted = !allMuted;
  }
  commitMixChange();
}

export function clearAllSolos() {
  for (const name of allTrackNames()) {
    const s = mixerState[name];
    if (!s) continue;
    s.soloed = false;
  }
  commitMixChange();
}

export function setLaneMutes(mutedByLane) {
  for (const name of allTrackNames()) {
    const s = mixerState[name];
    if (!s) continue;
    s.soloed = false;
    if (name in mutedByLane) s.muted = mutedByLane[name];
  }
  clearTakeSolos();
  commitMixChange();
}

export function wireMixerToolbar() {
  document.getElementById("mixer-reset")?.addEventListener("click", resetMixer);
  document.getElementById("mixer-mute-all")?.addEventListener("click", muteAll);
  document.getElementById("mixer-clear-solo")?.addEventListener("click", clearAllSolos);
}

export function wireStemListControls() {
  if (!stemListEl) return;
  for (const btn of stemListEl.querySelectorAll(".stem-mute")) {
    btn.addEventListener("click", () => toggleStemMute(btn.dataset.stem));
    btn.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        toggleStemMute(btn.dataset.stem);
      }
    });
  }
  for (const btn of stemListEl.querySelectorAll(".stem-solo")) {
    btn.addEventListener("click", () => toggleStemSolo(btn.dataset.stem));
    btn.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        toggleStemSolo(btn.dataset.stem);
      }
    });
  }
  for (const btn of stemListEl.querySelectorAll(".stem-monitor")) {
    btn.addEventListener("click", () => soloOnlyStem(btn.dataset.stem));
  }
}
