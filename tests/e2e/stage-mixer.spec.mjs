// Stage mode's mixer column and song overview: one mix shared with the studio's
// lanes, sections and a whole-song waveform to seek from, all fitting the window.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID } from "./helpers.mjs";

// seed.py writes these stems into a six-second fixture.
const FIXTURE_STEMS = ["vocals", "drums", "bass", "other"];
const FIXTURE_SECONDS = 6;
const FIXTURE_TOTAL_TEXT = "00:06";
const PERCENT = 100;
// Lanes the fixture lacks, served from stems it has, so a song can load all six.
const BORROWED_STEMS = { guitar: "bass", piano: "other" };
const ALL_STEMS = [...FIXTURE_STEMS, ...Object.keys(BORROWED_STEMS)];
const LYRICS = {
  v: 1, source: "lrclib", track: "Fixture Song", artist: "Fixture Band", album: "", duration: FIXTURE_SECONDS,
  synced: "[00:02.00] Hold the line until the morning light comes over the hill\n[00:04.00] Every word a little closer to the ground",
  plain: "", instrumental: false, lrclib_id: 1, others: [],
};
const LYRIC_SEEK_SEC = 2.6;
const SIX_STEM_WINDOWS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
const SECTIONS = [
  { id: "a", start: 0, end: 2, name: "Verse one", color: "#4a7fff" },
  { id: "b", start: 2, end: 4, name: "Big chorus", color: "#ff7a59" },
  { id: "c", start: 4, end: 6, name: "Outro", color: "#4a7fff" },
];
const SEEK_TOLERANCE_SEC = 0.15;
// Lets anything still settling after Stage opens land before the late duration arrives.
const NOTHING_HAPPENS_MS = 1000;
const WAVE_CLICK_FRACTION = 0.75;
const HALF_GAIN = "0.5";
const MIX_HIDDEN_KEY = "stemdeck.stage.mixHidden";
const WINDOWS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

const strip = (page, stem) => page.locator(`.stage-strip[data-stem="${stem}"]`);
const lane = (page, stem) => page.locator(`.lane-header[data-stem="${stem}"]`);
const clickHidden = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const mixOf = (page, stem) =>
  page.evaluate(async (name) => ({ ...(await import("/js/state.js")).mixerState[name] }), stem);
const currentTime = (page) =>
  page.evaluate(async () => (await import("/js/transport.js")).transport().getCurrentTime());

async function saveSections(page, sections, id = JOB_ID) {
  const res = await page.request.patch(`/api/jobs/${id}/sections`, { data: { sections } });
  expect(res.ok(), "saving sections").toBe(true);
}

async function enterStage(page) {
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView")).toBeVisible();
}

/** Rewrites the job state the studio reads when a track opens, leaving its sub-routes alone. */
async function rewriteJobState(page, id, rewrite) {
  await page.route(`**/api/jobs/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: rewrite(await response.json()) });
  });
}

test.afterEach(async ({ page }) => {
  await saveSections(page, []);
});

test.describe("stage mixer", () => {
  test("shows one strip per loaded stem, and no bar.beat number beside the dots", async ({ page }) => {
    await openStudio(page);
    await enterStage(page);
    await expect(page.locator(".stage-strip")).toHaveCount(FIXTURE_STEMS.length);
    for (const stem of FIXTURE_STEMS) await expect(strip(page, stem)).toBeVisible();
    await expect(page.locator("#stageCount")).toHaveCount(0);
    await expect(page.locator("#stageBeats")).toBeAttached();
  });

  test("a change in the studio's lanes shows in stage", async ({ page }) => {
    await openStudio(page);
    await enterStage(page);
    await clickHidden(page, '.lane-header[data-stem="drums"] .mute');
    await expect(strip(page, "drums").locator(".stage-ms.mute")).toHaveAttribute("aria-pressed", "true");
    await expect(strip(page, "drums")).toHaveClass(/silent/);

    await clickHidden(page, '.lane-header[data-stem="bass"] .solo');
    await expect(strip(page, "bass").locator(".stage-ms.solo")).toHaveAttribute("aria-pressed", "true");
    await expect(strip(page, "bass")).not.toHaveClass(/silent/);
    await expect(strip(page, "vocals")).toHaveClass(/silent/);

    await page.evaluate(async (gain) => (await import("/js/mixer.js")).setLaneVolume("other", Number(gain)), HALF_GAIN);
    await expect(strip(page, "other").locator(".stage-strip-fader")).toHaveValue(HALF_GAIN);
    await expect(strip(page, "other").locator(".stage-strip-value")).toHaveText("-6.0");
  });

  test("a change in stage drives the studio's mix", async ({ page }) => {
    await openStudio(page);
    await enterStage(page);
    await strip(page, "vocals").locator(".stage-ms.mute").click();
    expect((await mixOf(page, "vocals")).muted).toBe(true);
    await expect(lane(page, "vocals")).toHaveClass(/muted/);

    await strip(page, "drums").locator(".stage-ms.solo").click();
    expect((await mixOf(page, "drums")).soloed).toBe(true);
    await expect(lane(page, "drums").locator(".solo")).toHaveClass(/active/);
    await expect(strip(page, "bass")).toHaveClass(/silent/);

    await strip(page, "bass").locator(".stage-strip-fader").fill(HALF_GAIN);
    expect((await mixOf(page, "bass")).volume).toBe(Number(HALF_GAIN));
    await expect(lane(page, "bass").locator(".mx-fader-input")).toHaveValue(HALF_GAIN);
  });

  test("the Mix button hides the column, and the choice outlasts a reload", async ({ page }) => {
    await openStudio(page);
    await enterStage(page);
    const mix = page.locator("#stageMixBtn");
    await expect(mix).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#stageMixer")).toBeVisible();

    await mix.click();
    await expect(mix).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#stageMixer")).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), MIX_HIDDEN_KEY)).not.toBeNull();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
    await enterStage(page);
    await expect(page.locator("#stageMixBtn")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#stageMixer")).toBeHidden();
  });
});

test.describe("stage song overview", () => {
  test("shows the sections, the current one marked, and seeks from a section", async ({ page }) => {
    await saveSections(page, SECTIONS);
    await openStudio(page);
    await enterStage(page);
    const blocks = page.locator(".stage-sec");
    await expect(blocks).toHaveText(SECTIONS.map((s) => s.name));
    await expect(blocks.nth(0)).toHaveAttribute("aria-current", "true");

    await blocks.nth(1).click();
    await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(SECTIONS[1].start);
    expect(await currentTime(page)).toBeLessThan(SECTIONS[1].start + SEEK_TOLERANCE_SEC);
    await expect(blocks.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(blocks.nth(0)).not.toHaveAttribute("aria-current", "true");
    await expect(page.locator("#stageElapsed")).toHaveText("00:02");
    await expect(page.locator("#stageTotal")).toHaveText("00:06");
  });

  test("seeks from a click on the waveform, and moves the playhead there", async ({ page }) => {
    await openStudio(page);
    await enterStage(page);
    const wave = page.locator("#stageWave");
    const box = await wave.boundingBox();
    await wave.click({ position: { x: box.width * WAVE_CLICK_FRACTION, y: box.height / 2 } });
    const target = FIXTURE_SECONDS * WAVE_CLICK_FRACTION;
    await expect.poll(() => currentTime(page)).toBeGreaterThan(target - SEEK_TOLERANCE_SEC);
    expect(await currentTime(page)).toBeLessThan(target + SEEK_TOLERANCE_SEC);
    const left = await page.locator("#stagePlayhead").evaluate((el) => parseFloat(el.style.left));
    expect(Math.abs(left - WAVE_CLICK_FRACTION * PERCENT)).toBeLessThan((SEEK_TOLERANCE_SEC / FIXTURE_SECONDS) * PERCENT);
  });
});

for (const size of WINDOWS) {
  test(`stage fits ${size.width}x${size.height} with the mixer open and all four header buttons`, async ({ page }) => {
    await page.setViewportSize(size);
    await saveSections(page, SECTIONS);
    await openStudio(page);
    await enterStage(page);
    const fit = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const view = document.getElementById("stageView");
      const viewRect = view.getBoundingClientRect();
      const mixer = rect("stageMixer");
      const transport = document.querySelector(".stage-transport").getBoundingClientRect();
      const overview = rect("stageOverview");
      const header = ["stageMixBtn", "stageUpNextBtn", "stageMoreBtn", "stageExitBtn"].map(rect);
      const title = rect("stageTitle");
      return {
        headerInOrder: header.every((r, i) => i === 0 || header[i - 1].right <= r.left),
        headerClearOfTitle: title.right <= header[0].left,
        headerInside: header[3].right <= viewRect.right,
        overflows: view.scrollHeight > view.clientHeight || view.scrollWidth > view.clientWidth,
        transportInside: transport.bottom <= viewRect.bottom,
        overviewAboveTransport: overview.bottom <= transport.top,
        mixerBesideCentre: mixer.left >= overview.right,
        mixerInside: mixer.right <= viewRect.right && mixer.bottom <= viewRect.bottom,
      };
    });
    expect(fit).toEqual({
      headerInOrder: true,
      headerClearOfTitle: true,
      headerInside: true,
      overflows: false,
      transportInside: true,
      overviewAboveTransport: true,
      mixerBesideCentre: true,
      mixerInside: true,
    });
  });
}

/** Stage painted for a song whose duration is not known yet, as on open without a stored one. */
async function paintWithoutDuration(page) {
  await page.locator("#stageExitBtn").click();
  await page.evaluate(async () => (await import("/js/state.js")).setTotalDuration(0));
  await enterStage(page);
}

// The fixture's songs never take that path for real: without a stored duration they never learn one.
/** What player.js does when the audio reports the duration after the song opened. */
async function learnDurationLate(page, seconds) {
  await page.evaluate(async (sec) => {
    (await import("/js/state.js")).setTotalDuration(sec);
    document.dispatchEvent(new CustomEvent((await import("/js/player.js")).DURATION_EVENT));
  }, seconds);
}

test("a duration learnt after the song opened brings in its sections and total while paused", async ({ page }) => {
  await saveSections(page, SECTIONS);
  await openStudio(page);
  await enterStage(page);
  await paintWithoutDuration(page);
  await page.waitForTimeout(NOTHING_HAPPENS_MS);
  await expect(page.locator(".stage-sec")).toHaveCount(0);
  await expect(page.locator("#stageTotal")).toHaveText("00:00");

  await learnDurationLate(page, FIXTURE_SECONDS);
  await expect(page.locator("#stagePlayBtn")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".stage-sec")).toHaveText(SECTIONS.map((s) => s.name));
  await expect(page.locator("#stageTotal")).toHaveText(FIXTURE_TOTAL_TEXT);
  const wave = page.locator("#stageWave");
  const box = await wave.boundingBox();
  await wave.click({ position: { x: box.width * WAVE_CLICK_FRACTION, y: box.height / 2 } });
  await expect.poll(() => currentTime(page)).toBeGreaterThan(FIXTURE_SECONDS * WAVE_CLICK_FRACTION - SEEK_TOLERANCE_SEC);
});

const borrowStems = (state) => ({
  ...state,
  selected_stems: ALL_STEMS,
  stems: [
    ...state.stems,
    ...Object.entries(BORROWED_STEMS).map(([name, from]) => ({
      name,
      url: state.stems.find((s) => s.name === from).url,
    })),
  ],
});

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

for (const size of SIX_STEM_WINDOWS) {
  test(`stage fits ${size.width}x${size.height} with six strips and lyrics, every strip in view without scrolling`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.route("**/api/jobs/*/lyrics", (route) => route.fulfill({ status: 200, json: LYRICS }));
    await rewriteJobState(page, JOB_ID, borrowStems);
    await saveSections(page, SECTIONS);
    await openStudio(page);
    await enterStage(page);
    await expect(page.locator(".stage-strip")).toHaveCount(ALL_STEMS.length);
    await page.evaluate(async (at) => (await import("/js/transport.js")).setPlayheadTime(at), LYRIC_SEEK_SEC);
    await expect(page.locator("#stageLyric")).not.toHaveText("");
    await expect(page.locator("#stageLyrics")).toBeVisible();
    await expect(page.locator("#stageBeats i").first()).toBeVisible();

    const rects = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect().toJSON();
      return {
        lyrics: box(document.getElementById("stageLyrics")),
        beats: box(document.getElementById("stageBeats")),
        mixer: box(document.getElementById("stageMixer")),
        overview: box(document.getElementById("stageOverview")),
        transport: box(document.querySelector(".stage-transport")),
      };
    });
    for (const shown of ["lyrics", "beats"]) {
      for (const other of ["mixer", "overview", "transport"]) {
        expect(overlaps(rects[shown], rects[other]), `${shown} clear of ${other}`).toBe(false);
      }
    }
    const mixerScrolls = await page.locator("#stageMixer").evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(mixerScrolls, "mixer panel scrolls").toBe(false);
    for (const stem of ALL_STEMS) {
      await expect(strip(page, stem).locator(".stage-ms.solo")).toBeInViewport({ ratio: 1 });
    }
  });
}
