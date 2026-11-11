// The styled select list's decisions, kept free of the DOM: which option a
// key leads to, which option typing matches, and where the list opens.
// `disabled` is one flag per option, in the select's option order.

const NOT_FOUND = -1;
const LEADING_SYMBOLS = /^[^\p{L}\p{N}]+/u;

/** The first enabled option from the top, or from the bottom with `fromEnd`. */
export function edgeIndex(disabled, fromEnd) {
  const step = fromEnd ? -1 : 1;
  for (let i = fromEnd ? disabled.length - 1 : 0; i >= 0 && i < disabled.length; i += step) {
    if (!disabled[i]) return i;
  }
  return NOT_FOUND;
}

/** The next enabled option `step` away from `from`; stays put at either end. */
export function stepIndex(disabled, from, step) {
  if (from < 0) return edgeIndex(disabled, step < 0);
  for (let i = from + step; i >= 0 && i < disabled.length; i += step) {
    if (!disabled[i]) return i;
  }
  return from;
}

const comparable = (label) => label.trim().replace(LEADING_SYMBOLS, "").toLocaleLowerCase();

/**
 * The enabled option whose label starts with what was typed, searching on from
 * `from`. Pressing one letter again and again cycles through the options that
 * start with it. Leading symbols such as flags are skipped.
 */
export function typeaheadIndex(labels, disabled, typed, from) {
  const query = typed.toLocaleLowerCase();
  const chars = [...query];
  if (!chars.length) return NOT_FOUND;
  const cycling = chars.every((c) => c === chars[0]);
  const needle = cycling ? chars[0] : query;
  const start = cycling ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < labels.length; k++) {
    const i = (start + k) % labels.length;
    if (!disabled[i] && comparable(labels[i]).startsWith(needle)) return i;
  }
  return NOT_FOUND;
}

/**
 * Where the list goes: below the select, or above it when the list does not
 * fit below and there is more room above. Its height is capped to the room on
 * the chosen side and its left edge kept inside the viewport.
 */
export function placeList({ anchor, listWidth, listHeight, viewport, gap, margin }) {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const flipped = listHeight > below && above > below;
  const maxHeight = Math.max(0, flipped ? above : below);
  const height = Math.min(listHeight, maxHeight);
  const rightmost = viewport.width - margin - listWidth;
  return {
    top: flipped ? anchor.top - gap - height : anchor.bottom + gap,
    left: Math.max(margin, Math.min(anchor.left, rightmost)),
    maxHeight,
    flipped,
  };
}
