// Tempo edits made just before a song switch or a page close.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID } from "./helpers.mjs";
import {
  beatsUrl,
  savedTempo,
  savedBarLength,
  setGridBars,
  openTempo,
  openSongTempo,
  holdFirstPatch,
  FAILED_SAVES,
  failHeldSave,
  closeAndSettle,
  closeCuttingOffHeldSave,
  freezeTimers,
  clickFrozen,
  TAP_GAP_MS,
  NUDGE_SEC,
  resetSongs,
} from "./saveRaces.mjs";

test.afterEach(resetSongs);

test.describe("tempo", () => {
  test("a tapped tempo still commits to its song when the song changes first", async ({ page, request }) => {
    await page.clock.install();
    await openTempo(page);
    await freezeTimers(page);
    await clickFrozen(page, "#tempoTap");
    await page.clock.runFor(TAP_GAP_MS);
    await clickFrozen(page, "#tempoTap");
    const tapped = Number(await page.locator("#tempoReadout").textContent());
    await clickFrozen(page, `.cat-item[data-id="${SIBLING_JOB_ID}"]`);

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

  test("a grid edit after an unsent mode change closes on the mode its edit order gives", async ({ page, request }) => {
    await page.clock.install();
    await openTempo(page);
    const { seen } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    await page.locator("#tempoModeFollow").click();
    await seen;
    await freezeTimers(page);
    await clickFrozen(page, "#tempoModeConstant");
    await page.clock.runFor(1);
    await setGridBars(page, 3);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(3);
    // In edit order the grid comes after the mode change, and a grid save drops the saved mode.
    expect((await savedTempo(request, JOB_ID)).mode).toBe("follow");
  });

  test("a nudge queued behind a save in flight still reaches its song after a switch", async ({ page, request }) => {
    await openTempo(page);
    const { seen, release } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    const later = page.locator("#tempoNudgeLater");
    await later.click();
    await seen;
    await later.click();

    await openSongTempo(page, SIBLING_JOB_ID);
    release();

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).anchor).toBeCloseTo(2 * NUDGE_SEC, 5);
    expect((await savedTempo(request, SIBLING_JOB_ID)).user_keys ?? []).toEqual([]);
  });

  test("a tempo edit after the grid edit keeps the mode change's own place in edit order", async ({ page, request }) => {
    await page.clock.install();
    await openTempo(page);
    const { seen } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    await page.locator("#tempoModeFollow").click();
    await seen;
    await freezeTimers(page);
    await clickFrozen(page, "#tempoModeConstant");
    await page.clock.runFor(1);
    await setGridBars(page, 3);
    await page.clock.runFor(1);
    await clickFrozen(page, "#tempoBpmUp");
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(3);
    expect((await savedTempo(request, JOB_ID)).mode).toBe("follow");
  });

  test("a tempo save in flight when the page closes is sent again", async ({ page, request }) => {
    await openTempo(page);
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await page.locator("#tempoNudgeLater").click();
    await hold.seen;
    await closeCuttingOffHeldSave(page, hold, beatsUrl(JOB_ID));

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).anchor).toBeCloseTo(NUDGE_SEC, 5);
  });

  for (const [how, failure] of Object.entries(FAILED_SAVES)) {
    test(`a ${how} tempo save is neither shown on reopen nor sent on close`, async ({ page, request }) => {
      await openTempo(page);
      const savedAnchor = (await savedTempo(request, JOB_ID)).anchor;
      const anchor = page.locator("#tempoAnchor");
      const detected = await anchor.textContent();
      const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, failure.answer);
      await page.locator("#tempoNudgeLater").click();
      await hold.seen;
      await openSongTempo(page, SIBLING_JOB_ID);
      await failHeldSave(page, hold, failure, beatsUrl(JOB_ID));
      await openSongTempo(page, JOB_ID);

      await expect(anchor).toHaveText(detected);
      await closeAndSettle(page);
      expect((await savedTempo(request, JOB_ID)).anchor).toEqual(savedAnchor);
    });
  }
});
