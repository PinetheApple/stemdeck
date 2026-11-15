// The Master view of the EQ tab: master EQ, Glue, and Export loudness.

import { t } from "../i18n.js";
import { audioEngine } from "../state.js";
import { MASTER_LANE, getLaneEq, onFxChange, resetLane, setBypass, setLaneEq } from "../eqEngine.js";
import {
  choosePreset,
  getMaster,
  getPlan,
  getPlanState,
  isMasterOn,
  onChange as onMasterChange,
  setMaster,
  setMasterOn,
  warmLive,
  watch,
} from "../masterEngine.js";
import { EqGraph } from "./eqGraph.js";
import { graphBands } from "./eqPanelModel.js";
import { choosePresetFor, fmtSigned, grFraction, loudnessChoice, loudnessReadout, stepCeiling } from "./masterPanelModel.js";

const $ = (id) => document.getElementById(id);
const PERCENT = 100;
const GR_SCALE_DB = 12;
const GR_UNIT = " dB";

export class EqMasterView {
  #graph;

  constructor() {
    this.#graph = new EqGraph($("eqGraphMaster"), { onEdit: this.#onGraphEdit.bind(this) });
    $("eqPowerMaster").addEventListener("click", this.#onPowerClick.bind(this));
    $("eqGlue").addEventListener("input", this.#onGlueInput.bind(this));
    $("eqGlue").addEventListener("change", this.#onGlueChange.bind(this));
    $("eqLoudness").addEventListener("click", this.#onLoudnessClick.bind(this));
    $("eqCeilingDown").addEventListener("click", this.#onCeilingDownClick.bind(this));
    $("eqCeilingUp").addEventListener("click", this.#onCeilingUpClick.bind(this));
    $("eqFlatMaster").addEventListener("click", this.#onFlatClick.bind(this));
    onFxChange(this.#onFxChange.bind(this));
    onMasterChange(this.render.bind(this));
  }

  get graph() { return this.#graph; }

  show() {
    warmLive(true);
    watch();
    this.render();
  }

  leave() {
    warmLive(false);
  }

  render() {
    this.#renderEq();
    this.#renderGlue();
    this.#renderLoudness();
  }

  /** One meter frame: the glue's gain reduction. */
  tick() {
    const db = audioEngine?.masterFxReduction?.()?.glue ?? null;
    $("eqGrBar").style.width = `${grFraction(db, GR_SCALE_DB) * PERCENT}%`;
    $("eqGrValue").textContent = `${fmtSigned(Number.isFinite(db) ? db : 0)}${GR_UNIT}`;
  }

  #renderEq() {
    const eq = getLaneEq(MASTER_LANE);
    const power = $("eqPowerMaster");
    power.setAttribute("aria-pressed", String(!eq.bypass));
    power.title = t(eq.bypass ? "eq.powerOff" : "eq.power");
    power.setAttribute("aria-label", power.title);
    this.#graph.show({ bands: graphBands(eq), out: eq.params.out, bypass: eq.bypass });
  }

  #renderGlue() {
    const glue = $("eqGlue");
    glue.value = String(Math.round(getMaster().params.comp * PERCENT));
    glue.disabled = !isMasterOn();
    $("eqGlueValue").textContent = `${glue.value}%`;
  }

  #renderLoudness() {
    const master = getMaster();
    const on = isMasterOn();
    const choice = loudnessChoice(master);
    for (const btn of $("eqLoudness").querySelectorAll("[data-choice]")) {
      btn.setAttribute("aria-checked", String(btn.dataset.choice === choice));
    }
    const view = loudnessReadout(master, getPlan(), getPlanState());
    $("eqTargetValue").textContent = view.target;
    $("eqCeilingValue").textContent = view.ceiling;
    $("eqNowLufs").textContent = view.now;
    $("eqGainAtExport").textContent = view.gain;
    $("eqApproxHint").hidden = !on;
    $("eqCeilingDown").disabled = !on;
    $("eqCeilingUp").disabled = !on;
  }

  #onGraphEdit(bands, { commit }) {
    const eq = getLaneEq(MASTER_LANE);
    setLaneEq(MASTER_LANE, { ...eq, params: { ...eq.params, bands } }, { save: commit });
  }

  #onPowerClick() {
    setBypass(MASTER_LANE, !getLaneEq(MASTER_LANE).bypass);
  }

  #setGlue(save) {
    const master = getMaster();
    const comp = Number($("eqGlue").value) / PERCENT;
    setMaster({ ...master, params: { ...master.params, comp } }, { save });
  }

  #onGlueInput() {
    this.#setGlue(false);
  }

  #onGlueChange() {
    this.#setGlue(true);
  }

  #onLoudnessClick(e) {
    const btn = e.target.closest("[data-choice]");
    if (!btn) return;
    const preset = choosePresetFor(btn.dataset.choice);
    if (preset) choosePreset(preset);
    else setMasterOn(false);
  }

  #onCeilingDownClick() {
    setMaster(stepCeiling(getMaster(), -1));
  }

  #onCeilingUpClick() {
    setMaster(stepCeiling(getMaster(), 1));
  }

  #onFlatClick() {
    resetLane(MASTER_LANE);
  }

  #onFxChange({ lane }) {
    if (lane === null || lane === MASTER_LANE) this.render();
  }
}
