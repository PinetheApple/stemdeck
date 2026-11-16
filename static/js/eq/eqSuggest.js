const NOT_ENOUGH_SIGNAL = "not enough signal";
const REFUSED_STATUSES = new Set([404, 422]);

class SuggestError extends Error {
  constructor(status, detail) {
    super(`suggest: ${status} ${detail}`.trim());
    this.status = status;
    this.detail = detail;
  }
}

export async function fetchSuggestion(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new SuggestError(res.status, typeof body?.detail === "string" ? body.detail : "");
  }
  return res.json();
}

export const REFUSED_KEY = Object.freeze({ lane: "eq.suggestLaneFailed", mix: "eq.suggestMixFailed" });

/** The i18n key for a failed Suggest: too little sound, a refusal (`refusedKey`), or anything else. */
export function suggestErrorKey(err, refusedKey = REFUSED_KEY.lane) {
  if (!REFUSED_STATUSES.has(err?.status)) return "eq.suggestFailed";
  return err.detail === NOT_ENOUGH_SIGNAL ? "eq.suggestNoSignal" : refusedKey;
}
