// The Lane view of the EQ tab: the lane's graph or pedal, its readout, and
// Suggest / Flat. Everything heard goes through the engine API.

import { t } from "../i18n.js";
import { currentJobId } from "../state.js";
import { STEM_COLORS } from "../constants.js";
import { getLaneEq, onFxChange, previewLaneEq, resetLane, setBypass, setLaneEq } from "../eqEngine.js";
import { panelKindFor } from "./eqPanelKinds.js";
import { EqGraph } from "./eqGraph.js";
import { EqKnobs } from "./eqKnobs.js";
import {
  PEDAL_PANEL_KINDS,
  createSuggestSession,
  eqFromSuggestion,
  eqWithKnob,
  graphBands,
  panelTitleKey,
  readoutParts,
  suggestEqUrl,
} from "./eqPanelModel.js";
import { fetchSuggestion, suggestErrorKey } from "./eqSuggest.js";

const $ = (id) => document.getElementById(id);
const SMALL_GRAPH_CLASS = "eq-graph-sm";
const EQ_COLOR_VAR = "--eq-c";

export class EqLaneView {
  #root = $("eqLaneView");
  #lane = null;
  #kind = null;
  #busy = false;
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
    if (lane !== this.#lane) this.leave();
    this.#lane = lane;
    this.#kind = panelKindFor(lane);
    this.#root.style.setProperty(EQ_COLOR_VAR, STEM_COLORS[lane] || "");
    this.render();
  }

  /** Leaving the lane: an unapplied suggestion goes back to the saved EQ. */
  leave() {
    this.#session.undo();
    this.#status("");
  }

  render() {
    if (!this.#lane) return;
    const suggesting = this.#session.active;
    const eq = suggesting ? this.#session.suggested : getLaneEq(this.#lane);
    const pedal = PEDAL_PANEL_KINDS.has(this.#kind);
    $("eqLaneTitle").textContent = t(panelTitleKey(this.#kind));
    this.#renderPower(eq);
    $("eqGraphLane").classList.toggle(SMALL_GRAPH_CLASS, pedal);
    this.#graph.show(
      { bands: pedal ? eq.params.bands : graphBands(eq), out: eq.params.out, bypass: eq.bypass },
      { ghost: suggesting ? this.#ghost() : null, fitted: suggesting, editable: !pedal && !suggesting },
    );
    $("eqKnobs").hidden = !pedal;
    if (pedal) this.#knobs.show(this.#kind, eq);
    $("eqSuggestBar").hidden = !suggesting;
    $("eqLegend").hidden = !suggesting;
    $("eqLaneActions").hidden = suggesting;
    $("eqReadout").hidden = pedal || suggesting;
    this.#renderReadout();
  }

  #ghost() {
    const saved = getLaneEq(this.#lane);
    return { bands: saved.params.bands, out: saved.params.out };
  }

  #renderPower(eq) {
    const power = $("eqPowerLane");
    power.setAttribute("aria-pressed", String(!eq.bypass));
    power.title = t(eq.bypass ? "eq.powerOff" : "eq.power");
    power.setAttribute("aria-label", power.title);
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

  #onGraphEdit(bands, { commit }) {
    const eq = getLaneEq(this.#lane);
    setLaneEq(this.#lane, { ...eq, params: { ...eq.params, bands } }, { save: commit });
    this.#renderReadout();
  }

  #onKnobTurn(id, value, { commit }) {
    setLaneEq(this.#lane, eqWithKnob(this.#kind, getLaneEq(this.#lane), id, value), { save: commit });
  }

  #onPowerClick() {
    setBypass(this.#lane, !getLaneEq(this.#lane).bypass);
  }

  #onFlatClick() {
    this.leave();
    resetLane(this.#lane);
  }

  async #onSuggestClick() {
    if (this.#busy || !currentJobId) return;
    const lane = this.#lane;
    this.#busy = true;
    $("eqSuggestLane").disabled = true;
    this.#status("");
    try {
      const body = await fetchSuggestion(suggestEqUrl(currentJobId, lane, this.#kind));
      if (lane === this.#lane) this.#session.show(lane, eqFromSuggestion(body, this.#kind));
    } catch (err) {
      console.warn("[eq] suggest failed:", err);
      this.#status(t(suggestErrorKey(err)));
    } finally {
      this.#busy = false;
      $("eqSuggestLane").disabled = false;
      this.render();
    }
  }

  #onApplyClick() {
    this.#session.apply();
    this.render();
  }

  #onUndoClick() {
    this.#session.undo();
    this.render();
  }

  #onFxChange({ lane }) {
    if (lane === null || lane === this.#lane) this.render();
  }
}
