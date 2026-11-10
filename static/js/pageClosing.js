// The browser cuts off requests still in flight after beforeunload and before
// pagehide, so a save that fails in that window was never answered.
let closing = false;

globalThis.addEventListener?.("beforeunload", function markPageClosing() {
  closing = true;
});
globalThis.addEventListener?.("pageshow", function clearPageClosing() {
  closing = false;
});

/** True from beforeunload until the page is shown again. */
export const isPageClosing = () => closing;
