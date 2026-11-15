import { t } from "../i18n.js";
import { getLaneEq, setBypass, setLaneEq } from "../eqEngine.js";

/** A power button's state: pressed while the EQ plays, disabled while a suggestion is pending. */
export function renderPower(button, eq, { disabled = false } = {}) {
  button.setAttribute("aria-pressed", String(!eq.bypass));
  button.title = t(eq.bypass ? "eq.powerOff" : "eq.power");
  button.setAttribute("aria-label", button.title);
  button.disabled = disabled;
}

/** Store a graph edit on a lane (or the master); `commit` saves it. */
export function editLaneBands(lane, bands, { commit }) {
  const eq = getLaneEq(lane);
  setLaneEq(lane, { ...eq, params: { ...eq.params, bands } }, { save: commit });
}

export function toggleLaneBypass(lane) {
  setBypass(lane, !getLaneEq(lane).bypass);
}
