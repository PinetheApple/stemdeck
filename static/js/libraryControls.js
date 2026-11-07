// Building blocks shared by the library pane's setlists, track menu and song rename.

import { icon } from "./libraryIcons.js";

// Mirror the server's limits (SETLIST_NAME_MAX_CHARS, SONG_NAME_MAX_CHARS in app/core/config.py).
export const SETLIST_NAME_MAX_CHARS = 100;
export const SONG_NAME_MAX_CHARS = 300;

export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const PYDANTIC_VALUE_ERROR = /^Value error, /;

export class HttpError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

/** A JSON request; a failed answer throws an HttpError carrying the server's detail. */
export async function fetchJson(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const answer = await res.json().catch(() => null);
    throw new HttpError(res.status, answer?.detail);
  }
  return res.json();
}

export function isNotFound(err) {
  return err instanceof HttpError && err.status === HTTP_NOT_FOUND;
}

/** Why the server refused a 422, as a sentence a person can read, else "". */
export function refusalReason(err) {
  if (!(err instanceof HttpError) || err.status !== HTTP_UNPROCESSABLE) return "";
  const { detail } = err;
  if (typeof detail === "string") return detail;
  const first = Array.isArray(detail) ? detail[0]?.msg : "";
  return typeof first === "string" ? first.replace(PYDANTIC_VALUE_ERROR, "") : "";
}

export function textInput({ className, value = "", label, placeholder = label, maxLength }) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = className;
  input.value = value;
  input.maxLength = maxLength;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  return input;
}

/** A button with an icon, optional text, and a label as its tooltip and accessible name. */
export function iconButton(className, iconName, { label = "", text = "", filled = false } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.innerHTML = icon(iconName, { filled });
  if (label) {
    el.title = label;
    el.setAttribute("aria-label", label);
  }
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
  }
  return el;
}
