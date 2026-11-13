// The click sound preference (#93): it reaches the live click and survives a
// reload, a switch while playing leaves nothing queued behind, and every
// export that renders a click asks for the chosen sound.
//
// Whether a preset sounds right is a listening check; that the browser
// synthesis matches the export renderer is pinned in tests/js/click-sounds.test.mjs.

import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack, exportUi } from "./helpers.mjs";

const soundSelect = (page) => page.locator("#t-metro-sound");
const choosePath = (page) => page.evaluate(() => window.__e2e.choosePath());
const finishSave = (page) => page.evaluate(() => window.__e2e.finishSave());
const lastExportUrl = (page) =>
  page.evaluate(() => new URL(window.__e2e.callsFor("download_to_path").at(-1).args.url, location.href).search);
const liveSound = (page) =>
  page.evaluate(async () => (await import("/js/state.js")).metronome?.getSound());
const pendingClicks = (page) =>
  page.evaluate(async () => (await import("/js/state.js")).metronome.pendingCount());

async function chooseSound(page, id) {
  await page.evaluate(async (sound) => (await import("/js/transport.js")).setClickSound(sound), id);
}

async function savedSound(page) {
  return page.evaluate(async () => (await import("/js/transport.js")).getClickSound());
}

async function exportQuery(page, row) {
  const ui = exportUi(page);
  await ui.open();
  await ui[row].click();
  await choosePath(page);
  const query = new URLSearchParams(await lastExportUrl(page));
  await finishSave(page);
  return query;
}

async function tickExportClick(page) {
  await exportUi(page).open();
  await page.locator("#t-export-click").check();
  await page.keyboard.press("Escape");
}

test.describe("click sound", () => {
  test("the picker lists the presets, Classic first and chosen by default", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await expect(soundSelect(page)).toBeEnabled();
    await expect(soundSelect(page)).toHaveValue("classic");
    await expect(soundSelect(page).locator("option")).toHaveText([
      "Sound: Classic", "Sound: Woodblock", "Sound: Rimshot", "Sound: Soft", "Sound: Cowbell",
    ]);
    await expect(soundSelect(page)).toHaveAccessibleName("Click sound");
    expect(await savedSound(page)).toBe("classic");
    expect(await liveSound(page)).toBe("classic");
  });

  test("a chosen sound reaches the live click and survives a reload", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await soundSelect(page).selectOption("cowbell");
    expect(await liveSound(page)).toBe("cowbell");

    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await expect(soundSelect(page)).toHaveValue("cowbell");
    expect(await savedSound(page)).toBe("cowbell");
    expect(await liveSound(page)).toBe("cowbell");
  });

  test("an unknown sound reads as Classic", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await chooseSound(page, "cowbell");
    await chooseSound(page, "no-such-sound");
    expect(await savedSound(page)).toBe("classic");
    expect(await liveSound(page)).toBe("classic");
  });

  test("switching sound while the click plays leaves nothing queued behind", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await page.locator("#t-metro").click();
    await page.keyboard.press("Space");
    await expect.poll(() => pendingClicks(page), { timeout: 10_000 }).toBeGreaterThan(0);
    const counts = await page.evaluate(async () => {
      const { metronome } = await import("/js/state.js");
      const seen = [];
      for (const id of ["woodblock", "rimshot", "soft", "cowbell", "classic", "woodblock"]) {
        const before = metronome.pendingCount();
        metronome.setSound(id);
        seen.push([before, metronome.pendingCount(), metronome.getSound()]);
      }
      return seen;
    });
    for (const [before, after] of counts) expect(after).toBe(before);
    expect(counts.at(-1)[2]).toBe("woodblock");
    await page.keyboard.press("Space");
    await expect.poll(() => pendingClicks(page)).toBe(0);
  });

  test("the stems zip asks for the click only with the box ticked, in the chosen sound", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);
    await soundSelect(page).selectOption("rimshot");

    const plain = await exportQuery(page, "stems");
    expect([...plain.keys()].filter((k) => k.startsWith("click"))).toEqual([]);

    await tickExportClick(page);
    const withClick = await exportQuery(page, "stems");
    expect(withClick.get("click")).toBe("1");
    expect(withClick.get("click_sound")).toBe("rimshot");
    expect(withClick.get("click_gain")).toBeTruthy();
    expect(withClick.get("click_mult")).toBe("1");
    expect(withClick.has("count_in")).toBe(false);
  });

  test("the mix export sends the sound with the click and with a count-in alone", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);

    await tickExportClick(page);
    const classic = await exportQuery(page, "mix");
    expect(classic.get("click")).toBe("1");
    expect(classic.get("click_sound")).toBe("classic");

    await chooseSound(page, "soft");
    await exportUi(page).open();
    await page.locator("#t-export-click").uncheck();
    await page.locator("#t-export-count-in").check();
    await page.keyboard.press("Escape");
    const countInOnly = await exportQuery(page, "mix");
    expect(countInOnly.has("click")).toBe(false);
    expect(countInOnly.get("count_in")).toBeTruthy();
    expect(countInOnly.get("click_sound")).toBe("soft");
  });
});
