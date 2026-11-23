export const MIN_WAVES_PX = 320;

export const PANE_LIMITS = Object.freeze({
  sidebar: Object.freeze({ min: 232, max: 380 }),
  stems: Object.freeze({ min: 328, max: 480 }),
  tools: Object.freeze({ min: 320, max: 520 }),
});

/** The width a pane edge may take: inside [min, max], and grown by no more than the waveforms can spare. */
export function clampPaneWidth(px, { min, max, current, spare }) {
  // Floored, so rounding never takes the waveforms under their minimum.
  return Math.round(Math.max(min, Math.min(px, max, Math.floor(current + spare))));
}
