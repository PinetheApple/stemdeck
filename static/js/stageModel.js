// Stage mode's helpers: which stems get a strip, where sections sit, and text written only on change.

export const PERCENT = 100;

/** The mixer's lanes, in lane order, that the song actually loaded: lanes kept for an absent stem get no strip. */
export function stripStems(laneNames, loadedNames) {
  const loaded = new Set(loadedNames);
  return laneNames.filter((name) => loaded.has(name));
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

/** Writes `text` into `el` unless `painted[key]` says it is already there, so a frame that changes nothing writes nothing. */
export function setTextOnce(painted, key, el, text) {
  if (!el || painted[key] === text) return;
  painted[key] = text;
  el.textContent = text;
}
