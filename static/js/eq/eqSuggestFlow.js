import { t } from "../i18n.js";
import { createSuggestSession, targetCurvePoints } from "./eqPanelModel.js";
import { fetchSuggestion, suggestErrorKey } from "./eqSuggest.js";

/**
 * One panel's Suggest: ask, play the answer unsaved, then Apply or Undo.
 * An answer is dropped once the ask is aborted or no longer current().
 */
export class SuggestFlow {
  #session;
  #button;
  #status;
  #render;
  #refusedKey;
  #request = null;
  #target = null;

  /** preview/commit as for createSuggestSession; status(text) shows a failure. */
  constructor({ preview, commit, button, status, render, refusedKey }) {
    this.#session = createSuggestSession({ preview, commit });
    this.#button = button;
    this.#status = status;
    this.#render = render;
    this.#refusedKey = refusedKey;
  }

  get active() { return this.#session.active; }
  get suggested() { return this.#session.suggested; }
  /** The answer's target curve [[Hz, dB], ...], or null. */
  get target() { return this.#target; }

  /** Ask `url`; toSuggested(body) is what plays for `key` while it is current(). */
  async ask({ key, url, current, toSuggested }) {
    if (this.#request) return;
    const ctl = new AbortController();
    const wanted = () => !ctl.signal.aborted && current();
    this.#request = ctl;
    this.#button.disabled = true;
    this.#status("");
    try {
      const body = await fetchSuggestion(url, ctl.signal);
      if (wanted()) this.#show(key, body, toSuggested);
    } catch (err) {
      if (!wanted()) return;
      console.warn("[eq] suggest failed:", err);
      this.#status(t(suggestErrorKey(err, this.#refusedKey)));
    } finally {
      if (this.#request === ctl) this.#request = null;
      this.#button.disabled = false;
      this.#render();
    }
  }

  #show(key, body, toSuggested) {
    this.#target = targetCurvePoints(body);
    this.#session.show(key, toSuggested(body));
  }

  apply() {
    this.#session.apply();
    this.#target = null;
    this.#render();
  }

  undo() {
    this.#session.undo();
    this.#target = null;
    this.#render();
  }

  /** Drop an ask still out and undo an unapplied answer. */
  leave() {
    this.#request?.abort();
    this.#request = null;
    this.#session.undo();
    this.#target = null;
    this.#status("");
  }
}
