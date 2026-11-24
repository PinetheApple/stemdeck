// View > Sections bar governs the sections bar, not the library. Whatever it
// puts away it can bring back, and the library has its own control (#588).
import { test, expect } from "@playwright/test";
import { openStudio, openViewMenu } from "./helpers.mjs";

const PANELS = ["sections"];

const state = (page) =>
  page.evaluate((panels) => {
    const app = document.querySelector(".app");
    return {
      hidden: panels.filter((n) => app.classList.contains(`panel-${n}-off`)),
      libraryCollapsed: app.classList.contains("cat-collapsed"),
      buttons: [...document.querySelectorAll("#viewPanel .daw-panel-toggle")].map((b) => b.textContent.trim()),
    };
  }, PANELS);

async function clickPanel(page, name) {
  await openViewMenu(page);
  await page.locator(`#viewPanel .daw-panel-toggle[data-panel="${name}"]`).click();
}

test.describe("View panel toggles", () => {
  test("View's panel toggles are the panels it governs, and nothing else", async ({ page }) => {
    await openStudio(page, { tauri: true });

    expect((await state(page)).buttons).toEqual(["Sections bar"]);
  });

  test("every panel it puts away, it can bring back", async ({ page }) => {
    await openStudio(page, { tauri: true });
    expect((await state(page)).hidden).toEqual([]);

    for (const name of PANELS) await clickPanel(page, name);
    expect((await state(page)).hidden).toEqual(PANELS);

    // The way back is the same button. Collapsing to nothing is only safe
    // because of this.
    for (const name of PANELS) await clickPanel(page, name);
    expect((await state(page)).hidden).toEqual([]);
  });

  test("it leaves the library alone in both directions", async ({ page }) => {
    await openStudio(page, { tauri: true });
    expect((await state(page)).libraryCollapsed).toBe(false);

    for (const name of PANELS) await clickPanel(page, name);
    // The bug was that the library went with them and this row could not
    // return it (#588).
    expect((await state(page)).libraryCollapsed).toBe(false);
  });

  test("collapsing the library does not disturb the panels", async ({ page }) => {
    // The library's class lands on the same element the panels' classes do, so
    // this is the check that the two are genuinely independent rather than
    // accidentally not colliding.
    await openStudio(page, { tauri: true });
    await clickPanel(page, "sections");

    await page.locator("#sidebarCollapseBtn").click();
    await expect.poll(async () => (await state(page)).libraryCollapsed).toBe(true);

    expect((await state(page)).hidden).toEqual(["sections"]);
  });

  test("a collapsed panel survives a reload", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await clickPanel(page, "sections");
    expect((await state(page)).hidden).toEqual(["sections"]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await state(page)).hidden).toEqual(["sections"]);
  });
});
