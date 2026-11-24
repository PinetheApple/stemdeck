// A stem lane's ⋯ menu: what the header's second row holds, for lanes too short to show
// it. The ⋯ button is marked while the lane's key or EQ is changed, since neither shows.

import { PITCH_STEP, stemDisplayName } from "./constants.js";
import { mixerState } from "./state.js";
import { t } from "./i18n.js";
import { stepLanePitch } from "./mixer.js";
import { canStepLanePitch, laneKeyBlockedReason, laneKeyText } from "./laneKey.js";
import { openRowMenu } from "./rowMenu.js";
import { DOWNLOAD_ICON, hasStemDownload, stemDownloadLink } from "./laneDownload.js";
import { OPEN_LANE_EQ_EVENT } from "./eq/eqLaneMark.js";
import { MARK_STATE, markState } from "./eq/eqPanelModel.js";
import { getLaneEq, onFxChange } from "./eqEngine.js";

const CHANGED_CLASS = "is-changed";
const STATE_SEPARATOR = ", ";

const laneEqOn = (stemName) => markState(getLaneEq(stemName)) === MARK_STATE.active;
const keyHint = (stemName) => t("studio.lane.keyValue", { n: laneKeyText(stemName) });

function openLaneEq(stemName) {
  document.dispatchEvent(new CustomEvent(OPEN_LANE_EQ_EVENT, { detail: { lane: stemName } }));
}

/** What the lane has changed that its hidden row would show. */
function changedState(stemName) {
  const changed = [];
  if (mixerState[stemName]?.pitch) changed.push(keyHint(stemName));
  if (laneEqOn(stemName)) changed.push(t("eq.power"));
  return changed;
}

export function paintLaneMore(btn, stemName) {
  const name = stemDisplayName(stemName);
  const changed = changedState(stemName);
  const label = changed.length
    ? t("studio.lane.moreChanged", { name, state: changed.join(STATE_SEPARATOR) })
    : t("studio.lane.more", { name });
  btn.classList.toggle(CHANGED_CLASS, changed.length > 0);
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

export function refreshLaneMore(stemName) {
  for (const btn of document.querySelectorAll(`.lane-more[data-stem="${stemName}"]`)) paintLaneMore(btn, stemName);
}

function refreshAllLaneMores() {
  for (const btn of document.querySelectorAll(".lane-more[data-stem]")) paintLaneMore(btn, btn.dataset.stem);
}

function followFxChange({ lane }) {
  if (lane) refreshLaneMore(lane);
  else refreshAllLaneMores();
}

onFxChange(followFxChange);

function transposeEntry(stemName, direction) {
  const up = direction > 0;
  return {
    text: t(up ? "studio.lane.transposeUp" : "studio.lane.transposeDown"),
    icon: up ? "up" : "down",
    hint: keyHint(stemName),
    disabled: !canStepLanePitch(stemName, direction),
    title: laneKeyBlockedReason(stemName),
    onChoose: function transposeLane() { stepLanePitch(stemName, direction); },
  };
}

function eqEntry(stemName, name) {
  return {
    text: t("eq.laneMark", { name }),
    icon: "sliders",
    hint: t(laneEqOn(stemName) ? "eq.power" : "eq.powerOff"),
    onChoose: function chooseLaneEq() { openLaneEq(stemName); },
  };
}

function downloadEntry(stemName, name) {
  const ready = hasStemDownload(stemName);
  return {
    text: t("aria.download", { name }),
    iconHtml: DOWNLOAD_ICON,
    link: ready ? stemDownloadLink(stemName) : null,
    disabled: !ready,
  };
}

/** Toggle `stemName`'s lane menu under its ⋯ button. */
export function openLaneMenu(stemName, anchor) {
  const name = stemDisplayName(stemName);
  openRowMenu(
    anchor,
    t("studio.lane.more", { name }),
    [
      eqEntry(stemName, name),
      transposeEntry(stemName, PITCH_STEP),
      transposeEntry(stemName, -PITCH_STEP),
      { separator: true },
      downloadEntry(stemName, name),
    ],
    { alignRight: true },
  );
}
