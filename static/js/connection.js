// The wrapper hands back fetch's own promise untouched, so callers see the
// same response or error as they would without it.

export const FAILURES_BEFORE_OFFLINE = 3;
export const PROBE_INTERVAL_MS = 3000;
export const HEALTH_URL = "/api/health";
const API_PREFIX = "/api/";
const INDICATOR_ID = "connStatus";
/** Dispatched on document when the server answers again after requests went unanswered. */
export const CONNECTION_RESTORED_EVENT = "connectionrestored";

/** Whether a fetch input is one of this app's own API requests. */
export function isApiRequest(input, origin) {
  const raw = typeof input === "string" ? input : input?.url ?? String(input);
  let url;
  try {
    url = new URL(raw, origin);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname.startsWith(API_PREFIX);
}

const isAbort = (error) => error?.name === "AbortError";

/** Count unanswered API requests and probe HEALTH_URL until one answers. `onRestored` runs on
 * the first answer after the server was unreachable: offline, or its health check unanswered. */
export function createConnectionMonitor({ baseFetch, origin, onChange, onRestored, schedule }) {
  let failures = 0;
  let offline = false;
  let probeScheduled = false;
  let unreachable = false;

  function setOffline(next) {
    if (next === offline) return;
    offline = next;
    onChange(offline);
  }

  function recordAnswer() {
    const restored = unreachable;
    unreachable = false;
    failures = 0;
    setOffline(false);
    if (restored) onRestored();
  }

  function recordFailure(error) {
    if (isAbort(error)) return;
    failures += 1;
    if (failures >= FAILURES_BEFORE_OFFLINE) {
      unreachable = true;
      setOffline(true);
    }
    scheduleProbe();
  }

  function scheduleProbe() {
    if (probeScheduled) return;
    probeScheduled = true;
    schedule(runProbe, PROBE_INTERVAL_MS);
  }

  function runProbe() {
    probeScheduled = false;
    if (failures === 0) return;
    monitoredFetch(HEALTH_URL, { cache: "no-store" }).catch(markUnreachable);
  }

  // The probe's failure is already counted by monitoredFetch.
  function markUnreachable(error) {
    if (!isAbort(error)) unreachable = true;
  }

  function monitoredFetch(input, init) {
    const pending = baseFetch(input, init);
    if (isApiRequest(input, origin)) pending.then(recordAnswer, recordFailure);
    return pending;
  }

  /** One health check now: true when the server answered it. */
  function checkNow() {
    return monitoredFetch(HEALTH_URL, { cache: "no-store" }).then(wasAnswered, markNotAnswered);
  }

  function markNotAnswered(error) {
    markUnreachable(error);
    return false;
  }

  return { fetch: monitoredFetch, isOffline: () => offline, checkNow };
}

const wasAnswered = () => true;
let activeMonitor = null;

/** One health check now, through the app's monitor: true when the server answered it. */
export const checkConnectionNow = () => activeMonitor?.checkNow() ?? Promise.resolve(false);

function showConnectionState(offline) {
  document.getElementById(INDICATOR_ID)?.classList.toggle("hidden", !offline);
}

function announceRestored() {
  document.dispatchEvent(new CustomEvent(CONNECTION_RESTORED_EVENT));
}

function scheduleOnWindow(fn, ms) {
  window.setTimeout(fn, ms);
}

/** Route window.fetch through the monitor. Call once, before the app fetches. */
export function initConnection() {
  const monitor = createConnectionMonitor({
    baseFetch: window.fetch.bind(window),
    origin: window.location.origin,
    onChange: showConnectionState,
    onRestored: announceRestored,
    schedule: scheduleOnWindow,
  });
  activeMonitor = monitor;
  window.fetch = monitor.fetch;
}
