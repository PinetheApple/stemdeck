// A narrow window keeps the track view usable: the library gives way to the
// timeline, and the song head keeps its controls' labels at every width.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  MIN_TIMELINE_WIDTH,
  TRACK_TITLE,
  fixtureTrack,
  openStudio,
  waitForPanesSettled,
} from "./helpers.mjs";

const NARROW_WINDOW = { width: 1024, height: 768 };
const MEDIUM_WINDOW = { width: 1280, height: 800 };
const WIDE_WINDOW = { width: 1440, height: 900 };
const ROOMY_WINDOW = { width: 1600, height: 900 };
const TITLE_WINDOWS = [
  { size: NARROW_WINDOW, inspector: true },
  { size: NARROW_WINDOW, inspector: false },
  { size: WIDE_WINDOW, inspector: true },
];
const DRAG_PAST_MAX = 1000;
const DRAG_STEPS = { steps: 5 };
// The desktop store answers over IPC, so the library's saved state lands after the first layout.
const SLOW_STORE_MS = 200;
// Mirrors --lib-tags-max-h: about two rows of chips.
const TAGS_MAX_HEIGHT = 64;
const MANY_TAGS = Array.from({ length: 14 }, (_, i) => `tag number ${i + 1}`);
const FIXTURE_SECONDS = 6;
const HALF = FIXTURE_SECONDS / 2;
const SECTIONS = [
  { id: "s1", name: "Verse 1", start: 0, end: HALF, color: "#4a7fff" },
  { id: "s2", name: "Chorus", start: HALF, end: FIXTURE_SECONDS, color: "#ff7a59" },
];

const app = (page) => page.locator(".app");
const collapseButton = (page) => page.locator("#sidebarCollapseBtn");
const inspectorToggle = (page) => page.locator("#inspectorToggleBtn");
const reload = (page) => page.reload({ waitUntil: "domcontentloaded" });
const timelineWidth = (page) =>
  page.evaluate(() => document.querySelector("#daw-sections").getBoundingClientRect().width);
const nextFrames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function seedSections(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

async function openAt(page, size, options = {}) {
  await page.setViewportSize(size);
  await openStudio(page, options);
}

async function slowDownStore(page) {
  await page.addInitScript((delayMs) => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) =>
      cmd === "store_get"
        ? new Promise((done) => setTimeout(done, delayMs)).then(() => invoke(cmd, args))
        : invoke(cmd, args);
  }, SLOW_STORE_MS);
}

function firstSectionFit(page) {
  return page.evaluate(() => {
    const timeline = document.querySelector("#daw-sections").getBoundingClientRect();
    const block = document.querySelector('.section-block[data-id="s1"]');
    const label = block.querySelector(".section-label");
    const box = block.getBoundingClientRect();
    return {
      inside: box.left >= timeline.left && box.right <= timeline.right,
      labelCut: label.scrollWidth > label.clientWidth,
    };
  });
}

function stageButtonLook(page) {
  return page.evaluate(() => {
    const button = document.querySelector("#stageModeBtn");
    const label = button.querySelector("span");
    return {
      width: Math.round(button.getBoundingClientRect().width),
      labelShown: label.checkVisibility() && label.getBoundingClientRect().width > 1,
    };
  });
}

// Every lane's waveform is at least as wide as the timeline showing it.
function narrowestWave(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector("#wave-scroll").clientWidth;
    const waves = [...document.querySelectorAll(".stem-waveform-svg")].map((svg) => svg.getBoundingClientRect().width);
    return { viewport, narrowest: Math.min(...waves), count: waves.length };
  });
}

test.afterEach(async ({ page }) => {
  await seedSections(page, []);
});

test.describe("track view in a narrow window", () => {
  test("at 1024 with the inspector open the timeline stays readable", async ({ page }) => {
    await seedSections(page, SECTIONS);
    await openAt(page, NARROW_WINDOW);
    await expect(page.locator("#inspector")).toBeVisible();

    await expect(app(page)).toHaveClass(/cat-collapsed/);
    await expect.poll(() => timelineWidth(page)).toBeGreaterThanOrEqual(MIN_TIMELINE_WIDTH);
    await expect.poll(() => firstSectionFit(page)).toEqual({ inside: true, labelCut: false });
    await expect(page.locator("#songHead .daw-panel-toggles-label")).toBeVisible();
  });

  test("at 1024 with the inspector open the waveforms fill the timeline", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await page.locator("#waveLoadingOverlay.hidden").waitFor({ state: "attached" });
    await waitForPanesSettled(page);

    const { viewport, narrowest, count } = await narrowestWave(page);
    expect(count).toBeGreaterThan(0);
    expect(viewport).toBeGreaterThanOrEqual(MIN_TIMELINE_WIDTH);
    expect(narrowest).toBeGreaterThanOrEqual(viewport);
  });

  for (const { size, inspector } of TITLE_WINDOWS) {
    test(`the title fits at ${size.width} with the inspector ${inspector ? "open" : "closed"}`, async ({ page }) => {
      await openAt(page, size);
      if (!inspector) await inspectorToggle(page).click();
      await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
      await waitForPanesSettled(page);

      const cut = await page.locator("#title").evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(cut).toBe(false);
    });
  }

  test("the Stage mode button looks the same at 1024 and 1440", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    const narrow = await stageButtonLook(page);

    await page.setViewportSize(WIDE_WINDOW);
    await expect.poll(() => stageButtonLook(page)).toEqual(narrow);
    expect(narrow.labelShown).toBe(true);
  });

  test("many tags stay within two rows of the library", async ({ page }) => {
    await openAt(page, NARROW_WINDOW, {
      catalog: {
        folders: [
          { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
          { id: "trash", name: "Trash", items: [], color: null },
        ],
        tracks: { [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), tags: MANY_TAGS } },
      },
    });
    await inspectorToggle(page).click();
    await expect(page.locator(".lib-tag-chip")).toHaveCount(MANY_TAGS.length);

    const row = await page.locator(".lib-tags-row").evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrolls: el.scrollHeight > el.clientHeight,
    }));
    expect(row.height).toBeLessThanOrEqual(TAGS_MAX_HEIGHT);
    expect(row.scrolls).toBe(true);
  });

  test("the library comes back once the window has room for it", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await page.setViewportSize(ROOMY_WINDOW);
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
  });

  test("a library collapsed for a narrow window opens again after a reload and a wider window", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await reload(page);
    await expect(app(page)).toHaveClass(/cat-collapsed/);
    await page.setViewportSize(ROOMY_WINDOW);
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
  });

  test("a library reopened in a narrow window stays open, through a wide and narrow round trip", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await collapseButton(page).click();
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
    await page.setViewportSize(ROOMY_WINDOW);
    await nextFrames(page);
    await page.setViewportSize(NARROW_WINDOW);
    await nextFrames(page);
    expect(await app(page).getAttribute("class")).not.toContain("cat-collapsed");
  });

  test("a library the user shuts after an automatic collapse stays shut in a wide window", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await reload(page);
    await expect(app(page)).toHaveClass(/cat-collapsed/);
    await collapseButton(page).click();
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
    await collapseButton(page).click();
    await expect(app(page)).toHaveClass(/cat-collapsed/);
    await page.setViewportSize(ROOMY_WINDOW);
    await nextFrames(page);
    expect(await app(page).getAttribute("class")).toContain("cat-collapsed");
  });

  test("a library the user collapsed stays collapsed when the window widens", async ({ page }) => {
    await openAt(page, ROOMY_WINDOW, { tauri: true });
    await collapseButton(page).click();
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await slowDownStore(page);
    await page.setViewportSize(NARROW_WINDOW);
    await reload(page);
    await expect(page.locator(".cat-item").first()).toBeAttached();
    await page.setViewportSize(ROOMY_WINDOW);
    await nextFrames(page);
    expect(await app(page).getAttribute("class")).toContain("cat-collapsed");
  });

  test("a library dragged wide still leaves the timeline its minimum", async ({ page }) => {
    await openAt(page, MEDIUM_WINDOW);
    const handle = page.locator("#libraryResizer");
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + DRAG_PAST_MAX, box.y + box.height / 2, DRAG_STEPS);
    await page.mouse.up();

    await expect.poll(() => timelineWidth(page)).toBeGreaterThanOrEqual(MIN_TIMELINE_WIDTH);
  });
});
