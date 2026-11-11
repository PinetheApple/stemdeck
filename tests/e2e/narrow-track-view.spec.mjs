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
// Mirrors --lib-tags-max-h: two rows of chips and a glimpse of a third.
const TAGS_MAX_HEIGHT = 86;
const MANY_TAG_COUNT = 14;
const MANY_TAGS = Array.from({ length: MANY_TAG_COUNT }, (_, i) => `tag number ${i + 1}`);
const FEW_TAGS = ["live", "acoustic"];
// Longer than the library's width transition and the re-fit frame after it.
const STAY_WINDOW_MS = 600;
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

// Every collapsed state the library shows over a window, so a late re-fit can't slip past one look.
const collapsedStatesOver = (page) =>
  page.evaluate(async (windowMs) => {
    const seen = new Set();
    const until = performance.now() + windowMs;
    while (performance.now() < until) {
      seen.add(document.querySelector(".app").classList.contains("cat-collapsed"));
      await new Promise((done) => requestAnimationFrame(done));
    }
    return [...seen];
  }, STAY_WINDOW_MS);

const tagsFade = (page) =>
  page.locator(".lib-tags-row").evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--lib-tags-fade")));

async function openWithTags(page, tags) {
  await openAt(page, NARROW_WINDOW, {
    catalog: {
      folders: [
        { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
        { id: "trash", name: "Trash", items: [], color: null },
      ],
      tracks: { [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), tags } },
    },
  });
  await inspectorToggle(page).click();
  await expect(page.locator(".lib-tag-chip")).toHaveCount(tags.length);
  await waitForPanesSettled(page);
}

// Each chip's focus ring, grown by its outline and offset, inside the row's scroll box.
function clippedFocusRings(page) {
  return page.locator(".lib-tags-row").evaluate((row) => {
    const box = row.getBoundingClientRect();
    return [...row.querySelectorAll(".lib-tag-chip")]
      .map((chip) => {
        chip.focus({ focusVisible: true });
        const style = getComputedStyle(chip);
        const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const r = chip.getBoundingClientRect();
        const inside = r.left - ring >= box.left && r.right + ring <= box.right && r.top - ring >= box.top;
        return { tag: chip.dataset.tag, ring, inside };
      })
      .filter(({ ring, inside }) => !(ring > 0 && inside));
  });
}

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

  test("many tags stay within two rows of the library and fade until scrolled to the end", async ({ page }) => {
    await openWithTags(page, MANY_TAGS);

    const row = await page.locator(".lib-tags-row").evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrolls: el.scrollHeight > el.clientHeight,
    }));
    expect(row.height).toBeLessThanOrEqual(TAGS_MAX_HEIGHT);
    expect(row.scrolls).toBe(true);
    expect(await tagsFade(page)).toBeGreaterThan(0);

    await page.locator(".lib-tags-row").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => tagsFade(page)).toBe(0);
  });

  test("a few tags show unfaded, with their focus rings inside the row", async ({ page }) => {
    await openWithTags(page, FEW_TAGS);

    expect(await tagsFade(page)).toBe(0);
    expect(await clippedFocusRings(page)).toEqual([]);
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
    expect(await collapsedStatesOver(page)).toEqual([false]);
    await page.setViewportSize(NARROW_WINDOW);
    expect(await collapsedStatesOver(page)).toEqual([false]);
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
    expect(await collapsedStatesOver(page)).toEqual([true]);
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
    expect(await collapsedStatesOver(page)).toEqual([true]);
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
