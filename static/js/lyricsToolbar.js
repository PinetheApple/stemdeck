// The Lyrics tab's toolbar buttons (#31): every action there is one of these,
// an icon and a label, in one of three weights.

import { icon } from "./libraryIcons.js";

export const TOOL_PRIMARY = "lyrics-tool-primary";
export const TOOL_QUIET = "lyrics-tool-quiet";

/** A toolbar button with a Lucide icon; `className` adds its own classes. */
export function toolButton(className, iconName, label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className ? `lyrics-tool ${className}` : "lyrics-tool";
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
