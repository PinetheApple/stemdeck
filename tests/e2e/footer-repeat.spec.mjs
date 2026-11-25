// The footer Repeat button: off, Repeat queue, Repeat song, kept over a reload, and
// what each plays when a song ends, with a song from a list going on to the next in it.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";
import { SETTLE_MS, countOpens } from "./openVsPlaying.mjs";
import { SONG_OPEN_TIMEOUT_MS, UP_NEXT_KEY, call, endSong, openSongId, seekTo, stored } from "./singAlongHelpers.mjs";

test.use({ launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });

const SETLISTS_URL = "/api/setlists";
const NEAR_END_SEC = 5;
const RESTARTED_BEFORE_SEC = 2;
const SONG_END_TIMEOUT_MS = 15000;
const LABELS = Object.freeze({ off: "Repeat off", queue: "Repeat queue", song: "Repeat song" });

const repeatButton = (page) => page.locator("#t-repeat");
const engineState = (page) => page.evaluate(async () => {
  const engine = (await import("/js/state.js")).audioEngine;
  return { playing: engine.isPlaying(), at: engine.getCurrentTime() };
});

async function setRepeat(page, mode) {
  const button = repeatButton(page);
  while ((await button.getAttribute("data-repeat")) !== mode) await button.click();
  await expect(button).toHaveAccessibleName(LABELS[mode]);
}

async function expectOpenSong(page, id) {
  await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(id);
}

/** Opens the studio and plays a new setlist of `songIds` from its first song. */
async function playSetlistOf(page, request, songIds) {
  const created = await request.post(SETLISTS_URL, { data: { name: "Repeat", song_ids: songIds } });
  const { id } = await created.json();
  await openStudio(page);
  return {
    play: async () => {
      await call(page, "/js/setlists.js", "playSetlist", id);
      await expectOpenSong(page, songIds[0]);
    },
  };
}

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_URL);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_URL}/${setlist.id}`);
});

test("each click goes off, Repeat queue, Repeat song and off, and the state outlasts a reload", async ({ page }) => {
  await openStudio(page);
  const button = repeatButton(page);
  await expect(button).toHaveAccessibleName(LABELS.off);
  await button.click();
  await expect(button).toHaveAccessibleName(LABELS.queue);
  await expect(button).toHaveClass(/is-on/);
  await button.click();
  await expect(button).toHaveAccessibleName(LABELS.song);
  await expect(button).toHaveAttribute("title", LABELS.song);
  await expect(button.locator(".ic-repeat-one")).toBeVisible();
  await expect(button.locator(".ic-repeat-all")).toBeHidden();
  await page.reload();
  await expect(repeatButton(page)).toHaveAccessibleName(LABELS.song);
  await repeatButton(page).click();
  await expect(repeatButton(page)).toHaveAccessibleName(LABELS.off);
  await expect(repeatButton(page)).not.toHaveClass(/is-on/);
});

test("Repeat song starts the song again from the top when it ends", async ({ page }) => {
  await openStudio(page);
  await setRepeat(page, "song");
  await page.locator("#t-play").click();
  await seekTo(page, NEAR_END_SEC);
  await page.evaluate(() => {
    window.__songEnds = 0;
    document.addEventListener("trackended", function countSongEnd() { window.__songEnds++; });
  });
  await expect.poll(() => page.evaluate(() => window.__songEnds), { timeout: SONG_END_TIMEOUT_MS }).toBeGreaterThan(0);
  const after = await engineState(page);
  expect(after.playing).toBe(true);
  expect(after.at).toBeLessThan(RESTARTED_BEFORE_SEC);
  expect(await openSongId(page)).toBe(JOB_ID);
});

test("Repeat queue plays the songs from Up Next again from the first of them", async ({ page }) => {
  await openStudio(page);
  await setRepeat(page, "queue");
  const siblingOpens = countOpens(page, SIBLING_JOB_ID);
  await call(page, "/js/upNext.js", "queueUpNext", SIBLING_JOB_ID);
  await endSong(page, JOB_ID);
  await expectOpenSong(page, SIBLING_JOB_ID);
  await expect.poll(() => siblingOpens.count).toBe(1);
  await endSong(page, SIBLING_JOB_ID);
  await expect.poll(() => siblingOpens.count, { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(2);
  expect(await openSongId(page)).toBe(SIBLING_JOB_ID);
  await expect.poll(() => stored(page, UP_NEXT_KEY)).toEqual([]);
});

test("a song from a list goes on to the next in it, and with Repeat off playback stops after the last", async ({ page, request }) => {
  const setlist = await playSetlistOf(page, request, [JOB_ID, SIBLING_JOB_ID]);
  await setlist.play();
  await endSong(page, JOB_ID);
  await expectOpenSong(page, SIBLING_JOB_ID);
  const firstOpens = countOpens(page, JOB_ID);
  await endSong(page, SIBLING_JOB_ID);
  await page.waitForTimeout(SETTLE_MS);
  expect(firstOpens.count).toBe(0);
  expect(await openSongId(page)).toBe(SIBLING_JOB_ID);
});

test("Repeat song wins over the list's next song", async ({ page, request }) => {
  const setlist = await playSetlistOf(page, request, [JOB_ID, SIBLING_JOB_ID]);
  await setRepeat(page, "song");
  await setlist.play();
  const nextOpens = countOpens(page, SIBLING_JOB_ID);
  await endSong(page, JOB_ID);
  await expect.poll(async () => (await engineState(page)).playing).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
  expect(nextOpens.count).toBe(0);
  expect(await openSongId(page)).toBe(JOB_ID);
});

test("Repeat queue plays a setlist again from its first song after its last", async ({ page, request }) => {
  const setlist = await playSetlistOf(page, request, [JOB_ID, SIBLING_JOB_ID]);
  await setRepeat(page, "queue");
  await setlist.play();
  await endSong(page, JOB_ID);
  await expectOpenSong(page, SIBLING_JOB_ID);
  await endSong(page, SIBLING_JOB_ID);
  await expectOpenSong(page, JOB_ID);
});
