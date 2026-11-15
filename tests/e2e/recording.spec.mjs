// Recording tracks and takes, on Chromium's fake microphone.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";
import { openSong } from "./saveRaces.mjs";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

const TAKES_URL = `/api/jobs/${JOB_ID}/takes`;
const RECORD_MS = 1500;
const SLOW_SPEED = "0.75x";
const PART_FRAMES = 4800;
const MONO_FLOAT_BYTES = 4;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const MS_PER_SEC = 1000;
// Short enough that the stems already sit at their minimum lane height.
const SHORT_WINDOW = { width: 1440, height: 800 };
const STEMS_PLUS_TWO_TRACKS = 8;
const STEM_ROWS = 6;
// recorder.js offers the discard after SAVING_DISCARD_AFTER_MS (10 s) of "Saving…".
const DISCARD_OFFER_WAIT_MS = 15000;
const DISCARD_TEST_TIMEOUT_MS = 60000;
const RELEASE_WITHIN_MS = 1000;
const IMPORT_JOB_ID = "e2eimport0001";
const IMPORT_URL = "https://example.com/song";
// player.js WAVEFORM_LANE_HEIGHT + WAVEFORM_SEPARATOR_HEIGHT: the row a song had before + Track.
const STEM_FLOOR_PX = 72;
// "A few px": six stems give up at most this much so + Track fits at 1440x800.
const NO_TRACK_SHRINK_MAX_PX = 8;
// Well under recorder.js's TEARDOWN_WAIT_MS (500), so a wait that ran would show.
const FAST_PATH_MAX_MS = 100;

const recordBtn = (page) => page.locator("#t-rec");
const trackRow = (page) => page.locator(".rec-row").first();

// The frame count recorderWorklet.js reports on "stopped": everything it captured, tail included.
function spyOnCapturedFrames(page) {
  return page.addInitScript(function installCaptureSpy() {
    const Native = window.AudioWorkletNode;
    window.__e2e = { capturedFrames: null };
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        this.port.addEventListener("message", function onWorkletMessage({ data }) {
          if (data.type === "stopped") window.__e2e.capturedFrames = data.frames;
        });
      }
    };
  });
}

const capturedFrames = (page) => page.evaluate(() => window.__e2e.capturedFrames);

async function listing(request, jobId = JOB_ID) {
  return (await request.get(`/api/jobs/${jobId}/takes`)).json();
}

async function removeTracks({ request }) {
  for (const id of [JOB_ID, SIBLING_JOB_ID]) {
    const { tracks = [] } = await listing(request, id);
    for (const track of tracks) await request.delete(`/api/jobs/${id}/tracks/${track.id}`);
  }
}

test.afterEach(removeTracks);

async function addArmedTrack(page) {
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await expect(trackRow(page)).toBeVisible();
  await trackRow(page).locator(".rec-arm").click();
  await expect(recordBtn(page)).toBeEnabled();
}

async function sampleRate(page) {
  return page.evaluate(async () => (await import("/js/state.js")).audioEngine.audioContext.sampleRate);
}

async function markRecoverable(route) {
  const response = await route.fetch();
  const body = await response.json();
  for (const open of body.open ?? []) open.recoverable = true;
  await route.fulfill({ response, json: body });
}

async function refuseNewTakes(route) {
  if (route.request().method() !== "POST") return route.fallback();
  return route.fulfill({ status: HTTP_CONFLICT, json: { detail: "Another take is recording." } });
}

async function refuseParts(route) {
  if (route.request().method() !== "PUT") return route.fallback();
  return route.fulfill({ status: HTTP_NOT_FOUND, json: { detail: "Take not found." } });
}

async function recordTake(page) {
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);
  await recordBtn(page).click();
}

test("+ Track stays above the footer on a short window", async ({ page }) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openStudio(page);
  await addArmedTrack(page);
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await expect(page.locator(".rec-row")).toHaveCount(2);
  const add = await page.locator("#recAddTrack").boundingBox();
  const footer = await page.locator(".daw-footer").boundingBox();
  expect(add.y + add.height).toBeLessThanOrEqual(footer.y);
});

// Every mixer row inside the visible column, with its name, M, S and fader inside the row.
const headersFit = (page) =>
  page.evaluate(() => {
    const column = document.querySelector(".mixer-column");
    const view = column.getBoundingClientRect();
    const inside = (r, box) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    const rows = [...column.querySelectorAll(".lane-header.mx-row:not(.rec-take-row)")].filter((row) => row.offsetHeight);
    const problems = rows.flatMap(function rowProblems(row) {
      const box = row.getBoundingClientRect();
      const parts = [".mx-name", ".mute", ".solo", ".mx-fader"].map((sel) => row.querySelector(sel));
      const clipped = parts.filter((el) => !el || !inside(el.getBoundingClientRect(), box)).length;
      return [inside(box, view) ? null : "row hidden", clipped ? "part clipped" : null].filter(Boolean);
    });
    return { rows: rows.length, problems, scrollTop: column.scrollTop };
  });

const laneHeight = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector(".app")).getPropertyValue("--lane-h").trim());

async function expectAddRowAboveFooter(page) {
  const add = await page.locator(".rec-add-row").boundingBox();
  const footer = await page.locator(".daw-footer").boundingBox();
  expect(add.y + add.height).toBeLessThanOrEqual(footer.y);
}

test("a song with no tracks shows + Track without scrolling, its rows a few px under the stems' floor", async ({ page }) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openStudio(page);
  await expect.poll(() => headersFit(page)).toEqual({ rows: STEM_ROWS, problems: [], scrollTop: 0 });
  await expectAddRowAboveFooter(page);
  const rowPx = Number.parseFloat(await laneHeight(page));
  expect(rowPx).toBeLessThanOrEqual(STEM_FLOOR_PX);
  expect(rowPx).toBeGreaterThanOrEqual(STEM_FLOOR_PX - NO_TRACK_SHRINK_MAX_PX);
});

test("six stems and two recording tracks fit without scrolling", async ({ page }) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openStudio(page);
  await addArmedTrack(page);
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await expect(page.locator(".rec-row")).toHaveCount(2);
  await expect.poll(() => headersFit(page)).toEqual({ rows: STEMS_PLUS_TWO_TRACKS, problems: [], scrollTop: 0 });
  await expectAddRowAboveFooter(page);
});

test("Record waits for a recording track and says so", async ({ page }) => {
  await openStudio(page);
  await expect(recordBtn(page)).toBeVisible();
  await expect(recordBtn(page)).toBeDisabled();
  await expect(recordBtn(page)).toHaveAttribute("title", "Add a recording track");
});

test("arm, record, stop, then keep or delete the take", async ({ page, request }) => {
  await openStudio(page);
  await addArmedTrack(page);

  await recordTake(page);
  const keep = page.locator(".rec-take-row .rec-chip.is-primary");
  await expect(keep).toBeVisible({ timeout: 15000 });
  let saved = await listing(request);
  expect(saved.takes).toHaveLength(1);
  expect(saved.tracks[0].active_take_id).toBe(saved.takes[0].id);
  await keep.click();
  await expect(page.locator(".rec-take-row .rec-chip")).toHaveCount(0);
  await expect(page.locator(".rec-wave .rec-clip")).toBeVisible();

  await recordTake(page);
  const discard = page.locator(".rec-take-row .rec-chip:not(.is-primary)");
  await expect(discard).toBeVisible({ timeout: 15000 });
  await discard.click();
  await expect.poll(async () => (await listing(request)).takes.length).toBe(1);
});

test("a song switch mid-take finishes the take on its own song", async ({ page, request }) => {
  await spyOnCapturedFrames(page);
  await openStudio(page);
  await addArmedTrack(page);
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);

  const rate = await sampleRate(page);
  await openSong(page, SIBLING_JOB_ID);
  await expect(page.locator(".rec-notice")).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
  expect((await listing(request)).open).toHaveLength(0);
  const frames = Math.round((await listing(request)).takes[0].duration_sec * rate);
  expect(frames).toBe(await capturedFrames(page));
  expect((await listing(request, SIBLING_JOB_ID)).takes).toHaveLength(0);
  await expect(page.locator(".rec-row")).toHaveCount(0);
});

async function acceptImport(route) {
  if (route.request().method() !== "POST") return route.fallback();
  return route.fulfill({ status: 200, json: { job_id: IMPORT_JOB_ID } });
}

test("an import started mid-take finishes the take first, tail included", async ({ page, request }) => {
  await spyOnCapturedFrames(page);
  await openStudio(page);
  await addArmedTrack(page);
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);
  const rate = await sampleRate(page);

  await page.route("**/api/jobs", acceptImport);
  await page.evaluate(async (url) => (await import("/js/job.js")).importFromUrl(url), IMPORT_URL);
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
  expect((await listing(request)).open).toHaveLength(0);
  const frames = Math.round((await listing(request)).takes[0].duration_sec * rate);
  expect(frames).toBe(await capturedFrames(page));
});

test("a reload brings the track and its take back", async ({ page, request }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await recordTake(page);
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);

  await page.reload();
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
  await expect(trackRow(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".rec-wave .rec-clip")).toBeVisible();
  await expect(page.locator(".rec-take-row")).toHaveCount(0);
});

test("a take cut off by a crash comes back as unfinished and can be kept", async ({ page, request }) => {
  const track = await (await request.post(`/api/jobs/${JOB_ID}/tracks`, { data: { name: "Voice" } })).json();
  const take = await (await request.post(TAKES_URL, {
    data: {
      track_id: track.id,
      timeline: { frame0_song_sec: 0.5, tempo: 1 },
      latency: { round_trip_ms: 0, source: "estimated" },
      capture: { rate: 48000, channels: 1 },
    },
  })).json();
  await request.put(`${TAKES_URL}/${take.take_id}/parts?seq=0`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: Buffer.alloc(PART_FRAMES * MONO_FLOAT_BYTES),
  });

  await page.route(`**${TAKES_URL}`, markRecoverable);
  await openStudio(page);
  const row = page.locator(`.rec-take-row[data-rec-take="${take.take_id}"]`);
  await expect(row).toContainText("Unfinished");
  await row.locator(".rec-chip.is-primary").click();
  await expect.poll(async () => (await listing(request)).takes.length).toBe(1);
  await expect(page.locator(".rec-take-flag")).toHaveCount(0);

  const hint = page.locator(".rec-wave .rec-latency-hint");
  await expect(hint).toContainText("Timing is estimated.");
  await hint.getByRole("button", { name: "Test latency" }).click();
  await expect(page.locator('[data-pane="recording"] .rec-latency-value')).toBeVisible();
});

test("a take the server refuses to start says so and leaves the track armed", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.route(`**${TAKES_URL}`, refuseNewTakes);
  await recordBtn(page).click();
  const problem = page.locator(".rec-wave .rec-problem");
  await expect(problem).toContainText("Couldn't start recording. Try again.", { timeout: 15000 });
  await expect(recordBtn(page)).not.toHaveClass(/\bis-(recording|counting|saving)\b/);
  await expect(trackRow(page).locator(".rec-arm")).toHaveAttribute("aria-pressed", "true");

  await page.unroute(`**${TAKES_URL}`, refuseNewTakes);
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(recordBtn(page)).toBeEnabled();
});

test("R starts and stops recording", async ({ page, request }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.keyboard.press("r");
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press("r");
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
});

test("a soloed take leaves no stems to export", async ({ page, request }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await recordTake(page);
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
  await trackRow(page).locator(".solo").click();
  const exported = await page.evaluate(async () => (await import("/js/player.js")).downloadCurrentMix("wav"));
  expect(exported).toBe(false);
});

// Leaves part uploads unanswered, like a server that hangs.
function hangParts(route) {
  if (route.request().method() !== "PUT") return route.fallback();
  return new Promise(function neverAnswer() {});
}

test("discarding a save stuck on a hung server frees Record at once", async ({ page }) => {
  test.setTimeout(DISCARD_TEST_TIMEOUT_MS);
  await openStudio(page);
  await addArmedTrack(page);
  await page.route("**/takes/*/parts*", hangParts);
  await recordTake(page);
  await expect(recordBtn(page)).toHaveClass(/\bis-saving\b/);
  await expect(recordBtn(page)).toHaveAttribute("title", /Click to stop/, { timeout: DISCARD_OFFER_WAIT_MS });
  await recordBtn(page).click();
  await expect(recordBtn(page)).not.toHaveClass(/\bis-saving\b/, { timeout: RELEASE_WITHIN_MS });
  await expect(recordBtn(page)).toBeEnabled({ timeout: RELEASE_WITHIN_MS });
});

test("a take the server no longer has ends with an error on its track", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.route("**/takes/*/parts*", refuseParts);
  await recordBtn(page).click();
  const problem = page.locator(".rec-wave .rec-problem");
  await expect(problem).toContainText("This take couldn't be saved.", { timeout: 15000 });
  await expect(recordBtn(page)).not.toHaveClass(/\bis-(recording|counting|saving)\b/);
});

test("Stop pressed while the input is still starting leaves nothing capturing", async ({ page, request }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.evaluate(() => {
    const button = document.getElementById("t-rec");
    button.click();
    button.click();
  });
  await expect(recordBtn(page)).toBeEnabled();
  const started = Date.now();
  await recordTake(page);
  const wallSec = (Date.now() - started) / MS_PER_SEC;
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
  // A leaked capture feeds the next take too, doubling its length.
  expect((await listing(request)).takes[0].duration_sec).toBeLessThan(wallSec);
});

test("holding R starts recording once", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.keyboard.down("r");
  await page.keyboard.down("r");
  await page.keyboard.down("r");
  await page.keyboard.up("r");
  await expect(recordBtn(page)).toHaveClass(/\bis-(counting|recording)\b/, { timeout: 15000 });
  await recordBtn(page).click();
});

test("leaving the page while recording asks first", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  const asked = page.waitForEvent("dialog");
  page.reload().catch(() => {});
  const dialog = await asked;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await recordBtn(page).click();
});

test("a song switch with nothing recording does not wait for a take", async ({ page }) => {
  await openStudio(page);
  const waitedMs = await page.evaluate(async () => {
    const { finishTakeBeforeTeardown } = await import("/js/recorder.js");
    const started = performance.now();
    await finishTakeBeforeTeardown();
    return performance.now() - started;
  });
  expect(waitedMs).toBeLessThan(FAST_PATH_MAX_MS);
});

test("Record is off at other speeds and says why", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.locator("#t-speed-value").fill(SLOW_SPEED);
  await page.locator("#t-speed-value").press("Enter");
  await expect(recordBtn(page)).toBeDisabled();
  await expect(recordBtn(page)).toHaveAttribute("title", "Recording needs 1.00x speed");
});
