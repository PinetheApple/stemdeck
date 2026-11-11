import { t, TRANSLATIONS } from "./i18n.js";

// Fallback list used before /api/config responds. Kept in sync with
// STEM_NAMES in app/core/config.py — the API is the canonical source.
export let STEM_NAMES = ["vocals", "drums", "bass", "guitar", "piano", "other"];
export let TRACK_NAMES = ["original", ...STEM_NAMES];

// Stems from the on-demand lead/backing vocal split (#275, EXTRA_STEM_NAMES
// in app/core/config.py). Not folded into STEM_NAMES/TRACK_NAMES -- most jobs
// never run this split -- but the player/mixer render them as real lanes,
// swapped in for "vocals", via effectiveStemOrder() below.
export let EXTRA_STEM_NAMES = ["lead_vocals", "backing_vocals"];

export async function syncStemNamesFromAPI() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.stem_names) && data.stem_names.length > 0) {
      STEM_NAMES = data.stem_names;
      TRACK_NAMES = ["original", ...STEM_NAMES];
    }
    if (Array.isArray(data.extra_stem_names) && data.extra_stem_names.length > 0) {
      EXTRA_STEM_NAMES = data.extra_stem_names;
    }
  } catch (e) {
    console.warn("[constants] failed to sync stem names from API:", e);
  }
}

// The lane order for a specific job: STEM_NAMES with "vocals" replaced by
// lead_vocals + backing_vocals when a job's on-demand split (#275) has
// produced both. `presentNames` is the Set of stem names the job actually
// has (typically from job.stems). Order matters -- callers use this both to
// decide what to render and in what sequence (waveform stacking, mixer rows).
export function effectiveStemOrder(presentNames) {
  const splitDone = presentNames.has("lead_vocals") && presentNames.has("backing_vocals");
  return STEM_NAMES.flatMap((n) => (n === "vocals" && splitDone ? EXTRA_STEM_NAMES : [n]));
}

// A Proxy, not a plain object, so every lookup resolves through the CURRENT
// language live -- a plain object would freeze these labels in whatever
// language was active the moment this module first loaded. Callers keep their
// existing `STEM_DISPLAY[name] || name` fallback pattern unchanged: an
// unrecognized name (not one of ours) still yields undefined, same as a plain
// object would, rather than the i18n engine's own missing-key fallback
// (which returns the raw dictionary key string -- wrong here).
export const STEM_DISPLAY = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined;
    const key = `stem.${prop}`;
    return key in TRANSLATIONS.en ? t(key) : undefined;
  },
});

export const EMPTY_VALUE = "—";

// Mirrors the --vocals..--other tokens in variables.css: canvases cannot read
// CSS custom properties, so the lane drawings take their colours from here.
export const STEM_COLORS = {
  vocals: "#ff8fab",
  drums: "#ffb45e",
  bass: "#f2dc6b",
  guitar: "#7ddc9a",
  piano: "#a9a2ff",
  other: "#b3b8c0",
  original: "#c9c5c0",
  lead_vocals: "#ff9fb6",
  backing_vocals: "#e3a6e6",
};

export const PROGRESS_COLOR = "#3a3a3a";

export const LOOP_DEFAULT_START_FRAC = 0.25;
export const LOOP_DEFAULT_END_FRAC = 0.5;
// How far the [ and ] keys and the OS seek buttons move the playhead.
export const SEEK_STEP_SEC = 5;

export const LANE_VOLUME_MAX = 2;