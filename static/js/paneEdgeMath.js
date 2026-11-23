/** The width a pane edge may take: inside [min, max], and grown by no more than the waveforms can spare. */
export function clampPaneWidth(px, { min, max, current, spare }) {
  return Math.round(Math.max(min, Math.min(px, max, current + spare)));
}
