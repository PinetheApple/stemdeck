// A song whose stems are stored as MP3.
//
// The chunked engine streams WAV through HTTP Range windows and cannot parse
// MP3, so a compressed song has to go straight to the full-decode engine,
// which fetches each file whole. Range requests on a stem are therefore the
// evidence of which engine was picked. The fixture's WAV song is the control.

import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

const JOB_URL = `**/api/jobs/${JOB_ID}`;
const WAV_SUFFIX = /\.wav$/;
const MP3_SUFFIX = ".mp3";
const STEM_PATH = /\/stems\/[^/]+\.(wav|mp3)$/;
const DOWNLOAD_LANE = "vocals";

const toMp3 = (url) => url?.replace(WAV_SUFFIX, MP3_SUFFIX) ?? url;

/** Serve the fixture job as a song stored as MP3, the way the backend lists one. */
async function serveAsMp3(page) {
  await page.route(JOB_URL, async function answerAsMp3(route) {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const job = await response.json();
    job.stems = job.stems.map((stem) => ({ ...stem, url: toMp3(stem.url) }));
    job.mix_url = toMp3(job.mix_url);
    return route.fulfill({ response, json: job });
  });
}

/** Every stem request, and which of them asked for a byte range. */
function watchStemRequests(page) {
  const seen = { all: [], ranged: [] };
  page.on("request", async function recordStemRequest(request) {
    if (!STEM_PATH.test(new URL(request.url()).pathname)) return;
    seen.all.push(request.url());
    const headers = await request.allHeaders();
    if (headers.range) seen.ranged.push(request.url());
  });
  return seen;
}

function collectPageErrors(page) {
  const errors = [];
  page.on("pageerror", function recordPageError(error) {
    errors.push(error.message);
  });
  return errors;
}

const fullDecodeBuffers = (page) =>
  page.evaluate(async () => (await import("/js/state.js")).audioEngine?.getBuffers().size ?? 0);

const laneDownloadName = (page) =>
  page.locator(`.lane-header[data-stem="${DOWNLOAD_LANE}"] .lane-dl`).getAttribute("download");

test.describe("MP3 stems in the studio", () => {
  test("load in the full-decode engine and download as .mp3", async ({ page }) => {
    await serveAsMp3(page);
    const requests = watchStemRequests(page);
    const errors = collectPageErrors(page);

    await openStudio(page);

    await expect.poll(() => fullDecodeBuffers(page)).toBeGreaterThan(0);
    expect(requests.all.length).toBeGreaterThan(0);
    expect(requests.all.every((url) => url.endsWith(MP3_SUFFIX))).toBe(true);
    expect(requests.ranged).toEqual([]);
    expect(await laneDownloadName(page)).toMatch(/\.mp3$/);
    await expect(page.locator("#error")).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("a WAV song still streams in chunks and downloads as .wav", async ({ page }) => {
    const requests = watchStemRequests(page);

    await openStudio(page);

    await expect.poll(() => requests.ranged.length).toBeGreaterThan(0);
    expect(await fullDecodeBuffers(page)).toBe(0);
    expect(await laneDownloadName(page)).toMatch(/\.wav$/);
  });
});

test("MP3 stems play on the phone UI", async ({ page }) => {
  await serveAsMp3(page);
  const requests = watchStemRequests(page);
  const errors = collectPageErrors(page);

  await page.goto("/?ui=mobile", { waitUntil: "domcontentloaded" });
  await page.locator('[data-action="tab"][data-tab="library"]').first().click();
  await page.locator(`.track[data-id="${JOB_ID}"]`).first().click();
  // The key steppers only enable once the engine has loaded the audio.
  await expect(page.locator('.key-row [data-key-step="1"]')).toBeEnabled({ timeout: 20000 });

  expect(requests.all.every((url) => url.endsWith(MP3_SUFFIX))).toBe(true);
  expect(requests.ranged).toEqual([]);
  expect(errors).toEqual([]);
});
