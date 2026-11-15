// The small curve mark in the top-left corner of each lane header: dim while
// the lane's EQ is flat, coral once it changes the sound. A click opens the
// EQ tab on that lane.

import { t } from "../i18n.js";
import { STEM_DISPLAY } from "../constants.js";
import { getLaneEq, onFxChange } from "../mixFx.js";
import { markPath, markState } from "./eqPanelModel.js";

export const OPEN_LANE_EQ_EVENT = "eq:openlane";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARK_BOX = Object.freeze({ w: 18, h: 10 });
const MARK_SELECTOR = ".eq-lane-mark[data-lane]";

function onLaneMarkClick(e) {
  e.stopPropagation();
  const { lane } = e.currentTarget.dataset;
  document.dispatchEvent(new CustomEvent(OPEN_LANE_EQ_EVENT, { detail: { lane } }));
}

function paintMark(mark) {
  const { lane } = mark.dataset;
  const eq = getLaneEq(lane);
  const label = t("eq.laneMark", { name: STEM_DISPLAY[lane] || lane });
  mark.dataset.eq = markState(eq);
  mark.querySelector("path").setAttribute("d", markPath(eq, MARK_BOX));
  mark.setAttribute("aria-label", label);
  mark.title = label;
}

/** A lane's EQ mark, for the lane row builder to put in the header. */
export function createLaneEqMark(lane) {
  const mark = document.createElement("button");
  mark.type = "button";
  mark.className = "eq-lane-mark";
  mark.dataset.lane = lane;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MARK_BOX.w} ${MARK_BOX.h}`);
  svg.setAttribute("aria-hidden", "true");
  svg.appendChild(document.createElementNS(SVG_NS, "path"));
  mark.appendChild(svg);
  mark.addEventListener("click", onLaneMarkClick);
  paintMark(mark);
  return mark;
}

/** Repaint every mark, or only `lane`'s. */
export function refreshLaneMarks(lane = null) {
  for (const mark of document.querySelectorAll(MARK_SELECTOR)) {
    if (lane === null || mark.dataset.lane === lane) paintMark(mark);
  }
}

function followFxChange({ lane }) {
  refreshLaneMarks(lane ?? null);
}

onFxChange(followFxChange);
