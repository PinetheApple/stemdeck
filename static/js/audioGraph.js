/** Seconds a parameter change takes, so a dragged control never steps. */
export const PARAM_RAMP = 0.02;
/** Seconds a crossfade between two signal paths takes. */
export const XFADE = 0.02;
const RELEASE_MARGIN = 0.05;
/** Milliseconds after a crossfade starts when the faded-out nodes can go. */
export const RELEASE_MS = (XFADE + RELEASE_MARGIN) * 1000;

/**
 * Move `param` to `value` with a linear ramp from the value it has now, or
 * set it at once with `immediate` (for nodes that are not sounding yet).
 */
export function rampTo(param, value, ctx, { immediate = false, time = PARAM_RAMP } = {}) {
  if (immediate || typeof param.linearRampToValueAtTime !== "function") {
    param.cancelScheduledValues?.(0);
    param.value = value;
    return;
  }
  const now = ctx.currentTime;
  // cancelAndHoldAtTime would jump the parameter on every step in Chromium.
  const current = param.value;
  param.cancelScheduledValues?.(now);
  param.setValueAtTime?.(current, now);
  param.linearRampToValueAtTime(value, now + time);
}

/** Connect the nodes in series. */
export function chain(...nodes) {
  nodes.reduce((prev, node) => prev.connect(node));
}

export function disconnectQuietly(node, destination) {
  try {
    if (destination) node.disconnect(destination);
    else node.disconnect();
  } catch { /* noop */ }
}
