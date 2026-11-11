// A finished "Sync again" restore puts every panel on the restored song, as opening
// it from the library does.
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

const GONE_ID = "e2e0f00dface";
const GONE_URL = "https://example.invalid/gone-song";
const RESTORED_ID = "e2e0feedf00d";
const RESTORED_BPM = 133;
const RESTORED_BAND = { id: "Q1299", name: "Restored Band", englishName: "Restored Band" };
const WIKIMEDIA = /^https:\/\/([a-z]+\.wikipedia\.org|www\.wikidata\.org|query\.wikidata\.org)\//;

const CATALOG = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, GONE_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
    [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    [GONE_ID]: { ...fixtureTrack(GONE_ID, SIBLING_TITLE), status: "unavailable", sourceUrl: GONE_URL },
  },
};

/** The restored job's stream: the sibling's finished state, as a re-import of GONE_URL with a band. */
async function restoredEvents(route, url) {
  const state = await (await route.fetch({ url: url.replace(`${RESTORED_ID}/events`, SIBLING_JOB_ID) })).json();
  const restored = { ...state, job_id: RESTORED_ID, source_url: GONE_URL, artist: RESTORED_BAND };
  return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(restored)}\n\n` });
}

/** The restored job's grid: the sibling's, at its own tempo, so the Tempo tab can tell them apart. */
async function restoredBeats(route, url) {
  const response = await route.fetch({ url: url.replace(RESTORED_ID, SIBLING_JOB_ID) });
  const grid = await response.json();
  return route.fulfill({ response, json: { ...grid, tempo: { ...grid.tempo, bpm: RESTORED_BPM } } });
}

/** Answer for the restored job with the sibling's files. */
async function stubRestore(page) {
  await page.route(WIKIMEDIA, (route) => route.abort());
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { job_id: RESTORED_ID } });
  });
  await page.route(new RegExp(`/api/jobs/${RESTORED_ID}(/.*)?$`), (route) => {
    const url = route.request().url();
    if (url.endsWith("/events")) return restoredEvents(route, url);
    if (url.endsWith("/beats") && route.request().method() === "GET") return restoredBeats(route, url);
    return route.fallback({ url: url.replace(RESTORED_ID, SIBLING_JOB_ID) });
  });
}

test("a finished Sync again restore puts every panel on the restored song", async ({ page }) => {
  await page.addInitScript(() => {
    window.openedTracks = [];
    document.addEventListener("trackopen", (e) => window.openedTracks.push(e.detail?.id));
  });
  await openStudio(page, { catalog: CATALOG });
  // After openStudio: its own /api/jobs route would otherwise answer the POST first.
  await stubRestore(page);
  await waitForClickTrack(page, { revealOptions: false });
  await openInspectorTab(page, "upnext");
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageTitle")).toContainText(TRACK_TITLE);

  await page.evaluate(async (id) => (await import("/js/catalog.js")).loadTrackIntoStudio(id), GONE_ID);
  await expect(page.locator("#t-time")).toHaveText(/\/\s*00:02\s*$/, { timeout: 20000 });

  await expect(page.locator("#stageTitle")).toContainText(SIBLING_TITLE);
  await expect(page.locator("#upNextNow")).toContainText(SIBLING_TITLE);
  await expect(page.locator("#np-artist")).toHaveText(RESTORED_BAND.name);
  expect(await page.evaluate(() => window.openedTracks)).toContain(RESTORED_ID);

  await page.locator("#stageExitBtn").click();
  await openInspectorTab(page, "tempo");
  await expect(page.locator("#tempoReadout")).toBeVisible();
  await expect(page.locator("#tempoReadout")).toHaveText(RESTORED_BPM.toFixed(1));
});
