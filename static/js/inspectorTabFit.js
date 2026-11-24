// Which song-tool tabs go into More when the panel is too narrow for all of them.

const sum = (widths) => widths.reduce((total, w) => total + w, 0);

/** Indices of the tabs that go into More, never `open`; each other tab stays out while it still fits beside More. */
export function overflowTabs({ widths, open, room, moreWidth, gap }) {
  if (sum(widths) + gap * (widths.length - 1) <= room) return [];
  let used = moreWidth + gap + widths[open];
  const hidden = [];
  widths.forEach((width, index) => {
    if (index === open) return;
    if (used + gap + width <= room) used += gap + width;
    else hidden.push(index);
  });
  return hidden;
}
