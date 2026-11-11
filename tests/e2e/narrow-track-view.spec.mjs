// A narrow window keeps the track view usable: the library gives way to the
// timeline, and the song head keeps its controls' labels at every width.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

const NARROW_WINDOW = { width: 1024, height: 768 };
const MEDIUM_WINDOW = { width: 1280, height: 800 };
const WIDE_WINDOW = { width: 1440, height: 900 };
const ROOMY_WINDOW = { width: 1600, height: 900 };
const MIN_TIMELINE_WIDTH = 360;
const DRAG_PAST_MAX = 1000;
// The desktop store answers over IPC, so the library's saved state lands after the first layout.
const SLOW_STORE_MS = 200;
const FIXTURE_SECONDS = 6;
const HALF = FIXTURE_SECONDS / 2;
const SECTIONS = [
  { id: "s1", name: "Verse 1", start: 0, end: HALF, color: "#4a7fff" },
  { id: "s2", name: "Chorus", start: HALF, end: FIXTURE_SECONDS, color: "#ff7a59" },
];

const app = (page) => page.locator(".app");
const collapseButton = (page) => page.locator("#sidebarCollapseBtn");
const timelineWidth = (page) =>
  page.evaluate(() => document.querySelector("#daw-sections").getBoundingClientRect().width);

const reload = (page) => page.reload({ waitUntil: "domcontentloaded" });

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

const nextFrames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function reopenTrack(page) {
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await expect(app(page)).not.toHaveClass(/no-track/);
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

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
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
    await expect(page.locator("#title")).toBeVisible();
  });

  test("the Stage mode button looks the same at 1024 and 1440", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    const narrow = await stageButtonLook(page);

    await page.setViewportSize(WIDE_WINDOW);
    await expect.poll(() => stageButtonLook(page)).toEqual(narrow);
    expect(narrow.labelShown).toBe(true);
  });

  test("the library comes back once the window has room for it", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await page.setViewportSize(ROOMY_WINDOW);
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
  });

  test("a library reopened in a narrow window stays open", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await collapseButton(page).click();
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
    await reopenTrack(page);
    await expect(app(page)).not.toHaveClass(/cat-collapsed/);
  });

  test("a library collapsed for a narrow window opens again after a reload in a wide one", async ({ page }) => {
    await openAt(page, NARROW_WINDOW);
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    // A second window, so the narrow one never sees the room come back.
    const wide = await page.context().newPage();
    await wide.setViewportSize(ROOMY_WINDOW);
    await wide.goto("/", { waitUntil: "domcontentloaded" });
    await expect(app(wide)).not.toHaveClass(/cat-collapsed/);
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
    await page.mouse.move(box.x + DRAG_PAST_MAX, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => timelineWidth(page)).toBeGreaterThanOrEqual(MIN_TIMELINE_WIDTH);
  });
});
