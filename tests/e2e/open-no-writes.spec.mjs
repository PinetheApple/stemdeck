// Opening a song with the Lyrics tab showing while the server refuses every write:
// the song and its lyrics show as usual, nothing is written unless there is
// something new to keep, and a refused write is not sent again on each open.
// Held bands are covered in band-on-server.spec.mjs.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  LYRICS_LOOKUP,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

const API = /\/api\//;
const CATALOG_MODULE = "/js/catalog.js";
const LYRICS = /\/api\/jobs\/[a-f0-9]{12}\/lyrics$/;
// A keep carries ?picked=false when it is not the user's pick.
const KEEP = /\/api\/jobs\/[a-f0-9]{12}\/lyrics(\?.*)?$/;
const WIKIMEDIA = /^https:\/\/((www|query)\.wikidata\.org|[a-z-]+\.wikipedia\.org)\//;
const WRITES_REFUSED = 503;
const READ_METHODS = new Set(["GET", "HEAD"]);
const TAGS = { artist: "Fixture Band", title: "Fixture Song" };
// Tags and work already answered, so the one-time tag backfill has nothing to ask.
const TAGS_CHECKED = { audioTagsChecked: true, workChecked: true };
const EMBEDDED = "[00:00.50]Embedded one\n[00:02.00]Embedded two";
const A_REPEAT_WOULD_HAVE_LEFT_MS = 500;
const LIBRARY_SHOWN_MS = 20000;
const TRACK_OPEN_MS = 15000;
const LOOKUP_REFUSED = "Could not look up lyrics right now. Try again later.";
const NOTHING_KNOWN = "This track has no artist or song tags.";
const NOT_FOUND = "No lyrics found";
const REFUSED = { status: WRITES_REFUSED, json: { detail: "writes unavailable" } };
const ALREADY_LOOKING = { status: 409, json: { detail: "already looking" } };
const NOTHING_TO_LOOK_UP = { status: 404, json: { detail: "nothing to look up", others: [], nothing_known: true } };
const NO_LYRICS = { status: 404, json: { detail: "no lyrics", others: [] } };

const KEPT = {
  v: 1,
  source: "lrclib",
  lrclib_id: 201,
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "Studio",
  duration: 6,
  synced: "[00:00.50] Server one\n[00:02.00] Server two",
  plain: "",
  instrumental: false,
  others: [],
};

/** Every write to /api refused; resolves to the writes asked, as "METHOD path". */
async function refuseWrites(page) {
  const writes = [];
  await page.route(API, (route) => {
    const request = route.request();
    if (READ_METHODS.has(request.method())) return route.fallback();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: WRITES_REFUSED, json: { detail: "writes unavailable" } });
  });
  return writes;
}

/** Answer lookups in turn from `answers`, the last for every later one; each is recorded in `writes`. */
async function answerLookups(page, answers, writes) {
  await page.route(LYRICS_LOOKUP, (route) => {
    writes.push(`POST ${new URL(route.request().url()).pathname}`);
    return route.fulfill(answers.length > 1 ? answers.shift() : answers[0]);
  });
}

/** Keeping lyrics never reaches the server, as on a dropped connection; each is recorded in `writes`. */
async function dropKeeps(page, writes) {
  await page.route(KEEP, (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.fallback();
    writes.push(`PUT ${new URL(request.url()).pathname}`);
    return route.abort();
  });
}

/** Boot with the fixture track tagged `audioTags`, the server keeping `kept` lyrics;
 * `lookups` answers its lookups in turn, else they are refused as every write is,
 * and `keepsDropped` loses every keep on the way. */
async function boot(page, { audioTags = TAGS, kept = null, lookups = null, keepsDropped = false } = {}) {
  await page.route(LYRICS, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (kept) return route.fulfill({ status: 200, json: kept });
    return route.fulfill({ status: 404, json: { detail: "no lyrics" } });
  });
  await page.route(WIKIMEDIA, (route) => route.fulfill({
    status: 200,
    headers: { "access-control-allow-origin": "*" },
    json: { search: [] },
  }));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  const writes = await refuseWrites(page);
  if (lookups) await answerLookups(page, lookups, writes);
  if (keepsDropped) await dropKeeps(page, writes);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), ...TAGS_CHECKED, audioTags },
      [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"), ...TAGS_CHECKED },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: LIBRARY_SHOWN_MS });
  await openTrack(page, JOB_ID);
  await page.locator(".rail-lyrics").click();
  return writes;
}

async function openTrack(page, id) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().dblclick();
  await expect(page.locator(".app")).not.toHaveClass(/no-track/, { timeout: TRACK_OPEN_MS });
}

/** Open a song the way a click on its row does; the Lyrics view hides the library. */
function openFromCatalog(page, id) {
  return page.evaluate(async ([path, trackId]) => {
    const catalog = await import(new URL(path, location.href).href);
    await catalog.loadTrackIntoStudio(trackId);
  }, [CATALOG_MODULE, id]);
}

/** Open the other track and come back, twice, as a user browsing would. */
async function openAgain(page) {
  for (let i = 0; i < 2; i++) {
    await openFromCatalog(page, SIBLING_JOB_ID);
    await expect(page.locator("#title")).toContainText("again");
    await openFromCatalog(page, JOB_ID);
    await expect(page.locator("#title")).not.toContainText("again");
  }
  await page.waitForTimeout(A_REPEAT_WOULD_HAVE_LEFT_MS);
}

const lookupsIn = (writes) => () => writes.filter((w) => LYRICS_LOOKUP.test(w));
const lyricsStatus = (page) => page.locator("#lyricsStatus");
const lyricsWrites = (writes) => writes.filter((w) => w.includes(`/api/jobs/${JOB_ID}/lyrics`));

test.describe("opening a song while the server refuses writes", () => {
  test("shows the song and its kept lyrics, and writes nothing", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const writes = await boot(page, { kept: KEPT });
    await expect(page.locator(".lyrics-line")).toHaveText(["Server one", "Server two"]);

    await openAgain(page);

    await expect(page.locator(".lyrics-line")).toHaveText(["Server one", "Server two"]);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("shows a file's own lyrics, and a refused keep is not sent again on each open", async ({ page }) => {
    const writes = await boot(page, { audioTags: { ...TAGS, lyrics: EMBEDDED } });
    await expect(page.locator(".lyrics-line")).toHaveText(["Embedded one", "Embedded two"]);
    await expect.poll(() => lyricsWrites(writes)).toEqual([`PUT /api/jobs/${JOB_ID}/lyrics`]);

    await openAgain(page);

    await expect(page.locator(".lyrics-line")).toHaveText(["Embedded one", "Embedded two"]);
    expect(lyricsWrites(writes)).toHaveLength(1);
  });

  test("a keep that never reached the server is sent again on the next open", async ({ page }) => {
    const writes = await boot(page, { audioTags: { ...TAGS, lyrics: EMBEDDED }, keepsDropped: true });
    await expect(page.locator(".lyrics-line")).toHaveText(["Embedded one", "Embedded two"]);

    await openAgain(page);

    await expect(page.locator(".lyrics-line")).toHaveText(["Embedded one", "Embedded two"]);
    expect(lyricsWrites(writes)).toHaveLength(3);
  });

  test("a refused lookup is not asked again on each open, only by Look up again", async ({ page }) => {
    const writes = await boot(page);
    const lookups = lookupsIn(writes);
    await expect(lyricsStatus(page)).toHaveText(LOOKUP_REFUSED);
    expect(lookups()).toHaveLength(1);

    await openAgain(page);

    await expect(lyricsStatus(page)).toHaveText(LOOKUP_REFUSED);
    await expect(page.locator(".lyrics-tool", { hasText: "Look up again" })).toBeVisible();
    expect(lookups()).toHaveLength(1);

    await page.locator(".lyrics-tool", { hasText: "Look up again" }).click();
    await expect.poll(lookups).toHaveLength(2);
  });

  test("a lookup answered after a refusal is what later openings show", async ({ page }) => {
    const writes = await boot(page, { lookups: [REFUSED, NOTHING_TO_LOOK_UP] });
    await expect(lyricsStatus(page)).toHaveText(LOOKUP_REFUSED);

    await page.locator(".lyrics-tool", { hasText: "Look up again" }).click();
    await expect(lyricsStatus(page)).toContainText(NOTHING_KNOWN);
    await openAgain(page);

    await expect(lyricsStatus(page)).toContainText(NOTHING_KNOWN);
    expect(lookupsIn(writes)()).toHaveLength(4);
  });

  test("a lookup already running is asked again on the next open", async ({ page }) => {
    const writes = await boot(page, { lookups: [ALREADY_LOOKING, NO_LYRICS] });
    await expect(lyricsStatus(page)).toHaveText(LOOKUP_REFUSED);

    await openAgain(page);

    await expect(lyricsStatus(page)).toContainText(NOT_FOUND);
    expect(lookupsIn(writes)()).toHaveLength(2);
  });
});
