// A lost section, grid or tempo save across song switches, reconnects and later edits: it stays
// with its own song, goes again once the server is back, and is dropped only by a newer edit.
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
import {
  RESENT_WITHIN_MS,
  controlServer,
  expectNotified,
  failNextSave,
  notifications,
} from "./saveFailures.mjs";

const EDITED_BAR_LENGTH = 5;
const OTHER_BAR_LENGTH = 3;
const SECTION_INDICATOR = "#sectionsSaveIndicator";
const TEMPO_STATUS = "#tempoStatus";
const GRID_KIND = "beatgrid";

test.afterEach(resetSongs);

const addSection = (page) => page.locator("#sectionsAddBtn").click();
const sectionCount = (request, id = JOB_ID) => savedSections(request, id).then((s) => s.length);
const gridCards = async (page) => (await notifications(page)).filter((card) => card.kind === GRID_KIND);

/** From here, note when the Tempo tab next takes a grid from the server. */
const noteTempoRefresh = (page) =>
  page.evaluate(() => {
    window.e2eTempoRefreshed = false;
    document.addEventListener("tempochange", function markTempoRefreshed() { window.e2eTempoRefreshed = true; });
  });

test.describe("sections", () => {
  test.beforeEach(({ page }) => openStudio(page));

  test("a lost section save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(sectionsUrl(JOB_ID), () => addSection(page));
    await openSong(page, SIBLING_JOB_ID);
    await openSong(page, JOB_ID);

    await expect(page.locator(".section-block")).toHaveCount(1);
    await server.reconnect();
    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
  });

  test("a lost section save sent again while another song is open lands on its own song only", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(sectionsUrl(JOB_ID), () => addSection(page));
    await openSong(page, SIBLING_JOB_ID);
    await server.reconnect();

    await expect.poll(() => sectionCount(request), { timeout: RESENT_WITHIN_MS }).toBe(1);
    expect(await sectionCount(request, SIBLING_JOB_ID)).toBe(0);
    await expect(page.locator(".section-block")).toHaveCount(0);
    await expect(page.locator(SECTION_INDICATOR)).toBeHidden();
  });

  test("a lost section save the server refuses once it is back goes back and says so", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(sectionsUrl(JOB_ID), () => addSection(page));
    await server.reconnect({ refuse: true });

    await expect(page.locator(".section-block")).toHaveCount(0, { timeout: RESENT_WITHIN_MS });
    await expectNotified(page, "sections", "refused");
    expect(await sectionCount(request)).toBe(0);
  });
});

test.describe("beat grid", () => {
  test.beforeEach(({ page }) => openTempo(page));

  const editGrid = (page) => setGridBars(page, EDITED_BAR_LENGTH);

  test("a lost grid save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));
    await openSongTempo(page, SIBLING_JOB_ID);
    await openSongTempo(page, JOB_ID);

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    await server.reconnect();
    await expect.poll(() => savedBarLength(request, JOB_ID), { timeout: RESENT_WITHIN_MS }).toBe(EDITED_BAR_LENGTH);
  });

  test("a lost grid edit replaced by a tempo change no longer says it will save", async ({ page }) => {
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));
    await expectNotified(page, "grid", "lost");
    server.allowSaves();
    await page.locator("#tempoNudgeLater").click();

    await expect.poll(() => gridCards(page)).toEqual([]);
  });

  test("a lost grid edit replaced by a reset no longer says it will save", async ({ page }) => {
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));
    await expectNotified(page, "grid", "lost");
    server.allowSaves();
    await page.evaluate(async () => (await import("/js/beatgrid.js")).resetBeatGrid());

    await expect.poll(() => gridCards(page)).toEqual([]);
  });

  test("a lost grid edit outlives a refused tempo save and is saved on reconnect", async ({ page, request }) => {
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));
    const refusal = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.refused.answer);
    await page.locator("#tempoNudgeLater").click();
    await refusal.seen;
    await noteTempoRefresh(page);
    await failHeldSave(page, refusal, FAILED_SAVES.refused, beatsUrl(JOB_ID));
    await page.waitForFunction(() => window.e2eTempoRefreshed);

    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    expect(await gridCards(page)).toEqual([{ kind: GRID_KIND, message: await uiText(page, "notif.beatGridSavePending") }]);
    await server.reconnect();
    await expect.poll(() => savedBarLength(request, JOB_ID), { timeout: RESENT_WITHIN_MS }).toBe(EDITED_BAR_LENGTH);
  });

  test("a lost grid edit refused on reconnect after another song was edited goes back", async ({ page, request }) => {
    const saved = await savedBarLength(request, JOB_ID);
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => editGrid(page));
    await openSongTempo(page, SIBLING_JOB_ID);
    await setGridBars(page, OTHER_BAR_LENGTH);
    await expect.poll(() => savedBarLength(request, SIBLING_JOB_ID)).toBe(OTHER_BAR_LENGTH);
    await openSongTempo(page, JOB_ID);
    expect(await shownBarLength(page)).toBe(EDITED_BAR_LENGTH);
    await server.reconnect({ refuse: true });

    await expect.poll(() => shownBarLength(page), { timeout: RESENT_WITHIN_MS }).toBe(saved);
    await expectNotified(page, "grid", "refused");
  });

});

test.describe("tempo", () => {
  test.beforeEach(({ page }) => openTempo(page));

  const anchor = (page) => page.locator("#tempoAnchor");
  const nudge = (page) => page.locator("#tempoNudgeLater").click();
  const savedAnchor = async (request) => (await savedTempo(request, JOB_ID)).anchor;

  test("a lost tempo save is still shown when its song is reopened, and is saved", async ({ page, request }) => {
    const before = await savedAnchor(request);
    const saved = await anchor(page).textContent();
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => nudge(page));
    await openSongTempo(page, SIBLING_JOB_ID);
    await openSongTempo(page, JOB_ID);

    await expect(anchor(page)).not.toHaveText(saved);
    await server.reconnect();
    await expect.poll(() => savedAnchor(request), { timeout: RESENT_WITHIN_MS }).not.toEqual(before);
  });

  test("a tempo save lost again after its song was reopened mid-retry still shows the edit", async ({ page }) => {
    const saved = await anchor(page).textContent();
    const server = await controlServer(page);
    await server.loseSaves(beatsUrl(JOB_ID), () => nudge(page));
    const edited = await anchor(page).textContent();
    const retry = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`, FAILED_SAVES.lost.answer);
    await server.reconnect();
    await retry.seen;
    await openSongTempo(page, SIBLING_JOB_ID);
    await openSongTempo(page, JOB_ID);
    await failHeldSave(page, retry, FAILED_SAVES.lost, beatsUrl(JOB_ID));

    await expect(page.locator(TEMPO_STATUS)).toHaveText(await uiText(page, "tempo.savePending"));
    await expect(anchor(page)).toHaveText(edited);
    expect(edited).not.toBe(saved);
  });
});
