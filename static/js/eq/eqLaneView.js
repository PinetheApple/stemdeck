import { t } from "../i18n.js";
import { $ } from "../utils.js";
import { currentJobId } from "../state.js";
import { STEM_COLORS } from "../constants.js";
import { getLaneEq, onFxChange, previewLaneEq, resetLane, setLaneEq } from "../eqEngine.js";
import { panelKindFor } from "./eqPanelKinds.js";
import { EqGraph } from "./eqGraph.js";
import { EqKnobs } from "./eqKnobs.js";
import { editLaneBands, renderPower, toggleLaneBypass } from "./eqPanelControls.js";
import {
  PEDAL_PANEL_KINDS,
  createSuggestSession,
  eqFromSuggestion,
  eqWithKnob,
  graphBands,
  panelTitleKey,
  readoutParts,
  suggestEqUrl,
  targetCurvePoints,
} from "./eqPanelModel.js";
import { fetchSuggestion, suggestErrorKey } from "./eqSuggest.js";

const SMALL_GRAPH_CLASS = "eq-graph-sm";
const EQ_COLOR_VAR = "--eq-c";

export class EqLaneView {
  #root = $("eqLaneView");
  #lane = null;
  #job = null;
  #kind = null;
  #request = null;
  #target = null;
  #graph;
  #knobs;
  #session = createSuggestSession({ preview: previewLaneEq, commit: setLaneEq });

  constructor() {
    this.#graph = new EqGraph($("eqGraphLane"), {
      onEdit: this.#onGraphEdit.bind(this),
      onSelect: this.#renderReadout.bind(this),
    });
    this.#knobs = new EqKnobs($("eqKnobs"), { onTurn: this.#onKnobTurn.bind(this) });
    $("eqPowerLane").addEventListener("click", this.#onPowerClick.bind(this));
    $("eqFlatLane").addEventListener("click", this.#onFlatClick.bind(this));
    $("eqSuggestLane").addEventListener("click", this.#onSuggestClick.bind(this));
    $("eqSuggestApply").addEventListener("click", this.#onApplyClick.bind(this));
    $("eqSuggestUndo").addEventListener("click", this.#onUndoClick.bind(this));
    onFxChange(this.#onFxChange.bind(this));
  }

  get lane() { return this.#lane; }
  get graph() { return this.#graph; }

  /** Edit `lane`; a pending suggestion on another lane is undone first. */
  show(lane) {
    this.#graph.flush();
    if (lane !== this.#lane) this.leave();
    this.#lane = lane;
    this.#job = currentJobId;
    this.#kind = panelKindFor(lane);
    this.#root.style.setProperty(EQ_COLOR_VAR, STEM_COLORS[lane] || "");
    this.render();
  }

  /** Leaving the lane or the song: drop a Suggest still asked for, undo an unapplied one. */
  leave() {
    this.#graph.flush();
    this.#request?.abort();
    this.#request = null;
    this.#session.undo();
    this.#target = null;
    this.#status("");
  }

  render() {
    if (!this.#lane) return;
    const suggesting = this.#session.active;
    const eq = suggesting ? this.#session.suggested : getLaneEq(this.#lane);
    const pedal = PEDAL_PANEL_KINDS.has(this.#kind);
    $("eqLaneTitle").textContent = t(panelTitleKey(this.#kind));
    renderPower($("eqPowerLane"), eq, { disabled: suggesting });
    $("eqGraphLane").classList.toggle(SMALL_GRAPH_CLASS, pedal);
    this.#graph.show(
      { bands: pedal ? eq.params.bands : graphBands(eq), out: eq.params.out, bypass: eq.bypass },
      { ...this.#suggestLayers(suggesting), fitted: suggesting, editable: !pedal && !suggesting },
    );
    $("eqKnobs").hidden = !pedal;
    if (pedal) this.#knobs.show(this.#kind, eq, { enabled: !suggesting });
    $("eqSuggestBar").hidden = !suggesting;
    $("eqLegend").hidden = !suggesting;
    $("eqLegendTarget").hidden = !this.#target;
    $("eqLaneActions").hidden = suggesting;
    $("eqReadout").hidden = pedal || suggesting;
    this.#renderReadout();
  }

  #suggestLayers(suggesting) {
    if (!suggesting) return { ghost: null, target: null };
    const saved = getLaneEq(this.#lane);
    return { ghost: { bands: saved.params.bands, out: saved.params.out }, target: this.#target };
  }

  #renderReadout() {
    const readout = $("eqReadout");
    const i = this.#graph.selected;
    const band = i >= 0 ? graphBands(getLaneEq(this.#lane))[i] : null;
    const parts = band ? readoutParts(band) : { typeKey: "", f: "", g: "", q: "" };
    readout.querySelector('[data-r="n"]').textContent = band ? String(i + 1) : "";
    readout.querySelector('[data-r="type"]').textContent = band ? t(parts.typeKey) : "";
    for (const key of ["f", "g", "q"]) readout.querySelector(`[data-r="${key}"]`).textContent = parts[key];
  }

  #status(text) {
    $("eqLaneStatus").textContent = text;
  }

  #onGraphEdit(bands, opts) {
    if (currentJobId !== this.#job) return;
    editLaneBands(this.#lane, bands, opts);
    this.#renderReadout();
  }

  #onKnobTurn(id, value, { commit }) {
    setLaneEq(this.#lane, eqWithKnob(this.#kind, getLaneEq(this.#lane), id, value), { save: commit });
  }

  #onPowerClick() {
    toggleLaneBypass(this.#lane);
  }

  #onFlatClick() {
    this.leave();
    resetLane(this.#lane);
  }

  async #onSuggestClick() {
    if (this.#request || !currentJobId) return;
    const ask = { lane: this.#lane, kind: this.#kind, job: currentJobId, ctl: new AbortController() };
    this.#request = ask.ctl;
    $("eqSuggestLane").disabled = true;
    this.#status("");
    try {
      const body = await fetchSuggestion(suggestEqUrl(ask.job, ask.lane, ask.kind), ask.ctl.signal);
      if (this.#isCurrent(ask)) this.#showSuggestion(ask, body);
    } catch (err) {
      if (!this.#isCurrent(ask)) return;
      console.warn("[eq] suggest failed:", err);
      this.#status(t(suggestErrorKey(err)));
    } finally {
      if (this.#request === ask.ctl) this.#request = null;
      $("eqSuggestLane").disabled = false;
      this.render();
    }
  }

  #isCurrent(ask) {
    return !ask.ctl.signal.aborted && ask.job === currentJobId && ask.lane === this.#lane;
  }

  #showSuggestion(ask, body) {
    this.#target = targetCurvePoints(body);
    this.#session.show(ask.lane, eqFromSuggestion(body, ask.kind));
  }

  #onApplyClick() {
    this.#session.apply();
    this.#target = null;
    this.render();
  }

  #onUndoClick() {
    this.#session.undo();
    this.#target = null;
    this.render();
  }

  #onFxChange({ lane }) {
    if (lane === null || lane === this.#lane) this.render();
  }
}
