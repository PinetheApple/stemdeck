// Stage mode over the shared footer: Stage covers the top bar and the studio, the footer's own
// transport plays it, and its top bar, cue, lyric lines, section blocks and side panels follow the redesign.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";
import { seedUpNext, seekTo } from "./singAlongHelpers.mjs";

const LYRICS = {
  v: 1, source: "lrclib", track: "Fixture Song", artist: "Fixture Band", album: "", duration: 6,
  synced: "[00:01.00] Line one\n[00:02.00] Line two\n[00:03.00] Line three\n[00:04.00] Line four\n[00:05.00] Line five",
  plain: "", instrumental: false, lrclib_id: 1, others: [],
};
// On the fixture's 120 BPM 4/4 grid a bar is two seconds, so the chorus starts on bar three.
const SECTIONS = [
  { id: "a", start: 0, end: 4, name: "Verse one", color: "#4a7fff" },
  { id: "b", start: 4, end: 6, name: "Big chorus", color: "#ff7a59" },
];
const WINDOWS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];
const TOP_BAR_PLAY = ["stageTitle", "stageUpNextBtn", "stageMoreBtn", "stageLook", "stageMixBtn", "stageQueueBtn", "stageExitBtn"];
const TOP_BAR_SING = ["stageTitle", "stageUpNextBtn", "stageMoreBtn", "stageLook", "singVoiceBtn", "singBackingBtn", "stageQueueBtn", "stageExitBtn"];
const METER_LEVEL = "0.5";

async function saveSections(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "saving sections").toBe(true);
}

async function openStage(page, { sections = SECTIONS, upNext = [SIBLING_JOB_ID] } = {}) {
  await page.route("**/api/jobs/*/lyrics", (route) => route.fulfill({ status: 200, json: LYRICS }));
  await page.route("**/api/jobs/*/vocal-envelope", (route) => route.fulfill({ status: 404, json: {} }));
  await saveSections(page, sections);
  await seedUpNext(page, upNext);
  await openStudio(page);
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView")).toBeVisible();
}

const box = (page, selector) => page.locator(selector).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
});

test.afterEach(async ({ page }) => {
  await saveSections(page, []);
});

test("Stage covers the top bar and the studio, and the footer's transport stays to play it", async ({ page }) => {
  await openStage(page);
  await expect(page.locator(".stage-transport, #stagePlayBtn, #stageStopBtn, #stageNextBtn")).toHaveCount(0);
  for (const id of ["#t-stop", "#t-play", "#t-next"]) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator("#t-play")).toBeFocused();
  await expect(page.locator(".daw-topbar")).toBeHidden();
  const stage = await box(page, "#stageView");
  const footer = await box(page, ".daw-footer");
  expect(stage.bottom).toBeLessThanOrEqual(footer.top + 1);
  await page.locator("#t-play").click();
  await expect(page.locator("#t-play")).toHaveClass(/playing/);
});

test("the top bar holds the song, its actions, the look, Mix or Voices, Up Next and Exit", async ({ page }) => {
  await openStage(page);
  const inTopBar = (ids) => page.evaluate(
    (list) => list.filter((id) => !document.querySelector(".stage-top")?.contains(document.getElementById(id))),
    ids,
  );
  expect(await inTopBar(TOP_BAR_PLAY)).toEqual([]);
  await expect(page.locator("#stageQueueBtn")).toContainText("1");
  await page.locator("#stageLookSing").click();
  expect(await inTopBar(TOP_BAR_SING)).toEqual([]);
  await expect(page.locator("#singVoiceBtn")).toBeVisible();
  await expect(page.locator("#stageMixBtn")).toBeHidden();
});

test("Up Next opens from Play along in place of the Mix panel; Esc closes it, then Stage", async ({ page }) => {
  await openStage(page);
  await expect(page.locator("#stageMixer")).toBeVisible();
  const chip = page.locator("#stageQueueBtn");
  await chip.click();
  await expect(page.locator("#stageQueuePanel")).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#stageMixer")).toBeHidden();
  await expect(page.locator(`#stageQueuePanel .upnext-row[data-id="${SIBLING_JOB_ID}"]`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#stageQueuePanel")).toBeHidden();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#stageView")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#stageView")).toBeHidden();
});

test("an empty Up Next still shows the chip, and its panel says so", async ({ page }) => {
  await openStage(page, { upNext: [] });
  await expect(page.locator("#stageQueueBtn")).toBeVisible();
  await page.locator("#stageQueueBtn").click();
  await expect(page.locator("#stageQueuePanel #upNextEmpty")).toBeVisible();});

test("Play along shows the section, the bars to the next one and four lyric lines", async ({ page }) => {
  await openStage(page);
  await expect.poll(async () => {
    await seekTo(page, 2.5);
    return page.locator("#stageLyric").textContent();
  }).toBe("Line two");
  await expect(page.locator("#stageSection")).toHaveText("Verse one");
  await expect(page.locator("#stageThen")).toHaveText("then Big chorus in 1 bar");
  await expect(page.locator("#stageLyricPrev")).toHaveText("Line one");
  await expect(page.locator("#stageLyricNext")).toHaveText("Line three");
  await expect(page.locator("#stageLyricNext2")).toHaveText("Line four");
  await seekTo(page, 0.5);
  await expect(page.locator("#stageThen")).toHaveText("then Big chorus in 2 bars");
  await seekTo(page, 4.5);
  await expect(page.locator("#stageThen")).toHaveText("then End in 1 bar");
});

test("a section's loop button loops that section, and a second press turns Loop off", async ({ page }) => {
  await openStage(page);
  const loopOf = () => page.evaluate(async () => {
    const s = await import("/js/state.js");
    return { on: s.loopEnabled, start: s.loopStart, end: s.loopEnd };
  });
  const loop = page.locator('.stage-sec[data-start="4"] .stage-sec-loop');
  await expect(loop).toHaveAttribute("aria-pressed", "false");
  await loop.click();
  await expect.poll(loopOf).toEqual({ on: true, start: 4, end: 6 });
  await expect(loop).toHaveAttribute("aria-pressed", "true");
  await loop.click();
  await expect.poll(async () => (await loopOf()).on).toBe(false);
  await expect(loop).toHaveAttribute("aria-pressed", "false");
});

test("the section blocks and the song's waveform stay under Sing along", async ({ page }) => {
  await openStage(page);
  await page.locator("#stageLookSing").click();
  await expect(page.locator("#stageOverview")).toBeVisible();
  await expect(page.locator(".stage-sec")).toHaveCount(SECTIONS.length);
});

test("Sing along lists every line, marks the one sung, and a click on a line seeks to it", async ({ page }) => {
  await openStage(page);
  await page.locator("#stageLookSing").click();
  const lines = page.locator("#singLyrics .sing-line");
  await expect(lines).toHaveCount(5);
  await lines.nth(2).click();
  await expect(page.locator("#singLyrics .sing-line.now")).toHaveText("Line three");
  const time = await page.evaluate(async () => (await import("/js/transport.js")).transport().getCurrentTime());
  expect(time).toBeGreaterThanOrEqual(3);
});

test("each Mix row has M, S, a fader, its dB and a meter that follows the studio's", async ({ page }) => {
  await openStage(page);
  const row = page.locator('.stage-strip[data-stem="drums"]');
  for (const part of [".mute", ".solo", ".stage-strip-fader", ".stage-strip-value", ".stage-strip-meter"]) {
    await expect(row.locator(part)).toHaveCount(1);
  }
  await page.evaluate((level) => {
    document.querySelector('.stem-list [data-stem="drums"] .mini-meter')?.style.setProperty("--vu-scale", level);
  }, METER_LEVEL);
  await seekTo(page, 1);
  await expect.poll(() => row.locator(".stage-strip-meter").evaluate((el) => el.style.getPropertyValue("--vu-scale"))).toBe(METER_LEVEL);
});

for (const size of WINDOWS) {
  test(`Stage fits ${size.width}x${size.height} over the footer, with Mix, then Up Next, then Sing along`, async ({ page }) => {
    await page.setViewportSize(size);
    await openStage(page);
    const inside = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
      && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const check = async (ids) => {
      const stage = await box(page, "#stageView");
      for (const id of ids) expect(inside(stage, await box(page, `#${id}`)), id).toBe(true);
      const footer = await box(page, ".daw-footer");
      expect(footer.bottom).toBeLessThanOrEqual(size.height + 1);
    };
    await check([...TOP_BAR_PLAY, "stageMixer", "stageOverview", "stageSection"]);
    await page.locator("#stageQueueBtn").click();
    await check(["stageQueuePanel", "stageOverview"]);
    await page.locator("#stageLookSing").click();
    await check([...TOP_BAR_SING, "stageQueuePanel", "singLyrics", "stageOverview"]);
  });
}
