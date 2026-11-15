import { t } from "../i18n.js";
import { clamp } from "../audioMath.js";
import { fmtDb } from "./eqGraphMath.js";
import {
  KNOB_KEY_STEP_DB,
  KNOB_SWEEP_HALF_DEG,
  knobAngle,
  knobDragValue,
  knobValue,
  pedalKnobs,
} from "./eqPanelModel.js";
import { fmtSigned } from "./masterPanelModel.js";
import { DRAG_CLASS, svgEl } from "./eqSvg.js";

const SIZE = 44;
const CENTRE = SIZE / 2;
const ARC_R = 17;
const CAP_R = 12;
const POINTER_FROM = 4;
const POINTER_TO = 11;
// SVG angles start at 3 o'clock; the knob's 0 is straight up.
const UP_OFFSET_DEG = 90;
const HALF_TURN_DEG = 180;
const KEY_STEPS = Object.freeze({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 });

const rad = (deg) => ((deg - UP_OFFSET_DEG) * Math.PI) / HALF_TURN_DEG;

function arc(fromDeg, toDeg) {
  const [a, b] = fromDeg <= toDeg ? [fromDeg, toDeg] : [toDeg, fromDeg];
  const at = (deg) => `${CENTRE + ARC_R * Math.cos(rad(deg))},${CENTRE + ARC_R * Math.sin(rad(deg))}`;
  return `M${at(a)}A${ARC_R},${ARC_R} 0 ${b - a > HALF_TURN_DEG ? 1 : 0} 1 ${at(b)}`;
}

function dialSvg(value, min, max) {
  const svg = svgEl("svg", {
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    width: SIZE,
    height: SIZE,
    class: "eq-knob-svg",
    "aria-hidden": "true",
  });
  const deg = knobAngle(value, min, max);
  svgEl("path", { class: "eq-knob-track", d: arc(-KNOB_SWEEP_HALF_DEG, KNOB_SWEEP_HALF_DEG) }, svg);
  if (value !== 0) svgEl("path", { class: "eq-knob-value", d: arc(0, deg) }, svg);
  svgEl("circle", { class: "eq-knob-cap", cx: CENTRE, cy: CENTRE, r: CAP_R }, svg);
  const [c, s] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
  svgEl("line", {
    class: "eq-knob-pointer",
    x1: CENTRE + POINTER_FROM * c,
    y1: CENTRE + POINTER_FROM * s,
    x2: CENTRE + POINTER_TO * c,
    y2: CENTRE + POINTER_TO * s,
  }, svg);
  return svg;
}

function knobCell(knob) {
  const cell = document.createElement("div");
  cell.className = "eq-knob";
  cell.dataset.knob = knob.id;
  cell.setAttribute("role", "slider");
  cell.setAttribute("aria-valuemin", String(knob.min));
  cell.setAttribute("aria-valuemax", String(knob.max));
  const dial = document.createElement("div");
  dial.className = "eq-knob-dial";
  const name = document.createElement("span");
  name.className = "eq-knob-name";
  const val = document.createElement("span");
  val.className = "eq-knob-val num";
  cell.append(dial, name, val);
  return cell;
}

export class EqKnobs {
  #host;
  #onTurn;
  #kind = null;
  #eq = null;
  #drag = null;
  #enabled = true;

  constructor(host, { onTurn }) {
    this.#host = host;
    this.#onTurn = onTurn;
    host.addEventListener("pointerdown", this.#onPointerDown.bind(this));
    host.addEventListener("pointermove", this.#onPointerMove.bind(this));
    host.addEventListener("pointerup", this.#onPointerUp.bind(this));
    host.addEventListener("pointercancel", this.#onPointerUp.bind(this));
    host.addEventListener("keydown", this.#onKeyDown.bind(this));
    host.addEventListener("dblclick", this.#onDoubleClick.bind(this));
  }

  /** Draw the knobs of `kind` at the positions `eq` holds; disabled ones show but don't turn. */
  show(kind, eq, { enabled = true } = {}) {
    this.#eq = eq;
    this.#enabled = enabled;
    if (kind !== this.#kind) this.#build(kind);
    for (const knob of pedalKnobs(kind)) this.#paint(knob);
  }

  #build(kind) {
    this.#kind = kind;
    this.#host.replaceChildren(...pedalKnobs(kind).map(knobCell));
  }

  #paint(knob) {
    const cell = this.#host.querySelector(`[data-knob="${knob.id}"]`);
    const value = knobValue(this.#kind, this.#eq, knob.id);
    const label = t(`eq.knob.${knob.id}`);
    cell.firstChild.replaceChildren(dialSvg(value, knob.min, knob.max));
    cell.children[1].textContent = label;
    cell.lastChild.textContent = fmtSigned(value, { plus: true });
    cell.tabIndex = this.#enabled ? 0 : -1;
    cell.setAttribute("aria-label", label);
    cell.setAttribute("aria-valuenow", String(value));
    cell.setAttribute("aria-valuetext", fmtDb(value));
    cell.setAttribute("aria-disabled", String(!this.#enabled));
  }

  #knobOf(target) {
    const cell = target instanceof Element ? target.closest(".eq-knob") : null;
    if (!cell || !this.#enabled) return null;
    return pedalKnobs(this.#kind).find((k) => k.id === cell.dataset.knob);
  }

  #turn(knob, value, commit) {
    this.#onTurn(knob.id, value, { commit });
  }

  #onPointerDown(e) {
    const knob = this.#knobOf(e.target);
    if (!knob) return;
    e.preventDefault();
    e.target.closest(".eq-knob").focus();
    this.#drag = { knob, startY: e.clientY, start: knobValue(this.#kind, this.#eq, knob.id), value: null };
    this.#host.setPointerCapture(e.pointerId);
    this.#host.classList.add(DRAG_CLASS);
  }

  #onPointerMove(e) {
    const drag = this.#drag;
    if (!drag) return;
    const { min, max } = drag.knob;
    const value = knobDragValue(drag.start, e.clientY - drag.startY, min, max, e.shiftKey);
    if (value === drag.value) return;
    drag.value = value;
    this.#turn(drag.knob, value, false);
  }

  #onPointerUp() {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    this.#host.classList.remove(DRAG_CLASS);
    if (drag.value !== null) this.#turn(drag.knob, drag.value, true);
  }

  #onKeyDown(e) {
    const knob = this.#knobOf(e.target);
    const step = KEY_STEPS[e.key];
    if (!knob || !step) return;
    e.preventDefault();
    const value = knobValue(this.#kind, this.#eq, knob.id) + step * KNOB_KEY_STEP_DB;
    this.#turn(knob, clamp(value, knob.min, knob.max), true);
  }

  #onDoubleClick(e) {
    const knob = this.#knobOf(e.target);
    if (knob) this.#turn(knob, 0, true);
  }
}
