// Section, grid and tempo saves that fail say so. A refused one goes back to what the
// server keeps; a lost one stays, marked unsaved, until it reaches the server.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, uiText } from "./helpers.mjs";
import {
  FAILED_SAVES,
  beatsUrl,
  sectionsUrl,
  savedSections,
  savedTempo,
  savedBarLength,
  setGridBars,
  shownBarLength,
  openSong,
  openTempo,
  openSongTempo,
  holdFirstPatch,
  failHeldSave,
  resetSongs,
} from "./saveRaces.mjs";

// A lost save goes out again once the server answers, which its health probe notices within seconds.
const RESENT_WITHIN_MS = 15000;
const EDITED_BAR_LENGTH = 5;
const SECTION_INDICATOR = "#sectionsSaveIndicator";
const TEMPO_STATUS = "#tempoStatus";

const FAILURE_TEXT = {
  sections: { kind: "sections", refused: "notif.sectionsSaveFailed", lost: "notif.sectionsSavePending" },
  grid: {
    kind: "beatgrid",
    refused: "notif.beatGridSaveFailed",
    lost: "notif.beatGridSavePending",
    reset: "notif.beatGridResetFailed",
  },
  tempo: { kind: "tempo", refused: "notif.tempoSaveFailed", lost: "notif.tempoSavePending" },
};

test.afterEach(resetSongs);

const notifications = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("stemdeck:failures") || "[]").map(({ kind, message }) => ({ kind, message })),
  );

async function expectNotified(page, area, how) {
  const { kind, [how]: key } = FAILURE_TEXT[area];
  const message = await uiText(page, key);
  await expect.poll(() => notifications(page)).toEqual([{ kind, message }]);
}

/** Make the next PATCH to `url` fail as `failure` does, run `edit`, and wait until the page has the answer. */
async function failNextSave(page, url, failure, edit) {
  const hold = await holdFirstPatch(page, `**${url}`, failure.answer);
  await edit();
  await hold.seen;
  await failHeldSave(page, hold, failure, url);
}

/**
 * Lose every PATCH to `url` until `restore()`, so no retry reaches the server before the
 * test has looked at the unsaved state. Resolves once `edit`'s save is lost.
 */
async function loseSaves(page, url, edit) {
  let down = true;
  await page.route(`**${url}`, function loseWhileDown(route) {
    return down && route.request().method() === "PATCH" ? route.abort() : route.fallback();
  });
  const lost = page.waitForEvent("requestfailed", (r) => r.url().endsWith(url) && r.method() === "PATCH");
  await edit();
  await lost;
  return { restore: () => { down = false; } };
}

function refuseReset(route) {
  if (route.request().method() !== "DELETE") return route.fallback();
  return FAILED_SAVES.refused.answer(route);
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
    const server = await loseSaves(page, sectionsUrl(JOB_ID), () => addSection(page));

    await expect(page.locator(".section-block")).toHaveCount(1);
    await expect(page.locator(SECTION_INDICATOR)).toHaveText(await uiText(page, "sections.notSaved"));
    await expectNotified(page, "sections", "lost");
    server.restore();
    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
    await expect.poll(() => notifications(page)).toEqual([]);
  });

  test("a lost section save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const server = await loseSaves(page, sectionsUrl(JOB_ID), () => addSection(page));
    await openSong(page, SIBLING_JOB_ID);
    await openSong(page, JOB_ID);

    await expect(page.locator(".section-block")).toHaveCount(1);
    server.restore();
    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
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

  test("a lost grid save stays until the server takes it, and says so", async ({ page, request }) => {
    const server = await loseSaves(page, beatsUrl(JOB_ID), () => editGrid(page));

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    await expectNotified(page, "grid", "lost");
    server.restore();
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

  test("a lost grid save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const server = await loseSaves(page, beatsUrl(JOB_ID), () => editGrid(page));
    await openSongTempo(page, SIBLING_JOB_ID);
    await openSongTempo(page, JOB_ID);

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    server.restore();
    await expect.poll(() => savedBarLength(request, JOB_ID), { timeout: RESENT_WITHIN_MS }).toBe(EDITED_BAR_LENGTH);
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

  test("a lost tempo save stays, marked unsaved, until the server takes it", async ({ page, request }) => {
    const before = await savedAnchor(request);
    const saved = await anchor(page).textContent();
    const server = await loseSaves(page, beatsUrl(JOB_ID), () => nudge(page));

    await expect(anchor(page)).not.toHaveText(saved);
    await expect(page.locator(TEMPO_STATUS)).toHaveText(await uiText(page, "tempo.savePending"));
    await expectNotified(page, "tempo", "lost");
    server.restore();
    await expect.poll(() => savedAnchor(request), { timeout: RESENT_WITHIN_MS }).not.toEqual(before);
    await expect.poll(() => notifications(page)).toEqual([]);
  });

  test("a lost tempo save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const before = await savedAnchor(request);
    const saved = await anchor(page).textContent();
    const server = await loseSaves(page, beatsUrl(JOB_ID), () => nudge(page));
    await openSongTempo(page, SIBLING_JOB_ID);
    await openSongTempo(page, JOB_ID);

    await expect(anchor(page)).not.toHaveText(saved);
    server.restore();
    await expect.poll(() => savedAnchor(request), { timeout: RESENT_WITHIN_MS }).not.toEqual(before);
  });
});
