// Stage mode's mixer and song-overview maths, apart from the DOM so node can test them.

const ORIGINAL_LANE = "original";
const PERCENT = 100;
const DB_PER_GAIN_DECADE = 20;
const SILENT_DB_TEXT = "-∞";

/** The stems the open song loaded, in lane order: the strips Stage shows. Lanes kept for an absent stem stay out. */
export function loadedStems(trackIndex, loadedNames) {
  const loaded = new Set(loadedNames);
  return Object.entries(trackIndex)
    .filter(([name]) => name !== ORIGINAL_LANE && loaded.has(name))
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name);
}

/** As applyMix hears it: muted, or another loaded lane soloed while this one is not. */
export function isInaudible(name, mixerState, trackIndex) {
  const state = mixerState[name];
  if (!state) return false;
  if (state.muted) return true;
  const anySolo = Object.keys(trackIndex).some((lane) => mixerState[lane]?.soloed);
  return anySolo && !state.soloed;
}

/** Each section's `left` and `width` as percentages of the song, its end clipped to the song's. */
export function sectionSpans(sections, duration) {
  if (!(duration > 0)) return [];
  return sections.map((section, i) => {
    const end = Math.min(duration, section.end ?? sections[i + 1]?.start ?? duration);
    const start = Math.min(duration, section.start);
    return {
      start: section.start,
      name: section.name,
      left: (start / duration) * PERCENT,
      width: (Math.max(0, end - start) / duration) * PERCENT,
    };
  });
}

/** A lane gain as the studio's mixer writes it: dB to one decimal, signed when above unity. */
export function gainDbText(gain) {
  if (gain <= 0) return SILENT_DB_TEXT;
  const db = (DB_PER_GAIN_DECADE * Math.log10(gain)).toFixed(1);
  return parseFloat(db) > 0 ? `+${db}` : db;
}
