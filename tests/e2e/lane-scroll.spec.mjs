// The mixer rows and the waveform lanes scroll as one, even when the waveform
// pane carries a horizontal scrollbar the mixer column has no match for.

import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

const SHORT_WINDOW = { width: 1024, height: 768 };
// Wide enough that the waveforms fit their pane with no horizontal scrollbar.
const TALL_WIDE_WINDOW = { width: 1920, height: 1100 };
const ADDED_STEMS = ["guitar", "piano"];
const SOURCE_STEM = "bass";
const STEM_COUNT = 6;
const WHEEL_STEP_PX = 400;
const WHEEL_STEPS = 6;
const ZOOM_IN_DELTA = -240;
const ZOOM_IN_STEPS = 4;
const ALIGN_TOLERANCE_PX = 2;

// Headless Chromium hides scrollbars by default; the bar this is about must exist.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Serve the four-stem fixture as a six-stem song: the extra stems reuse the bass audio. */
async function serveSixStems(page) {
  await page.route(`**/api/jobs/${JOB_ID}`, async function addStemsToJob(route) {
    const response = await route.fetch();
    const job = await response.json();
    const source = job.stems.find((stem) => stem.name === SOURCE_STEM);
    for (const name of ADDED_STEMS) job.stems.push({ ...source, name });
    await route.fulfill({ response, json: job });
  });
  await page.route(`**/api/jobs/${JOB_ID}/peaks`, async function addStemsToPeaks(route) {
    const response = await route.fetch();
    const peaks = await response.json();
    for (const name of ADDED_STEMS) peaks[name] = peaks[SOURCE_STEM];
    await route.fulfill({ response, json: peaks });
  });
}

/** Row and lane edges, how far each column scrolls, and the panel the lanes divide. */
function laneGeometry(page) {
  return page.evaluate(() => {
    const edges = (selector) => [...document.querySelectorAll(selector)].map((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    });
    const shownBottom = (el) => el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
    const overflow = (el) => el.scrollHeight - el.clientHeight;
    const mixer = document.querySelector("#mixer");
    const waves = document.querySelector("#wave-scroll");
    return {
      rows: edges(".mixer-column .lane-header:not(.hidden)"),
      lanes: edges(".stem-waveform-row:not(.hidden)"),
      mixerBottom: shownBottom(mixer),
      wavesBottom: shownBottom(waves),
      overflow: [overflow(mixer), overflow(waves)],
      wavesScrollX: waves.scrollWidth > waves.clientWidth,
      panelHeight: document.querySelector(".daw-wave-panel").clientHeight,
      laneHeight: parseFloat(getComputedStyle(document.querySelector(".app")).getPropertyValue("--lane-h")),
    };
  });
}

function aligned(g) {
  if (g.lanes.length !== g.rows.length || g.rows.length === 0) return false;
  return g.rows.every((row, i) => Math.abs(row.top - g.lanes[i].top) <= ALIGN_TOLERANCE_PX);
}

/** What a user sees of the last lane: both halves shown, side by side. */
async function lastLaneView(page) {
  const g = await laneGeometry(page);
  return {
    rowShown: g.rows.at(-1).bottom <= g.mixerBottom + ALIGN_TOLERANCE_PX,
    laneShown: g.lanes.at(-1).bottom <= g.wavesBottom + ALIGN_TOLERANCE_PX,
    aligned: aligned(g),
  };
}

async function openSixStemStudio(page, viewport) {
  await page.setViewportSize(viewport);
  await serveSixStems(page);
  await openStudio(page);
  const playableRows = page.locator(".mixer-column .lane-header:not(.hidden):not(.unavailable)");
  await expect(playableRows).toHaveCount(STEM_COUNT);
  await expect.poll(async () => aligned(await laneGeometry(page))).toBe(true);
}

async function wheelMixerToBottom(page) {
  const box = await page.locator("#mixer").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < WHEEL_STEPS; step++) await page.mouse.wheel(0, WHEEL_STEP_PX);
}

async function zoomInOnWaves(page) {
  const box = await page.locator("#wave-scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < ZOOM_IN_STEPS; step++) await page.mouse.wheel(0, ZOOM_IN_DELTA);
}

test.describe("lanes beside a waveform pane with a horizontal scrollbar", () => {
  test("on a short window the last lane scrolls fully into view beside its mixer row", async ({ page }) => {
    await openSixStemStudio(page, SHORT_WINDOW);
    expect((await laneGeometry(page)).wavesScrollX).toBe(true);

    await wheelMixerToBottom(page);
    await expect.poll(() => lastLaneView(page))
      .toEqual({ rowShown: true, laneShown: true, aligned: true });
  });

  test("a window tall enough for every lane scrolls neither column", async ({ page }) => {
    await openSixStemStudio(page, TALL_WIDE_WINDOW);
    const g = await laneGeometry(page);
    expect(g.wavesScrollX).toBe(false);
    expect(g.overflow).toEqual([0, 0]);
  });

  test("with no horizontal scrollbar the lanes divide the whole panel", async ({ page }) => {
    await openSixStemStudio(page, TALL_WIDE_WINDOW);
    const g = await laneGeometry(page);
    expect(g.wavesScrollX).toBe(false);
    expect(g.laneHeight).toBe(Math.floor(g.panelHeight / STEM_COUNT));
  });

  test("zooming in on a tall window keeps every lane in view and in line", async ({ page }) => {
    await openSixStemStudio(page, TALL_WIDE_WINDOW);

    await zoomInOnWaves(page);
    await expect.poll(async () => {
      const g = await laneGeometry(page);
      return { scrollX: g.wavesScrollX, overflow: g.overflow, aligned: aligned(g) };
    }).toEqual({ scrollX: true, overflow: [0, 0], aligned: true });
  });
});
