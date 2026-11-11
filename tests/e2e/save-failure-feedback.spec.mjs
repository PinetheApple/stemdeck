// Section, grid and tempo saves that fail say so. A refused one goes back to what the
// server keeps; a lost one stays, marked unsaved, until it reaches the server.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, uiText } from "./helpers.mjs";
import { PROBE_INTERVAL_MS } from "../../static/js/connection.js";
import {
  FAILED_SAVES,
  beatsUrl,
  sectionsUrl,
  savedSections,
  savedTempo,
  savedBarLength,
  setGridBars,
  shownBarLength,
  openTempo,
  holdFirstPatch,
  resetSongs,
} from "./saveRaces.mjs";
import {
  RESENT_WITHIN_MS,
  SENDS_OF_A_LOST_SAVE,
  controlServer,
  expectNotified,
  failNextSave,
  isSaveTo,
  notifications,
} from "./saveFailures.mjs";

const EDITED_BAR_LENGTH = 5;
const OTHER_BAR_LENGTH = 3;
// A resend loop would send the save again within two of the page's health checks.
const HEALTH_CHECKS_WATCHED = 2;
const SETTLE_MS = 1000;
const NO_MORE_SENDS_MS = HEALTH_CHECKS_WATCHED * PROBE_INTERVAL_MS + SETTLE_MS;
const SECTION_INDICATOR = "#sectionsSaveIndicator";
const TEMPO_STATUS = "#tempoStatus";

test.afterEach(resetSongs);

function refuseReset(route) {
  if (route.request().method() !== "DELETE") return route.fallback();
  return FAILED_SAVES.refused.answer(route);
}

/** From here the song's grid cannot be fetched again. */
async function failGridReloads(page) {
  await page.route(`**${beatsUrl(JOB_ID)}`, function loseGridReload(route) {
    return route.request().method() === "GET" ? route.abort() : route.fallback();
  });
}

const addSection = (page) => page.locator("#sectionsAddBtn").click();
const sectionCount = (request) => savedSections(request, JOB_ID).then((s) => s.length);

test.describe("sections", () => {
  test.beforeEach(({ page }) => openStudio(page));

  test("a refused section save goes back to the saved sections and says so", async ({ page }) => {
    await failNextSave(page, sectionsUrl(JOB_ID), FAILED_SAVES.refused, () => addSection(page));

    await expect(page.locator(".section-block")).toHaveCount(0);
    await expectNotified(page, "sections", "refused");
  });

  test("a lost section save stays, marked unsaved, until the server takes it", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(sectionsUrl(JOB_ID), () => addSection(page));

    await expect(page.locator(".section-block")).toHaveCount(1);
    await expect(page.locator(SECTION_INDICATOR)).toHaveText(await uiText(page, "sections.notSaved"));
    await expectNotified(page, "sections", "lost");
    await server.reconnect();
    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
    await expect.poll(() => notifications(page)).toEqual([]);
  });

  test("a section save lost while the server is up goes again on its own", async ({ page, request }) => {
    await failNextSave(page, sectionsUrl(JOB_ID), FAILED_SAVES.lost, () => addSection(page));

    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
    await expect.poll(() => notifications(page)).toEqual([]);
  });

  test("a section save that keeps getting lost goes again once, not on every health check", async ({ page }) => {
    const sends = [];
    page.on("request", function noteSectionSave(r) {
      if (isSaveTo(sectionsUrl(JOB_ID))(r)) sends.push(r);
    });
    const server = await controlServer(page);
    await server.loseSaves(sectionsUrl(JOB_ID), () => addSection(page));
    await page.waitForTimeout(NO_MORE_SENDS_MS);

    expect(sends).toHaveLength(SENDS_OF_A_LOST_SAVE);
    await expectNotified(page, "sections", "lost");
  });
});

test.describe("beat grid", () => {
  test.beforeEach(({ page }) => openTempo(page));

  const editGrid = (page) => setGridBars(page, EDITED_BAR_LENGTH);

  test("a refused grid save goes back to the saved grid and says so", async ({ page, request }) => {
    const saved = await savedBarLength(request, JOB_ID);
    await failNextSave(page, beatsUrl(JOB_ID), FAILED_SAVES.refused, () => editGrid(page));

    await expect.poll(() => shownBarLength(page)).toBe(saved);
    await expectNotified(page, "grid", "refused");
  });

  test("a refused grid save goes back to the saved grid even when it cannot be fetched", async ({ page, request }) => {
    const saved = await savedBarLength(request, JOB_ID);
    await failGridReloads(page);
    await failNextSave(page, beatsUrl(JOB_ID), FAILED_SAVES.refused, () => editGrid(page));

    await expect.poll(() => shownBarLength(page)).toBe(saved);
  });

  test("a refused grid save hands the tempo panel the saved tempo", async ({ page, request }) => {
    await editGrid(page);
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(EDITED_BAR_LENGTH);
    await page.evaluate(() => {
      window.e2eGridTempos = [];
      document.addEventListener("beatgridsave", function noteGridTempo(e) {
        window.e2eGridTempos.push(e.detail.tempo ?? null);
      });
    });
    await failNextSave(page, beatsUrl(JOB_ID), FAILED_SAVES.refused, () => setGridBars(page, OTHER_BAR_LENGTH));

    const saved = await savedTempo(request, JOB_ID);
    await expect.poll(() => page.evaluate(() => window.e2eGridTempos.at(-1))).toEqual(saved);
  });

  test("a lost grid save stays until the server takes it, and says so", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    await expectNotified(page, "grid", "lost");
    await server.reconnect();
    await expect.poll(() => savedBarLength(request, JOB_ID), { timeout: RESENT_WITHIN_MS }).toBe(EDITED_BAR_LENGTH);
    await expect.poll(() => notifications(page)).toEqual([]);
  });

  test("a refused grid reset keeps the saved grid and says so", async ({ page, request }) => {
    await editGrid(page);
    await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(EDITED_BAR_LENGTH);
    await page.route(`**${beatsUrl(JOB_ID)}`, refuseReset);
    await page.evaluate(async () => (await import("/js/beatgrid.js")).resetBeatGrid());

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    await expectNotified(page, "grid", "reset");
  });
});

test.describe("tempo", () => {
  test.beforeEach(({ page }) => openTempo(page));

  const anchor = (page) => page.locator("#tempoAnchor");
  const nudge = (page) => page.locator("#tempoNudgeLater").click();
  const savedAnchor = async (request) => (await savedTempo(request, JOB_ID)).anchor;

  test("a refused tempo save goes back to the saved tempo and says so", async ({ page }) => {
    const saved = await anchor(page).textContent();
    await failNextSave(page, beatsUrl(JOB_ID), FAILED_SAVES.refused, () => nudge(page));

    await expect(anchor(page)).toHaveText(saved);
    await expect(page.locator(TEMPO_STATUS)).toHaveText(await uiText(page, "tempo.saveFailed"));
    await expectNotified(page, "tempo", "refused");
  });

  test("a refused tempo save goes back to the saved tempo even when the grid cannot be fetched", async ({ page }) => {
    const saved = await anchor(page).textContent();
    await failGridReloads(page);
    await failNextSave(page, beatsUrl(JOB_ID), FAILED_SAVES.refused, () => nudge(page));

    await expect(anchor(page)).toHaveText(saved);
  });

  test("a refused tempo save says so even when the edit after it is saved", async ({ page, request }) => {
    const hold = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.refused.answer);
    await nudge(page);
    await hold.seen;
    await page.locator("#tempoBpmUp").click();
    const bpm = Number(await page.locator("#tempoReadout").textContent());
    hold.release();

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bpm).toBeCloseTo(bpm, 5);
    await expectNotified(page, "tempo", "refused");
  });

  test("a lost tempo save stays, marked unsaved, until the server takes it", async ({ page, request }) => {
    const before = await savedAnchor(request);
    const saved = await anchor(page).textContent();
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => nudge(page));

    await expect(anchor(page)).not.toHaveText(saved);
    await expect(page.locator(TEMPO_STATUS)).toHaveText(await uiText(page, "tempo.savePending"));
    await expectNotified(page, "tempo", "lost");
    await server.reconnect();
    await expect.poll(() => savedAnchor(request), { timeout: RESENT_WITHIN_MS }).not.toEqual(before);
    await expect.poll(() => notifications(page)).toEqual([]);
  });
});
