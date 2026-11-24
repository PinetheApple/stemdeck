// Which song-tool tabs go into More when the panel is too narrow for all of them.

const sum = (widths) => widths.reduce((total, w) => total + w, 0);

/**
 * Indices of the tabs that move into More, in order: none when every tab fits
 * in `room`, never `open`. Each tab after the open one stays out while it still
 * fits beside More, as the prototype's panel does.
 */
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
