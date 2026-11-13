// ─── Persistent store (user-data.json, through the shell's store_* commands) ───
//
// Falls back to localStorage when running outside Tauri (browser dev mode).
// The store is user-data.json in the jobs folder, outside WebKit's reach, so
// WebView resets can never destroy user data.

// While the shell cannot open user-data.json every store command fails with this
// prefix; the page then stops instead of going on with stand-ins it could save.
const STORE_UNAVAILABLE = "user-data-unavailable";
const NEVER = new Promise(() => {});
let storeReadyPromise = null;

// One-time store events: each is reported once, and a handler registered
// later still gets an earlier report.
function storeEvent() {
  let reported = null;
  let handler = null;
  return {
    listen(fn) {
      handler = fn;
      if (reported) fn(reported.value);
    },
    report(value) {
      if (reported) return false;
      reported = { value };
      if (handler) handler(value);
      return true;
    },
  };
}

const unavailable = storeEvent();
const lost = storeEvent();

function isStoreUnavailable(err) {
  return String(err?.message ?? err).startsWith(STORE_UNAVAILABLE);
}

/** What the page does when the store cannot be reached. */
export function onStoreUnavailable(handler) {
  unavailable.listen(handler);
}

/** What the page does when the store opened empty because nothing could be recovered. */
export function onStoreLost(handler) {
  lost.listen(handler);
}

function reportUnavailable(err) {
  if (unavailable.report(err)) console.warn("[store] the library list cannot be reached:", err);
}

/** Resolves once the desktop store is open; never, when it cannot be. */
export function storeReady() {
  if (!window.__TAURI__?.core?.invoke) return Promise.resolve();
  if (!storeReadyPromise) {
    storeReadyPromise = window.__TAURI__.core.invoke("store_ready").then(
      (opened) => {
        if (opened?.lost) lost.report(true);
      },
      (err) => {
        reportUnavailable(err);
        return NEVER;
      },
    );
  }
  return storeReadyPromise;
}

export async function storeGet(key, fallback = null) {
  if (window.__TAURI__?.core?.invoke) {
    await storeReady();
    try {
      const val = await window.__TAURI__.core.invoke("store_get", { key });
      return val ?? fallback;
    } catch (e) {
      if (isStoreUnavailable(e)) {
        reportUnavailable(e);
        return NEVER;
      }
      console.warn("[store] get failed for", key, e);
      return fallback;
    }
  }
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch (e) { console.warn("[store] localStorage get failed for", key, e); return fallback; }
}

/** Resolves whether the write landed; never rejects, since most callers do not wait. */
export async function storeSet(key, value) {
  if (window.__TAURI__?.core?.invoke) {
    await storeReady();
    try {
      await window.__TAURI__.core.invoke("store_set", { key, value });
      return true;
    } catch (e) {
      if (isStoreUnavailable(e)) reportUnavailable(e);
      else console.warn("[store] set failed for", key, e);
    }
    return false;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) { console.warn("[store] localStorage set failed", e); }
  return false;
}

// Debounced variant — coalesces rapid writes (e.g. mixer slider moves) into
// a single store write ~300ms after the last call. Each call snapshots the
// value so no mutation races occur.
const _storePending = new Map();
export function storeSetDebounced(key, value, delayMs = 300) {
  if (_storePending.has(key)) clearTimeout(_storePending.get(key).timer);
  const snapshot = structuredClone(value);
  const timer = setTimeout(() => {
    _storePending.delete(key);
    storeSet(key, snapshot);
  }, delayMs);
  _storePending.set(key, { timer, snapshot });
}

/** Write a debounced value now, so a read right after it sees the change. */
export function storeFlushPending(key) {
  const pending = _storePending.get(key);
  if (!pending) return Promise.resolve(true);
  clearTimeout(pending.timer);
  _storePending.delete(key);
  return storeSet(key, pending.snapshot);
}

// Keys that hold critical user data and must be migrated from localStorage
// to the store on first launch after this feature ships.
const _MIGRATE_KEYS = [
  "stemdeck.folders",
  "stemdeck.deleted_jobs",
  "stemdeck:selected-stems",
];

// One-time bootstrap: copy localStorage → store for existing users.
// On fresh installs (no localStorage data) this is a no-op that just writes
// the migration flag so future upgrades can safely clear WebKit.
export async function runStoreMigrationIfNeeded() {
  if (!window.__TAURI__?.core?.invoke) return;
  await storeReady();
  try {
    // Check if any critical key is absent from the store but present in localStorage.
    const needs = await Promise.all(
      _MIGRATE_KEYS.map(async (k) => {
        const inStore = await window.__TAURI__.core.invoke("store_get", { key: k });
        return inStore === null && localStorage.getItem(k) !== null;
      })
    ).then((r) => r.some(Boolean));

    if (needs) {
      // Migrate fixed keys.
      for (const k of _MIGRATE_KEYS) {
        try {
          const raw = localStorage.getItem(k);
          if (raw !== null) {
            await window.__TAURI__.core.invoke("store_set", { key: k, value: JSON.parse(raw) });
          }
        } catch (e) { console.warn("[store] migration failed for key", k, e); }
      }
      // Migrate per-job mix keys (stemdeck:mix:<jobId>).
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("stemdeck:mix:")) {
          try {
            const raw = localStorage.getItem(k);
            if (raw !== null) {
              await window.__TAURI__.core.invoke("store_set", { key: k, value: JSON.parse(raw) });
            }
          } catch (e) { console.warn("[store] migration failed for key", k, e); }
        }
      }
    }

    // Write the flag regardless of whether migration was needed. This covers
    // fresh installs (no localStorage data) so future upgrades clear WebKit.
    await window.__TAURI__.core.invoke("mark_store_migration_done").catch((e) =>
      console.warn("[store] mark_store_migration_done failed:", e)
    );
  } catch (e) { console.warn("[store] migration error:", e); }
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m.toString().padStart(2, "0")}:${sec}`;
}

// Ruler tick: M:SS with no leading zero on the minutes digit ("0:30", "1:00", "12:30").
export function fmtTickLabel(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// Millisecond-precise timecode "ss.mmm" for the exact-loop inputs: total
// seconds, no minutes field. The minutes were two dead characters in a footer
// that runs out of width first, and a loop bound is read as an offset anyway.
// Integer-ms math avoids a rounding carry bug (e.g. 0.9999s -> "01.000", not
// "00.1000"). parseTimecode still accepts mm:ss.mmm on the way in.
export function fmtTimeMs(s) {
  if (!isFinite(s) || s < 0) return "00.000";
  const totalMs = Math.round(s * 1000);
  const sec = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;
  return `${sec.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

// Parse a user-typed loop time. Accepts "mm:ss(.mmm)" (seconds field 0-59) or a
// plain decimal-seconds value ("12.48"). Returns seconds, or null if unparseable.
export function parseTimecode(str) {
  const t = String(str ?? "").trim();
  const colon = /^(\d+):([0-5]?\d(?:\.\d{1,3})?)$/.exec(t);
  if (colon) return parseInt(colon[1], 10) * 60 + parseFloat(colon[2]);
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  return null;
}

// Can this track be fetched again from where it came from?
//
// "local:" is the scheme the importer gives an uploaded file: a name for
// something that was handed over once and is not reachable a second time.
// Everything else is a link the importer can act on.
//
// One predicate rather than three spellings of it. The composer arming the
// Extract stems button and the re-import of an unavailable track are asking the
// same question, and the answer stopped agreeing between them: the composer
// showed an uploaded file's bare filename as though it were a link, and the
// button then submitted it (#635).
export function isReimportableSource(sourceUrl) {
  return !!sourceUrl && !sourceUrl.startsWith("local:");
}

export const $ = (id) => document.getElementById(id);

/** For a save sent as the page closes: keepalive lets it finish after the page is gone. */
export const PAGE_CLOSE_FETCH = Object.freeze({ keepalive: true });