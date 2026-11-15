// #99: the filmed-take MP4 export dialog and Settings > Export's video encoder.
// The render and the encoder test are answered by stubs: their real runs are
// covered by pytest, and the GPU ones need the device.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone", "camera"],
});

const TAKES_URL = `/api/jobs/${JOB_ID}/takes`;
const TAKE_ID = "takefilmed1";
const RENDER_URL = `${TAKES_URL}/${TAKE_ID}/render`;
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
const SHOTS_DIR = process.env.FILM_SHOTS_DIR;

const ok = (speed) => ({ ok: true, reason: null, detail: null, speed, transient: false, device: null });
const bad = (reason) => ({ ok: false, reason, detail: "x", speed: null, transient: false, device: null });
const ENCODERS = {
  policy: { value: "auto", source: "setting" },
  choices: ["auto", "cpu", "h264_nvenc", "h264_vaapi", "h264_qsv"],
  candidates: ["h264_nvenc", "h264_vaapi", "h264_qsv"],
  disabled: [],
  render_available: true,
  last_test: null,
};
const TESTED = {
  at: 1,
  rows: [
    { encoder: "h264_nvenc", family: "nvidia", disabled: false, results: { "720p30": ok(31.2), "1080p60": ok(9.4) } },
    { encoder: "h264_vaapi", family: "vaapi", disabled: false, results: { "720p30": bad("missing"), "1080p60": bad("missing") } },
    { encoder: "h264_qsv", family: "intel", disabled: false, results: { "720p30": bad("no-device"), "1080p60": bad("no-device") } },
    { encoder: "libx264", family: "cpu", disabled: false, results: { "720p30": ok(4.1), "1080p60": ok(1.2) } },
  ],
};

async function stubFilmedTake(page) {
  await page.route(`**${TAKES_URL}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tracks = [{ id: "trkvideo", name: "Video 1", kind: "video", i_play: ["drums"], order: 0 }];
    body.takes = [{
      id: TAKE_ID, track_id: "trkvideo", label: "Take 1", placement_sec: 0.5, duration_sec: 3, created_at: 1,
      has_camera: true, camera_url: null, camera_dropped: null, camera_start_sec: 0.45,
      span: { start_sec: 0.5, end_sec: 3.5 }, trim: { in_sec: 1, out_sec: 3 }, i_play: ["drums"],
      peaks_url: `${TAKES_URL}/${TAKE_ID}/peaks`,
    }];
    await route.fulfill({ response, json: body });
  });
}

async function stubEncoders(page, status = ENCODERS) {
  let current = status;
  await page.route("**/api/video-encoders", (route) => route.fulfill({ json: current }));
  await page.route("**/api/video-encoders/test", (route) => {
    current = { ...current, last_test: TESTED };
    return route.fulfill({ json: TESTED });
  });
}

async function stubRender(page, finalView) {
  const posted = [];
  let reads = 0;
  await page.route(`**${RENDER_URL}`, (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { status: "queued", progress: 0 } });
    }
    reads += 1;
    return route.fulfill({ json: reads < 2 ? { status: "running", progress: 0.42 } : finalView });
  });
  await page.route(`**${TAKES_URL}/${TAKE_ID}/render.mp4`, (route) =>
    route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.from("mp4") }));
  return posted;
}

async function openReview(page) {
  await page.locator("#filmBtn").click();
  await page.locator("#filmTakeRow .film-take").click();
  await expect(page.locator("#filmExportBtn")).toBeEnabled();
}

test("Export MP4 renders over the mix without the take, then says where and with what", async ({ page }) => {
  await stubFilmedTake(page);
  await stubEncoders(page);
  const done = { status: "done", progress: 1, url: `${TAKES_URL}/${TAKE_ID}/render.mp4`, encoder: "h264_nvenc", family: "nvidia", fallback_reason: null };
  const posted = await stubRender(page, done);
  await openStudio(page);
  await openReview(page);
  await page.locator("#filmExportBtn").click();
  const dialog = page.getByRole("dialog", { name: "Export video" });
  await expect(dialog.getByRole("radio", { name: "1080p" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: "30" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog).toContainText("0:01 – 0:03");
  await dialog.getByRole("radio", { name: "720p" }).click();
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toContainText(/Saved as \w+_Take_1\.mp4\./, { timeout: 15000 });
  await expect(dialog).toContainText("Made with NVENC.");
  expect(posted[0].size).toBe("720");
  expect(posted[0].fps).toBe(30);
  expect(posted[0].stems).not.toContain("trkvideo");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#filmView")).toBeVisible();
});

test("an export redone on the CPU and a failed one say so", async ({ page }) => {
  await stubFilmedTake(page);
  await stubEncoders(page);
  const cpu = { status: "done", progress: 1, url: `${TAKES_URL}/${TAKE_ID}/render.mp4`, encoder: "libx264", family: "cpu", fallback_reason: "invalid-fps" };
  await stubRender(page, cpu);
  await openStudio(page);
  await openReview(page);
  await page.locator("#filmExportBtn").click();
  const dialog = page.getByRole("dialog", { name: "Export video" });
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toContainText("Made with the CPU", { timeout: 15000 });
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.unroute(`**${RENDER_URL}`);
  await stubRender(page, { status: "error", progress: 0, error: "timeout" });
  await page.locator("#filmExportBtn").click();
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toContainText("The video couldn't be made.", { timeout: 15000 });
  await expect(dialog.getByRole("button", { name: "Open Settings" })).toBeVisible();
});

test("Settings > Export picks the encoder and tests them", async ({ page }) => {
  await stubEncoders(page, { ...ENCODERS, auto_pick: "h264_nvenc" });
  const saved = [];
  await page.route("**/api/settings", (route) => {
    if (route.request().method() === "POST") saved.push(route.request().postDataJSON());
    return route.fallback();
  });
  await openStudio(page);
  await page.locator("#settingsBtn").click();
  await page.locator('.settings-tab[data-tab="export"]').click();
  const select = page.locator(".vid-enc-select");
  await expect(select).toHaveValue("auto");
  await expect(select.locator("option")).toHaveText(["Auto (NVENC)", "CPU only", "NVENC", "VAAPI", "QSV"]);
  await page.getByRole("button", { name: "Test encoders" }).click();
  const table = page.locator(".vid-enc-table");
  await expect(table).toContainText("Works");
  await expect(table).toContainText("The video driver for this card isn't installed.");
  await expect(table).toContainText("9.4×");
  await expect(select.locator('option[value="h264_vaapi"]')).toBeDisabled();
  await expect(select.locator('option[value="h264_vaapi"]')).toHaveText("VAAPI (failed test)");
  await select.selectOption("h264_nvenc");
  await expect.poll(() => saved.at(-1)?.video_encoder).toBe("h264_nvenc");
});

test("a forced CPU keeps the Auto choice plain and the select locked", async ({ page }) => {
  await stubEncoders(page, { ...ENCODERS, auto_pick: "h264_nvenc", policy: { value: "cpu", source: "env" } });
  await openStudio(page);
  await page.locator("#settingsBtn").click();
  await page.locator('.settings-tab[data-tab="export"]').click();
  const select = page.locator(".vid-enc-select");
  await expect(select).toHaveValue("cpu");
  await expect(select).toBeDisabled();
  await expect(select.locator('option[value="auto"]')).toHaveText("Auto");
});

for (const viewport of VIEWPORTS) {
  test(`Settings > Export with the encoder section at ${viewport.width}px`, async ({ page }) => {
    await stubEncoders(page, { ...ENCODERS, last_test: TESTED });
    await page.setViewportSize(viewport);
    await openStudio(page);
    await page.locator("#settingsBtn").click();
    await page.locator('.settings-tab[data-tab="export"]').click();
    const section = page.locator(".vid-enc-section");
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    const pane = await page.locator('.settings-pane[data-pane="export"]').boundingBox();
    const box = await section.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/settings-export-${viewport.width}.png` });
  });
}
