// The studio's one-key shortcuts (Space, [, ], L, K, I, O) leave Alt chords to
// the browser and the OS, and leave a focused select its own keys.
import { test, expect } from "@playwright/test";
import { openClickOptions, openStudio, waitForClickTrack } from "./helpers.mjs";

const MODIFIER_KEYS = ["Control", "Meta", "Alt", "Shift"];
const ALT_CHORDS = ["Alt+Space", "Alt+[", "Alt+]", "Alt+l", "Alt+k"];
const ALT_LOOP_CHORDS = ["Alt+i", "Alt+o"];
const SELECT_KEYS = ["k", "l", "Space"];

/** Record, for each non-modifier keydown, whether a handler claimed it. */
async function watchKeys(page) {
  await page.evaluate((modifiers) => {
    window.__keys = [];
    window.addEventListener("keydown", function recordKey(e) {
      if (!modifiers.includes(e.key)) window.__keys.push(e.defaultPrevented);
    });
  }, MODIFIER_KEYS);
}

const keysPrevented = (page) => page.evaluate(() => window.__keys.splice(0));

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

    expect(await keysPrevented(page)).toEqual(ALT_CHORDS.map(() => false));
    const after = await studioState(page);
    expect(after.playing).toBe(false);
    expect(after.time).toBeCloseTo(before.time, 2);
    await expect(page.locator("#t-loop")).not.toHaveClass(/active/);
    await expect(page.locator("#t-metro")).not.toHaveClass(/active/);

    // I and O only act with a loop on, and the playhead at 0 sits outside it.
    await page.keyboard.press("l");
    await expect(page.locator("#t-loop")).toHaveClass(/active/);
    const looped = await studioState(page);
    await keysPrevented(page);
    await pressAll(page, ALT_LOOP_CHORDS);
    expect(await keysPrevented(page)).toEqual(ALT_LOOP_CHORDS.map(() => false));
    const moved = await studioState(page);
    expect([moved.loopStart, moved.loopEnd]).toEqual([looped.loopStart, looped.loopEnd]);
  });

  test("a focused select keeps its own keys", async ({ page }) => {
    await setUp(page);
    await openClickOptions(page);
    const select = page.locator("#t-metro-bar");
    await select.focus();
    await expect(select).toBeFocused();

    // Space last: if it opens the list, the list has the keys after it.
    await pressAll(page, SELECT_KEYS);

    expect(await keysPrevented(page)).toEqual(SELECT_KEYS.map(() => false));
    await page.keyboard.press("Escape");
    expect((await studioState(page)).playing).toBe(false);
    await expect(page.locator("#t-loop")).not.toHaveClass(/active/);
    await expect(page.locator("#t-metro")).not.toHaveClass(/active/);

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("k");
    await expect(page.locator("#t-metro")).toHaveClass(/active/);
  });
});
