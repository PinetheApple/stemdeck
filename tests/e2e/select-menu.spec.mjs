// Selects open StemDeck's own list (static/js/selectMenu.js) instead of the
// browser's grey system list, while the <select> stays the source of truth.

import { test, expect } from "@playwright/test";
import { openClickOptions, openStudio, seedLibrary, waitForClickTrack } from "./helpers.mjs";

const SETTINGS_URL = /\/api\/settings$/;
const FRUITS = ["Apple", "Banana", "Blueberry", "Cherry (out of season)", "Damson"];
const DISABLED_FRUIT = "Cherry (out of season)";
const NEAR_BOTTOM_PX = 40;
const SCROLLED_PAST_PX = 400;
const LONG_LIST_SIZE = 25;
const itemName = (n) => `Item ${String(n).padStart(2, "0")}`;

const list = (page) => page.locator("#select-menu-list");
const option = (page, name) => list(page).getByRole("option", { name, exact: true });

/** A select of fruits pinned near the top, or `bottom` px above the window's
 * bottom edge, counting the change events the app would see. */
async function addFruitSelect(page, { bottom = null } = {}) {
  await page.evaluate(({ fruits, disabledFruit, bottom }) => {
    const select = document.createElement("select");
    select.id = "fruit";
    select.setAttribute("aria-label", "Fruit");
    const edge = bottom === null ? "top: 40px" : `bottom: ${bottom}px`;
    select.style.cssText = `position: fixed; left: 40px; z-index: 5; ${edge}`;
    for (const name of fruits) {
      const choice = new Option(name, name.toLowerCase());
      choice.disabled = name === disabledFruit;
      select.append(choice);
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
const focused = (page) => page.evaluate(() => document.activeElement?.id);
/** The select's text box (its content edge) against the caret's left edge,
 * which sits --caret-inset + --caret-w in from the padding box's right. */
const textClearOfCaret = (select) => select.evaluate((el) => {
  const style = getComputedStyle(el);
  const probe = document.createElement("div");
  probe.style.width = "calc(var(--caret-inset) + var(--caret-w))";
  document.body.append(probe);
  const caretReach = probe.getBoundingClientRect().width;
  probe.remove();
  const paddingBoxRight = el.getBoundingClientRect().right - parseFloat(style.borderRightWidth);
  const textRight = paddingBoxRight - parseFloat(style.paddingRight);
  return caretReach > 0 && textRight <= paddingBoxRight - caretReach;
});
const isPlaying = (page) => page.evaluate(async () => (await import("/js/state.js")).audioEngine.isPlaying());

test.describe("select lists", () => {
  test("a click opens StemDeck's styled list, focused, and a pick hands focus back", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.click();

    await expect(list(page)).toBeVisible();
    await expect(list(page)).toHaveAttribute("role", "listbox");
    await expect(list(page)).toHaveAttribute("aria-label", "Fruit");
    await expect(list(page)).toBeFocused();
    await expect(list(page).getByRole("option")).toHaveText(FRUITS);
    await expect(option(page, "Apple")).toHaveAttribute("aria-selected", "true");
    await expect(list(page)).toHaveAttribute("aria-activedescendant", await option(page, "Apple").getAttribute("id"));
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

    await option(page, "Banana").click();
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("banana");
    await expect(fruit).toHaveAttribute("aria-expanded", "false");
    expect(await fruitChanges(page)).toBe(1);
    expect(await focused(page)).toBe("fruit");
  });

  test("open-list keys move, type-ahead and pick; Escape closes back to the select", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.focus();

    await page.keyboard.press("Enter");
    await expect(list(page)).toBeFocused();
    await expect(option(page, "Apple")).toHaveClass(/active/);
    await page.keyboard.press("End");
    await expect(option(page, "Damson")).toHaveClass(/active/);
    await page.keyboard.press("ArrowUp");
    await expect(option(page, "Blueberry")).toHaveClass(/active/);
    await page.keyboard.press("PageUp");
    await expect(option(page, "Apple")).toHaveClass(/active/);
    await page.keyboard.type("bl");
    await expect(option(page, "Blueberry")).toHaveClass(/active/);
    await expect(list(page)).toHaveAttribute("aria-activedescendant", await option(page, "Blueberry").getAttribute("id"));

    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("apple");
    expect(await focused(page)).toBe("fruit");

    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toHaveValue("banana");
    expect(await fruitChanges(page)).toBe(1);
    expect(await focused(page)).toBe("fruit");
  });

  test("F4 opens the list and F4 closes it again", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.focus();
    await page.keyboard.press("F4");
    await expect(list(page)).toBeFocused();
    await page.keyboard.press("F4");
    await expect(list(page)).toHaveCount(0);
    await expect(fruit).toBeFocused();
  });

  test("PageDown and PageUp move a page, not to the ends", async ({ page }) => {
    await openApp(page);
    await page.evaluate(({ size, names }) => {
      const select = document.createElement("select");
      select.id = "long";
      select.style.cssText = "position: fixed; top: 40px; left: 40px; z-index: 5";
      for (let n = 1; n <= size; n++) select.append(new Option(names[n - 1], String(n)));
      select.value = "5";
      document.body.append(select);
    }, { size: LONG_LIST_SIZE, names: Array.from({ length: LONG_LIST_SIZE }, (_, i) => itemName(i + 1)) });
    await page.locator("#long").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("PageDown");
    await expect(option(page, itemName(15))).toHaveClass(/active/);
    await page.keyboard.press("PageUp");
    await expect(option(page, itemName(5))).toHaveClass(/active/);
  });

  test("letters on a closed select type ahead natively, and shortcut letters still reach the app", async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page);
    await openClickOptions(page);
    const accent = page.locator("#t-metro-bar");
    await accent.focus();
    await page.keyboard.press("3");
    await expect(accent).toHaveValue("3");
    await expect(list(page)).toHaveCount(0);
    await expect(page.locator("#t-loop")).not.toHaveClass(/active/);
    await page.keyboard.press("l");
    await expect(page.locator("#t-loop")).toHaveClass(/active/);
    await expect(list(page)).toHaveCount(0);
  });

  test("on a closed select the arrows step the value, as a native one does", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(fruit).toHaveValue("blueberry");
    await page.keyboard.press("ArrowDown");
    await expect(fruit).toHaveValue("damson");
    await expect(list(page)).toHaveCount(0);
    expect(await fruitChanges(page)).toBe(3);
  });

  test("a disabled option is skipped and cannot be picked", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.selectOption("blueberry");
    await page.evaluate(() => { window.fruitChanges = 0; });
    await fruit.click();

    const cherry = option(page, DISABLED_FRUIT);
    await expect(cherry).toHaveAttribute("aria-disabled", "true");
    await cherry.click({ force: true });
    await expect(list(page)).toBeVisible();
    await expect(fruit).toHaveValue("blueberry");

    await page.keyboard.press("ArrowDown");
    await expect(option(page, "Damson")).toHaveClass(/active/);
    await page.keyboard.press("Home");
    await page.keyboard.type("c");
    await expect(option(page, "Apple")).toHaveClass(/active/);
    expect(await fruitChanges(page)).toBe(0);
  });

  test("near the bottom edge the list opens upward, inside the window", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page, { bottom: NEAR_BOTTOM_PX });
    await fruit.click();

    const select = await fruit.boundingBox();
    const box = await list(page).boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(select.y);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  });

  test("a value set by code shows in the list, open or not", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await page.evaluate(() => { document.querySelector("#fruit").value = "damson"; });
    await fruit.click();
    await expect(list(page).getByRole("option", { selected: true })).toHaveText("Damson");

    await page.evaluate(() => { document.querySelector("#fruit").value = "banana"; });
    await expect(list(page).getByRole("option", { selected: true })).toHaveText("Banana");
    await expect(option(page, "Banana")).toHaveClass(/active/);
  });

  test("the list closes when its select is removed, scrolled away or clicked off", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await fruit.click();
    await page.evaluate(() => document.querySelector("#fruit").remove());
    await expect(list(page)).toHaveCount(0);

    await page.evaluate((scrolledPast) => {
      const pane = document.createElement("div");
      pane.id = "pane";
      pane.style.cssText = "position: fixed; top: 40px; left: 40px; width: 200px; height: 120px; overflow: auto; z-index: 5";
      pane.innerHTML = `<select id="inpane"><option>One</option><option>Two</option></select><div id="spacer" style="height: ${scrolledPast * 2}px"></div>`;
      document.body.append(pane);
    }, SCROLLED_PAST_PX);
    await page.locator("#inpane").click();
    await expect(list(page)).toBeVisible();
    await page.evaluate((scrolledPast) => { document.querySelector("#pane").scrollTop = scrolledPast; }, SCROLLED_PAST_PX);
    await expect(list(page)).toHaveCount(0);

    await page.evaluate(() => { document.querySelector("#pane").scrollTop = 0; });
    await page.locator("#inpane").click();
    await expect(list(page)).toBeVisible();
    await page.locator("#spacer").click({ position: { x: 170, y: 60 } });
    await expect(list(page)).toHaveCount(0);
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
    await page.locator(".set-demucs-device").click();
    await expect(option(page, "CUDA (NVIDIA)")).not.toHaveAttribute("aria-disabled", "true");

    release();
    await expect(list(page).getByRole("option", { name: /^CUDA \(NVIDIA\).+/ })).toHaveAttribute("aria-disabled", "true");
    await expect(list(page)).toBeVisible();
  });

  test("the list takes the field's font", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const quality = page.locator(".set-separation-quality");
    await quality.click();
    const field = await quality.evaluate((el) => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize]);
    await expect(list(page)).toHaveCSS("font-family", field[0]);
    await expect(list(page)).toHaveCSS("font-size", field[1]);
  });

  test("in Settings the option text ends before the caret", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const general = [".set-language", ".set-demucs-device", ".set-separation-quality"];
    for (const selector of general) expect(await textClearOfCaret(page.locator(selector))).toBe(true);
    await page.locator('.settings-tab[data-tab="export"]').click();
    for (const selector of [".set-export-samplerate", ".set-video-height"]) {
      expect(await textClearOfCaret(page.locator(selector))).toBe(true);
    }
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

  test("with Guide on, Escape closes the list and Guide stays on", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page);
    await page.locator("#helpModeBtn").click();
    await expect(page.locator("body")).toHaveClass(/help-mode/);
    await fruit.click();
    await expect(list(page)).toHaveCount(0);

    await fruit.focus();
    await page.keyboard.press("Enter");
    await expect(list(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
    await expect(page.locator("body")).toHaveClass(/help-mode/);
  });

  test("Space on a select the user just picked from still plays and pauses", async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page);
    await openClickOptions(page);
    await page.locator("#t-metro-countin").click();
    await option(page, "Count-in: 1 bar").click();
    await expect(page.locator("#t-metro-countin")).toBeFocused();

    await page.keyboard.press("Space");
    await expect(list(page)).toHaveCount(0);
    await expect.poll(() => isPlaying(page)).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(() => isPlaying(page)).toBe(false);
  });

  test("picking Custom accent in the Tempo tab reveals the beats field", async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page);
    await openClickOptions(page);
    await page.locator("#t-metro-bar").click();
    await option(page, "Custom...").click();
    await expect(page.locator("#t-metro-bar")).toHaveValue("custom");
    await expect(page.locator("#t-metro-bar-custom")).toBeVisible();
  });
});

test.describe("select lists without the popover API", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { delete HTMLElement.prototype.showPopover; });
  });

  test.afterEach(async ({ page }) => {
    await page.request.post("/api/settings", { data: { separation_quality: "standard" } });
  });

  test("the list still opens in the window, flips and takes clicks", async ({ page }) => {
    await openApp(page);
    const fruit = await addFruitSelect(page, { bottom: NEAR_BOTTOM_PX });
    await fruit.click();
    await expect(list(page)).not.toHaveAttribute("popover");
    const select = await fruit.boundingBox();
    const box = await list(page).boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(select.y);
    expect(box.y).toBeGreaterThanOrEqual(0);
    await option(page, "Damson").click();
    await expect(fruit).toHaveValue("damson");
  });

  test("a pick lands inside the Tempo tab's accent select", async ({ page }) => {
    await openStudio(page);
    await waitForClickTrack(page);
    await openClickOptions(page);
    await page.locator("#t-metro-bar").click();
    await option(page, "3/4").click();
    await expect(page.locator("#t-metro-bar")).toHaveValue("3");
  });

  test("a pick lands inside Settings", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const quality = page.locator(".set-separation-quality");
    await quality.click();
    await option(page, "Best (2× slower)").click();
    await expect(quality).toHaveValue("best");
    await expect(page.locator(".library-editor")).toBeVisible();
  });
});
