// Auto-scroll: a zoomed-in timeline follows the playhead a page at a time.
import { test, expect } from "@playwright/test";
import { openStudio, SIBLING_JOB_ID } from "./helpers.mjs";

// seed.py writes a 6 second fixture; at 10x a page holds well under a second.
const ZOOM_IN_NOTCHES = 40;
const NOTCH_DELTA = -240;
// transport.js: WAVE_ZOOM_STEP per notch.
const NOTCH_FACTOR = 1.18;
const CENTRE_ANCHOR = 0.5;
const ZOOM_SLACK = 0.9;
const WATCH_MS = 1500;
// A page turn moves the view by most of a page; anything smaller is jitter.
const MIN_TURN_FRACTION = 0.5;
const LOOP_START = "01.000";
const LOOP_END = "02.000";
const WRAP_WATCH_MS = 3000;
const PARTIAL_ZOOM_NOTCHES = 4;
// Zooming at the far left pushes a playhead past mid-page off the right edge,
// where it cannot come back into view by itself.
const FAR_LEFT_ANCHOR = 0.05;
const MID_PAGE = 0.4;

async function zoomIn(page, { notches = ZOOM_IN_NOTCHES, anchor = CENTRE_ANCHOR } = {}) {
  await expect(page.locator("#waveLoadingOverlay")).toBeHidden();
  const box = await page.locator(".wave-scroll").boundingBox();
  await page.mouse.move(box.x + box.width * anchor, box.y + box.height / 2);
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, NOTCH_DELTA);
  await expect.poll(() => page.evaluate(async (factor) => {
    const { WAVE_ZOOM_MAX } = await import("/js/transport.js");
    const wave = document.getElementById("wave-scroll");
    return wave.scrollWidth / wave.clientWidth / Math.min(WAVE_ZOOM_MAX, factor);
  }, NOTCH_FACTOR ** notches)).toBeGreaterThan(ZOOM_SLACK);
}

// Where the drawn playhead sits in the visible part of the timeline, from the
// marker's own position, so the check does not repeat the code's arithmetic.
async function readView(page) {
  return page.evaluate(() => {
    const wave = document.getElementById("wave-scroll");
    const marker = document.querySelector("#ruler-time .playhead-marker");
    const x = (parseFloat(marker.style.left) / 100) * wave.scrollWidth - wave.scrollLeft;
    return {
      scrollLeft: wave.scrollLeft,
      viewport: wave.clientWidth,
      inView: x >= 0 && x <= wave.clientWidth,
      fraction: x / wave.clientWidth,
    };
  });
}

// Every frame for `ms`: the scroll offset, whether the playhead is in view and the time.
function watchFrames(page, ms) {
  return page.evaluate(async (duration) => {
    const { transport } = await import("/js/transport.js");
    const wave = document.getElementById("wave-scroll");
    const marker = document.querySelector("#ruler-time .playhead-marker");
    const frames = [];
    const end = performance.now() + duration;
    await new Promise(function sample(resolve) {
      const x = (parseFloat(marker.style.left) / 100) * wave.scrollWidth - wave.scrollLeft;
      frames.push({
        scrollLeft: wave.scrollLeft,
        inView: x >= 0 && x <= wave.clientWidth,
        time: transport().getCurrentTime(),
      });
      if (performance.now() >= end) resolve();
      else requestAnimationFrame(() => sample(resolve));
    });
    return { frames, viewport: wave.clientWidth };
  }, ms);
}

const isPlaying = (page) =>
  page.evaluate(async () => (await import("/js/transport.js")).transport()?.isPlaying() === true);

const playheadInView = async (page) => (await readView(page)).inView;

async function play(page) {
  await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(true);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("auto-scroll", () => {
  test("is on by default and follows the playhead a page at a time", async ({ page }) => {
    await openStudio(page);
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "true");
    await zoomIn(page);
    await play(page);
    await expect.poll(() => playheadInView(page)).toBe(true);

    const { frames, viewport } = await watchFrames(page, WATCH_MS);
    const moves = frames.slice(1)
      .map((f, i) => Math.abs(f.scrollLeft - frames[i].scrollLeft))
      .filter((d) => d > 0);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((d) => d >= viewport * MIN_TURN_FRACTION)).toBe(true);
    expect(frames.every((f) => f.inView)).toBe(true);
  });

  test("zooming in during playback keeps following", async ({ page }) => {
    await openStudio(page);
    await zoomIn(page, { notches: PARTIAL_ZOOM_NOTCHES });
    await play(page);
    await expect.poll(() => playheadInView(page)).toBe(true);

    await expect.poll(async () => (await readView(page)).fraction).toBeGreaterThan(MID_PAGE);
    // One jump: a wheel burst zooms in steps small enough to follow anyway.
    await page.evaluate(async (anchor) => {
      const wave = document.getElementById("wave-scroll").getBoundingClientRect();
      const { setWaveZoomLevel, WAVE_ZOOM_MAX } = await import("/js/transport.js");
      setWaveZoomLevel(WAVE_ZOOM_MAX, wave.left + wave.width * anchor);
    }, FAR_LEFT_ANCHOR);
    await expect.poll(() => playheadInView(page)).toBe(true);
    const { frames } = await watchFrames(page, WATCH_MS);
    expect(frames.every((f) => f.inView)).toBe(true);
  });

  test("turned off, the view stays put", async ({ page }) => {
    await openStudio(page);
    await zoomIn(page);
    await page.locator("#autoScrollBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");
    const before = await readView(page);
    await play(page);

    const { frames } = await watchFrames(page, WATCH_MS);
    expect(frames.every((f) => f.scrollLeft === before.scrollLeft)).toBe(true);
    expect(frames.at(-1).inView).toBe(false);
  });

  test("the choice survives a reload and a change of song", async ({ page }) => {
    await openStudio(page);
    await page.locator("#autoScrollBtn").click();
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator(".app")).not.toHaveClass(/no-track/);
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");

    await page.locator("#autoScrollBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "true");
  });

  test("a manual scroll pauses following until a seek", async ({ page }) => {
    await openStudio(page);
    await zoomIn(page);
    await play(page);

    const box = await page.locator(".wave-scroll").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 100_000);
    await page.keyboard.up("Shift");
    await expect.poll(() => page.evaluate(() => {
      const wave = document.getElementById("wave-scroll");
      return wave.scrollLeft + wave.clientWidth >= wave.scrollWidth - 1;
    })).toBe(true);

    const { frames } = await watchFrames(page, WATCH_MS);
    expect(frames.every((f) => !f.inView)).toBe(true);
    expect(new Set(frames.map((f) => f.scrollLeft)).size).toBe(1);

    await page.keyboard.press("BracketLeft");
    await expect.poll(() => playheadInView(page)).toBe(true);
  });

  test("a loop wrap brings the view back to the loop start", async ({ page }) => {
    await openStudio(page);
    await page.locator("#t-loop-end").fill(LOOP_END);
    await page.locator("#t-loop-end").blur();
    await page.locator("#t-loop-start").fill(LOOP_START);
    await page.locator("#t-loop-start").blur();
    await expect(page.locator("#t-loop")).toHaveClass(/active/);
    await zoomIn(page);
    await play(page);
    await expect.poll(() => playheadInView(page)).toBe(true);

    const { frames } = await watchFrames(page, WRAP_WATCH_MS);
    const wraps = frames.slice(1).filter((f, i) => f.time < frames[i].time);
    expect(wraps.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.inView)).toBe(true);
  });
});
