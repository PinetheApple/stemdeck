// Section and grid edits made just before a song switch or a page close.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";
import {
  STALE_BPM,
  beatsUrl,
  sectionsUrl,
  isBeatsPatch,
  savedSections,
  savedTempo,
  savedBarLength,
  setGridBars,
  shownBarLength,
  queueSectionsSave,
  queueGridSave,
  openSong,
  openTempo,
  openSongTempo,
  holdFirstPatch,
  FAILED_SAVES,
  failHeldSave,
  closeAsHeldSaveFails,
  closePage,
  leaveSaveForClose,
  noteSaves,
  notedSaves,
  liveSaves,
  freezeTimers,
  clickFrozen,
  resetSongs,
} from "./saveRaces.mjs";

test.afterEach(resetSongs);

test.describe("sections", () => {
  test("a section added just before switching songs is saved to its song", async ({ page, request }) => {
    await page.clock.install();
    await openStudio(page);
    await freezeTimers(page);
    await clickFrozen(page, "#sectionsAddBtn");
    await clickFrozen(page, `.cat-item[data-id="${SIBLING_JOB_ID}"]`);

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
    expect(await savedSections(request, SIBLING_JOB_ID)).toEqual([]);
  });

  test("a section save held open across a switch lands on its own song only", async ({ page, request }) => {
    await openStudio(page);
    const { seen, release } = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`);
    await page.locator("#sectionsAddBtn").click();
    await openSong(page, SIBLING_JOB_ID);
    await seen;
    await expect(page.locator(".section-block")).toHaveCount(0);
    release();

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
    expect(await savedSections(request, SIBLING_JOB_ID)).toEqual([]);
    await expect(page.locator(".section-block")).toHaveCount(0);
  });

  test("a song reopened before its section save lands shows the edit", async ({ page, request }) => {
    await openStudio(page);
    const { seen, release } = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`);
    await page.locator("#sectionsAddBtn").click();
    await openSong(page, SIBLING_JOB_ID);
    await seen;
    await openSong(page, JOB_ID);

    await expect(page.locator(".section-block")).toHaveCount(1);
    release();
    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });

  test("a refused section save is neither shown on reopen nor sent on close", async ({ page, request }) => {
    await openTempo(page);
    const hold = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`, FAILED_SAVES.refused.answer);
    await page.locator("#sectionsAddBtn").click();
    await openSongTempo(page, SIBLING_JOB_ID);
    await hold.seen;
    await failHeldSave(page, hold, FAILED_SAVES.refused, sectionsUrl(JOB_ID));
    // The sibling is too short for a section; its grid goes out after the sections on close.
    await leaveSaveForClose(page, beatsUrl(SIBLING_JOB_ID), () => setGridBars(page, 5));
    await openSongTempo(page, JOB_ID);

    await expect(page.locator(".section-block")).toHaveCount(0);
    await closePage(page);
    await expect.poll(() => savedBarLength(request, SIBLING_JOB_ID)).toBe(5);
    expect(await savedSections(request, JOB_ID)).toEqual([]);
  });

  test("a section added just before the page closes is saved", async ({ page, request }) => {
    await openStudio(page);
    await page.locator("#sectionsAddBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });

  test("a section save in flight when the page closes is sent again", async ({ page, request }) => {
    await openStudio(page);
    const hold = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await page.locator("#sectionsAddBtn").click();
    await hold.seen;
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.lost, sectionsUrl(JOB_ID));

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });

  test("a section save queued behind one in flight is sent when the page closes", async ({ page, request }) => {
    await openStudio(page);
    const hold = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await page.locator("#sectionsAddBtn").click();
    await queueSectionsSave(page);
    await hold.seen;
    for (let queued = 0; queued < 2; queued++) {
      await page.locator("#sectionsAddBtn").click();
      await queueSectionsSave(page);
    }
    await noteSaves(page);
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.lost, sectionsUrl(JOB_ID));

    expect(await liveSaves(page)).toEqual([]);
    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(3);
  });
});

test.describe("beat grid", () => {
  test.beforeEach(async ({ page }) => openTempo(page));

  test("a grid edit made just before the page closes is saved", async ({ page, request }) => {
    await setGridBars(page, 3);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bars_edited).toBe(true);
  });

  test("a grid save in flight when the page closes is sent again", async ({ page, request }) => {
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await setGridBars(page, 3);
    await hold.seen;
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.lost, beatsUrl(JOB_ID));

    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(3);
  });

  test("a grid save refused while the page closes is not sent again", async ({ page, request }) => {
    const detected = await savedBarLength(request, JOB_ID);
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.refused.answer);
    await setGridBars(page, 3);
    await hold.seen;
    await openSongTempo(page, SIBLING_JOB_ID);
    await setGridBars(page, 5);
    await openSongTempo(page, JOB_ID);
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.refused, beatsUrl(JOB_ID));

    await expect.poll(() => savedBarLength(request, SIBLING_JOB_ID)).toBe(5);
    expect(await savedBarLength(request, JOB_ID)).toBe(detected);
  });

  test("a grid save queued behind one in flight is sent when the page closes", async ({ page, request }) => {
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await setGridBars(page, 3);
    await queueGridSave(page);
    await hold.seen;
    await setGridBars(page, 5);
    await queueGridSave(page);
    await noteSaves(page);
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.lost, beatsUrl(JOB_ID));

    expect(await liveSaves(page)).toEqual([]);
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(5);
  });

  test("a grid edit made while its save is in flight is saved after it", async ({ page, request }) => {
    const { seen, release } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    await setGridBars(page, 3);
    await seen;
    await setGridBars(page, 5);
    release();

    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(5);
  });

  test("a song reopened before its grid save lands shows the edit", async ({ page, request }) => {
    const { seen, release } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    await setGridBars(page, 3);
    await openSongTempo(page, SIBLING_JOB_ID);
    await seen;
    await openSongTempo(page, JOB_ID);

    expect(await shownBarLength(page)).toBe(3);
    release();
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(3);
  });

  test("a refused grid save is neither shown on reopen nor sent on close", async ({ page, request }) => {
    const detected = await savedBarLength(request, JOB_ID);
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.refused.answer);
    await setGridBars(page, 3);
    await openSongTempo(page, SIBLING_JOB_ID);
    await hold.seen;
    await failHeldSave(page, hold, FAILED_SAVES.refused, beatsUrl(JOB_ID));
    await leaveSaveForClose(page, beatsUrl(SIBLING_JOB_ID), () => setGridBars(page, 5));
    await openSongTempo(page, JOB_ID);

    expect(await shownBarLength(page)).not.toBe(3);
    await closePage(page);
    await expect.poll(() => savedBarLength(request, SIBLING_JOB_ID)).toBe(5);
    expect(await savedBarLength(request, JOB_ID)).toBe(detected);
  });

  test("the open song's grid goes first when the page closes", async ({ page, request }) => {
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await setGridBars(page, 3);
    await openSongTempo(page, SIBLING_JOB_ID);
    await hold.seen;
    await setGridBars(page, 5);
    await noteSaves(page);
    await closeAsHeldSaveFails(page, hold, FAILED_SAVES.lost, beatsUrl(JOB_ID));

    const closeSaves = (await notedSaves(page)).filter((save) => save.keepalive).map((save) => save.url);
    expect(closeSaves).toEqual([beatsUrl(SIBLING_JOB_ID), beatsUrl(JOB_ID)]);
    await expect.poll(() => savedBarLength(request, SIBLING_JOB_ID)).toBe(5);
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(3);
  });

  test("a grid save answered after a switch never puts its tempo on the new song", async ({ page }) => {
    await page.evaluate(() => {
      window.gridSaves = 0;
      document.addEventListener("beatgridsave", () => { window.gridSaves += 1; });
    });
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

    await openSongTempo(page, SIBLING_JOB_ID);
    const siblingBpm = await page.locator("#tempoReadout").textContent();
    release();
    await page.waitForFunction(() => window.gridSaves > 0);
    await expect(page.locator("#tempoReadout")).toHaveText(siblingBpm);
    await expect(page.locator("#tempoModeConstant")).toHaveAttribute("aria-checked", "true");

    const next = page.waitForRequest(isBeatsPatch(SIBLING_JOB_ID));
    await page.locator("#tempoBpmUp").click();
    expect((await next).postDataJSON().tempo.bpm).toBeCloseTo(Number(siblingBpm) + 0.1, 5);
  });
});

test.describe("after a beforeunload that never closed the page", () => {
  const EDITED_BAR_LENGTH = 3;

  test.beforeEach(async ({ page }) => {
    await openTempo(page);
    await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
  });

  test("a section edit is saved", async ({ page, request }) => {
    await page.locator("#sectionsAddBtn").click();
    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });

  test("a grid edit is saved", async ({ page, request }) => {
    await page.locator("#t-metro-edit").click();
    await page.locator("#bg-barlen").fill(String(EDITED_BAR_LENGTH));
    await page.locator("#bg-barlen").press("Enter");
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(EDITED_BAR_LENGTH);
  });

  test("a tempo edit is saved", async ({ page, request }) => {
    await page.locator("#tempoBpmUp").click();
    const bpm = Number(await page.locator("#tempoReadout").textContent());
    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bpm).toBeCloseTo(bpm, 5);
  });
});
