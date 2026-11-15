// Click-free AudioParam moves for the EQ and master effects.

/** Seconds a parameter change takes, so a dragged control never steps. */
export const PARAM_RAMP = 0.02;
/** Seconds a crossfade between two signal paths takes. */
export const XFADE = 0.02;

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
  // Not cancelAndHoldAtTime: in Chromium, holding a running ramp and starting
  // the next from it jumped the parameter on every knob step.
  const current = param.value;
  param.cancelScheduledValues?.(now);
  param.setValueAtTime?.(current, now);
  param.linearRampToValueAtTime(value, now + time);
}
