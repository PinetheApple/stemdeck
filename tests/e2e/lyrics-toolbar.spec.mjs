// The Lyrics tab's actions as one toolbar of buttons (#31), with the server's
// lyrics endpoints stubbed. What each action does in depth is in its own spec.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  LYRICS_LOOKUP,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

const JSON_TYPE = "application/json";
const NARROW = { width: 1024, height: 768 };
const WIDE = { width: 1600, height: 900 };
const SUBPIXEL = 0.5;
const ACTIONS = ["Sync lines", "Align", "Edit lines", "Paste or load lyrics", "Remove lyrics"];
const found = (extra = {}) => ({
  v: 1,
  source: "lrclib",
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "Studio",
  duration: 6,
  synced: "[00:00.50] Server one\n[00:02.00] Server two",
  plain: "Server one\nServer two",
  instrumental: false,
  lrclib_id: 201,
  others: [],
  ...extra,
});

const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });

async function setUp(page, { server = found(), viewport = WIDE } = {}) {
  const kept = { lyrics: server };
  const deletes = [];
  await page.route(LYRICS_LOOKUP, (route) => answer(route, 502, { detail: "lyrics service unreachable" }));
  await page.route(`**/api/jobs/${JOB_ID}/lyrics`, (route) => answer(route, 200, kept.lyrics));
  await page.route(`**/api/jobs/${JOB_ID}/lyrics/user-text`, (route) => {
    deletes.push(route.request().method());
    kept.lyrics = found();
    return answer(route, 200, kept.lyrics);
  });
  await page.route(`**/api/jobs/${JOB_ID}/vocal-envelope`, (route) => answer(route, 404, { detail: "no vocals" }));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, null);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, "E2E Fixture Track"), audioTags: { artist: "Fixture Band", title: "Fixture Song" } },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "E2E Fixture Track (again)"),
    },
  });
  await page.setViewportSize(viewport);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await expect(page.locator(".app")).not.toHaveClass(/no-track/, { timeout: 15000 });
  await page.locator(".rail-lyrics").click();
  await expect(page.locator(".lyrics-line").first()).toHaveText("Server one");
  return { deletes };
}

const toolbar = (page) => page.locator(".lyrics-tools");
const tool = (page, name) => toolbar(page).locator(".lyrics-tool", { hasText: name });
const visibleTools = (page) => toolbar(page).locator(".lyrics-tool:visible");

test.describe("the lyrics toolbar", () => {
  test("holds every action as a button with an icon, the main one filled and Remove quiet and last", async ({ page }) => {
    await setUp(page);
    await expect(toolbar(page)).toHaveCount(1);
    await expect(toolbar(page)).toHaveAttribute("role", "group");
    await expect(toolbar(page)).toHaveAttribute("aria-label", "Lyrics actions");
    await expect(visibleTools(page)).toHaveCount(ACTIONS.length);
    for (const name of ACTIONS) {
      await expect(tool(page, name).locator("svg.ic")).toHaveCount(1);
      await expect(tool(page, name)).toHaveCSS("cursor", "pointer");
    }
    await expect(page.locator(".lyrics-link:visible")).toHaveCount(0);
    await expect(tool(page, "Sync lines")).toHaveClass(/lyrics-tool-primary/);
    await expect(tool(page, "Remove lyrics")).toHaveClass(/lyrics-tool-quiet/);
    const boxes = await Promise.all(ACTIONS.map((name) => tool(page, name).boundingBox()));
    const last = boxes.at(-1);
    expect(boxes.every((box) => box.y < last.y || (box.y === last.y && box.x <= last.x))).toBe(true);
  });

  test("each button still does its job", async ({ page }) => {
    await setUp(page);
    await tool(page, "Sync lines").click();
    await expect(page.locator("#lyricsSync")).toBeVisible();
    await expect(tool(page, "Sync lines")).toHaveAttribute("aria-expanded", "true");
    await tool(page, "Sync lines").click();
    await expect(page.locator("#lyricsSync")).toHaveCount(0);

    await tool(page, "Align").click();
    await expect(page.locator("#lyricsAlign")).toBeVisible();
    await tool(page, "Align").click();
    await expect(page.locator("#lyricsAlign")).toHaveCount(0);

    await tool(page, "Edit lines").click();
    await expect(page.locator(".lyrics-edit-input")).toHaveCount(2);
    await page.locator("#lyricsEditor").getByRole("button", { name: "Cancel", exact: true }).click();
    await tool(page, "Paste or load lyrics").click();
    await expect(page.locator(".lyrics-paste")).toBeVisible();
    await page.locator("#lyricsEditor").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(toolbar(page)).toBeVisible();
  });

  test("Back to original is a quiet button that drops the user's lyrics", async ({ page }) => {
    const { deletes } = await setUp(page, { server: found({ source: "user", lrclib_id: null, has_original: true }) });
    const back = tool(page, "Back to original");
    await expect(back).toHaveClass(/lyrics-tool-quiet/);
    await back.click();
    await expect(page.locator(".lyrics-match-meta")).toHaveText("Fixture Band · Studio");
    expect(deletes).toEqual(["DELETE"]);
  });

  test("wraps inside the sidebar at 1024 px", async ({ page }) => {
    await setUp(page, { viewport: NARROW });
    const bar = await toolbar(page).boundingBox();
    const panel = await page.locator("#lyricsPanel").boundingBox();
    expect(bar.x + bar.width).toBeLessThanOrEqual(panel.x + panel.width + SUBPIXEL);
    const boxes = await visibleTools(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBeGreaterThan(1);
    for (const box of boxes) expect(box.right).toBeLessThanOrEqual(bar.x + bar.width + SUBPIXEL);
  });
});
