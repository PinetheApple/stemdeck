export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const finiteOr = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function roundTo(v, digits) {
  const scale = 10 ** digits;
  return Math.round(v * scale) / scale;
}

export const round1 = (v) => roundTo(v, 1);
export const round2 = (v) => roundTo(v, 2);
export const round3 = (v) => roundTo(v, 3);

export const dbToGain = (db) => 10 ** (db / 20);

export const gainToDb = (gain) => 20 * Math.log10(gain);
