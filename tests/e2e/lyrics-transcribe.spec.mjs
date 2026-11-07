// Transcribe lyrics on demand (#30), with the server's endpoints stubbed. What
// the server does is tests/test_lyrics_transcribe_api.py.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  LYRICS_LOOKUP,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

const JSON_TYPE = "application/json";
const POLL_WAIT_MS = 2500;
const CPU_NOTE = "Transcribing on the CPU can take a few minutes.";
const WHISPER = {
  v: 1,
  source: "whisper",
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "",
  duration: 6,
  synced: "[00:00.50]<00:00.50>Heard <00:01.00>words\n[00:02.00]<00:02.00>Second <00:02.50>line",
  plain: "Heard words\nSecond line",
  instrumental: false,
  language: "en",
  others: [],
};

const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });
const idle = (device = "cuda") => ({ state: "idle", available: true, unavailable: null, device });
const running = (phase, progress, device = "cuda") =>
  ({ state: "running", phase, progress, available: false, unavailable: null, device });
const ended = (state, device = "cuda") => ({ state, available: true, unavailable: null, device });

/**
 * Open the fixture track's Lyrics tab with no lyrics anywhere. `transcribe`
 * holds each track's GET .../lyrics/transcribe answer, which the test changes
 * as the run goes; a POST starts a run as `started`, a cancel records itself.
 */
async function setUp(page, { transcribe = {}, started = running("queued", 0) } = {}) {
  const server = { lyrics: {}, transcribe: { [JOB_ID]: idle(), [SIBLING_JOB_ID]: idle(), ...transcribe } };
  const calls = { starts: [], cancels: [], gets: { [JOB_ID]: 0, [SIBLING_JOB_ID]: 0 } };
  await page.route(LYRICS_LOOKUP, (route) => answer(route, 404, { detail: "no lyrics" }));
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    await page.route(`**/api/jobs/${id}/lyrics`, (route) =>
      (server.lyrics[id] ? answer(route, 200, server.lyrics[id]) : answer(route, 404, { detail: "no lyrics" })));
    await page.route(`**/api/jobs/${id}/lyrics/transcribe`, (route) => {
      if (route.request().method() === "POST") {
        calls.starts.push(id);
        server.transcribe[id] = started;
        return answer(route, 202, started);
      }
      calls.gets[id]++;
      return answer(route, 200, server.transcribe[id]);
    });
    await page.route(`**/api/jobs/${id}/cancel`, (route) => {
      calls.cancels.push(id);
      return answer(route, 200, { status: "done" });
    });
    await page.route(`**/api/jobs/${id}/vocal-envelope`, (route) => answer(route, 404, { detail: "no vocals" }));
  }
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), audioTags: { artist: "Fixture Band", title: "Fixture Song" } },
      [SIBLING_JOB_ID]: {
        ...fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
        audioTags: { artist: "Fixture Band", title: "Other Song" },
      },
    },
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
  await openTrack(page, JOB_ID);
  return { server, calls };
}

async function openTrack(page, id) {
  await page.locator(".rail-library").click();
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
  await page.locator(".rail-lyrics").click();
}

const startButton = (page) => page.locator(".lyrics-transcribe-open");
const message = (page) => page.locator(".lyrics-transcribe-message");
const progress = (page) => page.locator(".lyrics-transcribe-progress");
const percent = (page) => page.locator(".lyrics-transcribe-percent");
const cancelButton = (page) => page.locator(".lyrics-transcribe-cancel");
const pasteButton = (page) => page.locator(".lyrics-supply-open");
const primaries = (page) => page.locator(".lyrics-tools .lyrics-tool-primary");
const PRIMARY = /lyrics-tool-primary/;
const notFound = (page) => expect(page.locator("#lyricsStatus")).toHaveText(/No lyrics found/);
const timedLines = (page) => page.evaluate(async () => (await import("/js/lyrics.js")).getTimedLyricLines().length);

test.describe("transcribing lyrics on demand", () => {
  test("is offered beside Paste for a song with none, on the GPU without a warning", async ({ page }) => {
    await setUp(page);
    await notFound(page);
    await expect(startButton(page)).toBeVisible();
    await expect(startButton(page)).toHaveText("Transcribe lyrics");
    await expect(pasteButton(page)).toBeVisible();
    await expect(message(page)).toBeHidden();
    await expect(primaries(page)).toHaveCount(1);
    await expect(startButton(page)).toHaveClass(PRIMARY);
  });

  test("warns up front that a CPU run can take a few minutes", async ({ page }) => {
    await setUp(page, { transcribe: { [JOB_ID]: idle("cpu") } });
    await expect(startButton(page)).toBeVisible();
    await expect(message(page)).toHaveText(CPU_NOTE);
  });

  test("is not offered when the setting is off; Paste is the main action", async ({ page }) => {
    const off = { state: "idle", available: false, unavailable: "off", device: "cuda" };
    await setUp(page, { transcribe: { [JOB_ID]: off } });
    await notFound(page);
    await expect(startButton(page)).toBeHidden();
    await expect(message(page)).toBeHidden();
    await expect(primaries(page)).toHaveCount(1);
    await expect(pasteButton(page)).toHaveClass(PRIMARY);
  });

  test("shows each phase's progress, then the lyrics without a reload", async ({ page }) => {
    const { server, calls } = await setUp(page);
    await startButton(page).click();
    expect(calls.starts).toEqual([JOB_ID]);
    await expect(message(page)).toHaveText("Waiting for an import to finish…");
    await expect(startButton(page)).toBeHidden();
    await expect(pasteButton(page)).toBeVisible();
    await expect(pasteButton(page)).not.toHaveClass(PRIMARY);
    await expect(primaries(page)).toHaveCount(0);

    server.transcribe[JOB_ID] = running("download", 0.4);
    await expect(message(page)).toHaveText("Downloading the lyrics model…");
    await expect(percent(page)).toHaveText("40%");
    server.transcribe[JOB_ID] = running("transcribe", 0.75);
    await expect(message(page)).toHaveText("Transcribing lyrics…");
    await expect(percent(page)).toHaveText("75%");

    server.lyrics[JOB_ID] = WHISPER;
    server.transcribe[JOB_ID] = { ...ended("done"), available: false, unavailable: "has_lyrics" };
    await expect(page.locator(".lyrics-line")).toHaveText(["Heard words", "Second line"]);
    await expect(page.locator(".lyrics-match-meta")).toHaveText("Fixture Band · Transcribed");
    await expect(progress(page)).toBeHidden();
    expect(await timedLines(page)).toBe(2);
  });

  test("Cancel stops the run through the job's cancel", async ({ page }) => {
    const { server, calls } = await setUp(page, { started: running("transcribe", 0.2) });
    await startButton(page).click();
    await expect(cancelButton(page)).toBeVisible();
    await cancelButton(page).click();
    expect(calls.cancels).toEqual([JOB_ID]);

    server.transcribe[JOB_ID] = ended("cancelled");
    await expect(message(page)).toHaveText("Transcription cancelled.");
    await expect(progress(page)).toBeHidden();
    await expect(startButton(page)).toBeVisible();
    await expect(pasteButton(page)).toBeVisible();
  });

  test("says so when there is too little singing, and keeps Paste", async ({ page }) => {
    const { server } = await setUp(page, { started: running("transcribe", 0.1) });
    await startButton(page).click();
    await expect(progress(page)).toBeVisible();
    server.transcribe[JOB_ID] = ended("no_singing");
    await expect(message(page)).toHaveText("There is too little singing in this track to transcribe.");
    await expect(pasteButton(page)).toBeVisible();
    await expect(page.locator(".lyrics-line")).toHaveCount(0);
  });

  test("says so when it fails, and keeps Paste", async ({ page }) => {
    const { server } = await setUp(page, { started: running("load", 0) });
    await startButton(page).click();
    await expect(message(page)).toHaveText("Loading the lyrics model…");
    server.transcribe[JOB_ID] = ended("failed", "cpu");
    await expect(message(page)).toHaveText("The lyrics could not be transcribed.");
    await expect(pasteButton(page)).toBeVisible();
  });

  test("a run never shows on another song, and its lyrics wait for their own", async ({ page }) => {
    const { server, calls } = await setUp(page, { transcribe: { [JOB_ID]: running("transcribe", 0.5) } });
    await expect(percent(page)).toHaveText("50%");

    await openTrack(page, SIBLING_JOB_ID);
    await expect(page.locator("#lyricsStatus")).toHaveText(/Other Song/);
    await expect(progress(page)).toBeHidden();
    await expect(startButton(page)).toBeVisible();
    const getsAfterSwitch = calls.gets[JOB_ID];

    server.lyrics[JOB_ID] = WHISPER;
    server.transcribe[JOB_ID] = ended("done");
    await page.waitForTimeout(POLL_WAIT_MS);
    expect(calls.gets[JOB_ID]).toBe(getsAfterSwitch);
    await expect(page.locator(".lyrics-line")).toHaveCount(0);
    await expect(progress(page)).toBeHidden();

    await openTrack(page, JOB_ID);
    await expect(page.locator(".lyrics-line")).toHaveText(["Heard words", "Second line"]);
  });
});
