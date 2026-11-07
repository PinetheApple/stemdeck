// The user's choice of lyrics kept with the song (#41): a picked version and a
// removal go to PUT and DELETE /api/jobs/{id}/lyrics, so every device and song
// bundle has them, and what a browser kept before is carried over once.
//
// The server is stood in for (stubLyricsLookup, answerLyricsChoice); what it
// keeps and refuses is tests/test_lyrics_choice_api.py.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubLyricsLookup,
  stubUpdateCheck,
} from "./helpers.mjs";

const WIKIMEDIA = /^https:\/\/((www|query)\.wikidata\.org|[a-z-]+\.wikipedia\.org)\//;
const TAGS = { artist: "Fixture Band", title: "Fixture Song" };
const ROWS = [
  {
    id: 101,
    trackName: "Fixture Song",
    artistName: "Fixture Band",
    albumName: "Studio",
    duration: 6,
    syncedLyrics: "[00:00.50] First line\n[00:02.00] Second line\n[00:04.00] Third line",
    plainLyrics: "First line\nSecond line\nThird line",
  },
  {
    id: 102,
    trackName: "Fixture Song (Live)",
    artistName: "Fixture Band",
    albumName: "Live",
    duration: 300,
    syncedLyrics: null,
    plainLyrics: "Live words\nMore live words",
  },
];
const STORE_KEY = `stemdeck.lyrics.${JOB_ID}`;
const CARRIED_OVER_KEY = "stemdeck.lyrics_carried_over";
const CARRY_OVER = /\/lyrics\?carry_over=true$/;
const REMOVED = "Lyrics removed for this track.";
const SERVER_ERROR = 500;

const KEPT_HERE = {
  entry: {
    v: 1,
    source: "lrclib",
    id: 77,
    track: "Fixture Song",
    artist: "Fixture Band",
    album: "Chosen",
    duration: 6,
    instrumental: false,
    synced: "[00:00.50] Chosen one\n[00:02.00] Chosen two",
    plain: "",
    savedAt: 1,
    offsetSec: 0.5,
  },
  others: [],
};

/** Seed this browser's old entry for the fixture track, on the first load only. */
async function keepInBrowser(page, saved) {
  await page.addInitScript(([key, value]) => {
    if (sessionStorage.getItem("e2e-seeded-lyrics")) return;
    localStorage.setItem(key, JSON.stringify(value));
    sessionStorage.setItem("e2e-seeded-lyrics", "1");
  }, [STORE_KEY, saved]);
}

/** The tagged fixture track's routes and library, the server's lyrics stood in for. */
async function prepare(page) {
  const asked = await stubLyricsLookup(page, { rows: ROWS, artist: TAGS.artist, song: TAGS.title });
  await page.route(WIKIMEDIA, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ search: [] }),
  }));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), audioTags: TAGS },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
    },
  });
  return asked;
}

async function boot(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
}

async function open(page) {
  const asked = await prepare(page);
  await boot(page);
  return asked;
}

async function showLyrics(page) {
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await expect(page.locator(".app")).not.toHaveClass(/no-track/, { timeout: 15000 });
  await page.locator(".rail-lyrics").click();
}

/** Reload with nothing of this browser's lyrics left, as another device would open the song. */
async function openElsewhere(page) {
  await page.evaluate((key) => localStorage.removeItem(key), STORE_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
  await showLyrics(page);
}

const stored = (page, key = STORE_KEY) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
const failures = (page) =>
  page.evaluate(async () => (await import("/js/notifications.js")).getFailures().map((f) => f.message));
const removeButton = (page) => page.locator(".lyrics-tools .lyrics-tool", { hasText: "Remove lyrics" });

/** Answer `method` on the fixture track's lyrics with a server error, `times` times. */
const failLyrics = (page, method, times = 1) => page.route(
  new RegExp(`/api/jobs/${JOB_ID}/lyrics(\\?.*)?$`),
  (route) => (route.request().method() === method
    ? route.fulfill({ status: SERVER_ERROR, json: { detail: "could not save lyrics" } })
    : route.fallback()),
  { times },
);

test.describe("the user's lyrics choice is kept with the song", () => {
  test("a picked version is kept on the server and shown wherever the song is opened", async ({ page }) => {
    const asked = await open(page);
    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveCount(3);
    await page.locator(".lyrics-versions-toggle").click();
    await page.locator(".lyrics-version", { hasText: "Fixture Song (Live)" }).click();
    await expect(page.locator(".lyrics-text").first()).toHaveText("Live words");

    expect(asked.choices.map((c) => c.method)).toEqual(["PUT"]);
    expect(asked.choices[0].body).toEqual({
      source: "lrclib",
      track: "Fixture Song (Live)",
      artist: "Fixture Band",
      album: "Live",
      duration: 300,
      instrumental: false,
      synced: "",
      plain: "Live words\nMore live words",
      lrclib_id: 102,
    });
    expect(await stored(page)).toBeNull();

    await openElsewhere(page);
    await expect(page.locator(".lyrics-text").first()).toHaveText("Live words");
    expect(asked).toHaveLength(1);
  });

  test("a removal is kept on the server, and the lookup does not bring lyrics back", async ({ page }) => {
    const asked = await open(page);
    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveCount(3);
    await removeButton(page).click();
    await expect(page.locator("#lyricsStatus")).toHaveText(REMOVED);
    expect(asked.choices.map((c) => c.method)).toEqual(["DELETE"]);

    await openElsewhere(page);
    await expect(page.locator("#lyricsStatus")).toHaveText(REMOVED);
    expect(asked).toHaveLength(1);
  });

  test("a lookup answered with the removal shows it, and Look up again ends it", async ({ page }) => {
    const asked = await open(page);
    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveCount(3);
    await removeButton(page).click();
    await expect(page.locator("#lyricsStatus")).toHaveText(REMOVED);

    // Read before the removal, say on another device: no lyrics, so the tab looks them up.
    await page.route(new RegExp(`/api/jobs/${JOB_ID}/lyrics$`), (route) => (route.request().method() === "GET"
      ? route.fulfill({ status: 404, json: { detail: "no lyrics" } })
      : route.fallback()), { times: 1 });
    await page.locator(".rail-library").click();
    await page.locator(".rail-lyrics").click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1].body).toEqual({});
    await expect(page.locator("#lyricsStatus")).toHaveText(REMOVED);
    await expect(page.locator(".lyrics-line")).toHaveCount(0);

    await page.locator(".lyrics-tool", { hasText: "Look up again" }).click();
    await expect(page.locator(".lyrics-line")).toHaveCount(3);
    expect(asked.at(-1).body).toEqual({ again: true });
  });

  test("a pick or removal the server could not keep says so, and leaves what was shown", async ({ page }) => {
    await open(page);
    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveCount(3);

    await failLyrics(page, "PUT");
    await page.locator(".lyrics-versions-toggle").click();
    await page.locator(".lyrics-version", { hasText: "Fixture Song (Live)" }).click();
    await expect.poll(() => failures(page)).toEqual(["Could not keep these lyrics. Try again."]);
    await expect(page.locator(".lyrics-line")).toHaveCount(3);

    await failLyrics(page, "DELETE");
    await removeButton(page).click();
    await expect.poll(() => failures(page)).toContain("Could not remove the lyrics. Try again.");
    await expect(page.locator(".lyrics-line")).toHaveCount(3);
    await expect(page.locator("#lyricsStatus")).not.toHaveText(REMOVED);
  });
});

test.describe("lyrics this browser kept before are carried over once", () => {
  test("a kept version goes up with its offset, and the browser's copy is dropped", async ({ page }) => {
    await keepInBrowser(page, KEPT_HERE);
    const asked = await open(page);
    await expect.poll(() => stored(page)).toBeNull();
    expect(asked.choices).toHaveLength(1);
    const [carried] = asked.choices;
    expect(carried.method).toBe("PUT");
    expect(carried.url).toMatch(CARRY_OVER);
    expect(carried.body).toMatchObject({ source: "lrclib", lrclib_id: 77, album: "Chosen", offset_sec: 0.5 });
    await expect.poll(() => stored(page, CARRIED_OVER_KEY)).toBe(true);

    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveText(["Chosen one", "Chosen two"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
    await showLyrics(page);
    await expect(page.locator(".lyrics-line")).toHaveText(["Chosen one", "Chosen two"]);
    expect(asked.choices).toHaveLength(1);
  });

  test("a server error keeps the browser's copy for the next boot", async ({ page }) => {
    await keepInBrowser(page, KEPT_HERE);
    const asked = await prepare(page);
    await failLyrics(page, "PUT");
    const refused = page.waitForResponse((r) => CARRY_OVER.test(r.url()) && r.status() === SERVER_ERROR);
    await boot(page);
    await refused;
    await expect.poll(() => stored(page)).toEqual(KEPT_HERE);
    expect(await stored(page, CARRIED_OVER_KEY)).toBeNull();
    expect(asked.choices).toEqual([]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => stored(page)).toBeNull();
    expect(asked.choices.map((c) => c.method)).toEqual(["PUT"]);
    await expect.poll(() => stored(page, CARRIED_OVER_KEY)).toBe(true);
  });

  test("a removal goes up as one", async ({ page }) => {
    await keepInBrowser(page, { dismissed: true });
    const asked = await open(page);
    await expect.poll(() => stored(page)).toBeNull();
    expect(asked.choices.map((c) => [c.method, CARRY_OVER.test(c.url)])).toEqual([["DELETE", true]]);
    await showLyrics(page);
    await expect(page.locator("#lyricsStatus")).toHaveText(REMOVED);
    expect(asked).toEqual([]);
  });
});
