// Media keys, headset buttons and the OS media controls reach the app through
// navigator.mediaSession. A test cannot press an OS key, so the page records
// the handlers the app registers and the position states it reports, and the
// tests call the handlers the way the browser would.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, fixtureTrack, openStudio, waitForClickTrack } from "./helpers.mjs";

// A 1x1 PNG. data: is in the page's img-src, so it loads with no network.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ARTIST = "The Fixtures";
const ALBUM = "Fixture Album";
const FIXTURE_DURATION_SEC = 6;
const SECONDS_CLOSE = 1;

function library() {
  const tracks = {
    [JOB_ID]: {
      ...fixtureTrack(JOB_ID, "With Cover"),
      thumb: PIXEL,
      artist: { name: ARTIST },
      audioTags: { album: ALBUM },
      audioTagsChecked: true,
    },
    [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "No Cover"),
  };
  return {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: Object.keys(tracks), color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks,
  };
}

async function recordMediaSession(page) {
  await page.addInitScript(() => {
    const session = navigator.mediaSession;
    const record = { handlers: {}, positions: [] };
    window.__media = record;
    const setActionHandler = session.setActionHandler.bind(session);
    session.setActionHandler = function recordActionHandler(action, handler) {
      record.handlers[action] = handler;
      setActionHandler(action, handler);
    };
    const setPositionState = session.setPositionState.bind(session);
    session.setPositionState = function recordPositionState(state) {
      record.positions.push(state ?? null);
      setPositionState(state);
    };
  });
}

async function openWithMediaSession(page) {
  await recordMediaSession(page);
  await openStudio(page, { catalog: library() });
  // The engine is up once the click track is.
  await waitForClickTrack(page, { revealOptions: false });
}

const runAction = (page, action, details = {}) =>
  page.evaluate(
    ([name, extra]) => window.__media.handlers[name]({ action: name, ...extra }),
    [action, details],
  );

const handlerKind = (page, action) =>
  page.evaluate((name) => {
    const handler = window.__media.handlers[name];
    return handler === undefined ? "unregistered" : handler === null ? "cleared" : "set";
  }, action);

const isPlaying = (page) =>
  page.evaluate(async () => (await import("/js/transport.js")).transport()?.isPlaying() === true);

const currentTime = (page) =>
  page.evaluate(async () => (await import("/js/transport.js")).transport().getCurrentTime());

const playbackState = (page) => page.evaluate(() => navigator.mediaSession.playbackState);

const lastPosition = (page) => page.evaluate(() => window.__media.positions.at(-1) ?? null);

const metadata = (page) =>
  page.evaluate(() => {
    const meta = navigator.mediaSession.metadata;
    if (!meta) return null;
    return {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      artwork: meta.artwork.map((art) => art.src),
    };
  });

async function expectPlaying(page, playing) {
  await expect.poll(() => isPlaying(page)).toBe(playing);
  await expect.poll(() => playbackState(page)).toBe(playing ? "playing" : "paused");
}

test.describe("system media controls", () => {
  test("the OS controls name the open song with its artist, album and cover", async ({ page }) => {
    await openWithMediaSession(page);
    const title = (await page.locator("#title").textContent()).trim();

    await expect.poll(() => metadata(page)).toEqual({
      title,
      artist: ARTIST,
      album: ALBUM,
      artwork: [PIXEL],
    });
    await expect.poll(() => playbackState(page)).toBe("paused");
  });

  test("play, pause and stop act on the transport, and the OS state follows", async ({ page }) => {
    await openWithMediaSession(page);

    await runAction(page, "play");
    await expectPlaying(page, true);
    const playing = await lastPosition(page);
    expect(playing.playbackRate).toBe(1);
    expect(Math.abs(playing.duration - FIXTURE_DURATION_SEC)).toBeLessThan(SECONDS_CLOSE);

    await runAction(page, "pause");
    await expectPlaying(page, false);

    await runAction(page, "play");
    await expectPlaying(page, true);
    await runAction(page, "stop");
    await expectPlaying(page, false);
    expect(await currentTime(page)).toBe(0);
  });

  test("Space still toggles playback, and the OS state follows it", async ({ page }) => {
    await openWithMediaSession(page);
    // Opening the song focused its library row, which keeps Space for itself.
    await page.evaluate(() => document.activeElement?.blur());

    await page.keyboard.press("Space");
    await expectPlaying(page, true);
    await page.keyboard.press("Space");
    await expectPlaying(page, false);
  });

  test("seeking from the OS moves the playhead and the reported position", async ({ page }) => {
    await openWithMediaSession(page);

    await runAction(page, "seekto", { seekTime: 3 });
    await expect.poll(() => currentTime(page)).toBeCloseTo(3, 1);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeCloseTo(3, 1);

    await runAction(page, "seekbackward", { seekOffset: 2 });
    await expect.poll(() => currentTime(page)).toBeCloseTo(1, 1);
    await runAction(page, "seekforward", { seekOffset: 1 });
    await expect.poll(() => currentTime(page)).toBeCloseTo(2, 1);

    await runAction(page, "seekto", { seekTime: 5.5 });
    await runAction(page, "seekbackward");
    await expect.poll(() => currentTime(page)).toBeCloseTo(0.5, 1);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeCloseTo(0.5, 1);
  });

  test("next plays the first song in Up Next, and the OS names it", async ({ page }) => {
    await openWithMediaSession(page);
    expect(await handlerKind(page, "nexttrack")).toBe("cleared");

    await page.evaluate((id) => {
      document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } }));
    }, SIBLING_JOB_ID);
    await expect.poll(() => handlerKind(page, "nexttrack")).toBe("set");
    await runAction(page, "seekto", { seekTime: 3 });

    await runAction(page, "nexttrack");
    await expect(page.locator("#title")).toHaveText(/^E2E Fixture Track \(again\)$/, { timeout: 15000 });
    await expect.poll(async () => (await metadata(page))?.title).toBe("E2E Fixture Track (again)");
    await expectPlaying(page, true);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeLessThan(SECONDS_CLOSE);
    await expect.poll(() => handlerKind(page, "nexttrack")).toBe("cleared");
  });

  test("previous restarts the open song and keeps it playing", async ({ page }) => {
    await openWithMediaSession(page);
    await runAction(page, "play");
    await expectPlaying(page, true);
    await runAction(page, "seekto", { seekTime: 3 });
    await expect.poll(() => currentTime(page)).toBeGreaterThan(2.5);

    await runAction(page, "previoustrack");
    await expect.poll(() => currentTime(page)).toBeLessThan(SECONDS_CLOSE);
    await expectPlaying(page, true);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeLessThan(SECONDS_CLOSE);
  });

  test("previous restarts a paused song and leaves it paused", async ({ page }) => {
    await openWithMediaSession(page);
    await runAction(page, "seekto", { seekTime: 3 });
    await expect.poll(() => currentTime(page)).toBeCloseTo(3, 1);

    await runAction(page, "previoustrack");
    await expect.poll(() => currentTime(page)).toBe(0);
    await expectPlaying(page, false);
    await expect.poll(async () => (await lastPosition(page))?.position).toBe(0);
  });

  test("a speed change reaches the reported position state", async ({ page }) => {
    await openWithMediaSession(page);

    await runAction(page, "play");
    await expectPlaying(page, true);
    await page.locator("#t-speed-05").click();
    await expect.poll(async () => (await lastPosition(page))?.playbackRate).toBe(0.5);
  });

  test("closing the song clears what the OS shows", async ({ page }) => {
    await openWithMediaSession(page);
    await expect.poll(() => metadata(page)).not.toBeNull();
    expect(await handlerKind(page, "previoustrack")).toBe("set");

    await page.evaluate(async () => (await import("/js/job.js")).reset());
    await expect.poll(() => metadata(page)).toBeNull();
    await expect.poll(() => playbackState(page)).toBe("none");
    expect(await lastPosition(page)).toBeNull();
    expect(await handlerKind(page, "previoustrack")).toBe("cleared");
  });
});
