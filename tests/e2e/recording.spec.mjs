// Recording tracks and takes, on Chromium's fake microphone.
import { test, expect } from "@playwright/test";
import { SELECTED_ROW_CLASS } from "../../static/js/rovingRows.js";
import { JOB_ID, SIBLING_JOB_ID, TRACK_TITLE, exportUi, openStudio, openSpeedOptions } from "./helpers.mjs";
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
// Short enough that the lanes sit at their floor and the mixer scrolls.
const SHORT_WINDOW = { width: 1440, height: 800 };
const STEMS_PLUS_TWO_TRACKS = 8;
const STEM_ROWS = 6;
// recorder.js offers the discard after SAVING_DISCARD_AFTER_MS (10 s) of "Saving…".
const DISCARD_OFFER_WAIT_MS = 15000;
const DISCARD_TEST_TIMEOUT_MS = 60000;
const RELEASE_WITHIN_MS = 1000;
const IMPORT_JOB_ID = "e2eimport0001";
const IMPORT_URL = "https://example.com/song";
// player.js WAVEFORM_LANE_HEIGHT + WAVEFORM_SEPARATOR_HEIGHT: the floor no lane goes under.
const STEM_FLOOR_PX = 72;
// The 24 px minimum target, as dialog-keyboard.spec checks it.
const MIN_TARGET_PX = 24;
const ALL_ARROW_HITS = [true, true, true, true];
// Well under recorder.js's TEARDOWN_WAIT_MS (500), so a wait that ran would show.
const FAST_PATH_MAX_MS = 100;
const EXPORT_ROUTE = /\/(mixdown\.wav|stems\/all\.zip)\?/;

// Long enough for a click's show to have reached the studio, had it started one.
const SETTLE_MS = 600;

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
  const mixerTop = (await page.locator("#mixer").boundingBox()).y;
  // Plain DOM clicks: Playwright's own scroll-into-view before a click would move the lanes itself.
  await page.evaluate(() => document.querySelector("#recAddTrack").click());
  await page.getByRole("menuitem", { name: "Audio track" }).evaluate((item) => item.click());
  await expect(page.locator(".rec-row")).toHaveCount(2);
  expect((await page.locator("#mixer").boundingBox()).y).toBe(mixerTop);
  const add = await page.locator("#recAddTrack").boundingBox();
  const footer = await page.locator(".daw-footer").boundingBox();
  expect(add.y + add.height).toBeLessThanOrEqual(footer.y);
});

// Every mixer row with its name, M, S and fader inside the row.
const headersFit = (page) =>
  page.evaluate(() => {
    const inside = (r, box) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    const rows = [...document.querySelectorAll(".mixer-column .lane-header.mx-row:not(.rec-take-row)")]
      .filter((row) => row.offsetHeight);
    const clipped = rows.filter(function partClipped(row) {
      const box = row.getBoundingClientRect();
      const parts = [".mx-name", ".mute", ".solo", ".mx-fader"].map((sel) => row.querySelector(sel));
      return parts.some((el) => !el || !inside(el.getBoundingClientRect(), box));
    });
    return { rows: rows.length, clipped: clipped.length };
  });

const laneHeight = async (page) =>
  Number.parseFloat(
    await page.evaluate(() => getComputedStyle(document.querySelector(".app")).getPropertyValue("--lane-h")),
  );

async function expectAddRowAboveFooter(page) {
  const add = await page.locator(".rec-add-row").boundingBox();
  const footer = await page.locator(".daw-footer").boundingBox();
  expect(add.y + add.height).toBeLessThanOrEqual(footer.y);
}

// As dialog-keyboard.spec: each arrow answers MIN_TARGET_PX away from the K, at its edge and at the far end.
async function keyArrowHits(page, stem) {
  const lane = page.locator(`.lane-key[data-stem="${stem}"]`);
  // Centred, so the sticky + Track row is not over the lane being probed.
  await lane.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const up = await lane.locator(".lane-key-step.up").boundingBox();
  const down = await lane.locator(".lane-key-step.down").boundingBox();
  const upYs = [up.y + up.height - 1, up.y + up.height - MIN_TARGET_PX + 1];
  const downYs = [down.y + 1, down.y + MIN_TARGET_PX - 1];
  return page.evaluate(
    ({ upX, upYs, downX, downYs }) => {
      const hit = (x, y, sel) => Boolean(document.elementFromPoint(x, y)?.closest(sel));
      return [
        ...upYs.map((y) => hit(upX, y, ".lane-key-step.up")),
        ...downYs.map((y) => hit(downX, y, ".lane-key-step.down")),
      ];
    },
    { upX: up.x + up.width / 2, upYs, downX: down.x + down.width / 2, downYs },
  );
}

// Shown lanes, and of those the ones a user can reach: an unavailable lane takes no pointer at all.
const shownStems = (page) =>
  page.locator(".lane-key[data-stem]").evaluateAll((keys) => keys
    .map((key) => key.closest(".lane-header"))
    .filter((row) => row.offsetHeight)
    .map((row) => ({ stem: row.querySelector(".lane-key").dataset.stem, usable: !row.classList.contains("unavailable") })));

test("a song with no tracks keeps the stems' lane height, + Track at the end of the lanes", async ({ page }) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openStudio(page);
  await expect.poll(() => headersFit(page)).toEqual({ rows: STEM_ROWS, clipped: 0 });
  expect(await laneHeight(page)).toBeGreaterThanOrEqual(STEM_FLOOR_PX);
  await page.locator(".rec-add-row").scrollIntoViewIfNeeded();
  await expectAddRowAboveFooter(page);
});

test("six stems and two recording tracks keep the lane floor and every K arrow's full target", async ({ page }) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openStudio(page);
  await addArmedTrack(page);
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await expect(page.locator(".rec-row")).toHaveCount(2);
  await expect.poll(() => headersFit(page)).toEqual({ rows: STEMS_PLUS_TWO_TRACKS, clipped: 0 });
  expect(await laneHeight(page)).toBeGreaterThanOrEqual(STEM_FLOOR_PX);
  await expectAddRowAboveFooter(page);
  const stems = await shownStems(page);
  expect(stems).toHaveLength(STEM_ROWS);
  const usable = stems.filter((lane) => lane.usable).map((lane) => lane.stem);
  expect(usable.length).toBeGreaterThan(0);
  for (const stem of usable) expect(await keyArrowHits(page, stem), stem).toEqual(ALL_ARROW_HITS);
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

test("a click on another song mid-take only selects its row", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });

  const sibling = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();
  await sibling.click();
  await expect(sibling).toHaveClass(new RegExp(`\\b${SELECTED_ROW_CLASS}\\b`));
  await page.waitForTimeout(SETTLE_MS);
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  await expect(page.locator("#openPreview")).toBeHidden();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/);
  await recordBtn(page).click();
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

// Answers every export with a stub file and keeps the query each one asked for.
// After openStudio, so it wins over the helpers' own mixdown stub.
async function captureExports(page) {
  const queries = [];
  await page.route(EXPORT_ROUTE, function stubExport(route) {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ status: 200, body: "x" });
  });
  return queries;
}

async function exportFromMenu(page, item, queries) {
  const ui = exportUi(page);
  const before = queries.length;
  await ui.open();
  await ui[item].click();
  await expect.poll(() => queries.length).toBe(before + 1);
  await expect(ui.label).toHaveText("Export Mix");
  return queries.at(-1);
}

const lanesOf = (query) => query.get("stems").split(",");

test("a solo on a silenced stem does not silence the export", async ({ page }) => {
  await openStudio(page);
  const queries = await captureExports(page);
  await page.locator('.lane-header[data-stem="vocals"] .solo').click();
  await page.evaluate(async () => (await import("/js/mixer.js")).setSilencedStems(["vocals"]));
  expect(lanesOf(await exportFromMenu(page, "mix", queries))).toContain("drums");
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
  await openSpeedOptions(page);
  await page.locator("#t-speed-value").fill(SLOW_SPEED);
  await page.locator("#t-speed-value").press("Enter");
  await expect(recordBtn(page)).toBeDisabled();
  await expect(recordBtn(page)).toHaveAttribute("title", "Recording needs 1.00x speed");
});
