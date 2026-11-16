// Filming yourself playing along, on Chromium's fake camera and microphone.
// The export and Settings > Export are in film-export.spec.mjs.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone", "camera"],
});

const TAKES_URL = `/api/jobs/${JOB_ID}/takes`;
// Past the count-in, so the take is longer than the shortest trim.
const RECORD_SEC = 3;
const SAVE_TIMEOUT_MS = 20000;
const RECORD_TEST_TIMEOUT_MS = 60000;
// Holds the take in "Saving…" long enough to close Film during it.
const SLOW_FINISH_MS = 2000;
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
const RECT_TOLERANCE_PX = 1;

const film = (page) => page.locator("#filmView");
const appClasses = (page) => page.evaluate(() => {
  const app = document.querySelector(".app");
  return { film: app.classList.contains("film-mode"), stage: app.classList.contains("stage-mode") };
});

async function removeTracks({ request }) {
  const { tracks = [] } = await (await request.get(TAKES_URL)).json();
  for (const track of tracks) await request.delete(`/api/jobs/${JOB_ID}/tracks/${track.id}`);
}

test.afterEach(removeTracks);

async function recordedPast(sec) {
  const { recordingTake, REC_PHASE } = await import("/js/recorder.js");
  const { transport } = await import("/js/transport.js");
  return recordingTake()?.phase === REC_PHASE.recording && transport().getCurrentTime() > sec;
}

async function openFilm(page) {
  await page.locator("#filmBtn").click();
  await expect(film(page)).toBeVisible();
}

test("Film opens over the studio and Esc puts everything back", async ({ page }) => {
  await openStudio(page);
  const topbar = page.locator(".daw-topbar");
  const footerTransport = page.locator(".footer-group-transport");
  await expect(topbar).toBeVisible();
  await openFilm(page);
  expect(await appClasses(page)).toEqual({ film: true, stage: false });
  await expect(topbar).toBeHidden();
  await expect(footerTransport).toBeHidden();
  await expect(page.locator("#filmBtn")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(film(page)).toBeHidden();
  expect(await appClasses(page)).toEqual({ film: false, stage: false });
  await expect(topbar).toBeVisible();
  await expect(footerTransport).toBeVisible();
  await expect(page.locator("#filmBtn")).toHaveAttribute("aria-pressed", "false");
});

test("with Film open, F does not open Stage and Esc closes Film only", async ({ page }) => {
  await openStudio(page);
  await openFilm(page);
  await page.keyboard.press("f");
  await expect(page.locator("#stageView")).toBeHidden();
  expect(await appClasses(page)).toEqual({ film: true, stage: false });
  await page.keyboard.press("Escape");
  await expect(film(page)).toBeHidden();
  await expect(page.locator("#stageView")).toBeHidden();
  expect(await appClasses(page)).toEqual({ film: false, stage: false });
});

test("opening Film from Stage leaves Film as the only mode", async ({ page }) => {
  await openStudio(page);
  await page.keyboard.press("f");
  await expect(page.locator("#stageView")).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("film:open", { detail: {} })));
  await expect(film(page)).toBeVisible();
  await expect(page.locator("#stageView")).toBeHidden();
  expect(await appClasses(page)).toEqual({ film: true, stage: false });
});

test("the camera preview and the input level run", async ({ page }) => {
  await openStudio(page);
  await openFilm(page);
  await expect.poll(() => page.evaluate(() => {
    const stream = document.getElementById("filmCameraVideo").srcObject;
    return stream?.getVideoTracks().length ?? 0;
  })).toBe(1);
  await expect(page.locator("#filmCameraName")).not.toHaveText("No camera");
  await expect(page.locator("#filmRecBtn")).toBeEnabled();
  await expect(page.locator("#filmProblem")).toBeHidden();
});

test("I play silences a stem while Film is open and never touches the mix", async ({ page }) => {
  await openStudio(page);
  await page.evaluate(async () => {
    const { audioEngine } = await import("/js/state.js");
    const setGain = audioEngine.setGain.bind(audioEngine);
    window.__gains = {};
    audioEngine.setGain = (name, value) => {
      window.__gains[name] = value;
      return setGain(name, value);
    };
  });
  await openFilm(page);
  await page.locator('.film-stem[data-stem="drums"]').click();
  await expect(page.locator('.film-stem[data-stem="drums"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#filmIPlayNote")).toBeVisible();
  const during = await page.evaluate(async () => {
    const { mixerState } = await import("/js/state.js");
    return { gains: { ...window.__gains }, muted: mixerState.drums.muted };
  });
  expect(during.gains.drums).toBe(0);
  expect(during.gains.bass).toBeGreaterThan(0);
  expect(during.muted).toBe(false);
  await page.keyboard.press("Escape");
  const after = await page.evaluate(() => window.__gains.drums);
  expect(after).toBeGreaterThan(0);
});

test("a missing GStreamer package says so with the command to copy", async ({ page }) => {
  await page.addInitScript(() => {
    delete window.MediaRecorder;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { get: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" });
  });
  await page.route("**/api/video-encoders", async (route) => {
    const response = await route.fetch();
    const json = { ...(await response.json()), os: { key: "linux", distro: "endeavouros", distro_like: ["arch"] } };
    await route.fulfill({ response, json });
  });
  await openStudio(page);
  await openFilm(page);
  await expect(page.locator("#filmProblemText")).toContainText("GStreamer");
  await expect(page.locator("#filmProblemCode")).toContainText("sudo pacman -S");
  await expect(page.locator("#filmProblemBtn")).toHaveText("Copy command");
  await expect(page.locator("#filmRecBtn")).toBeDisabled();
});

test("no camera says what to do and offers to try again", async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => (constraints.video
      ? Promise.reject(new DOMException("none", "NotFoundError"))
      : getUserMedia(constraints));
  });
  await openStudio(page);
  await openFilm(page);
  await expect(page.locator("#filmProblemText")).toContainText("No camera found");
  await expect(page.locator("#filmProblemBtn")).toHaveText("Try again");
  await expect(page.locator("#filmRecBtn")).toBeDisabled();
  await expect(page.locator("#filmCameraName")).toHaveText("No camera");
});

test("the + Track menu adds a Video track whose arm button opens Film", async ({ page }) => {
  await openStudio(page);
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Video track" }).click();
  const row = page.locator(".rec-row").first();
  await expect(row.locator(".mx-name")).toHaveText("Video 1");
  await row.locator(".rec-arm").click();
  await expect(film(page)).toBeVisible();
});

async function addArmedAudioTrack(page) {
  await page.locator("#recAddTrack").click();
  await page.getByRole("menuitem", { name: "Audio track" }).click();
  await page.locator(".rec-row").first().locator(".rec-arm").click();
  await expect(page.locator("#t-rec")).toBeEnabled();
  return page.evaluate(async () => (await import("/js/recorderArm.js")).armedTrack()?.trackId);
}

const armedTrackId = (page) => page.evaluate(async () => (await import("/js/recorderArm.js")).armedTrack()?.trackId ?? null);

test("closing Film arms the studio's track again", async ({ page }) => {
  await openStudio(page);
  const trackId = await addArmedAudioTrack(page);
  expect(trackId).toBeTruthy();
  await openFilm(page);
  await expect.poll(() => armedTrackId(page)).not.toBe(trackId);
  await page.keyboard.press("Escape");
  await expect(film(page)).toBeHidden();
  await expect.poll(() => armedTrackId(page)).toBe(trackId);
});

test("Film stays shut while a studio take records, so it can't stop it", async ({ page }) => {
  await openStudio(page);
  await addArmedAudioTrack(page);
  await page.locator("#t-rec").click();
  await expect(page.locator("#t-rec")).toHaveClass(/\bis-recording\b/, { timeout: SAVE_TIMEOUT_MS });
  await expect(page.locator("#filmBtn")).toBeDisabled();
  await expect(page.locator("#filmBtn")).toHaveAttribute("title", "Stop recording to film");
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("film:open", { detail: {} })));
  await page.keyboard.press("Escape");
  await expect(film(page)).toBeHidden();
  await expect(page.locator("#t-rec")).toHaveClass(/\bis-recording\b/);
  await page.locator("#t-rec").click();
  await expect(page.locator("#filmBtn")).toBeEnabled({ timeout: SAVE_TIMEOUT_MS });
  await expect(page.locator("#filmBtn")).toHaveAttribute("title", "Film yourself playing along");
});

test("closing Film while its take saves still arms the studio's track again", async ({ page }) => {
  test.setTimeout(RECORD_TEST_TIMEOUT_MS);
  await page.route("**/finish", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_FINISH_MS));
    await route.continue();
  });
  await openStudio(page);
  const trackId = await addArmedAudioTrack(page);
  await openFilm(page);
  await expect(page.locator("#filmRecBtn")).toBeEnabled();
  await page.locator("#filmRecBtn").click();
  await expect.poll(() => page.evaluate(recordedPast, 0), { timeout: SAVE_TIMEOUT_MS }).toBe(true);
  await page.locator("#filmRecBtn").click();
  await page.keyboard.press("Escape");
  await expect(film(page)).toBeHidden();
  await expect.poll(() => armedTrackId(page), { timeout: SAVE_TIMEOUT_MS }).toBe(trackId);
});

test("a filmed take keeps camera and sound, then reviews and trims", async ({ page }) => {
  test.setTimeout(RECORD_TEST_TIMEOUT_MS);
  const finishes = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/finish")) finishes.push(req.postDataJSON());
  });
  await openStudio(page);
  await openFilm(page);
  await expect(page.locator("#filmRecBtn")).toBeEnabled();
  await page.locator("#filmRecBtn").click();
  await expect(page.locator("#filmRecBadge")).toBeVisible({ timeout: SAVE_TIMEOUT_MS });
  // Past the count-in: a Stop while the take is still counting saves nothing.
  // page.evaluate awaits the module imports; waitForFunction would take the
  // returned promise itself as truthy.
  await expect.poll(
    () => page.evaluate(recordedPast, RECORD_SEC),
    { timeout: SAVE_TIMEOUT_MS },
  ).toBe(true);
  await page.locator("#filmRecBtn").click();
  await expect(page.locator("#filmTakeBadge")).toHaveText("Take 1", { timeout: SAVE_TIMEOUT_MS });

  expect(finishes[0]?.camera?.first_frame_clock).toMatch(/^(capture|recorder-start)$/);
  expect(finishes[0].camera.parts).toBeGreaterThan(0);
  const listing = await (await page.request.get(TAKES_URL)).json();
  expect(listing.tracks.map((track) => track.kind)).toEqual(["video"]);
  expect(listing.takes[0].has_camera).toBe(true);
  await expect(page.locator("#filmTakeVideo")).toBeVisible();
  await expect(page.locator("#filmExportBtn")).toBeEnabled();

  const patched = page.waitForRequest((req) => req.method() === "PATCH" && req.url().includes("/takes/"));
  const handle = page.locator('.film-handle[data-edge="in"]');
  const box = await handle.boundingBox();
  const take = await page.locator("#filmTakeRow .film-take").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(take.x + take.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const body = (await patched).postDataJSON();
  expect(body.trim.in_sec).toBeGreaterThan(listing.takes[0].span.start_sec);
  await expect(page.locator(".film-trim-out").first()).toBeVisible();
});

test("a take that lost its picture says it has sound only", async ({ page }) => {
  await page.route(`**${TAKES_URL}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tracks = [{ id: "trkvideo", name: "Video 1", kind: "video", i_play: [], order: 0 }];
    body.takes = [{
      id: "takenopic", track_id: "trkvideo", label: "Take 1", placement_sec: 0.5, duration_sec: 2, created_at: 1,
      has_camera: false, camera_url: null, camera_dropped: "parts-missing", span: { start_sec: 0.5, end_sec: 2.5 },
      trim: null, i_play: [], peaks_url: `${TAKES_URL}/takenopic/peaks`,
    }];
    await route.fulfill({ response, json: body });
  });
  await openStudio(page);
  await openFilm(page);
  await page.locator("#filmTakeRow .film-take").click();
  await expect(page.locator("#filmNote")).toHaveText("The picture couldn't be saved, so this take has sound only.");
  await expect(page.locator("#filmExportBtn")).toBeDisabled();
});

for (const viewport of VIEWPORTS) {
  test(`the Guide outlines Film and Stage mode apart at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openStudio(page);
    await page.locator("#helpModeBtn").click();
    const rings = await page.evaluate((tolerance) => {
      const box = (el) => el.getBoundingClientRect();
      const close = (a, b) => ["left", "top", "right", "bottom"].every((k) => Math.abs(a[k] - b[k]) <= tolerance);
      const all = [...document.querySelectorAll(".help-intro-ring")].map(box);
      const of = (id) => {
        const r = box(document.getElementById(id));
        const ring = all.find((b) => close(b, r));
        return ring && { left: ring.left, right: ring.right, top: ring.top, bottom: ring.bottom };
      };
      return { film: of("filmBtn"), stage: of("stageModeBtn") };
    }, RECT_TOLERANCE_PX);
    expect(rings.film).toBeTruthy();
    expect(rings.stage).toBeTruthy();
    expect(rings.film.right).toBeLessThanOrEqual(rings.stage.left + RECT_TOLERANCE_PX);
  });
}
