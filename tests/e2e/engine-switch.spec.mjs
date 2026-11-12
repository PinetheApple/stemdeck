// A song change drops the previous song's engine.
import { test, expect } from "@playwright/test";
import { SIBLING_JOB_ID, openStudio } from "./helpers.mjs";

test.use({ launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });

const STREAMING_FLAG = ["stemdeck.audioEngine", "0"];
const LOAD_TIMEOUT_MS = 20000;

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
  await page.waitForFunction(async () => {
    const st = await import("/js/state.js");
    if (!st.audioEngine || (await st.audioEngine.ready) !== true) return false;
    window.__previousEngine = st.audioEngine;
    return true;
  }, null, { timeout: LOAD_TIMEOUT_MS });
  await page.locator("#t-play").click();
  await expect.poll(() => state(page, () => window.__previousEngine.isPlaying())).toBe(true);
}

test("a streaming-path song silences the previous engine at once and takes the transport", async ({ page }) => {
  await openStudio(page);
  await rememberPlayingEngine(page);

  const stems = await holdStems(page, SIBLING_JOB_ID);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), STREAMING_FLAG);
  await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).currentJobId)).toBe(SIBLING_JOB_ID);

  expect(await state(page, () => window.__previousEngine.isPlaying())).toBe(false);
  expect(await state(page, async () => (await import("/js/state.js")).audioEngine)).toBeNull();
  await expect.poll(() => state(page, () => window.__previousEngine.audioContext.state)).toBe("closed");

  stems.release();
  await expect(page.locator(".app")).not.toHaveClass(/engine-waveforms/);
  await page.waitForFunction(
    async () => ((await import("/js/state.js")).multitrack?.audios?.length ?? 0) > 0,
    null,
    { timeout: LOAD_TIMEOUT_MS },
  );
  await page.locator("#t-play").click();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).multitrack.isPlaying())).toBe(true);
  await page.locator("#t-stop").click();
  await expect.poll(() => state(page, async () => (await import("/js/state.js")).multitrack.isPlaying())).toBe(false);
  expect(await state(page, () => window.__previousEngine.isPlaying())).toBe(false);
});
