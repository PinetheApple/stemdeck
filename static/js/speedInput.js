// The speed fader's range, and what a typed speed or a wheel notch means. No DOM.

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1;
const HUNDREDTHS = 100;
const NOTCH_HUNDREDTHS = 5;
export const SPEED_NOTCH = NOTCH_HUNDREDTHS / HUNDREDTHS;
// A bare number this big can only mean a percentage: nobody types 83 for 83x.
const PERCENT_FROM = 10;
const TYPED_SPEED = /^(\d+(?:\.\d*)?|\.\d+)\s*([x%]?)$/i;
const PERCENT_SIGN = "%";

/** `rate` within the fader's range, to the hundredth. */
export function clampSpeed(rate) {
  const inRange = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
  return Math.round(inRange * HUNDREDTHS) / HUNDREDTHS;
}

/** The speed in "0.83", "0,83", "0.83x", "83" or "83%", clamped; null when it is not a number. */
export function parseSpeedInput(text) {
  const match = TYPED_SPEED.exec(String(text).trim().replace(",", "."));
  if (!match) return null;
  const [, digits, unit] = match;
  const number = Number(digits);
  const isPercent = unit === PERCENT_SIGN || (unit === "" && number >= PERCENT_FROM);
  return clampSpeed(isPercent ? number / HUNDREDTHS : number);
}

/** The next notch above (`direction` > 0) or below `rate`, within the range. */
export function nextNotch(rate, direction) {
  const notch = Math.round(rate * HUNDREDTHS) / NOTCH_HUNDREDTHS;
  const next = direction > 0 ? Math.floor(notch) + 1 : Math.ceil(notch) - 1;
  return clampSpeed((next * NOTCH_HUNDREDTHS) / HUNDREDTHS);
}
