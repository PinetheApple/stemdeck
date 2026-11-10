// The browser cuts off requests still in flight after beforeunload and before
// pagehide, so a save that fails in that window was never answered.
let closing = false;

function clearPageClosing() {
  closing = false;
}

globalThis.addEventListener?.("beforeunload", function markPageClosing() {
  closing = true;
});
globalThis.addEventListener?.("pageshow", clearPageClosing);
// A beforeunload need not end in a close, and every edit starts with input: input means it did not.
globalThis.addEventListener?.("pointerdown", clearPageClosing, true);
globalThis.addEventListener?.("keydown", clearPageClosing, true);

/** True from beforeunload until the page is shown again or gets input. */
export const isPageClosing = () => closing;

/** True when a save failed because the closing page cut it off; a refused save is not a TypeError. */
export const wasCutOffByPageClose = (error) => closing && error instanceof TypeError;
