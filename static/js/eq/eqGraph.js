// The parametric graph: grid, live spectrum, the curve and numbered handles.
// Edits come back through onEdit(bands, {commit}); the graph never saves.

import { t } from "../i18n.js";
import { clamp } from "../audioMath.js";
import { EQ_LIMITS, eqResponseDb, normalizeEq } from "../eqMath.js";
import { liveSampleRate } from "../eqEngine.js";
import {
  DB_RANGE,
  SPEC_MAX_DB,
  SPEC_MIN_DB,
  curveFreqs,
  dbToY,
  defaultBandAt,
  dragBand,
  freqToX,
  hasQ,
  keyStep,
  nodeXY,
  wheelQ,
  xToFreq,
  yToDb,
} from "./eqGraphMath.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_R = 7;
const LABEL_DY = 3.5;
const GRID_HZ = Object.freeze([[100, "100"], [1000, "1k"], [10000, "10k"]]);
const GRID_DB = Object.freeze([-12, 0, 12]);
const GRID_LABEL_PAD = 3;
const GRID_LABEL_BASE = 4;
const GRID_LABEL_W = 30;
const DELETE_KEYS = new Set(["Delete", "Backspace"]);
const DRAG_CLASS = "eq-dragging";
const BYPASS_CLASS = "eq-bypassed";

function svgEl(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

const pathOf = (points) => points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

const bandIndexOf = (target) => {
  const g = target instanceof Element ? target.closest(".eq-handle") : null;
  return g ? Number(g.dataset.band) : -1;
};

export class EqGraph {
  #host;
  #svg;
  #layers;
  #r = { x: 0, y: 0, w: 1, h: 1 };
  #drag = null;
  #view = { bands: [], out: 0, bypass: false, ghost: null, fitted: false, editable: true, selected: 0 };
  #onEdit;
  #onSelect;

  constructor(host, { onEdit = () => {}, onSelect = () => {} } = {}) {
    this.#host = host;
    this.#onEdit = onEdit;
    this.#onSelect = onSelect;
    this.#svg = svgEl("svg", { class: "eq-svg" });
    this.#layers = {
      spectrum: svgEl("path", { class: "eq-spectrum" }, this.#svg),
      grid: svgEl("g", { class: "eq-grid" }, this.#svg),
      ghost: svgEl("path", { class: "eq-ghost" }, this.#svg),
      fill: svgEl("path", { class: "eq-fill" }, this.#svg),
      curve: svgEl("path", { class: "eq-curve" }, this.#svg),
      handles: svgEl("g", {}, this.#svg),
    };
    host.replaceChildren(this.#svg);
    this.#listen();
    new ResizeObserver(this.#resize.bind(this)).observe(host);
  }

  /** Show bands {bands, out, bypass}; opts {ghost, fitted, editable}. Ignored mid-drag. */
  show({ bands, out = 0, bypass = false }, { ghost = null, fitted = false, editable = true } = {}) {
    if (this.#drag) return;
    const view = this.#view;
    Object.assign(view, { bands: bands.map((b) => ({ ...b })), out, bypass, ghost, fitted, editable });
    view.selected = clamp(view.selected, 0, Math.max(0, bands.length - 1));
    this.#draw();
  }

  get selected() { return this.#view.bands.length ? this.#view.selected : -1; }

  /** One spectrum frame: dB per column, the columns spread evenly across the width; null clears it. */
  drawSpectrum(columns) {
    const layer = this.#layers.spectrum;
    if (!columns) {
      layer.setAttribute("d", "");
      return;
    }
    const { w, h } = this.#r;
    const span = SPEC_MAX_DB - SPEC_MIN_DB;
    const step = w / Math.max(1, columns.length - 1);
    const yOf = (db) => h - ((clamp(db, SPEC_MIN_DB, SPEC_MAX_DB) - SPEC_MIN_DB) / span) * h;
    const line = pathOf(Array.from(columns, (db, c) => [c * step, yOf(db)])).replace(/^M/, "L");
    layer.setAttribute("d", `M0,${h}${line}L${w},${h}Z`);
  }

  refreshLabels() {
    this.#drawHandles();
  }

  #listen() {
    const svg = this.#svg;
    svg.addEventListener("pointerdown", this.#onPointerDown.bind(this));
    svg.addEventListener("pointermove", this.#onPointerMove.bind(this));
    svg.addEventListener("pointerup", this.#onPointerUp.bind(this));
    svg.addEventListener("pointercancel", this.#onPointerUp.bind(this));
    svg.addEventListener("dblclick", this.#onDoubleClick.bind(this));
    svg.addEventListener("wheel", this.#onWheel.bind(this), { passive: false });
    svg.addEventListener("keydown", this.#onKeyDown.bind(this));
    svg.addEventListener("focusin", this.#onFocusIn.bind(this));
  }

  #resize() {
    const w = Math.max(1, this.#host.clientWidth);
    const h = Math.max(1, this.#host.clientHeight);
    this.#r = { x: 0, y: 0, w, h };
    this.#svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.#svg.setAttribute("width", w);
    this.#svg.setAttribute("height", h);
    this.#drawGrid();
    this.#draw();
  }

  #curvePoints(bands, out) {
    const r = this.#r;
    const freqs = curveFreqs(r);
    const db = eqResponseDb(normalizeEq({ params: { out, bands } }), freqs, liveSampleRate());
    return Array.from(freqs, (f, i) => [freqToX(f, r), dbToY(clamp(db[i], -DB_RANGE, DB_RANGE), r)]);
  }

  #drawGrid() {
    const { grid } = this.#layers;
    const r = this.#r;
    grid.replaceChildren();
    for (const [hz, label] of GRID_HZ) {
      const x = freqToX(hz, r);
      svgEl("line", { x1: x, x2: x, y1: 0, y2: r.h }, grid);
      const nearEdge = x + GRID_LABEL_W > r.w;
      const text = svgEl("text", {
        x: nearEdge ? x - GRID_LABEL_PAD : x + GRID_LABEL_PAD,
        y: r.h - GRID_LABEL_BASE,
        "text-anchor": nearEdge ? "end" : "start",
      }, grid);
      text.textContent = label;
    }
    for (const db of GRID_DB) {
      const y = dbToY(db, r);
      svgEl("line", { x1: 0, x2: r.w, y1: y, y2: y, class: db === 0 ? "eq-zero" : "" }, grid);
    }
  }

  #drawCurve() {
    const { curve, fill, ghost } = this.#layers;
    const view = this.#view;
    const d = pathOf(this.#curvePoints(view.bands, view.out));
    const zero = dbToY(0, this.#r);
    curve.setAttribute("d", d);
    fill.setAttribute("d", `${d}L${this.#r.w},${zero}L0,${zero}Z`);
    ghost.setAttribute("d", view.ghost ? pathOf(this.#curvePoints(view.ghost.bands, view.ghost.out)) : "");
    this.#host.classList.toggle(BYPASS_CLASS, view.bypass);
  }

  #handleAt(i) {
    const layer = this.#layers.handles;
    if (layer.children[i]) return layer.children[i];
    const g = svgEl("g", { class: "eq-handle", role: "button" }, layer);
    svgEl("circle", { r: HANDLE_R }, g);
    svgEl("text", {}, g);
    g.dataset.band = String(i);
    return g;
  }

  #drawHandles() {
    const layer = this.#layers.handles;
    const view = this.#view;
    const shown = view.editable || view.fitted ? view.bands : [];
    while (layer.children.length > shown.length) layer.lastChild.remove();
    shown.forEach((band, i) => {
      const g = this.#handleAt(i);
      const { x, y } = nodeXY(band, this.#r);
      g.firstChild.setAttribute("cx", x);
      g.firstChild.setAttribute("cy", y);
      g.lastChild.setAttribute("x", x);
      g.lastChild.setAttribute("y", y + LABEL_DY);
      g.lastChild.textContent = String(i + 1);
      g.classList.toggle("selected", i === view.selected && view.editable);
      g.classList.toggle("fitted", view.fitted);
      g.setAttribute("aria-label", t("eq.bandAria", { n: i + 1 }));
      g.setAttribute("tabindex", view.editable ? "0" : "-1");
    });
  }

  #draw() {
    this.#drawCurve();
    this.#drawHandles();
  }

  #select(i) {
    this.#view.selected = i;
    this.#drawHandles();
    this.#onSelect(i);
  }

  #edit(bands, commit) {
    this.#view.bands = bands;
    this.#draw();
    this.#onEdit(bands.map((b) => ({ ...b })), { commit });
  }

  #replaceBand(i, band, commit = true) {
    this.#edit(this.#view.bands.map((b, j) => (j === i ? band : b)), commit);
  }

  #removeBand(i) {
    this.#edit(this.#view.bands.filter((_, j) => j !== i), true);
    this.#select(Math.max(0, Math.min(i, this.#view.bands.length - 1)));
  }

  #pointIn(e) {
    const box = this.#svg.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  #onPointerDown(e) {
    const i = bandIndexOf(e.target);
    if (!this.#view.editable || i < 0) return;
    e.preventDefault();
    this.#select(i);
    this.#drag = { i, start: { ...this.#view.bands[i] }, from: this.#pointIn(e), moved: false };
    this.#svg.setPointerCapture(e.pointerId);
    this.#host.classList.add(DRAG_CLASS);
  }

  #onPointerMove(e) {
    const drag = this.#drag;
    if (!drag) return;
    const at = this.#pointIn(e);
    drag.moved = true;
    const band = dragBand(drag.start, at.x - drag.from.x, at.y - drag.from.y, this.#r, { fine: e.shiftKey });
    this.#replaceBand(drag.i, band, false);
  }

  #onPointerUp() {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    this.#host.classList.remove(DRAG_CLASS);
    if (drag.moved) this.#edit(this.#view.bands, true);
  }

  #onDoubleClick(e) {
    const view = this.#view;
    if (!view.editable) return;
    const i = bandIndexOf(e.target);
    if (i >= 0) {
      this.#removeBand(i);
      return;
    }
    if (view.bands.length >= EQ_LIMITS.maxBands) return;
    const at = this.#pointIn(e);
    const band = defaultBandAt(xToFreq(at.x, this.#r), clamp(yToDb(at.y, this.#r), -DB_RANGE, DB_RANGE));
    this.#edit([...view.bands, band], true);
    this.#select(view.bands.length - 1);
  }

  #onWheel(e) {
    const i = bandIndexOf(e.target);
    if (!this.#view.editable || i < 0 || !hasQ(this.#view.bands[i].type)) return;
    e.preventDefault();
    const band = this.#view.bands[i];
    this.#replaceBand(i, { ...band, q: wheelQ(band.q, e.deltaY, e.shiftKey) });
  }

  #onKeyDown(e) {
    const i = bandIndexOf(e.target);
    if (!this.#view.editable || i < 0) return;
    if (DELETE_KEYS.has(e.key)) {
      e.preventDefault();
      this.#removeBand(i);
      return;
    }
    const band = keyStep(this.#view.bands[i], e.key, e.shiftKey);
    if (band === this.#view.bands[i]) return;
    e.preventDefault();
    this.#replaceBand(i, band);
  }

  #onFocusIn(e) {
    const i = bandIndexOf(e.target);
    if (i >= 0 && i !== this.#view.selected) this.#select(i);
  }
}
