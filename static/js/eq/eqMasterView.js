import { $ } from "../utils.js";
import { audioEngine, currentJobId } from "../state.js";
import { MASTER_LANE, getLaneEq, onFxChange, previewLaneEq, resetLane, setLaneEq } from "../eqEngine.js";
import {
  choosePreset,
  currentMixSource,
  getMaster,
  getPlan,
  getPlanState,
  onChange as onMasterChange,
  previewMaster,
  setMaster,
  setMasterOn,
  warmLive,
  watch,
} from "../masterEngine.js";
import { masterIsOn } from "../masterMath.js";
import { EqGraph } from "./eqGraph.js";
import { PANEL_KIND } from "./eqPanelKinds.js";
import { eqFromSuggestion, graphBands, suggestMasterUrl } from "./eqPanelModel.js";
import { fmtDb } from "./eqGraphMath.js";
import { editLaneBands, renderPower, toggleLaneBypass } from "./eqPanelControls.js";
import { REFUSED_KEY } from "./eqSuggest.js";
import { SuggestFlow } from "./eqSuggestFlow.js";
import {
  PERCENT,
  choosePresetFor,
  fmtPercent,
  grFraction,
  loudnessChoice,
  loudnessReadout,
  masterFromSuggestion,
  stepCeiling,
} from "./masterPanelModel.js";

const GR_SCALE_DB = 12;

function previewSuggested(_lane, suggested) {
  previewLaneEq(MASTER_LANE, suggested?.eq ?? null);
  previewMaster(suggested?.master ?? null);
}

function commitSuggested(_lane, { eq, master }) {
  setLaneEq(MASTER_LANE, eq);
  setMaster(master);
  previewMaster(null);
}

function suggestionOf(body) {
  return { eq: eqFromSuggestion(body, PANEL_KIND.graph), master: masterFromSuggestion(body) };
}

export class EqMasterView {
  #graph;
  #job = null;
  #suggest = new SuggestFlow({
    preview: previewSuggested,
    commit: commitSuggested,
    button: $("eqSuggestMaster"),
    status: this.#status.bind(this),
    render: this.render.bind(this),
    refusedKey: REFUSED_KEY.mix,
  });

  constructor() {
    this.#graph = new EqGraph($("eqGraphMaster"), { onEdit: this.#onGraphEdit.bind(this) });
    $("eqPowerMaster").addEventListener("click", this.#onPowerClick.bind(this));
    $("eqGlue").addEventListener("input", this.#onGlueInput.bind(this));
    $("eqGlue").addEventListener("change", this.#onGlueChange.bind(this));
    $("eqLoudness").addEventListener("click", this.#onLoudnessClick.bind(this));
    $("eqCeilingDown").addEventListener("click", this.#onCeilingDownClick.bind(this));
    $("eqCeilingUp").addEventListener("click", this.#onCeilingUpClick.bind(this));
    $("eqFlatMaster").addEventListener("click", this.#onFlatClick.bind(this));
    $("eqSuggestMaster").addEventListener("click", this.#onSuggestClick.bind(this));
    $("eqSuggestApplyMaster").addEventListener("click", this.#onApplyClick.bind(this));
    $("eqSuggestUndoMaster").addEventListener("click", this.#onUndoClick.bind(this));
    onFxChange(this.#onFxChange.bind(this));
    onMasterChange(this.render.bind(this));
  }

  get graph() { return this.#graph; }

  show() {
    this.#job = currentJobId;
    warmLive(true);
    watch();
    this.render();
  }

  /** Leaving the view or the song: drop a Suggest still asked for, undo an unapplied one. */
  leave() {
    this.#graph.flush();
    this.#suggest.leave();
    warmLive(false);
  }

  render() {
    const suggesting = this.#suggest.active;
    const master = suggesting ? this.#suggest.suggested.master : getMaster();
    this.#renderEq(suggesting);
    this.#renderGlue(master, suggesting);
    this.#renderLoudness(master, suggesting);
    $("eqSuggestBarMaster").hidden = !suggesting;
    $("eqLegendMaster").hidden = !suggesting;
    $("eqLegendTargetMaster").hidden = !this.#suggest.target;
    $("eqMasterActions").hidden = suggesting;
  }

  /** One meter frame: the glue's gain reduction. */
  tick() {
    const db = audioEngine?.masterFxReduction?.()?.glue ?? null;
    $("eqGrBar").style.width = fmtPercent(grFraction(db, GR_SCALE_DB));
    $("eqGrValue").textContent = fmtDb(Number.isFinite(db) ? db : 0);
  }

  #renderEq(suggesting) {
    const saved = getLaneEq(MASTER_LANE);
    const eq = suggesting ? this.#suggest.suggested.eq : saved;
    renderPower($("eqPowerMaster"), eq, { disabled: suggesting });
    const layers = suggesting
      ? { ghost: { bands: saved.params.bands, out: saved.params.out }, target: this.#suggest.target, fitted: true }
      : {};
    this.#graph.show(
      { bands: graphBands(eq), out: eq.params.out, bypass: eq.bypass },
      { ...layers, editable: !suggesting },
    );
  }

  #renderGlue(master, suggesting) {
    const { comp } = master.params;
    const glue = $("eqGlue");
    glue.value = String(Math.round(comp * PERCENT));
    glue.disabled = suggesting || !masterIsOn(master);
    $("eqGlueValue").textContent = fmtPercent(comp);
  }

  #renderLoudness(master, suggesting) {
    const on = masterIsOn(master);
    const choice = loudnessChoice(master);
    for (const btn of $("eqLoudness").querySelectorAll("[data-choice]")) {
      btn.setAttribute("aria-checked", String(btn.dataset.choice === choice));
      btn.disabled = suggesting;
    }
    const view = loudnessReadout(master, getPlan(), getPlanState());
    $("eqTargetValue").textContent = view.target;
    $("eqCeilingValue").textContent = view.ceiling;
    $("eqNowLufs").textContent = view.now;
    $("eqGainAtExport").textContent = view.gain;
    $("eqApproxHint").hidden = !on;
    $("eqCeilingDown").disabled = suggesting || !on;
    $("eqCeilingUp").disabled = suggesting || !on;
  }

  #status(text) {
    $("eqMasterStatus").textContent = text;
  }

  #onGraphEdit(bands, opts) {
    if (currentJobId !== this.#job) return;
    editLaneBands(MASTER_LANE, bands, opts);
  }

  #onPowerClick() {
    toggleLaneBypass(MASTER_LANE);
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

  #onSuggestClick() {
    const src = currentMixSource();
    if (!src) return;
    const job = currentJobId;
    this.#suggest.ask({
      key: MASTER_LANE,
      url: suggestMasterUrl(src),
      current: () => job === currentJobId,
      toSuggested: suggestionOf,
    });
  }

  #onApplyClick() {
    this.#suggest.apply();
  }

  #onUndoClick() {
    this.#suggest.undo();
  }

  #onFxChange({ lane }) {
    if (lane === null || lane === MASTER_LANE) this.render();
  }
}
