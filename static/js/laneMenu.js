// A stem lane's ⋯ menu: what the header's second row holds, for lanes too short to show it.

import { STEM_DISPLAY } from "./constants.js";
import { mixerState } from "./state.js";
import { t } from "./i18n.js";
import { setLanePitch } from "./mixer.js";
import { openTakesMenu } from "./takesMenu.js";
import { OPEN_LANE_EQ_EVENT } from "./eq/eqLaneMark.js";

const UP = 1;
const DOWN = -1;

function openLaneEq(stemName) {
  document.dispatchEvent(new CustomEvent(OPEN_LANE_EQ_EVENT, { detail: { lane: stemName } }));
}

/** A transpose entry that is usable exactly when the header's own step button is, and says why not. */
function transposeEntry(stemName, row, direction) {
  const step = row?.querySelector(`.lane-key-step.${direction === UP ? "up" : "down"}`);
  return {
    text: t(direction === UP ? "studio.lane.transposeUp" : "studio.lane.transposeDown"),
    icon: direction === UP ? "up" : "down",
    disabled: !step || step.disabled,
    title: step?.disabled ? row.querySelector(".lane-key")?.title : "",
    onChoose: function transposeLane() {
      setLanePitch(stemName, (mixerState[stemName]?.pitch ?? 0) + direction);
    },
  };
}

/** Toggle `stemName`'s lane menu under its ⋯ button. */
export function openLaneMenu(stemName, anchor) {
  const name = STEM_DISPLAY[stemName] || stemName;
  const row = anchor.closest(".lane-header");
  openTakesMenu(anchor, t("studio.lane.more", { name }), [
    { text: t("eq.laneMark", { name }), icon: "sliders", onChoose: function chooseLaneEq() { openLaneEq(stemName); } },
    transposeEntry(stemName, row, UP),
    transposeEntry(stemName, row, DOWN),
    { separator: true },
    {
      text: t("aria.download", { name }),
      iconHtml: row?.querySelector(".lane-dl svg")?.outerHTML ?? "",
      onChoose: function chooseStemDownload() { row?.querySelector(".lane-dl")?.click(); },
    },
  ], { alignRight: true });
}
