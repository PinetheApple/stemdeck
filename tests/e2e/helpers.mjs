// Shared setup for the browser tests.
//
// Two things here are load-bearing and were both learned the hard way:
//
// 1. The sidebar renders from the library store, not from /api/jobs. A job that
//    exists on disk but is absent from the store is invisible in the UI, and a
//    test that clicks nothing passes for the wrong reason. seedLibrary writes
//    that store before any script runs.
//
// 2. The desktop and browser download paths genuinely diverge, which is why
//    #335 was invisible in a browser. stubTauri installs a controllable
//    window.__TAURI__ so the desktop branch runs, and so the test decides when
//    an export finishes rather than racing a real one.

export const JOB_ID = "e2e0deadbeef";
export const TRACK_TITLE = "E2E Fixture Track";

// The second job seed.py writes, a re-extraction of the same source. Its
// source_url is identical to the fixture track's.
export const SIBLING_JOB_ID = "e2e0cafebabe";
export const SIBLING_TITLE = "E2E Fixture Track (again)";
export const SOURCE_URL = "local:e2e-fixture";

// libraryResize.js keeps at least this much waveform beside the stem labels.
export const MIN_TIMELINE_WIDTH = 360;

const STORAGE_KEY = "stemdeck.folders";
const STORAGE_VERSION = 2;
const BANDS_UPLOADED_KEY = "stemdeck.bands_uploaded";
const TRASH_PUSHED_KEY = "stemdeck.trash_pushed";
const seededFlagKey = "e2e.seeded";

/** The library store's shape for one finished track. */
export function fixtureTrack(id, title) {
  return {
    id,
    title,
    status: "done",
    stems: ["vocals", "drums", "bass", "other"],
    sourceUrl: SOURCE_URL,
    createdAt: 1700000000,
    favorite: false,
  };
}

/**
 * Write the library store before any of the app's scripts run.
 *
 * Tests that care about which folder a track is in build the state themselves
 * and call this. seedLibrary is the default arrangement on top of it.
 *
 * `bandsUploaded` defaults to true: a browser that has done its one-time band
 * upload, since a seeded band would otherwise PATCH the fixture job shared by the run.
 * `trashPushed` likewise, for the one-time Trash push. `seedOnce` writes the
 * store on the first load only, so a reload keeps what the app saved.
 */
export async function seedCatalogState(
  page,
  {
    folders,
    tracks,
    bandsUploaded = true,
    trashPushed = true,
    seedOnce = false,
  },
) {
  const flags = [bandsUploaded && BANDS_UPLOADED_KEY, trashPushed && TRASH_PUSHED_KEY].filter(Boolean);
  await page.addInitScript(
    ({ key, value, flags, seedOnce, seededFlagKey }) => {
      if (seedOnce && window.sessionStorage.getItem(seededFlagKey)) return;
      window.sessionStorage.setItem(seededFlagKey, "1");
      window.localStorage.setItem(key, JSON.stringify(value));
      flags.forEach((flag) => window.localStorage.setItem(flag, "true"));
    },
    { key: STORAGE_KEY, value: { v: STORAGE_VERSION, folders, tracks }, flags, seedOnce, seededFlagKey },
  );
}

/** Read the library store back, to assert on what was persisted. */
export async function readCatalogState(page) {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || "null"), STORAGE_KEY);
}

/**
 * Put both fixture tracks in the library so the sidebar renders them.
 *
 * Both, not just one. syncWithServer imports any server job the store does not
 * already know, so leaving one out would add it as a row of its own on every
 * page load in the suite.
 */
export async function seedLibrary(page) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
}

/**
 * Install a fake Tauri bridge so the app takes its desktop code path.
 *
 * The export is two commands, and the test controls each independently:
 *
 *   pick_export_destination  the native save dialog
 *   download_to_path         the transfer
 *
 * Holding the dialog open is what makes #338 testable -- the label must still
 * read "Export Mix" while the user is choosing a folder, because nothing is
 * being exported yet. Holding the transfer open is what makes #335 testable.
 * Tests drive both through window.__e2e.
 */
export async function stubTauri(page) {
  await page.addInitScript(() => {
    const calls = [];
    let pendingResolve = null;
    let pendingReject = null;
    let pickResolve = null;

    const settle = (fn) => (v) => {
      pendingResolve = null;
      pendingReject = null;
      fn(v);
    };

    window.__e2e = {
      calls,
      // Choose a destination, as if the user hit Save in the dialog.
      choosePath: () => pickResolve && (pickResolve("token-1"), (pickResolve = null)),
      // Dismiss the dialog. No transfer follows.
      cancelPick: () => pickResolve && (pickResolve(null), (pickResolve = null)),
      pickPending: () => Boolean(pickResolve),
      // Settle the transfer that is currently in flight.
      finishSave: (value) => pendingResolve && pendingResolve(value ?? null),
      failSave: (message) => pendingReject && pendingReject(message ?? "save failed"),
      savePending: () => Boolean(pendingResolve),
      callsFor: (cmd) => calls.filter((c) => c.cmd === cmd),
    };

    window.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          calls.push({ cmd, args });
          switch (cmd) {
            case "pick_export_destination":
              return new Promise((resolve) => { pickResolve = resolve; });
            case "download_to_path":
            case "save_audio_file":
              return new Promise((resolve, reject) => {
                pendingResolve = settle(resolve);
                pendingReject = settle(reject);
              });
            // The library store lives in the Tauri store on desktop. Back it
            // with localStorage so seedLibrary works in this mode too.
            case "store_get": {
              const raw = window.localStorage.getItem(args?.key);
              return Promise.resolve(raw === null ? null : JSON.parse(raw));
            }
            case "store_set":
              window.localStorage.setItem(args?.key, JSON.stringify(args?.value));
              return Promise.resolve(null);
            case "get_setup_status":
              return Promise.resolve({ ready: true, data_dir: "/tmp/e2e", ffmpeg: "/usr/bin/ffmpeg" });
            default:
              return Promise.resolve(null);
          }
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  });
}

/**
 * Keep export requests off the real backend.
 *
 * A browser-mode export fetches a mixdown endpoint that shells out to ffmpeg.
 * These tests are about the menu's state machine, so the bytes are irrelevant
 * and the render time is not worth paying.
 */
export async function stubExportEndpoints(page) {
  await page.route("**/api/jobs/*/mix**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from("RIFF") }));
  await page.route("**/api/jobs/*/stems.zip**", (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from("PK") }));
  await page.route("**/api/jobs/*/render**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from("RIFF") }));
}

/**
 * Answer the tag read an older track asks for when it is opened (#699), with
 * `answer` as its audio_tags (null: the file had none; a function: called with
 * the job id), and record the job id of each request. `hold`, when given, is
 * awaited before answering, so a test can act while the read is still out.
 * `status` other than 200 answers with that error instead.
 */
export async function stubAudioTags(page, answer = null, { hold = null, status = 200 } = {}) {
  const asked = [];
  await page.route("**/api/jobs/*/audio-tags", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    asked.push(id);
    if (hold) await hold;
    const tags = typeof answer === "function" ? answer(id) : answer;
    try {
      await route.fulfill(status === 200
        ? { status, contentType: "application/json", body: JSON.stringify({ audio_tags: tags }) }
        : { status, contentType: "application/json", body: JSON.stringify({ detail: "stubbed" }) });
    } catch {
      // The page went away while the answer was held.
    }
  });
  return asked;
}

/**
 * Answer the update check locally instead of letting it reach GitHub.
 *
 * Two reasons. It puts an external service in the path of every run, and more
 * subtly it makes the notification centre non-deterministic: when the release
 * on GitHub is newer than the version under test, an update card appears and
 * lights the same badge failure notifications use. That is real behaviour --
 * one badge for the centre -- but a test asserting on the badge has to control
 * it. A non-ok response is the check's own "nothing to see" path.
 *
 * This is why the notification tests passed locally and failed in CI: a dev
 * build reports a version containing "dev", which checkForUpdate skips, so the
 * card never appeared on a developer machine.
 */
export async function stubUpdateCheck(page, { available = false } = {}) {
  if (available) {
    // Force the "an update exists" state: the check skips dev builds, so the
    // version has to look like a release for the card to appear at all.
    await page.route("**/api/health**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          name: "StemDeck",
          status: "ok",
          version: "0.5.0",
          ffmpeg_configured: true,
          demucs_model: "htdemucs_6s",
          demucs_device: "cpu",
        }),
      }));
    // A single object, not an array: the app asks for /releases/latest, which
    // is GitHub's own answer to "which release is the latest one". A release
    // published as a pre-release, or as neither latest nor pre-release, is not
    // returned by that endpoint at all, so it cannot be offered (#666).
    await page.route("https://api.github.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tag_name: "v9.9.9",
          draft: false,
          prerelease: false,
          body: "notes",
          html_url: "https://example.invalid",
          assets: [],
        }),
      }));
    return;
  }
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: "stubbed by tests" }),
    }));
}

// A read still in flight when the test ends: its response is gone and the
// request can no longer be answered.
const TEARDOWN_ERROR = /Response has been disposed|Target page, context or browser has been closed/;

/** Open the fixture track in the studio and wait until the transport is live. */
/**
 * Keep favourites off the shared e2e backend (#734).
 *
 * A heart now writes to the server, and every spec shares one server, so a
 * favourite set by one test would come back through GET /api/jobs into the
 * next one's library. Writes are answered here instead, and the server's
 * value stays null, which the desktop reads as "never said". A test about the
 * sync itself passes `serverFavorites` to stand in for what the server knows.
 */
export async function stubFavorites(page, serverFavorites = {}) {
  const writes = [];
  await page.route("**/api/jobs/*/favorite", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const { favorite } = JSON.parse(route.request().postData() || "{}");
    writes.push({ id, favorite });
    serverFavorites[id] = favorite;
    await route.fulfill({ json: { job_id: id, favorite } });
  });
  await page.route(/\/api\/jobs(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    try {
      const res = await route.fetch();
      const jobs = await res.json();
      for (const j of jobs) j.favorite = serverFavorites[j.job_id] ?? null;
      await route.fulfill({ response: res, json: jobs });
    } catch (err) {
      if (!TEARDOWN_ERROR.test(String(err?.message))) throw err;
    }
  });
  return writes;
}

const TRASH_ACTION = /\/api\/jobs\/([^/]+)\/(trash|restore)$/;
/** The job list the library sync reads, Trash included. */
export const JOB_LIST_URL = /\/api\/jobs\?trashed=include$/;

/**
 * Stand in for the server's Trash, which the desktop follows on every sync, so a
 * real trash or restore would leak into every later spec on the shared backend.
 *
 * Options, each a list of job ids unless noted:
 * - `trashed`: listed as trashed.
 * - `unavailable`: listed with status "unavailable".
 * - `hidden`: left out of the list.
 * - `replaces`: { jobId: replacedJobId }, listed as each job's `replaces`.
 *
 * Returns the server: `trashed`, `unavailable` and `hidden` as Sets the test may
 * change; `offline` makes trash and restore fail; `refuseWith` answers them with
 * that status; `calls` records each as { id, action }.
 */
export async function stubServerTrash(
  page,
  {
    trashed = [],
    unavailable = [],
    hidden = [],
    replaces = {},
  } = {},
) {
  const server = {
    calls: [],
    offline: false,
    refuseWith: null,
    trashed: new Set(trashed),
    unavailable: new Set(unavailable),
    hidden: new Set(hidden),
  };
  await page.route(TRASH_ACTION, (route) => {
    if (server.offline) return route.abort();
    const [, id, action] = new URL(route.request().url()).pathname.match(TRASH_ACTION);
    server.calls.push({ id, action });
    if (server.refuseWith) return route.fulfill({ status: server.refuseWith, json: { detail: "stubbed" } });
    if (action === "trash") server.trashed.add(id);
    else server.trashed.delete(id);
    return route.fulfill({ json: { job_id: id, trashed_at: action === "trash" ? 1 : null } });
  });
  await page.route(JOB_LIST_URL, async (route) => {
    try {
      const jobs = await (await route.fetch()).json();
      const listed = jobs
        .filter((state) => !server.hidden.has(state.job_id))
        .map((state) => ({
          ...state,
          trashed_at: server.trashed.has(state.job_id) ? 1 : null,
          status: server.unavailable.has(state.job_id) ? "unavailable" : state.status,
          replaces: replaces[state.job_id] ?? null,
        }));
      await route.fulfill({ json: listed });
    } catch (err) {
      if (!TEARDOWN_ERROR.test(String(err?.message))) throw err;
    }
  });
  return server;
}

export async function openStudio(
  page,
  { tauri = false, updateAvailable = false, serverFavorites = {}, catalog = null } = {},
) {
  if (catalog) await seedCatalogState(page, catalog);
  else await seedLibrary(page);
  const favoriteWrites = await stubFavorites(page, serverFavorites);
  if (tauri) await stubTauri(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page, { available: updateAvailable });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
  // The transport total only leaves 00:00 once an engine has reported a
  // duration, so it doubles as "the studio is actually ready".
  await page.waitForFunction(
    () => !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00"),
    null,
    { timeout: 20000 },
  );
  return { favoriteWrites };
}

/**
 * Wait for the library pane to finish sliding open or shut. A narrow window
 * collapses it once a song opens, and its width animates, so anything measured
 * beside it mid-slide is measured at a width that is about to change.
 */
export async function waitForPanesSettled(page) {
  await page.waitForFunction(() => document.querySelector(".sidebar").getAnimations().length === 0);
}

/** Wait until the Network pane has rendered what /api/settings gave it: cards or the empty note. */
export async function waitForNetworkRendered(page) {
  await page.locator(".settings-net-qr > *").first().waitFor({ state: "attached" });
}

/**
 * afterEach hook for specs that rewrite /api/settings through route.fetch(). Several panes
 * fetch it, and a handler still awaiting its response when the page closes throws.
 */
export async function settleRoutes({ page }) {
  await page.unrouteAll({ behavior: "wait" });
}

/**
 * Wait until the click track is live.
 *
 * openStudio returns once the transport reports a duration, but the metronome
 * is built later still -- after the audio engine is up and the beat grid has
 * been fetched. Acting before then hits a null metronome, where the rate and
 * accent controls silently no-op: the click looks present and does nothing.
 */
export async function waitForClickTrack(page, { revealOptions = true } = {}) {
  await page.waitForFunction(
    () => document.querySelector("#t-metro") && !document.querySelector("#t-metro").disabled,
    null,
    { timeout: 20000 },
  );
  if (revealOptions) await openClickOptions(page);
}

/** Show one of the inspector's tabs: "tempo", "upnext" or "details". */
export async function openInspectorTab(page, name) {
  const tab = page.locator(`.inspector-tab[data-tab="${name}"]`);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await page.locator(`.inspector-pane[data-pane="${name}"]`).waitFor({ state: "visible", timeout: 5000 });
}

/**
 * Put the click-track options where a test can click them: the inspector's
 * Tempo tab. A spec that goes straight for #t-metro-bar while another tab is
 * showing finds a control that exists, is enabled, and cannot be clicked.
 *
 * Pass revealOptions: false to waitForClickTrack to leave the tabs alone.
 */
export async function openClickOptions(page) {
  await openInspectorTab(page, "tempo");
}

export const exportUi = (page) => ({
  button: page.locator("#t-export-btn"),
  panel: page.locator("#t-export-panel"),
  label: page.locator("#t-export-label"),
  mix: page.locator("#t-export-mix"),
  stems: page.locator("#t-export-stems"),
  region: page.locator("#t-export-region"),
  fmt: (name) => page.locator(`#t-fmt-${name}`),
  error: page.locator("#error:not(.hidden)"),
  open: async () => {
    await page.locator("#t-export-btn").click();
    await page.locator("#t-export-panel:not(.hidden)").waitFor({ timeout: 5000 });
  },
});

/** The server's lyrics lookup, which the Lyrics tab asks rather than LRCLIB (#719). */
export const LYRICS_LOOKUP = /\/api\/jobs\/[a-f0-9]{12}\/lyrics\/lookup$/;

/** GET .../lyrics after the user removed the track's lyrics. */
export const LYRICS_REMOVED = { detail: "lyrics removed", removed: true, others: [] };

const isUsersDecision = (lyrics) => Boolean(lyrics?.removed || lyrics?.chosen || lyrics?.source === "user");

/** lyrics.json once `version` is kept over `shown`: chosen when `picked`, with
 * what was shown and its others still offered, once each, without it. */
function keptLyrics(version, shown, picked) {
  const pool = shown?.source ? [shown, ...(shown.others || [])] : shown?.others || [];
  const seen = new Set([version.lrclib_id]);
  const others = [];
  for (const { others: _, chosen: __, timing: ___, ...other } of pool) {
    if (other.lrclib_id && !seen.has(other.lrclib_id)) {
      seen.add(other.lrclib_id);
      others.push(other);
    }
  }
  return { v: 1, ...version, ...(picked ? { chosen: true } : {}), timing: "exact", others };
}

/**
 * Answer PUT or DELETE /api/jobs/{id}/lyrics the way the server keeps the
 * user's choice (tests/test_lyrics_choice_api.py): a version becomes the
 * lyrics, chosen unless ?picked=false, and a removal leaves LYRICS_REMOVED; a
 * decision already held stays against ?carry_over=true or ?picked=false.
 * `holder.lyrics` is what GET then answers (200 with a source, else 404), and
 * `sent` collects { method, url, body }.
 * Resolves to false for any other method, which the caller answers.
 */
export async function answerLyricsChoice(route, holder, sent = []) {
  const request = route.request();
  const method = request.method();
  if (method !== "PUT" && method !== "DELETE") return false;
  const body = method === "PUT" ? request.postDataJSON() : null;
  sent.push({ method, url: request.url(), body });
  const query = new URL(request.url()).searchParams;
  const carryOver = query.get("carry_over") === "true";
  const picked = query.get("picked") !== "false";
  if (!((carryOver || !picked) && isUsersDecision(holder.lyrics))) {
    holder.lyrics = method === "PUT" ? keptLyrics(body, holder.lyrics, picked) : LYRICS_REMOVED;
  }
  await route.fulfill({ status: holder.lyrics.source ? 200 : 404, json: holder.lyrics });
  return true;
}

/**
 * Stand in for the server's lyrics lookup, so the lyrics specs run offline and
 * never reach LRCLIB through the shared backend.
 *
 * `rows` are LRCLIB rows. Like the server, it keeps only versions of `song` by
 * `artist` (brackets and a " - ..." tail aside), keeps the first within 3 s of
 * the track's `duration` and offers the others with it, or offers them all
 * when none is that length. What it kept or offered is then what GET
 * .../lyrics answers, as the server's lyrics.json would; the user's pick and
 * removal are kept as answerLyricsChoice does, and a lookup after a removal
 * answers it unless asked `again`, which ends it. The rule itself is tested
 * against the real server in tests/test_lyrics_lookup.py; this only has to
 * answer the way it does. Resolves to the requests the page made: [{ id, body }], with the PUTs
 * and DELETEs in its `choices`.
 */
export async function stubLyricsLookup(page, { rows = [], artist = "", song = "", duration = 6, offline = false, nothingKnown = false } = {}) {
  const asked = [];
  // Not enumerable, so `asked` still equals a plain array of lookups.
  Object.defineProperty(asked, "choices", { value: [] });
  const jobs = {};
  const jobOf = (route) => new URL(route.request().url()).pathname.split("/")[3];
  const holderOf = (route) => (jobs[jobOf(route)] ??= { lyrics: null });
  const version = (r) => ({
    source: "lrclib",
    lrclib_id: r.id,
    track: r.trackName,
    artist: r.artistName,
    album: r.albumName || "",
    duration: r.duration,
    instrumental: Boolean(r.instrumental),
    synced: r.syncedLyrics || "",
    plain: r.plainLyrics || "",
  });
  const songKey = (s) => String(s || "").replace(/[([{][^)\]}]*[)\]}]/g, "").replace(/\s+-\s+.*$/, "").trim().toLowerCase();
  const answerHeld = (route, lyrics) => route.fulfill({
    status: lyrics.source ? 200 : 404,
    json: lyrics,
    headers: { "cache-control": "no-cache" },
  });
  await page.route(/\/api\/jobs\/[a-f0-9]{12}\/lyrics(\?.*)?$/, async (route) => {
    const holder = holderOf(route);
    if (await answerLyricsChoice(route, holder, asked.choices)) return;
    if (route.request().method() !== "GET") return route.fallback();
    if (holder.lyrics?.source || holder.lyrics?.removed || holder.lyrics?.others?.length) return answerHeld(route, holder.lyrics);
    return route.fallback();
  });
  await page.route(LYRICS_LOOKUP, (route) => {
    const holder = holderOf(route);
    const body = JSON.parse(route.request().postData() || "{}");
    asked.push({ id: jobOf(route), body });
    if (holder.lyrics?.source) return answerHeld(route, holder.lyrics);
    if (holder.lyrics?.removed && !body.again) return answerHeld(route, holder.lyrics);
    if (holder.lyrics?.removed) holder.lyrics = null;
    if (offline) return route.fulfill({ status: 502, json: { detail: "lyrics service unreachable" } });
    if (nothingKnown) return route.fulfill({ status: 404, json: { detail: "nothing to look up", others: [], nothing_known: true } });
    const mine = rows.filter((r) => r.artistName === artist && songKey(r.trackName) === songKey(song)).map(version);
    const best = mine.find((v) => Math.abs(v.duration - duration) <= 3);
    holder.lyrics = best
      ? { v: 1, ...best, timing: "exact", others: mine.filter((v) => v !== best) }
      : { detail: "no lyrics", others: mine };
    return answerHeld(route, holder.lyrics);
  });
  return asked;
}

const PENDING_UPLOADS_MAX = 5;
const PENDING_URLS_MAX = 50;
const SEPARATING = { status: "separating", stage: "Separating 40%", progress: 0.4 };

/** What GET /api/queue answers: an unpaused queue with every pending slot free. */
function queueState(running, queued = []) {
  return {
    running,
    queued,
    paused: false,
    max_pending_uploads: PENDING_UPLOADS_MAX,
    max_pending_urls: PENDING_URLS_MAX,
    capacity_left_uploads: PENDING_UPLOADS_MAX,
    capacity_left_urls: PENDING_URLS_MAX,
  };
}

/**
 * Stand in for the import queue, for a test that has to watch an import while
 * it runs. The e2e backend never separates anything, so a job that stays
 * "running" long enough to look at cannot be produced for real.
 *
 * `run()` reports the job as running and `settle()` as gone, each followed by a
 * queue read so the page sees it at once. The queue stream is held off, or its
 * own empty frames would override the stub. `sourceUrl` is what the job was
 * imported from; a `local:` one is an upload.
 */
export async function stubImportQueue(page, jobId, title = "Importing", { sourceUrl = null } = {}) {
  let running = false;
  await page.route("**/api/queue", (route) =>
    route.fulfill({
      json: queueState(running ? { ...SEPARATING, job_id: jobId, title, source_url: sourceUrl } : null),
    }));
  await page.route("**/api/queue/events", (route) => route.abort());
  const read = () => page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
  return {
    run: async () => { running = true; await read(); },
    settle: async () => { running = false; await read(); },
  };
}

const LONG_QUEUE_RUNNING_ID = "e2e0feed0000";
const LONG_QUEUE_WAITING_IDS = ["e2e0feed0001", "e2e0feed0002", "e2e0feed0003"];

/** A running import and three waiting ones, so the last two waiting rows offer "extract next". */
export async function stubLongQueue(page) {
  const job = (id) => ({ job_id: id, status: "queued", title: id, source_url: `https://example.invalid/${id}` });
  const running = { ...job(LONG_QUEUE_RUNNING_ID), ...SEPARATING };
  await page.route(
    "**/api/queue",
    (route) => route.fulfill({ json: queueState(running, LONG_QUEUE_WAITING_IDS.map(job)) }),
  );
  await page.route("**/api/queue/events", (route) => route.abort());
}

const JOB_URL = /\/api\/jobs\/[a-f0-9]{12}$/;

/**
 * Answer "Save for this track" here. The fixture job is shared by the whole run,
 * so a real PATCH would leave its saved band on every spec after this one.
 */
export async function stubBandSave(page) {
  await page.route(JOB_URL, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const real = await (await page.request.get(route.request().url())).json();
    const { band } = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...real, user_band: band, artist: band }),
    });
  });
}

/** The messages in the notification centre, newest first. */
export async function failureMessages(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("stemdeck:failures") || "[]").map((f) => f.message));
}

/** A string as the page shows it in its current language. */
export async function uiText(page, key, vars = {}) {
  return page.evaluate(async ([k, v]) => (await import("/js/i18n.js")).t(k, v), [key, vars]);
}

/** Keys the specs press by name; the library's arrow keys are rovingRows.js's ROW_KEY. */
export const KEY = Object.freeze({
  TAB: "Tab",
  ENTER: "Enter",
  ESCAPE: "Escape",
  DELETE: "Delete",
});
