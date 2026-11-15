// Recording tracks and takes (#98), on Chromium's fake microphone.
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

const recordBtn = (page) => page.locator("#t-rec");
const trackRow = (page) => page.locator(".rec-row").first();

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

async function recordTake(page) {
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);
  await recordBtn(page).click();
}

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
  await openStudio(page);
  await addArmedTrack(page);
  await recordBtn(page).click();
  await expect(recordBtn(page)).toHaveClass(/\bis-recording\b/, { timeout: 15000 });
  await page.waitForTimeout(RECORD_MS);

  await openSong(page, SIBLING_JOB_ID);
  await expect(page.locator(".rec-notice")).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await listing(request)).takes.length, { timeout: 15000 }).toBe(1);
  expect((await listing(request)).open).toHaveLength(0);
  expect((await listing(request, SIBLING_JOB_ID)).takes).toHaveLength(0);
  await expect(page.locator(".rec-row")).toHaveCount(0);
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

  await openStudio(page);
  const row = page.locator(`.rec-take-row[data-rec-take="${take.take_id}"]`);
  await expect(row).toContainText("Unfinished");
  await row.locator(".rec-chip.is-primary").click();
  await expect.poll(async () => (await listing(request)).takes.length).toBe(1);
  await expect(page.locator(".rec-take-flag")).toHaveCount(0);
});

test("Record is off at other speeds and says why", async ({ page }) => {
  await openStudio(page);
  await addArmedTrack(page);
  await page.locator("#t-speed-value").fill(SLOW_SPEED);
  await page.locator("#t-speed-value").press("Enter");
  await expect(recordBtn(page)).toBeDisabled();
  await expect(recordBtn(page)).toHaveAttribute("title", "Recording needs 1.00x speed");
});
