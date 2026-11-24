// A draggable pane edge. The width is a CSS variable on the host, so every
// element sized from it follows.

import { storeGet, storeSet, storeSetDebounced } from "./utils.js";
import { clampPaneWidth } from "./paneEdgeMath.js";

export const KEYBOARD_STEP_PX = 16;
export const GROWS_RIGHT = 1;
export const GROWS_LEFT = -1;
const DRAGGING_CLASS = "is-dragging";
const SIZING_CLASS = "is-sizing";

/**
 * handle: the separator; host: where cssVar is set; measure(): the pane's width now;
 * spare(): how far the waveforms are above their minimum; grows: which drag direction widens the pane.
 */
export class PaneEdge {
  constructor({ handle, host, cssVar, min, max, storeKey, measure, spare, grows = GROWS_RIGHT }) {
    Object.assign(this, { handle, host, cssVar, min, max, storeKey, measure, spare, grows });
    this.preferred = null;
    this.drag = null;
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onLostCapture = this.onLostCapture.bind(this);
    handle.addEventListener("pointerdown", this.onPointerDown.bind(this));
    handle.addEventListener("dblclick", this.reset.bind(this));
    handle.addEventListener("keydown", this.onKeydown.bind(this));
  }

  clampTo(px) {
    return clampPaneWidth(px, { min: this.min, max: this.max, current: this.measure(), spare: this.spare() });
  }

  shown() {
    return this.handle.getClientRects().length > 0;
  }

  /** The width it is sized from before the waveforms are weighed: the chosen one, else the default. */
  target() {
    if (this.preferred !== null) return this.preferred;
    const shown = this.host.style.getPropertyValue(this.cssVar);
    if (!shown) return Math.round(this.measure());
    // Only a default narrowed earlier is unknown, so only then is it laid out bare, with transitions off.
    this.host.classList.add(SIZING_CLASS);
    this.host.style.removeProperty(this.cssVar);
    const natural = Math.round(this.measure());
    this.host.style.setProperty(this.cssVar, shown);
    void this.host.offsetWidth;
    this.host.classList.remove(SIZING_CLASS);
    return natural;
  }

  /** How much more room the waveforms would have with this pane at its target width. */
  slack() {
    return this.shown() ? Math.round(this.measure()) - this.target() : 0;
  }

  render() {
    const target = this.target();
    const width = this.clampTo(target);
    const next = this.preferred === null && width === target ? "" : `${width}px`;
    if (this.host.style.getPropertyValue(this.cssVar) === next) return;
    this.host.classList.add(SIZING_CLASS);
    this.host.style.setProperty(this.cssVar, next);
    // Lays out now, while transitions are off, so the pane tracks the pointer.
    void this.host.offsetWidth;
    this.host.classList.remove(SIZING_CLASS);
  }

  syncAria() {
    const width = this.measure();
    this.handle.setAttribute("aria-valuemin", String(this.min));
    this.handle.setAttribute("aria-valuemax", String(Math.max(this.min, Math.min(this.max, Math.round(width + this.spare())))));
    this.handle.setAttribute("aria-valuenow", String(Math.round(width)));
  }

  fit() {
    if (!this.shown()) return;
    this.render();
    this.syncAria();
  }

  choose(px) {
    this.preferred = px;
    this.fit();
  }

  save() {
    storeSet(this.storeKey, this.preferred);
    // Replaces a pending arrow-key write, which would otherwise land after this one.
    storeSetDebounced(this.storeKey, this.preferred);
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    this.drag = { x: e.clientX, width: Math.round(this.measure()), preferred: this.preferred, moved: false };
    this.handle.setPointerCapture(e.pointerId);
    this.handle.classList.add(DRAGGING_CLASS);
    this.handle.addEventListener("pointermove", this.onPointerMove);
    this.handle.addEventListener("lostpointercapture", this.onLostCapture);
  }

  onPointerMove(e) {
    const { drag } = this;
    const next = this.clampTo(drag.width + (e.clientX - drag.x) * this.grows);
    drag.moved = drag.moved || next !== drag.width;
    this.choose(drag.moved ? next : drag.preferred);
  }

  // Follows pointerup and pointercancel alike, so a cancelled drag still cleans up.
  onLostCapture() {
    this.handle.removeEventListener("pointermove", this.onPointerMove);
    this.handle.removeEventListener("lostpointercapture", this.onLostCapture);
    this.handle.classList.remove(DRAGGING_CLASS);
    if (this.drag.moved) this.save();
    this.drag = null;
  }

  reset() {
    this.choose(null);
    this.save();
  }

  onKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.reset();
      return;
    }
    const direction = { ArrowRight: this.grows, ArrowLeft: -this.grows }[e.key];
    if (!direction) return;
    e.preventDefault();
    const current = Math.round(this.measure());
    const next = this.clampTo(current + direction * KEYBOARD_STEP_PX);
    if (next === current) return;
    this.choose(next);
    storeSetDebounced(this.storeKey, this.preferred);
  }

  async restore() {
    const stored = await storeGet(this.storeKey, null);
    if (Number.isFinite(stored)) this.choose(stored);
  }
}
