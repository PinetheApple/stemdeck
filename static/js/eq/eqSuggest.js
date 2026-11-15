// Asking the server for a Suggest fit, and what to tell the user when it can't.

const NOT_ENOUGH_SIGNAL_STATUS = 422;

class SuggestError extends Error {
  constructor(status, detail) {
    super(`suggest: ${status} ${detail}`.trim());
    this.status = status;
  }
}

export async function fetchSuggestion(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new SuggestError(res.status, typeof body?.detail === "string" ? body.detail : "");
  }
  return res.json();
}

/** The i18n key for a failed Suggest: too little sound, or anything else. */
export function suggestErrorKey(err) {
  return err?.status === NOT_ENOUGH_SIGNAL_STATUS ? "eq.suggestNoSignal" : "eq.suggestFailed";
}
