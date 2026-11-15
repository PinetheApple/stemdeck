export const SVG_NS = "http://www.w3.org/2000/svg";
export const DRAG_CLASS = "eq-dragging";

export function svgEl(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}
