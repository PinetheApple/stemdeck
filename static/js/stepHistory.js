// Songs in the order they came, with a place among them, stepped through like a
// browser's Back and Forward.

export const BACK = -1;
export const FORWARD = 1;
const NONE = -1;

export function createStepHistory() {
  let ids = [];
  let at = NONE;

  function nearest(step, isListed) {
    for (let i = at + step; i >= 0 && i < ids.length; i += step) {
      if (isListed(ids[i])) return i;
    }
    return NONE;
  }

  return {
    /** `id` comes after the current place; whatever was ahead of it is dropped. */
    visit(id) {
      if (!id || ids[at] === id) return;
      ids = [...ids.slice(0, at + 1), id];
      at = ids.length - 1;
    },
    /** The nearest song `step` away that `isListed` keeps, or null. */
    peek(step, isListed) {
      return ids[nearest(step, isListed)] ?? null;
    },
    /** Move to the nearest song `step` away that `isListed` keeps; null when there is none. */
    go(step, isListed) {
      const to = nearest(step, isListed);
      if (to === NONE) return null;
      at = to;
      return ids[at];
    },
  };
}
