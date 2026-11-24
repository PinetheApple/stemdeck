// Greys a stem lane, header and waveform, while it is not heard: muted, or silenced by a solo elsewhere.

export const SILENT_CLASS = "is-silent";
const LANE_PARTS = ".mixer-column .lane-header[data-stem], .stem-waveform-row[data-stem]";

export function paintLaneSilence(isSilenced) {
  for (const part of document.querySelectorAll(LANE_PARTS)) {
    part.classList.toggle(SILENT_CLASS, isSilenced(part.dataset.stem));
  }
}
