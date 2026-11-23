// The desktop shell: one 52px top bar, a sidebar that collapses to a strip of
// covers with its views, song tools that hide, and every library view reachable.

import { test, expect } from "@playwright/test";
import { JOB_ID, MIN_TIMELINE_WIDTH, openStudio, uiText, waitForPanesSettled } from "./helpers.mjs";

const TOP_BAR_HEIGHT = 52;
const STRIP_WIDTH = 64;
const TOP_BAR_ORDER = [
  "#sidebarCollapseBtn",
  ".topbar-brand",
  "#addSongBtn",
  "#notifBtn",
  "#helpModeBtn",
  "#aboutBtn",
  "#settingsBtn",
  "#inspectorToggleBtn",
];
const QUEUED_ID = "e2e0q0000001";
const SMALL_WINDOWS = [
  { name: "1366x768", size: { width: 1366, height: 768 }, collapsed: false },
  { name: "1024x768 with the sidebar collapsed", size: { width: 1024, height: 768 }, collapsed: true },
];
const SHELL_CONTROLS = [...TOP_BAR_ORDER, ".lib-nav-library", ".lib-nav-favorites", ".lib-nav-trash"];

const reload = (page) => page.reload({ waitUntil: "domcontentloaded" });
const boxOf = (page, selector) => page.locator(selector).first().boundingBox();

async function stubQueue(page, queued) {
  const job = (id) => ({ job_id: id, status: "queued", title: id, source_url: "https://example.com/a" });
  await page.route("**/api/queue", (route) => route.fulfill({ json: { running: null, queued: queued.map(job), paused: false } }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("top bar", () => {
  test("is one 52px row, in order, with no icon rail left", async ({ page }) => {
    await openStudio(page);
    const bar = await boxOf(page, "#topbar");
    expect(bar.height).toBe(TOP_BAR_HEIGHT);
    await expect(page.locator(".sidebar-rail")).toHaveCount(0);
    let left = -1;
    for (const selector of TOP_BAR_ORDER) {
      const box = await boxOf(page, selector);
      expect(box.x, selector).toBeGreaterThan(left);
      expect(box.y, selector).toBeGreaterThanOrEqual(bar.y);
      expect(box.y + box.height, selector).toBeLessThanOrEqual(bar.y + bar.height);
      left = box.x;
    }
  });

  test("shows Importing N while imports run, and it opens the import queue", async ({ page }) => {
    await openStudio(page);
    await expect(page.locator("#importingBtn")).toBeHidden();
    await stubQueue(page, [QUEUED_ID]);
    await expect(page.locator("#importingBtn")).toBeVisible();
    await expect(page.locator("#importingBtn")).toHaveText(await uiText(page, "shell.importing", { count: 1 }));
    await page.locator("#importingBtn").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/queue-view/);
  });

  test("Add song opens and closes today's import bar", async ({ page }) => {
    await openStudio(page);
    const addSong = page.locator("#addSongBtn");
    await expect(page.locator("#url")).toBeHidden();
    await expect(addSong).toHaveAttribute("aria-expanded", "false");
    await addSong.click();
    await expect(page.locator("#url")).toBeVisible();
    await expect(page.locator("#url")).toBeFocused();
    await expect(addSong).toHaveAttribute("aria-expanded", "true");
    await addSong.click();
    await expect(page.locator("#url")).toBeHidden();
  });
});

test("every icon-only top-bar button has a tooltip and an accessible name", async ({ page }) => {
  await openStudio(page);
  for (const selector of TOP_BAR_ORDER.filter((s) => s.startsWith("#") && s !== "#addSongBtn")) {
    const button = page.locator(selector);
    await expect(button, selector).toHaveAttribute("title", /\S/);
    await expect(button, selector).toHaveAttribute("aria-label", /\S/);
  }
  await expect(page.locator("#aboutBtn")).toHaveAttribute("aria-label", await uiText(page, "nav.about"));
});

test.describe("sidebar and song tools toggles", () => {
  test("the sidebar collapses to a 64px strip of covers, and stays so after a reload", async ({ page }) => {
    await openStudio(page);
    const toggle = page.locator("#sidebarCollapseBtn");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await boxOf(page, "#catalogPanel")).width).toBe(STRIP_WIDTH);
    await expect(page.locator(`#catalogStrip .strip-thumb[data-id="${JOB_ID}"]`).first()).toBeVisible();
    for (const view of ["library", "favorites", "trash"]) {
      await expect(page.locator(`.strip-nav-${view}`)).toHaveAttribute("aria-label", /\S/);
    }
    await reload(page);
    await expect(page.locator("#sidebarCollapseBtn")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await boxOf(page, "#catalogPanel")).width).toBe(STRIP_WIDTH);
  });

  test("the song-tools toggle hides the right panel, shows it, and is remembered", async ({ page }) => {
    await openStudio(page);
    const toggle = page.locator("#inspectorToggleBtn");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.locator("#inspector")).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await reload(page);
    await expect(page.locator("#inspector")).toBeHidden();
    await expect(page.locator("#inspectorToggleBtn")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#inspectorToggleBtn").click();
    await expect(page.locator("#inspector")).toBeVisible();
  });
});

test.describe("the rail's views are still reachable", () => {
  test("Favorites, Trash and back to the library from the sidebar", async ({ page }) => {
    await openStudio(page);
    const panel = page.locator("#catalogPanel");
    await page.locator(".lib-nav-favorites").click();
    await expect(panel).toHaveClass(/favorites-view/);
    await expect(page.locator(".lib-nav-favorites")).toHaveAttribute("aria-pressed", "true");
    await page.locator(".lib-nav-trash").click();
    await expect(panel).toHaveClass(/trash-view/);
    await page.locator(".lib-nav-library").click();
    await expect(panel).not.toHaveClass(/trash-view|favorites-view/);
  });

  test("Favorites, Trash and the queue from a collapsed sidebar, which opens on that view", async ({ page }) => {
    await openStudio(page);
    await page.locator("#sidebarCollapseBtn").click();
    await expect(page.locator(".strip-nav-queue")).toBeHidden();
    await page.locator(".strip-nav-favorites").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/favorites-view/);
    await expect(page.locator("#sidebarCollapseBtn")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#sidebarCollapseBtn").click();
    await page.locator(".strip-nav-trash").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/trash-view/);
    await page.locator("#sidebarCollapseBtn").click();
    await stubQueue(page, [QUEUED_ID]);
    await page.locator(".strip-nav-queue").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/queue-view/);
  });

  test("the import queue from the sidebar while imports run", async ({ page }) => {
    await openStudio(page);
    await expect(page.locator(".lib-nav-queue")).toBeHidden();
    await stubQueue(page, [QUEUED_ID]);
    await page.locator(".lib-nav-queue").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/queue-view/);
  });

  test("Lyrics from the song tools, opening a collapsed sidebar", async ({ page }) => {
    await openStudio(page);
    await page.locator("#sidebarCollapseBtn").click();
    await page.locator("#songToolsLyricsBtn").click();
    await expect(page.locator("#catalogPanel")).toHaveClass(/lyrics-view/);
    await expect(page.locator("#lyricsPanel")).toBeVisible();
    await expect(page.locator("#songToolsLyricsBtn")).toHaveAttribute("aria-pressed", "true");
  });

  test("About from the top bar", async ({ page }) => {
    await openStudio(page);
    await page.locator("#topbar #aboutBtn").click();
    await expect(page.locator("#aboutDialog")).toBeVisible();
  });
});

test.describe("small windows", () => {
  for (const { name, size, collapsed } of SMALL_WINDOWS) {
    test(`at ${name} nothing is cut off or overlaps`, async ({ page }) => {
      await page.setViewportSize(size);
      await openStudio(page);
      const isCollapsed = await page.locator(".app").evaluate((el) => el.classList.contains("cat-collapsed"));
      if (collapsed !== isCollapsed) await page.locator("#sidebarCollapseBtn").click();
      const boxes = [];
      for (const selector of SHELL_CONTROLS) {
        const target = page.locator(selector).first();
        if (!(await target.isVisible())) continue;
        const box = await target.boundingBox();
        expect(box.x, selector).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, selector).toBeLessThanOrEqual(size.width);
        expect(box.y + box.height, selector).toBeLessThanOrEqual(size.height);
        for (const other of boxes) expect(overlaps(box, other.box), `${selector} / ${other.selector}`).toBe(false);
        boxes.push({ selector, box });
      }
      const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      expect(scroll.w).toBeLessThanOrEqual(size.width);
      expect(scroll.h).toBeLessThanOrEqual(size.height);
      const footer = await boxOf(page, "#footer");
      expect(footer.y + footer.height).toBeLessThanOrEqual(size.height);
      await waitForPanesSettled(page);
      await expect.poll(async () => (await boxOf(page, ".daw-wave-panel")).width).toBeGreaterThanOrEqual(MIN_TIMELINE_WIDTH);
    });
  }
});
