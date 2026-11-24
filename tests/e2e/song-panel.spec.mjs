// The right panel's song tools: Lyrics, Up Next, Tempo, EQ and Details as tabs, the
// ones that don't fit in More, Lyrics first, the last tab remembered.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, TAB_STORE_KEY, fixtureTrack, openStudio, uiText } from "./helpers.mjs";

const WIDE_WINDOW = { width: 1600, height: 900 };
const TAB_ORDER = ["lyrics", "upnext", "tempo", "eq", "details"];
const WIDE_TAB_PADDING = "#inspector .inspector-tab { padding-inline: 48px !important; }";
const LRCLIB = /^https:\/\/lrclib\.net\//;
const LINE_COUNT = 40;
const LINE_STEP_S = 0.14;
const CLICKED_LINE = 3;
const SEEK_TOLERANCE_S = 0.05;
const LATE_SEEK_S = 5.6;

const tab = (page, name) => page.locator(`.inspector-tab[data-tab="${name}"]`);
const pane = (page, name) => page.locator(`.inspector-pane[data-pane="${name}"]`);
const moreBtn = (page) => page.locator("#inspectorMoreBtn");
const moreMenu = (page) => page.locator('.lib-menu[role="menu"]');
const lane = (page) => page.locator("#lyricsLane");
const syncPanel = (page) => page.locator("#lyricsSync");
const syncToggle = (page) => page.locator(".lyrics-tools .lyrics-sync-toggle");
const hiddenTabs = (page) =>
  page.locator(".inspector-tab[data-tab]").evaluateAll((tabs) => tabs.filter((t) => t.hidden).map((t) => t.dataset.tab));

const stampOf = (seconds) => {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `[${minutes}:${(seconds % 60).toFixed(2).padStart(5, "0")}]`;
};
const LINES = Array.from({ length: LINE_COUNT }, (_, i) => ({ text: `Line ${i + 1}`, at: i * LINE_STEP_S }));
const LYRICS = {
  v: 1,
  source: "lrclib",
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "Studio",
  duration: 6,
  synced: LINES.map(({ text, at }) => `${stampOf(at)} ${text}`).join("\n"),
  plain: LINES.map(({ text }) => text).join("\n"),
  instrumental: false,
  lrclib_id: 301,
  timing: "exact",
  others: [],
};

const CATALOG = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), audioTags: { artist: "Fixture Band", title: "Fixture Song" } },
    [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
  },
};

async function openWithLyrics(page) {
  await page.route(LRCLIB, (route) => route.abort("internetdisconnected"));
  await page.route(`**/api/jobs/${JOB_ID}/lyrics`, (route) => route.fulfill({ status: 200, json: LYRICS }));
  await page.route(`**/api/jobs/${JOB_ID}/lyrics/user-synced`, (route) => route.fulfill({ status: 200, json: {} }));
  await page.setViewportSize(WIDE_WINDOW);
  await openStudio(page, { catalog: CATALOG });
  await expect(page.locator("#lyricsBody .lyrics-line")).toHaveCount(LINE_COUNT);
}

async function openWideTabs(page) {
  await page.addInitScript((css) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
    });
  }, WIDE_TAB_PADDING);
  await page.setViewportSize(WIDE_WINDOW);
  await openStudio(page);
  await expect(moreBtn(page)).toBeVisible();
}

const playheadSeconds = (page) =>
  page.evaluate(async () => (await import("/js/transport.js")).transport().getCurrentTime());

test.describe("song tools panel", () => {
  test("its tabs are Lyrics, Up Next, Tempo, EQ and Details, and it first opens on Lyrics", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page);
    const names = await page.locator(".inspector-tab[data-tab]").evaluateAll((tabs) => tabs.map((t) => t.dataset.tab));
    expect(names).toEqual(TAB_ORDER);
    await expect(tab(page, "lyrics")).toHaveText(await uiText(page, "lyrics.title"));
    await expect(tab(page, "lyrics")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#inspector #lyricsPanel")).toBeVisible();
    await expect(page.locator("#catalogList")).toBeVisible();
    await expect(page.locator("#songToolsLyricsBtn")).toHaveCount(0);
    await expect(page.locator("#upNextCount")).toHaveCount(1);
    await expect(tab(page, "upnext").locator("#upNextCount")).toHaveCount(1);
  });

  test("the last tab is remembered", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page);
    await tab(page, "tempo").click();
    await expect(pane(page, "tempo")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TAB_STORE_KEY)).toContain("tempo");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(tab(page, "tempo")).toHaveAttribute("aria-selected", "true");
    await expect(pane(page, "lyrics")).toBeHidden();
  });

  test("← and → move between the tabs, round the ends", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page);
    await tab(page, "lyrics").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "upnext")).toBeFocused();
    await expect(tab(page, "upnext")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "upnext")).toHaveAttribute("tabindex", "0");
    await expect(tab(page, "lyrics")).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "details")).toBeFocused();
    await expect(pane(page, "details")).toBeVisible();
  });

  test("the Up Next tab opens from elsewhere in the app, showing the panel", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page);
    await page.locator("#inspectorToggleBtn").click();
    await expect(page.locator("#inspector")).toBeHidden();
    await page.evaluate(async () => (await import("/js/inspector.js")).openInspectorTab("upnext"));
    await expect(pane(page, "upnext")).toBeVisible();
    await expect(page.locator("#inspectorToggleBtn")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("tabs that don't fit", () => {
  test("move into More; the open tab stays out, and More picks one", async ({ page }) => {
    await openWideTabs(page);
    const inMore = await hiddenTabs(page);
    expect(inMore.length).toBeGreaterThan(0);
    expect(inMore).not.toContain("lyrics");
    await expect(tab(page, "lyrics")).toBeVisible();
    const labels = await Promise.all(inMore.map((name) => tab(page, name).locator("[data-i18n]").textContent()));
    for (const label of labels) await expect(moreBtn(page)).toHaveAttribute("title", new RegExp(label.trim()));
    await expect(moreBtn(page)).toHaveAttribute("aria-haspopup", "menu");

    await moreBtn(page).click();
    await expect(moreMenu(page)).toBeVisible();
    await expect(moreBtn(page)).toHaveAttribute("aria-expanded", "true");
    const items = moreMenu(page).locator('[role="menuitem"]');
    await expect(items).toHaveCount(inMore.length);
    const last = inMore.at(-1);
    await items.nth(inMore.length - 1).click();
    await expect(moreMenu(page)).toBeHidden();
    await expect(tab(page, last)).toBeVisible();
    await expect(tab(page, last)).toHaveAttribute("aria-selected", "true");
    await expect(pane(page, last)).toBeVisible();
  });

  test("Esc closes More, and → brings out a tab that was in it", async ({ page }) => {
    await openWideTabs(page);
    await moreBtn(page).click();
    await expect(moreMenu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(moreMenu(page)).toBeHidden();
    await expect(moreBtn(page)).toBeFocused();

    const before = await hiddenTabs(page);
    await tab(page, "lyrics").focus();
    for (let step = 0; step < TAB_ORDER.length - 1; step += 1) await page.keyboard.press("ArrowRight");
    await expect(tab(page, "details")).toBeFocused();
    expect(before).toContain("details");
    await expect(tab(page, "details")).toBeVisible();
  });
});

test.describe("Lyrics tab", () => {
  test("Sync lines shows the lyric lane; another tab or hiding the panel leaves both", async ({ page }) => {
    await openWithLyrics(page);
    await syncToggle(page).click();
    await expect(syncPanel(page)).toBeVisible();
    await expect(lane(page)).toBeVisible();

    await tab(page, "tempo").click();
    await expect(lane(page)).toBeHidden();
    await tab(page, "lyrics").click();
    await expect(syncPanel(page)).toBeHidden();
    await expect(lane(page)).toBeHidden();

    await syncToggle(page).click();
    await expect(lane(page)).toBeVisible();
    await page.locator("#inspectorToggleBtn").click();
    await expect(lane(page)).toBeHidden();
    await page.locator("#inspectorToggleBtn").click();
    await expect(syncPanel(page)).toBeHidden();
  });

  test("a line click seeks there, and the sung line stays in view", async ({ page }) => {
    await openWithLyrics(page);
    await page.locator("#lyricsBody .lyrics-line").nth(CLICKED_LINE).click();
    await expect
      .poll(() => playheadSeconds(page))
      .toBeGreaterThanOrEqual(LINES[CLICKED_LINE].at - SEEK_TOLERANCE_S);
    expect(await playheadSeconds(page)).toBeLessThan(LINES[CLICKED_LINE + 1].at);

    await page.evaluate(async (s) => (await import("/js/transport.js")).setPlayheadTime(s), LATE_SEEK_S);
    const current = page.locator("#lyricsBody .lyrics-line.current");
    await expect(current).toHaveCount(1);
    await expect
      .poll(async () => {
        const line = await current.boundingBox();
        const box = await pane(page, "lyrics").boundingBox();
        return line.y >= box.y && line.y + line.height <= box.y + box.height;
      })
      .toBe(true);
  });
});
