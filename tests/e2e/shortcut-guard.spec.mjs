import { test, expect } from "@playwright/test";
import { focusAddedInput, openClickOptions, openStudio, waitForClickTrack } from "./helpers.mjs";

const MODIFIER_KEYS = ["Control", "Meta", "Alt", "Shift"];
const ALT_CHORDS = ["Alt+Space", "Alt+[", "Alt+]", "Alt+l", "Alt+k"];
const ALT_LOOP_CHORDS = ["Alt+i", "Alt+o"];
const SHORTCUT_LETTERS = ["k", "l"];
const TEXT_FIELD_KEYS = [...SHORTCUT_LETTERS, "Space"];
const SELECT_LIST = "#select-menu-list";
const TEXT_ENTRY_TYPES = ["number", "search"];
const ACTIVE = /\bactive\b/;
const MIXER_FADER = ".mx-fader-input";
const SPEED_FADER = "#t-speed";
const SPEED_BOX = "#t-speed-value";
const MUTE_CHIP = ".mx-btn.mute";
const MUTED_LANE = ".lane-header.muted";
const CLAIMING_CONTROL_ID = "shortcut-guard-claiming";
const STAGE_MODE = /\bstage-mode\b/;
const UNCHANGED_SPEED = "1.00x";

/** Record, for each non-modifier keydown, whether a handler claimed it. */
async function watchKeys(page) {
  await page.evaluate((modifiers) => {
    window.__keys = [];
    window.addEventListener("keydown", function recordKey(e) {
      if (!modifiers.includes(e.key)) window.__keys.push(e.defaultPrevented);
    });
  }, MODIFIER_KEYS);
}

const takePreventedKeys = (page) => page.evaluate(() => window.__keys.splice(0));

const studioState = (page) => page.evaluate(async () => {
  const engine = (await import("/js/transport.js")).transport();
  return {
    playing: engine.isPlaying(),
    time: engine.getCurrentTime(),
    loopStart: document.querySelector("#t-loop-start").value,
    loopEnd: document.querySelector("#t-loop-end").value,
  };
});

async function pressAll(page, keys) {
  for (const key of keys) await page.keyboard.press(key);
}

/** Focus `target` the way a keyboard user does, so it shows a focus ring. */
async function tabOnto(page, target) {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  expect(await target.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

async function setUp(page) {
  await openStudio(page);
  await waitForClickTrack(page, { revealOptions: false });
  await watchKeys(page);
}

test.describe("one-key shortcuts and what they leave alone", () => {
  test("Alt chords stay with the browser", async ({ page }) => {
    await setUp(page);
    const before = await studioState(page);

    await pressAll(page, ALT_CHORDS);

    expect(await takePreventedKeys(page)).toEqual(ALT_CHORDS.map(() => false));
    const after = await studioState(page);
    expect(after.playing).toBe(false);
    expect(after.time).toBeCloseTo(before.time, 2);
    await expect(page.locator("#t-loop")).not.toHaveClass(ACTIVE);
    await expect(page.locator("#t-metro")).not.toHaveClass(ACTIVE);

    // I and O only act with a loop on, and the playhead at 0 sits outside it.
    await page.keyboard.press("l");
    await expect(page.locator("#t-loop")).toHaveClass(ACTIVE);
    const looped = await studioState(page);
    await takePreventedKeys(page);
    await pressAll(page, ALT_LOOP_CHORDS);
    expect(await takePreventedKeys(page)).toEqual(ALT_LOOP_CHORDS.map(() => false));
    const moved = await studioState(page);
    expect([moved.loopStart, moved.loopEnd]).toEqual([looped.loopStart, looped.loopEnd]);
  });

  test("a focused select keeps its own keys", async ({ page }) => {
    await setUp(page);
    await openClickOptions(page);
    const select = page.locator("#t-metro-bar");
    await select.focus();
    await expect(select).toBeFocused();

    await pressAll(page, SHORTCUT_LETTERS);
    expect(await takePreventedKeys(page)).toEqual(SHORTCUT_LETTERS.map(() => false));
    await page.keyboard.press("Space");
    await expect(page.locator(SELECT_LIST)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(SELECT_LIST)).toHaveCount(0);
    expect((await studioState(page)).playing).toBe(false);
    await expect(page.locator("#t-loop")).not.toHaveClass(ACTIVE);
    await expect(page.locator("#t-metro")).not.toHaveClass(ACTIVE);

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("k");
    await expect(page.locator("#t-metro")).toHaveClass(ACTIVE);
  });

  test("a focused editable element keeps its own keys", async ({ page }) => {
    await setUp(page);
    await page.evaluate(() => {
      const editable = document.createElement("div");
      editable.id = "shortcut-guard-editable";
      editable.setAttribute("contenteditable", "");
      document.body.append(editable);
    });
    await page.locator("#shortcut-guard-editable").focus();

    await page.keyboard.press("k");

    expect(await takePreventedKeys(page)).toEqual([false]);
    await expect(page.locator("#t-metro")).not.toHaveClass(ACTIVE);
  });

  test("a focused mixer fader moves on its arrows and leaves K, L and Space to the shortcuts", async ({ page }) => {
    await setUp(page);
    const fader = page.locator(MIXER_FADER).filter({ visible: true }).first();
    await fader.focus();
    await expect(fader).toBeFocused();
    const before = await studioState(page);
    const startValue = await fader.inputValue();

    await page.keyboard.press("ArrowLeft");

    await expect(fader).not.toHaveValue(startValue);
    expect(await takePreventedKeys(page)).toEqual([false]);
    expect((await studioState(page)).time).toBeCloseTo(before.time, 2);
    await expect(page.locator("#t-loop")).not.toHaveClass(ACTIVE);

    await pressAll(page, SHORTCUT_LETTERS);
    await expect(page.locator("#t-metro")).toHaveClass(ACTIVE);
    await expect(page.locator("#t-loop")).toHaveClass(ACTIVE);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
    await expect(fader).toBeFocused();
  });

  test("a focused speed fader moves on its arrows and leaves ] and Space to the shortcuts", async ({ page }) => {
    await setUp(page);
    const fader = page.locator(SPEED_FADER);
    await fader.focus();
    await expect(fader).toBeFocused();
    const before = await studioState(page);

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(SPEED_BOX)).not.toHaveValue(UNCHANGED_SPEED);
    await expect(page.locator("#t-loop")).not.toHaveClass(ACTIVE);
    expect((await studioState(page)).time).toBeCloseTo(before.time, 2);

    await page.keyboard.press("]");
    await expect.poll(async () => (await studioState(page)).time).toBeGreaterThan(before.time);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
  });

  test("a button reached by Tab takes Space as its own press and leaves L to the shortcut", async ({ page }) => {
    await setUp(page);
    await tabOnto(page, page.locator("#t-metro"));

    await page.keyboard.press("l");
    await expect(page.locator("#t-loop")).toHaveClass(ACTIVE);
    await page.keyboard.press("Space");

    await expect(page.locator("#t-metro")).toHaveClass(ACTIVE);
    expect((await studioState(page)).playing).toBe(false);
  });

  test("Space after a mouse click on a button plays and does not press the button again", async ({ page }) => {
    await setUp(page);
    const metro = page.locator("#t-metro");
    await metro.click();
    await expect(metro).toHaveClass(ACTIVE);
    await expect(metro).toBeFocused();

    await page.keyboard.press("Space");

    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
    await expect(metro).toHaveClass(ACTIVE);
  });

  test("Space after a mouse click on a checkbox plays and does not untick it", async ({ page }) => {
    await setUp(page);
    const checkbox = await focusAddedInput(page, "checkbox");
    await checkbox.blur();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();

    await page.keyboard.press("Space");

    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
    await expect(checkbox).toBeChecked();
  });

  test("Space after a mouse click on a mute chip plays and does not unmute the stem", async ({ page }) => {
    await setUp(page);
    const mute = page.locator(MUTE_CHIP).filter({ visible: true }).first();
    await mute.click();
    await expect(page.locator(MUTED_LANE)).toHaveCount(1);
    await expect(mute).toBeFocused();

    await page.keyboard.press("Space");

    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
    await expect(page.locator(MUTED_LANE)).toHaveCount(1);
  });

  test("a checkbox reached by Tab takes Space as its own press and leaves K to the shortcut", async ({ page }) => {
    await setUp(page);
    const checkbox = await focusAddedInput(page, "checkbox");
    await tabOnto(page, checkbox);

    await page.keyboard.press("k");
    await expect(page.locator("#t-metro")).toHaveClass(ACTIVE);
    await page.keyboard.press("Space");

    await expect(checkbox).toBeChecked();
    expect((await studioState(page)).playing).toBe(false);
  });

  for (const type of TEXT_ENTRY_TYPES) {
    test(`a focused ${type} field keeps its own keys`, async ({ page }) => {
      await setUp(page);
      await focusAddedInput(page, type);

      await pressAll(page, TEXT_FIELD_KEYS);

      expect(await takePreventedKeys(page)).toEqual(TEXT_FIELD_KEYS.map(() => false));
      expect((await studioState(page)).playing).toBe(false);
      await expect(page.locator("#t-loop")).not.toHaveClass(ACTIVE);
      await expect(page.locator("#t-metro")).not.toHaveClass(ACTIVE);
    });
  }

  test("Space on a mute chip reached by Tab mutes the stem and leaves playback alone", async ({ page }) => {
    await setUp(page);
    const mute = page.locator(MUTE_CHIP).filter({ visible: true }).first();
    await tabOnto(page, mute);

    await page.keyboard.press("Space");
    await expect(page.locator(MUTED_LANE)).toHaveCount(1);

    // Space off the chip plays, so a Space the chip let through would have paused it again.
    await mute.blur();
    await page.keyboard.press("Space");
    await expect.poll(async () => (await studioState(page)).playing).toBe(true);
  });

  test("F on a focused slider turns Stage mode on", async ({ page }) => {
    await setUp(page);
    const fader = page.locator(SPEED_FADER);
    await fader.focus();
    await expect(fader).toBeFocused();

    await page.keyboard.press("f");

    await expect(page.locator(".app")).toHaveClass(STAGE_MODE);
  });

  test("a key a focused control has already handled is not also a shortcut", async ({ page }) => {
    await setUp(page);
    await page.evaluate((id) => {
      const control = document.createElement("div");
      control.id = id;
      control.tabIndex = 0;
      control.addEventListener("keydown", function claimKey(e) { e.preventDefault(); });
      document.body.append(control);
    }, CLAIMING_CONTROL_ID);
    const control = page.locator(`#${CLAIMING_CONTROL_ID}`);
    await control.focus();

    await page.keyboard.press("l");

    // L off the control turns the loop on, so an L that got through would have it off again.
    await control.blur();
    await page.keyboard.press("l");
    await expect(page.locator("#t-loop")).toHaveClass(ACTIVE);
  });
});
