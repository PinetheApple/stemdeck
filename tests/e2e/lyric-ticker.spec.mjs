// The current lyric line and the next one, in one line under the section blocks.
import { test, expect } from "@playwright/test";
import {
  openStudio,
  fixtureTrack,
  stubLyricsLookup,
  stubAudioTags,
  JOB_ID,
  SIBLING_JOB_ID,
  TALL_WINDOW,
} from "./helpers.mjs";

const SYNCED = "[00:00.50] First line\n[00:02.00] Second line\n[00:04.00] Third line";
const ROWS = [{
  id: 101,
  trackName: "Fixture Song",
  artistName: "Fixture Band",
  albumName: "",
  duration: 6,
  instrumental: false,
  syncedLyrics: SYNCED,
  plainLyrics: "First line\nSecond line\nThird line",
}];
// The artist box's own lookup, answered with no band so nothing leaves the machine.
const WIKIMEDIA = /^https:\/\/((www|query)\.wikidata\.org|[a-z-]+\.wikipedia\.org)\//;
const STARTS_AT_TWO = { id: "s1", name: "Verse", start: 2.2, end: 3, color: "#4a7fff" };

test.use({ viewport: TALL_WINDOW });

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function openTaggedStudio(page) {
  await stubLyricsLookup(page, { rows: ROWS, artist: "Fixture Band", song: "Fixture Song" });
  await stubAudioTags(page, null);
  await page.route(WIKIMEDIA, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ search: [] }),
  }));
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [STARTS_AT_TWO] } });
  expect(res.ok(), "seeding sections").toBe(true);
  await openStudio(page, {
    catalog: {
      folders: [
        { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
        { id: "trash", name: "Trash", items: [], color: null },
      ],
      tracks: {
        [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), audioTags: { artist: "Fixture Band", title: "Fixture Song" } },
        [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
      },
    },
  });
}

test("the current lyric line and the next show under the section blocks", async ({ page }) => {
  await openTaggedStudio(page);
  const ticker = page.locator("#lyricTicker");

  await expect(ticker.locator(".lyric-ticker-next")).toHaveText("First line", { timeout: 15000 });
  await page.locator('.section-block[data-id="s1"]').click();

  await expect(ticker.locator(".lyric-ticker-now")).toHaveText("Second line");
  await expect(ticker.locator(".lyric-ticker-next")).toHaveText("Third line");
  const blocks = await page.locator("#daw-sections").boundingBox();
  const line = await ticker.boundingBox();
  expect(line.y).toBeGreaterThanOrEqual(blocks.y + blocks.height - 1);
  expect(await ticker.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
});
