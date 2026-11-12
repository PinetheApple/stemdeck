// A song change drops the previous song's engine, and a Play pressed while the
// stems load waits for them instead of ending the song.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";

test.use({ launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });

const STREAMING_FLAG = ["stemdeck.audioEngine", "0"];
const LOAD_TIMEOUT_MS = 20000;
const TICKS_MS = 600;

const stemsOf = (jobId) => new RegExp(`${jobId}.*\\.wav`);
const state = (page, fn) => page.evaluate(fn);

/** Hold every stem download of `jobId` until `release()`. */
async function holdStems(page, jobId) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(stemsOf(jobId), async function continueWhenReleased(route) {
    await held;
    await route.continue().catch(function ignorePageClosed() {});
  });
  return { release };
}

async function rememberPlayingEngine(page) {
  await page.waitForFunction(
    async () => {
      const st = await import("/js/state.js");
      if (!st.audioEngine || (await st.audioEngine.ready) !== true) return false;
      window.__previousEngine = st.audioEngine;
      return true;
    },
    null,
    { timeout: LOAD_TIMEOUT_MS },
  );
  await page.locator("#t-play").click();
  await expect.poll(() => state(page, () => window.__previousEngine.isPlaying())).toBe(true);
}

async function waitForEngine(page) {
  await page.waitForFunction(
    async () => Boolean((await import("/js/state.js")).audioEngine),
    null,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

async function openStreamingSibling(page) {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), STREAMING_FLAG);
  await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).currentJobId)).toBe(SIBLING_JOB_ID);
}

async function waitForStreamingAudio(page) {
  await expect(page.locator(".app")).not.toHaveClass(/engine-waveforms/);
  await page.waitForFunction(
    async () => ((await import("/js/state.js")).multitrack?.audios?.length ?? 0) > 0,
    null,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

async function countTrackEnds(page) {
  await page.evaluate(() => {
    window.__trackEnds = 0;
    document.addEventListener("trackended", function countTrackEnd() { window.__trackEnds++; });
  });
}

test("a streaming-path song silences the previous engine at once and takes the transport", async ({ page }) => {
  await openStudio(page);
  await rememberPlayingEngine(page);

  const stems = await holdStems(page, SIBLING_JOB_ID);
  await openStreamingSibling(page);

  expect(await state(page, () => window.__previousEngine.isPlaying())).toBe(false);
  expect(await state(page, async () => (await import("/js/state.js")).audioEngine)).toBeNull();
  await expect.poll(() => state(page, () => window.__previousEngine.audioContext.state)).toBe("closed");

  stems.release();
  await waitForStreamingAudio(page);
  await page.locator("#t-play").click();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).multitrack.isPlaying())).toBe(true);
  await page.locator("#t-stop").click();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).multitrack.isPlaying())).toBe(false);
  expect(await state(page, () => window.__previousEngine.isPlaying())).toBe(false);
});

test("Play pressed while the stems load starts the song once they arrive", async ({ page }) => {
  const stems = await holdStems(page, JOB_ID);
  await openStudio(page, { waitForDuration: false });
  await waitForEngine(page);
  await countTrackEnds(page);

  await page.locator("#t-play").click();
  await page.waitForTimeout(TICKS_MS);
  expect(await state(page, () => window.__trackEnds)).toBe(0);

  stems.release();
  await expect.poll(
    () => state(page, async () => (await import("/js/state.js")).audioEngine.isClockReady()),
    { timeout: LOAD_TIMEOUT_MS },
  ).toBe(true);
  await expect.poll(
    () => state(page, async () => (await import("/js/state.js")).audioEngine.getCurrentTime()),
  ).toBeGreaterThan(0);
  expect(await state(page, () => window.__trackEnds)).toBe(0);
});

test("a previous song's abandoned Play leaves the next song's Play button lit", async ({ page }) => {
  const stems = await holdStems(page, JOB_ID);
  await openStudio(page, { waitForDuration: false });
  await waitForEngine(page);
  await page.locator("#t-play").click();

  await openStreamingSibling(page);
  await waitForStreamingAudio(page);
  await page.locator("#t-play").click();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).multitrack.isPlaying())).toBe(true);
  await expect(page.locator("#t-play")).toHaveClass(/playing/);

  stems.release();
  await page.waitForTimeout(TICKS_MS);
  await expect(page.locator("#t-play")).toHaveClass(/playing/);
});
