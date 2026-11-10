// The browser cuts off requests still in flight after beforeunload and before
// pagehide, so a save that fails in that window was never answered.
let closing = false;

function clearPageClosing() {
  closing = false;
}

function markPageClosing() {
  closing = true;
}

globalThis.addEventListener?.("beforeunload", markPageClosing);
// Not every close fires beforeunload first; the close flushes never check the flag.
globalThis.addEventListener?.("pagehide", markPageClosing);
globalThis.addEventListener?.("pageshow", clearPageClosing);
// A beforeunload need not end in a close, and saves must not wait for one that never
// comes. Every edit starts with input, so input lets them go out again.
globalThis.addEventListener?.("pointerdown", clearPageClosing, true);
globalThis.addEventListener?.("keydown", clearPageClosing, true);

/** True from beforeunload or pagehide until the page is shown again or gets input. */
export const isPageClosing = () => closing;

/** True when a save failed because the closing page cut it off; a refused save is not a TypeError. */
export const wasCutOffByPageClose = (error) => closing && error instanceof TypeError;
