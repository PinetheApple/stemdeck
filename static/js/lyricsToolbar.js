// The Lyrics tab's toolbar buttons (#31): every action there is one of these,
// an icon and a label, in one of three weights.

import { icon } from "./libraryIcons.js";

export const TOOL_PRIMARY = "lyrics-tool-primary";
export const TOOL_QUIET = "lyrics-tool-quiet";

/** A toolbar button with a Lucide icon; `className` adds its own classes. */
export function toolButton(className, iconName, label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `lyrics-tool ${className}`;
  node.innerHTML = icon(iconName);
  const text = document.createElement("span");
  text.className = "lyrics-tool-label";
  node.append(text);
  setToolLabel(node, label);
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

export function setToolLabel(node, label) {
  node.querySelector(".lyrics-tool-label").textContent = label;
}

const isShown = (node) => !node.closest("[hidden]");

/** Keep exactly one main action in `toolbar`: the first shown match of
 * `order`, or none while `paused()`. Follows the buttons as they change. */
export function keepOnePrimary(toolbar, order, paused) {
  const pick = () => {
    const main = paused() ? null : order.map((selector) => [...toolbar.querySelectorAll(selector)].find(isShown)).find(Boolean);
    for (const node of toolbar.querySelectorAll(".lyrics-tool")) node.classList.toggle(TOOL_PRIMARY, node === main);
  };
  new MutationObserver(pick).observe(toolbar, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-disabled"],
  });
  pick();
}
