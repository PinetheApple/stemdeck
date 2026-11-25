import { t } from "../i18n.js";
import { $ } from "../utils.js";
import { currentJobId } from "../state.js";
import { STEM_COLORS } from "../constants.js";
import { getLaneEq, onFxChange, previewLaneEq, resetLane, setLaneEq } from "../eqEngine.js";
import { panelKindFor } from "./eqPanelKinds.js";
import { EqGraph } from "./eqGraph.js";
import { editLaneBands, renderPower, toggleLaneBypass } from "./eqPanelControls.js";
import { eqFromSuggestion, graphBands, panelTitleKey, readoutParts, suggestEqUrl } from "./eqPanelModel.js";
import { REFUSED_KEY } from "./eqSuggest.js";
import { SuggestFlow } from "./eqSuggestFlow.js";

const EQ_COLOR_VAR = "--eq-c";

export class EqLaneView {
  #root = $("eqLaneView");
  #lane = null;
  #job = null;
  #kind = null;
  #graph;
  #suggest = new SuggestFlow({
    preview: previewLaneEq,
    commit: setLaneEq,
    button: $("eqSuggestLane"),
    status: this.#status.bind(this),
    render: this.render.bind(this),
    refusedKey: REFUSED_KEY.lane,
  });

  constructor() {
    this.#graph = new EqGraph($("eqGraphLane"), {
      onEdit: this.#onGraphEdit.bind(this),
      onSelect: this.#renderReadout.bind(this),
    });
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
    this.#suggest.leave();
  }

  render() {
    if (!this.#lane) return;
    const suggesting = this.#suggest.active;
    const eq = suggesting ? this.#suggest.suggested : getLaneEq(this.#lane);
    $("eqLaneTitle").textContent = t(panelTitleKey(this.#kind));
    renderPower($("eqPowerLane"), eq, { disabled: suggesting });
    this.#graph.show(
      { bands: graphBands(eq), out: eq.params.out, bypass: eq.bypass },
      { ...this.#suggestLayers(suggesting), fitted: suggesting, editable: !suggesting },
    );
    $("eqSuggestBar").hidden = !suggesting;
    $("eqLegend").hidden = !suggesting;
    $("eqLegendTarget").hidden = !this.#suggest.target;
    $("eqLaneActions").hidden = suggesting;
    $("eqReadout").hidden = suggesting;
    this.#renderReadout();
  }

  #suggestLayers(suggesting) {
    if (!suggesting) return { ghost: null, target: null };
    const saved = getLaneEq(this.#lane);
    return { ghost: { bands: saved.params.bands, out: saved.params.out }, target: this.#suggest.target };
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

  #onPowerClick() {
    toggleLaneBypass(this.#lane);
  }

  #onFlatClick() {
    this.leave();
    resetLane(this.#lane);
  }

  #onSuggestClick() {
    if (!currentJobId) return;
    const lane = this.#lane;
    const kind = this.#kind;
    const job = currentJobId;
    this.#suggest.ask({
      key: lane,
      url: suggestEqUrl(job, lane, kind),
      current: () => job === currentJobId && lane === this.#lane,
      toSuggested: eqFromSuggestion,
    });
  }

  #onApplyClick() {
    this.#suggest.apply();
  }

  #onUndoClick() {
    this.#suggest.undo();
  }

  #onFxChange({ lane }) {
    if (lane === null || lane === this.#lane) this.render();
  }
}
