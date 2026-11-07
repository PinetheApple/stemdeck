// Edits made just before a song switch or a page close (#40). Each test holds
// the race open with a route, or acts inside the save debounce, then switches.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openStudio,
  openInspectorTab,
  waitForClickTrack,
} from "./helpers.mjs";

const RESET_TEMPO = { mode: null, bpm: null, anchor: null, beats_per_bar: null };
const STALE_BPM = 97;
const TAP_GAP_MS = 400;
const NUDGE_SEC = 0.01;
const GONE_ID = "e2e0f00dface";
const GONE_URL = "https://example.invalid/gone-song";
const RESTORED_ID = "e2e0feedf00d";
const SIBLING_LENGTH_SEC = 2;

const beatsUrl = (id) => `/api/jobs/${id}/beats`;
const isBeatsPatch = (id) => (r) => r.url().endsWith(beatsUrl(id)) && r.method() === "PATCH";

test.afterEach(async ({ request }) => {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await request.patch(`/api/jobs/${id}/sections`, { data: { sections: [] } });
    await request.delete(beatsUrl(id));
    await request.patch(beatsUrl(id), { data: { tempo: RESET_TEMPO } });
  }
});

const savedSections = async (request, id) => (await (await request.get(`/api/jobs/${id}`)).json()).sections ?? [];
const savedGrid = async (request, id) => (await request.get(beatsUrl(id))).json();
const savedTempo = async (request, id) => (await savedGrid(request, id)).tempo;
const setGridBars = (page, beatsPerBar) =>
  page.evaluate(async (n) => (await import("/js/beatgrid.js")).setBarLengthAt(0, n), beatsPerBar);

async function openSong(page, id) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
}

/** Studio on the fixture track with the click live and the Tempo tab showing. */
async function openTempo(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Wait for the sibling's playback and click, then its grid (the only one ending inside its length). */
async function waitForSiblingTempo(page) {
  await expect(page.locator("#t-time")).toHaveText(/\/\s*00:02\s*$/, { timeout: 20000 });
  await waitForClickTrack(page, { revealOptions: false });
  await page.waitForFunction(async (lengthSec) => {
    const beats = (await import("/js/beatgrid.js")).getBeats();
    return beats.length > 0 && beats.at(-1) < lengthSec;
  }, SIBLING_LENGTH_SEC);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Hold the next requests matching `pattern` until `release()`; `seen` resolves on the first. */
async function holdRequests(page, pattern) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    markSeen(route.request());
    await held;
    await route.fallback();
  });
  return { seen, release };
}

test.describe("sections", () => {
  test("a section added just before switching songs is saved to its song", async ({ page, request }) => {
    await openStudio(page);
    await page.locator("#sectionsAddBtn").click();
    await openSong(page, SIBLING_JOB_ID);

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
    expect(await savedSections(request, SIBLING_JOB_ID)).toEqual([]);
  });

  test("a section added just before the page closes is saved", async ({ page, request }) => {
    await openStudio(page);
    await page.locator("#sectionsAddBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });
});

test.describe("beat grid", () => {
  test("a grid edit made just before the page closes is saved", async ({ page, request }) => {
    await openTempo(page);
    await setGridBars(page, 3);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bars_edited).toBe(true);
  });

  test("a grid edit made while its save is in flight is saved after it", async ({ page, request }) => {
    await openTempo(page);
    const { seen, release } = await holdRequests(page, `**${beatsUrl(JOB_ID)}`);
    await setGridBars(page, 3);
    await seen;
    await setGridBars(page, 5);
    release();

    await expect.poll(async () => (await savedGrid(request, JOB_ID)).bars?.[0]?.beats_per_bar).toBe(5);
  });

  test("a grid save answered after a switch never puts its tempo on the new song", async ({ page }) => {
    await page.addInitScript(() => {
      window.gridSaves = 0;
      document.addEventListener("beatgridsave", () => { window.gridSaves += 1; });
    });
    await openTempo(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${beatsUrl(JOB_ID)}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await held;
      const response = await route.fetch();
      const saved = await response.json();
      await route.fulfill({ response, json: { ...saved, tempo: { ...saved.tempo, bpm: STALE_BPM } } });
    });
    const sent = page.waitForRequest(isBeatsPatch(JOB_ID));
    await setGridBars(page, 3);
    await sent;

    await openSong(page, SIBLING_JOB_ID);
    await waitForSiblingTempo(page);
    const siblingBpm = await page.locator("#tempoReadout").textContent();
    release();
    await page.waitForFunction(() => window.gridSaves > 0);
    await expect(page.locator("#tempoReadout")).toHaveText(siblingBpm);
    await expect(page.locator("#tempoModeConstant")).toHaveAttribute("aria-checked", "true");

    const next = page.waitForRequest(isBeatsPatch(SIBLING_JOB_ID));
    await page.locator("#tempoBpmUp").click();
    const bpm = (await next).postDataJSON().tempo.bpm;
    expect(bpm).toBeCloseTo(Number(siblingBpm) + 0.1, 5);
  });
});

test.describe("tempo", () => {
  test("a tapped tempo still commits to its song when the song changes first", async ({ page, request }) => {
    await openTempo(page);
    const tap = page.locator("#tempoTap");
    await tap.click();
    await page.waitForTimeout(TAP_GAP_MS);
    await tap.click();
    const tapped = Number(await page.locator("#tempoReadout").textContent());

    await openSong(page, SIBLING_JOB_ID);

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bpm).toBeCloseTo(tapped, 5);
    expect((await savedTempo(request, SIBLING_JOB_ID)).user_keys ?? []).toEqual([]);
  });

  test("a tap made just before the page closes is saved", async ({ page, request }) => {
    await openTempo(page);
    const tap = page.locator("#tempoTap");
    await tap.click();
    await page.waitForTimeout(TAP_GAP_MS);
    await tap.click();
    const tapped = Number(await page.locator("#tempoReadout").textContent());
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bpm).toBeCloseTo(tapped, 5);
  });

  test("a nudge queued behind a save in flight still reaches its song after a switch", async ({ page, request }) => {
    await openTempo(page);
    const { seen, release } = await holdRequests(page, `**${beatsUrl(JOB_ID)}`);
    const later = page.locator("#tempoNudgeLater");
    await later.click();
    await seen;
    await later.click();

    await openSong(page, SIBLING_JOB_ID);
    await waitForSiblingTempo(page);
    release();

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).anchor).toBeCloseTo(2 * NUDGE_SEC, 5);
    expect((await savedTempo(request, SIBLING_JOB_ID)).user_keys ?? []).toEqual([]);
  });
});

/** Answer for the restored job with the sibling's files, as a finished re-import of GONE_URL. */
async function stubRestore(page) {
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { job_id: RESTORED_ID } });
  });
  await page.route(new RegExp(`/api/jobs/${RESTORED_ID}(/.*)?$`), async (route) => {
    const url = route.request().url();
    if (url.endsWith("/events")) {
      const state = await (await route.fetch({ url: url.replace(`${RESTORED_ID}/events`, SIBLING_JOB_ID) })).json();
      const restored = { ...state, job_id: RESTORED_ID, source_url: GONE_URL };
      return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(restored)}\n\n` });
    }
    return route.fallback({ url: url.replace(RESTORED_ID, SIBLING_JOB_ID) });
  });
}

test("a finished Sync again restore puts every panel on the restored song", async ({ page }) => {
  await page.addInitScript(() => {
    window.openedTracks = [];
    document.addEventListener("trackopen", (e) => window.openedTracks.push(e.detail?.id));
  });
  await openStudio(page, {
    catalog: {
      folders: [
        { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, GONE_ID], color: null },
        { id: "trash", name: "Trash", items: [], color: null },
      ],
      tracks: {
        [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
        [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
        [GONE_ID]: { ...fixtureTrack(GONE_ID, SIBLING_TITLE), status: "unavailable", sourceUrl: GONE_URL },
      },
    },
  });
  // After openStudio: its own /api/jobs route would otherwise answer the POST first.
  await stubRestore(page);
  await openInspectorTab(page, "upnext");
  await expect(page.locator("#upNextNow")).not.toContainText(SIBLING_TITLE);

  await openSong(page, GONE_ID);
  await expect(page.locator("#t-time")).toHaveText(/\/\s*00:02\s*$/, { timeout: 20000 });

  await expect(page.locator("#upNextNow")).toContainText(SIBLING_TITLE);
  expect(await page.evaluate(() => window.openedTracks)).toContain(RESTORED_ID);
});
