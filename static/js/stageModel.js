// Stage mode's shared helpers: section placement, kept apart from the DOM so node can test it.

export const PERCENT = 100;

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

/** Writes `text` into `el` unless `painted[key]` says it is already there, so a frame that changes nothing writes nothing. */
export function setTextOnce(painted, key, el, text) {
  if (!el || painted[key] === text) return;
  painted[key] = text;
  el.textContent = text;
}
