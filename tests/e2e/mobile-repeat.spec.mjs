// Repeat on the phone UI: the same three states and stored choice as the studio's footer,
// and a song's end that plays it again or, with Repeat off, stops. The phone has no Up Next,
// setlists or list context, so Repeat queue there repeats the song.

import { test, expect } from "@playwright/test";
import { JOB_ID } from "./helpers.mjs";

test.use({ launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });

const REPEAT_STORE_KEY = "stemdeck.repeat";
const READY_TIMEOUT_MS = 20000;
const SONG_END_TIMEOUT_MS = 15000;
const NEAR_END_FRACTION = 0.9;
const RESTARTED_TIMES = /^0:0[0-2]$/;
const STATES = Object.freeze([
  { mode: "off", caption: "Repeat", label: "Repeat off" },
  { mode: "queue", caption: "Queue", label: "Repeat queue" },
  { mode: "song", caption: "Song", label: "Repeat song" },
]);

const repeatButton = (page) => page.locator(".t-repeat");
const playButton = (page) => page.locator(".t-play");
const elapsed = (page) => page.locator(".wave-times .cur");

const storedRepeat = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), REPEAT_STORE_KEY);
const seedRepeat = (page, mode) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [REPEAT_STORE_KEY, mode]);

/** Opens the fixture song on the phone UI and waits until it can play. */
async function openOnPhone(page) {
  await page.goto("/?ui=mobile", { waitUntil: "domcontentloaded" });
  await page.locator('[data-action="tab"][data-tab="library"]').first().click();
  await page.locator(`.track[data-id="${JOB_ID}"]`).first().click();
  await expect(playButton(page)).toBeEnabled({ timeout: READY_TIMEOUT_MS });
}

async function seekNearEnd(page) {
  const box = await page.locator("[data-seek]").boundingBox();
  await page.mouse.click(box.x + box.width * NEAR_END_FRACTION, box.y + box.height / 2);
}

test("each tap goes off, Queue, Song and off, captioned, and keeps the studio's stored choice", async ({ page }) => {
  await openOnPhone(page);
  const button = repeatButton(page);
  await expect(button).toHaveText(STATES[0].caption);
  for (const { mode, caption, label } of [...STATES.slice(1), STATES[0]]) {
    await button.click();
    await expect(button).toHaveText(caption);
    await expect(button).toHaveAccessibleName(label);
    await expect(button).toHaveAttribute("data-repeat", mode);
    await expect.poll(() => storedRepeat(page)).toBe(mode);
  }
});

test("a choice made in the studio shows on the phone", async ({ page }) => {
  await seedRepeat(page, "song");
  await openOnPhone(page);
  await expect(repeatButton(page)).toHaveText("Song");
  await expect(repeatButton(page)).toHaveClass(/\bon\b/);
});

for (const mode of ["song", "queue"]) {
  test(`with Repeat ${mode} the song plays again from the top when it ends`, async ({ page }) => {
    await seedRepeat(page, mode);
    await openOnPhone(page);
    await playButton(page).click();
    await expect(playButton(page)).toHaveAttribute("data-playing", "true");
    await seekNearEnd(page);
    await expect(elapsed(page)).not.toHaveText(RESTARTED_TIMES);
    await expect(elapsed(page)).toHaveText(RESTARTED_TIMES, { timeout: SONG_END_TIMEOUT_MS });
    await expect(playButton(page)).toHaveAttribute("data-playing", "true");
  });
}

test("with Repeat off the song stops at its end and the next Library song does not open", async ({ page }) => {
  await openOnPhone(page);
  const title = await page.locator(".track-title").textContent();
  await playButton(page).click();
  await expect(playButton(page)).toHaveAttribute("data-playing", "true");
  await seekNearEnd(page);
  await expect(playButton(page)).toHaveAttribute("data-playing", "false", { timeout: SONG_END_TIMEOUT_MS });
  await expect(page.locator(".track-title")).toHaveText(title);
});
