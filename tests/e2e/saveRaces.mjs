// Shared by the specs that race a save against a song switch or a page close: they
// hold a save open with a route, or freeze the page's timers so no debounce fires first.
import { expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, waitForClickTrack } from "./helpers.mjs";

const RESET_TEMPO = { mode: null, bpm: null, anchor: null, beats_per_bar: null };
export const STALE_BPM = 97;
export const TAP_GAP_MS = 400;
export const NUDGE_SEC = 0.01;
const SIBLING_LENGTH_SEC = 2;
const SETTLE_MS = 500;
// The page's clock keeps running while the test asks to pause it, so it pauses a little ahead.
const FREEZE_AHEAD_MS = 100;
const TRACK_TIME = { [JOB_ID]: /\/\s*00:06\s*$/, [SIBLING_JOB_ID]: /\/\s*00:02\s*$/ };

export const sectionsUrl = (id) => `/api/jobs/${id}/sections`;
export const beatsUrl = (id) => `/api/jobs/${id}/beats`;
export const isBeatsPatch = (id) => (r) => r.url().endsWith(beatsUrl(id)) && r.method() === "PATCH";

/** Put both fixture songs' sections, grid and tempo back as the server detected them. */
export async function resetSongs({ request }) {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await request.patch(sectionsUrl(id), { data: { sections: [] } });
    await request.delete(beatsUrl(id));
    await request.patch(beatsUrl(id), { data: { tempo: RESET_TEMPO } });
  }
}

export const savedSections = async (request, id) => (await (await request.get(`/api/jobs/${id}`)).json()).sections ?? [];
const savedGrid = async (request, id) => (await request.get(beatsUrl(id))).json();
export const savedTempo = async (request, id) => (await savedGrid(request, id)).tempo;
export const savedBarLength = async (request, id) => (await savedGrid(request, id)).bars?.[0]?.beats_per_bar;
export const setGridBars = (page, beatsPerBar) =>
  page.evaluate(async (n) => (await import("/js/beatgrid.js")).setBarLengthAt(0, n), beatsPerBar);
export const shownBarLength = (page) =>
  page.evaluate(async () => (await import("/js/beatgrid.js")).getBars()[0]?.beats_per_bar);
// Not awaited in the page: the save it queues may be the one a test is holding.
const queueSave = (page, module, flush) =>
  page.evaluate(([path, name]) => { import(path).then((m) => m[name]()); }, [module, flush]);
export const queueSectionsSave = (page) => queueSave(page, "/js/sections.js", "flushSectionsSave");
export const queueGridSave = (page) => queueSave(page, "/js/beatgrid.js", "flushBeatGrid");

export async function openSong(page, id) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
  await expect(page.locator("#t-time")).toHaveText(TRACK_TIME[id], { timeout: 20000 });
}

/** Studio on the fixture track with the click live and the Tempo tab showing. */
export async function openTempo(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Open a song and wait for its own grid: only the sibling's ends inside its length. */
export async function openSongTempo(page, id) {
  await openSong(page, id);
  await waitForClickTrack(page, { revealOptions: false });
  await page.waitForFunction(async ([sibling, lengthSec]) => {
    const beats = (await import("/js/beatgrid.js")).getBeats();
    return beats.length > 0 && (beats.at(-1) < lengthSec) === sibling;
  }, [id === SIBLING_JOB_ID, SIBLING_LENGTH_SEC]);
  await expect(page.locator("#tempoModeConstant")).toBeEnabled();
}

/** Hold the first PATCH matching `pattern` until `release()`, then `answer` it. `seen` resolves when it is sent. */
export async function holdFirstPatch(page, pattern, answer = (route) => route.fallback()) {
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
    await answer(route);
  });
  return { seen, release };
}

// A save the server refuses, and one whose request is lost, with the event that settles each.
export const FAILED_SAVES = {
  refused: { answer: (route) => route.fulfill({ status: 422, json: { detail: "invalid" } }), settles: "requestfinished" },
  lost: { answer: (route) => route.abort(), settles: "requestfailed" },
};

/** Let the held save fail, and wait until the page has its answer. */
export async function failHeldSave(page, hold, { settles }, url) {
  const settled = page.waitForEvent(settles, (r) => r.url().endsWith(url));
  hold.release();
  await settled;
}

// Playwright's routes and request events never see a keepalive request sent as the page
// closes, so the page notes each one in session storage, which outlives a reload.
const CLOSE_SAVES_KEY = "e2e-close-saves";

/** From here, note the URL of every keepalive PATCH the page sends, in order. */
export async function noteCloseSaves(page) {
  await page.evaluate((key) => {
    const send = window.fetch;
    window.fetch = function noteCloseSave(url, options) {
      if (options?.keepalive && options.method === "PATCH") {
        const noted = JSON.parse(sessionStorage.getItem(key) ?? "[]");
        sessionStorage.setItem(key, JSON.stringify([...noted, String(url)]));
      }
      return send(url, options);
    };
  }, CLOSE_SAVES_KEY);
}

export const notedCloseSaves = (page) =>
  page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]"), CLOSE_SAVES_KEY);

/** Close the page and give any save it sends on the way out time to arrive. */
export async function closeAndSettle(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
}

/** Stop the page's clock: from here a debounce fires only when the test runs time on. */
export async function freezeTimers(page) {
  await page.clock.pauseAt(await page.evaluate((ahead) => Date.now() + ahead, FREEZE_AHEAD_MS));
}

// Clicks without Playwright's actionability wait, which needs the frozen clock to move.
export const clickFrozen = (page, selector) => page.locator(selector).first().dispatchEvent("click");
