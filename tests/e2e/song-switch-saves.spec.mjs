// Edits made just before a song switch or a page close (#40). Each test makes the
// race certain: it holds a save open with a route, or freezes the page's timers
// so no save debounce can fire before the switch does.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, waitForClickTrack } from "./helpers.mjs";

const RESET_TEMPO = { mode: null, bpm: null, anchor: null, beats_per_bar: null };
const STALE_BPM = 97;
const TAP_GAP_MS = 400;
const NUDGE_SEC = 0.01;
const SIBLING_LENGTH_SEC = 2;
const TRACK_TIME = { [JOB_ID]: /\/\s*00:06\s*$/, [SIBLING_JOB_ID]: /\/\s*00:02\s*$/ };

const sectionsUrl = (id) => `/api/jobs/${id}/sections`;
const beatsUrl = (id) => `/api/jobs/${id}/beats`;
const isBeatsPatch = (id) => (r) => r.url().endsWith(beatsUrl(id)) && r.method() === "PATCH";

test.afterEach(async ({ request }) => {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await request.patch(sectionsUrl(id), { data: { sections: [] } });
    await request.delete(beatsUrl(id));
    await request.patch(beatsUrl(id), { data: { tempo: RESET_TEMPO } });
  }
});

const savedSections = async (request, id) => (await (await request.get(`/api/jobs/${id}`)).json()).sections ?? [];
const savedGrid = async (request, id) => (await request.get(beatsUrl(id))).json();
const savedTempo = async (request, id) => (await savedGrid(request, id)).tempo;
const savedBarLength = async (request, id) => (await savedGrid(request, id)).bars?.[0]?.beats_per_bar;
const setGridBars = (page, beatsPerBar) =>
  page.evaluate(async (n) => (await import("/js/beatgrid.js")).setBarLengthAt(0, n), beatsPerBar);
const shownBarLength = (page) =>
  page.evaluate(async () => (await import("/js/beatgrid.js")).getBars()[0]?.beats_per_bar);
// Not awaited in the page: the save it queues may be the one a test is holding.
const queueSave = (page, module, flush) =>
  page.evaluate(([path, name]) => { import(path).then((m) => m[name]()); }, [module, flush]);
const queueSectionsSave = (page) => queueSave(page, "/js/sections.js", "flushSectionsSave");
const queueGridSave = (page) => queueSave(page, "/js/beatgrid.js", "flushBeatGrid");

async function openSong(page, id) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
  await expect(page.locator("#t-time")).toHaveText(TRACK_TIME[id], { timeout: 20000 });
}

/** Studio on the fixture track with the click live and the Tempo tab showing. */
async function openTempo(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Open a song and wait for its own grid: only the sibling's ends inside its length. */
async function openSongTempo(page, id) {
  await openSong(page, id);
  await waitForClickTrack(page, { revealOptions: false });
  await page.waitForFunction(async ([sibling, lengthSec]) => {
    const beats = (await import("/js/beatgrid.js")).getBeats();
    return beats.length > 0 && (beats.at(-1) < lengthSec) === sibling;
  }, [id === SIBLING_JOB_ID, SIBLING_LENGTH_SEC]);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Hold the first PATCH matching `pattern` until `release()`; `seen` resolves when it is sent. */
async function holdFirstPatch(page, pattern) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  let first = true;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "PATCH" || !first) return route.fallback();
    first = false;
    markSeen(route.request());
    await held;
    await route.fallback();
  });
  return { seen, release };
}

/** Stop the page's clock: from here a debounce fires only when the test runs time on. */
async function freezeTimers(page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
}

// Clicks without Playwright's actionability wait, which needs the frozen clock to move.
const clickFrozen = (page, selector) => page.locator(selector).first().dispatchEvent("click");

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

  test("a section added just before the page closes is saved", async ({ page, request }) => {
    await openStudio(page);
    await page.locator("#sectionsAddBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(1);
  });

  test("a section save queued behind one in flight is sent when the page closes", async ({ page, request }) => {
    await openStudio(page);
    const { seen } = await holdFirstPatch(page, `**${sectionsUrl(JOB_ID)}`);
    await page.locator("#sectionsAddBtn").click();
    await queueSectionsSave(page);
    await seen;
    await page.locator("#sectionsAddBtn").click();
    await queueSectionsSave(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => savedSections(request, JOB_ID).then((s) => s.length)).toBe(2);
  });
});

test.describe("beat grid", () => {
  test.beforeEach(async ({ page }) => openTempo(page));

  test("a grid edit made just before the page closes is saved", async ({ page, request }) => {
    await setGridBars(page, 3);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(async () => (await savedTempo(request, JOB_ID)).bars_edited).toBe(true);
  });

  test("a grid save queued behind one in flight is sent when the page closes", async ({ page, request }) => {
    const { seen } = await holdFirstPatch(page, `**${beatsUrl(JOB_ID)}`);
    await setGridBars(page, 3);
    await queueGridSave(page);
    await seen;
    await setGridBars(page, 5);
    await queueGridSave(page);
    await page.reload({ waitUntil: "domcontentloaded" });

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
});
