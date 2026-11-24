import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, showSongTools, waitForPanesSettled } from "./helpers.mjs";
import { MIN_WAVES_PX, PANE_LIMITS } from "../../static/js/paneEdgeMath.js";

const STORE_KEY = "stemdeck.library.width";
const INSPECTOR_HIDDEN_KEY = "stemdeck.inspector.hidden";
const INSPECTOR_HIDDEN = "1";
const { min: MIN_WIDTH, max: MAX_WIDTH } = PANE_LIMITS.sidebar;
const STRIP_WIDTH = 64;
const MIN_WAVES = MIN_WAVES_PX;
const KEYBOARD_STEP = 16;
const CUSTOM_WIDTH = 300;
const DRAG_WIDER = 100;
const DRAG_NARROWER = 60;
const DRAG_PAST_MIN = -280;
const DRAG_PAST_MAX = 1000;
const WIDE_WINDOW = { width: 1600, height: 900 };
const SMALL_WINDOW = { width: 1280, height: 720 };
// The song tools give way first, down to their minimum.
const SMALL_WINDOW_INSPECTOR = PANE_LIMITS.tools.min;
const TOOLS_OPEN_SQUEEZE_WINDOW = { width: 1024, height: 800 };
const TAB_LIMIT = 100;
const PAST_ARROW_KEY_SAVE_MS = 500;

const handleOf = (page) => page.locator("#libraryResizer");
const collapseButton = (page) => page.locator("#sidebarCollapseBtn");
const reload = (page) => page.reload({ waitUntil: "domcontentloaded" });

const widthOf = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, selector);

const libraryWidth = (page) => widthOf(page, ".sidebar");
const waveWidth = (page) => widthOf(page, ".daw-wave-panel");

/** In SMALL_WINDOW, with the song tools kept open, a MAX_WIDTH library stops where the waveforms reach their floor. */
async function squeezedWidth(page) {
  // Shown while the library still opens, the tools would leave no room for it and collapse it.
  await waitForPanesSettled(page);
  await showSongTools(page);
  await waitForPanesSettled(page);
  await expect.poll(async () => Math.floor(await waveWidth(page))).toBe(MIN_WAVES);
  const width = await libraryWidth(page);
  expect(width).toBeLessThan(MAX_WIDTH);
  return width;
}

const savedWidth = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORE_KEY);

const inlineWidth = (page) =>
  page.evaluate(() => document.querySelector(".app").style.getPropertyValue("--library-w"));

const nextFrames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function dragHandle(page, dx) {
  const box = await handleOf(page).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

// The song tools step aside here; kept open, they leave the library no room, and reopening it is the user's call.
async function openWithNoRoom(page) {
  await page.setViewportSize(TOOLS_OPEN_SQUEEZE_WINDOW);
  await openStudio(page);
  await showSongTools(page);
  await expect(page.locator(".app")).toHaveClass(/cat-collapsed/);
  await collapseButton(page).click();
  await expect(handleOf(page)).toBeVisible();
  await expect.poll(() => libraryWidth(page)).toBe(MIN_WIDTH);
}

async function openWide(page) {
  await page.setViewportSize(WIDE_WINDOW);
  await openStudio(page);
  await expect(handleOf(page)).toBeVisible();
}

async function dragTo(page, target) {
  await dragHandle(page, target - (await libraryWidth(page)));
  await expect.poll(() => libraryWidth(page)).toBe(target);
  await expect.poll(() => savedWidth(page)).toBe(target);
}

async function collapseLibrary(page) {
  await collapseButton(page).click();
  await expect.poll(() => widthOf(page, ".sidebar")).toBe(STRIP_WIDTH);
  await expect(handleOf(page)).toBeHidden();
}

async function pressRepeatedly(page, key, times) {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

test.describe("library pane width", () => {
  test("dragging resizes the pane and the stem tracks take the rest", async ({ page }) => {
    await openWide(page);
    const startLibrary = await libraryWidth(page);
    const startTracks = await widthOf(page, ".daw-main-col");

    await dragHandle(page, DRAG_WIDER);
    expect(await libraryWidth(page)).toBe(startLibrary + DRAG_WIDER);
    expect(await widthOf(page, ".daw-main-col")).toBe(startTracks - DRAG_WIDER);

    await dragHandle(page, -DRAG_NARROWER);
    const netDrag = DRAG_WIDER - DRAG_NARROWER;
    expect(await libraryWidth(page)).toBe(startLibrary + netDrag);
    expect(await widthOf(page, ".daw-main-col")).toBe(startTracks - netDrag);
  });

  test("a drag stops at the minimum and maximum widths", async ({ page }) => {
    await openWide(page);

    await dragHandle(page, DRAG_PAST_MIN);
    expect(await libraryWidth(page)).toBe(MIN_WIDTH);

    await dragHandle(page, DRAG_PAST_MAX);
    expect(await libraryWidth(page)).toBe(MAX_WIDTH);
    await expect(handleOf(page)).toHaveAttribute("aria-valuemin", String(MIN_WIDTH));
    await expect(handleOf(page)).toHaveAttribute("aria-valuemax", String(MAX_WIDTH));
  });

  test("a drag that can't change the width saves nothing", async ({ page }) => {
    await openWithNoRoom(page);
    expect(await libraryWidth(page)).toBe(MIN_WIDTH);

    await dragHandle(page, DRAG_WIDER);
    await page.waitForTimeout(PAST_ARROW_KEY_SAVE_MS);

    expect(await libraryWidth(page)).toBe(MIN_WIDTH);
    expect(await savedWidth(page)).toBeNull();
    expect(await inlineWidth(page)).toBe("");
  });

  test("an arrow key that can't change the width saves nothing", async ({ page }) => {
    await openWithNoRoom(page);
    await handleOf(page).focus();

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(PAST_ARROW_KEY_SAVE_MS);

    expect(await libraryWidth(page)).toBe(MIN_WIDTH);
    expect(await savedWidth(page)).toBeNull();
    expect(await inlineWidth(page)).toBe("");
  });

  test("a saved width too wide for the window yields to the tracks and comes back", async ({ page }) => {
    await openWide(page);
    await dragTo(page, MAX_WIDTH);

    await page.setViewportSize(SMALL_WINDOW);
    const smallMax = await squeezedWidth(page);
    await expect(handleOf(page)).toHaveAttribute("aria-valuemax", String(smallMax));
    expect(await widthOf(page, "#inspector")).toBe(SMALL_WINDOW_INSPECTOR);
    expect(await savedWidth(page)).toBe(MAX_WIDTH);

    await reload(page);
    // Room is only weighed with a song open, so the tools step aside again before they are shown.
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(page.locator("#inspector")).toBeHidden();
    await showSongTools(page);
    await expect.poll(() => libraryWidth(page)).toBe(smallMax);

    await page.setViewportSize(WIDE_WINDOW);
    await expect.poll(() => libraryWidth(page)).toBe(MAX_WIDTH);
  });

  test("the chosen width survives a reload", async ({ page }) => {
    await openWide(page);
    await dragTo(page, CUSTOM_WIDTH);

    await reload(page);

    await expect.poll(() => libraryWidth(page)).toBe(CUSTOM_WIDTH);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(CUSTOM_WIDTH));
  });

  test("a reload right after a drag keeps the width", async ({ page }) => {
    await openWide(page);

    await dragHandle(page, CUSTOM_WIDTH - (await libraryWidth(page)));
    await reload(page);

    await expect.poll(() => libraryWidth(page)).toBe(CUSTOM_WIDTH);
  });

  test("double-clicking the handle goes back to the default width, for good", async ({ page }) => {
    await openWide(page);
    const defaultWidth = await libraryWidth(page);
    await dragTo(page, CUSTOM_WIDTH);

    await handleOf(page).dblclick();

    await expect.poll(() => libraryWidth(page)).toBe(defaultWidth);
    await expect.poll(() => savedWidth(page)).toBeNull();
    await reload(page);
    await expect.poll(() => libraryWidth(page)).toBe(defaultWidth);
  });

  test("Enter goes back to the default width, even straight after an arrow key", async ({ page }) => {
    await openWide(page);
    const defaultWidth = await libraryWidth(page);
    await dragTo(page, CUSTOM_WIDTH);

    await handleOf(page).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");

    expect(await libraryWidth(page)).toBe(defaultWidth);
    await page.waitForTimeout(PAST_ARROW_KEY_SAVE_MS);
    expect(await savedWidth(page)).toBeNull();
  });

  test("collapsing hides the handle and reopening brings the width back", async ({ page }) => {
    await openWide(page);
    await dragTo(page, CUSTOM_WIDTH);
    const openTracks = await widthOf(page, ".daw-main-col");

    await collapseLibrary(page);
    await expect.poll(() => widthOf(page, ".daw-main-col")).toBe(openTracks + CUSTOM_WIDTH - STRIP_WIDTH);

    await collapseButton(page).click();
    await expect.poll(() => libraryWidth(page)).toBe(CUSTOM_WIDTH);
    await expect(handleOf(page)).toBeVisible();
    await expect.poll(() => widthOf(page, ".daw-main-col")).toBe(openTracks);
  });

  test("reopening reports a width that changed while the library was collapsed", async ({ page }) => {
    await openWide(page);
    await dragTo(page, MAX_WIDTH);

    await collapseLibrary(page);
    await page.setViewportSize(SMALL_WINDOW);
    await collapseButton(page).click();

    const smallMax = await squeezedWidth(page);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(smallMax));
  });

  test("a reload while collapsed keeps the width for reopening", async ({ page }) => {
    await openWide(page);
    await dragTo(page, CUSTOM_WIDTH);
    await collapseLibrary(page);

    await reload(page);
    await expect(page.locator(".app")).toHaveClass(/cat-collapsed/);
    await expect(handleOf(page)).toBeHidden();

    await collapseButton(page).click();
    await expect.poll(() => libraryWidth(page)).toBe(CUSTOM_WIDTH);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(CUSTOM_WIDTH));
  });

  test("Stage mode leaves a large saved width clamped to a small window", async ({ page }) => {
    await openWide(page);
    await dragTo(page, MAX_WIDTH);
    await page.setViewportSize(SMALL_WINDOW);
    const smallMax = await squeezedWidth(page);

    await page.locator("#stageModeBtn").click();
    await expect(handleOf(page)).toBeHidden();
    await nextFrames(page);
    expect(await inlineWidth(page)).toBe(`${smallMax}px`);

    await page.keyboard.press("Escape");
    await expect(handleOf(page)).toBeVisible();
    await expect.poll(() => libraryWidth(page)).toBe(smallMax);
    expect(await waveWidth(page)).toBeGreaterThanOrEqual(MIN_WAVES);
  });

  test("leaving Stage mode re-fits a window that shrank during it", async ({ page }) => {
    await openWide(page);
    await dragTo(page, MAX_WIDTH);

    await page.locator("#stageModeBtn").click();
    await expect(handleOf(page)).toBeHidden();
    await page.setViewportSize(SMALL_WINDOW);
    await page.keyboard.press("Escape");

    await expect(handleOf(page)).toBeVisible();
    const smallMax = await squeezedWidth(page);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(smallMax));
  });

  test("showing the inspector re-clamps a library sized while it was hidden", async ({ page }) => {
    await page.setViewportSize(SMALL_WINDOW);
    await openStudio(page);
    await page.evaluate(
      ([hiddenKey, hidden, widthKey, width]) => {
        localStorage.setItem(hiddenKey, hidden);
        localStorage.setItem(widthKey, String(width));
      },
      [INSPECTOR_HIDDEN_KEY, INSPECTOR_HIDDEN, STORE_KEY, MAX_WIDTH],
    );
    await reload(page);
    await expect(page.locator("#inspector")).toBeHidden();
    await expect.poll(() => libraryWidth(page)).toBe(MAX_WIDTH);

    await page.locator("#inspectorToggleBtn").click();
    await expect(page.locator("#inspector")).toBeVisible();
    await squeezedWidth(page);
  });

  test("the handle is reached with Tab and sized with the arrow keys", async ({ page }) => {
    await openWide(page);
    const handle = handleOf(page);
    await expect(handle).toHaveAttribute("role", "separator");
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-label", "Resize sidebar");

    await collapseButton(page).focus();
    const handleFocused = () => handle.evaluate((el) => el === document.activeElement);
    for (let i = 0; i < TAB_LIMIT && !(await handleFocused()); i++) await page.keyboard.press("Tab");
    expect(await handleFocused()).toBe(true);

    const start = await libraryWidth(page);
    await page.keyboard.press("ArrowRight");
    expect(await libraryWidth(page)).toBe(start + KEYBOARD_STEP);
    await expect(handle).toHaveAttribute("aria-valuenow", String(start + KEYBOARD_STEP));

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect(await libraryWidth(page)).toBe(start + KEYBOARD_STEP);
    await expect.poll(() => savedWidth(page)).toBe(start + KEYBOARD_STEP);
  });

  test("the arrow keys stop at the minimum and maximum widths", async ({ page }) => {
    await openWide(page);
    await handleOf(page).focus();
    const pressesAcross = (distance) => Math.ceil(distance / KEYBOARD_STEP) + 1;

    await pressRepeatedly(page, "ArrowLeft", pressesAcross((await libraryWidth(page)) - MIN_WIDTH));
    expect(await libraryWidth(page)).toBe(MIN_WIDTH);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(MIN_WIDTH));

    await pressRepeatedly(page, "ArrowRight", pressesAcross(MAX_WIDTH - MIN_WIDTH));
    expect(await libraryWidth(page)).toBe(MAX_WIDTH);
    await expect(handleOf(page)).toHaveAttribute("aria-valuenow", String(MAX_WIDTH));
  });
});
