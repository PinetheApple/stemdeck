// Selects open StemDeck's own list (static/js/selectMenu.js) instead of the
// browser's grey system list, while the <select> itself stays the source of
// truth that the rest of the app reads and writes.

import { test, expect } from "@playwright/test";
import { openClickOptions, openStudio, seedLibrary, waitForClickTrack } from "./helpers.mjs";

const SETTINGS_URL = /\/api\/settings$/;
const FRUITS = ["Apple", "Banana", "Blueberry", "Cherry (out of season)", "Damson"];
const DISABLED_FRUIT = "Cherry (out of season)";
const NEAR_BOTTOM_PX = 40;

const list = (page) => page.locator("#select-menu-list");

/** A select of fruits pinned `bottom` px above the window's bottom edge (or
 * near the top), counting the change events the app would see. */
async function addFruitSelect(page, { bottom = null } = {}) {
  await page.evaluate(({ fruits, disabledFruit, bottom }) => {
    const select = document.createElement("select");
    select.id = "fruit";
    select.setAttribute("aria-label", "Fruit");
    select.style.cssText = `position: fixed; left: 40px; z-index: 5; ${bottom === null ? "top: 40px" : `bottom: ${bottom}px`}`;
    for (const name of fruits) {
      const option = new Option(name, name.toLowerCase());
      option.disabled = name === disabledFruit;
      select.append(option);
    }
    window.fruitChanges = 0;
    select.addEventListener("change", function countChange() { window.fruitChanges++; });
    document.body.append(select);
  }, { fruits: FRUITS, disabledFruit: DISABLED_FRUIT, bottom });
  return page.locator("#fruit");
}

async function openApp(page) {
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

const fruitChanges = (page) => page.evaluate(() => window.fruitChanges);
const focusedId = (page) => page.evaluate(() => document.activeElement?.id);

test.describe("select lists", () => {
  test("a click opens StemDeck's styled list, not the browser's", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.click();

    await expect(list(page)).toBeVisible();
    await expect(list(page)).toHaveAttribute("role", "listbox");
    await expect(list(page).getByRole("option")).toHaveText(FRUITS);
    await expect(fruit).toHaveAttribute("aria-expanded", "true");
    const surface = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--surface-2)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
    await expect(list(page)).toHaveCSS("background-color", surface);

    await list(page).getByRole("option", { name: "Banana" }).click();
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("banana");
    expect(await fruitChanges(page)).toBe(1);
    expect(await focusedId(page)).toBe("fruit");
  });

  test("arrows, type-ahead and Enter pick; Escape closes and keeps focus", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.focus();

    await page.keyboard.press("ArrowDown");
    await expect(list(page)).toBeVisible();
    await expect(list(page).getByRole("option", { name: "Apple" })).toHaveClass(/active/);
    await page.keyboard.press("End");
    await expect(list(page).getByRole("option", { name: "Damson" })).toHaveClass(/active/);
    await page.keyboard.press("ArrowUp");
    await expect(list(page).getByRole("option", { name: "Blueberry" })).toHaveClass(/active/);
    await page.keyboard.press("Home");
    await page.keyboard.type("bl");
    await expect(list(page).getByRole("option", { name: "Blueberry" })).toHaveClass(/active/);
    await expect(fruit).toHaveAttribute("aria-activedescendant", await list(page).getByRole("option", { name: "Blueberry" }).getAttribute("id"));

    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("apple");
    expect(await focusedId(page)).toBe("fruit");

    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("banana");
    expect(await fruitChanges(page)).toBe(1);
  });

  test("a disabled option is skipped and cannot be picked", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.selectOption("blueberry");
    await page.evaluate(() => { window.fruitChanges = 0; });
    await fruit.click();

    const cherry = list(page).getByRole("option", { name: DISABLED_FRUIT });
    await expect(cherry).toHaveAttribute("aria-disabled", "true");
    await cherry.click({ force: true });
    await expect(list(page)).toBeVisible();
    await expect(fruit).toHaveValue("blueberry");

    await page.keyboard.press("ArrowDown");
    await expect(list(page).getByRole("option", { name: "Damson" })).toHaveClass(/active/);
    await page.keyboard.press("Home");
    await page.keyboard.type("c");
    await expect(list(page).getByRole("option", { name: "Apple" })).toHaveClass(/active/);
    expect(await fruitChanges(page)).toBe(0);
  });

  test("near the bottom edge the list opens upward, inside the window", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page, { bottom: NEAR_BOTTOM_PX });
    await fruit.click();

    const select = await fruit.boundingBox();
    const box = await list(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box.y + box.height).toBeLessThanOrEqual(select.y);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  });

  test("the list follows the select's value, and the select follows the list", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await page.evaluate(() => { document.querySelector("#fruit").value = "damson"; });
    await fruit.click();
    await expect(list(page).getByRole("option", { selected: true })).toHaveText("Damson");
    await expect(list(page).getByRole("option", { name: "Damson" })).toHaveClass(/active/);

    await list(page).getByRole("option", { name: "Apple" }).click();
    expect(await page.evaluate(() => document.querySelector("#fruit").value)).toBe("apple");
    expect(await page.evaluate(() => document.querySelector("#fruit").selectedOptions[0].text)).toBe("Apple");
  });

  test("options the app rebuilds while the list is open show at once", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(SETTINGS_URL, async function holdSettings(route) {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const settings = await response.json();
      await held;
      await route.fulfill({ response, json: { ...settings, demucs_device: "auto", demucs_devices_available: ["cpu"] } });
    });
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const device = page.locator(".set-demucs-device");
    await device.click();
    await expect(list(page).getByRole("option", { name: "CUDA (NVIDIA)", exact: true })).not.toHaveAttribute("aria-disabled", "true");

    release();
    await expect(list(page).getByRole("option", { name: /^CUDA \(NVIDIA\).+/ })).toHaveAttribute("aria-disabled", "true");
    await expect(list(page)).toBeVisible();
  });

  test("Escape closes only the list, not Settings around it", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const quality = page.locator(".set-separation-quality");
    await quality.click();
    await expect(list(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
    await expect(quality).toBeVisible();
    await expect(quality).toBeFocused();
  });

  test("picking Custom accent in the Tempo tab reveals the beats field", async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page);
    await openClickOptions(page);
    await page.locator("#t-metro-bar").click();
    await list(page).getByRole("option", { name: "Custom..." }).click();
    await expect(page.locator("#t-metro-bar")).toHaveValue("custom");
    await expect(page.locator("#t-metro-bar-custom")).toBeVisible();
  });
});
