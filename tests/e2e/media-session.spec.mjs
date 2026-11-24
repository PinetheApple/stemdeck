// Media keys, headset buttons and the OS media controls reach the app through
// navigator.mediaSession. A test cannot press an OS key, so the page records
// the handlers the app registers and the position states it reports, and the
// tests call the handlers the way the browser would.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  fixtureTrack,
  openClickOptions,
  openStudio,
  waitForClickTrack,
  openSpeedOptions,
} from "./helpers.mjs";

// A 1x1 PNG. data: is in the page's img-src, so it loads with no network.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ARTIST = "The Fixtures";
const ALBUM = "Fixture Album";
const FIXTURE_DURATION_SEC = 6;
const SECONDS_CLOSE = 1;
const LOOP_START_SEC = 2;
const LOOP_END_SEC = 4;
// The fixture's one-bar count-in lasts about 2 s; the watch sits inside it.
const LEAD_IN_SETTLE_MS = 300;
const LEAD_IN_WATCH_MS = 1000;
const CANCEL_WITHIN_MS = 1000;
const NEAR_END_SEC = 5.5;
const SECOND_CHUNK_SEC = 5;
const ANCHOR_PLAYING = { loaded: true, playing: true };
const ANCHOR_HELD = { loaded: true, playing: false };
const ANCHOR_RELEASED = { loaded: false, playing: false };

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
    const record = { handlers: {}, positions: [], anchors: [], anchorPlays: 0 };
    window.__media = record;
    const countAnchorPlay = () => { record.anchorPlays += 1; };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function recordAnchor() {
      const isAnchor = this.getAttribute("src")?.startsWith("blob:");
      if (isAnchor && !record.anchors.includes(this)) {
        record.anchors.push(this);
        this.addEventListener("playing", countAnchorPlay);
      }
      return play.call(this);
    };
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
    const playbackState = Object.getOwnPropertyDescriptor(MediaSession.prototype, "playbackState");
    record.states = [];
    Object.defineProperty(session, "playbackState", {
      get: () => playbackState.get.call(session),
      set: function recordPlaybackState(state) {
        record.states.push(state);
        playbackState.set.call(session, state);
      },
    });
  });
}

const anchorPlays = (page) => page.evaluate(() => window.__media.anchorPlays);

const statesSent = (page) => page.evaluate(() => window.__media.states.length);

const statesSince = (page, from) => page.evaluate((at) => window.__media.states.slice(at), from);

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

const positionsSent = (page) => page.evaluate(() => window.__media.positions.length);

const lastPosition = (page) => page.evaluate(() => window.__media.positions.at(-1) ?? null);

const anchorState = (page) =>
  page.evaluate(() => {
    const anchor = window.__media.anchors.at(-1);
    if (!anchor) return null;
    return { loaded: anchor.hasAttribute("src"), playing: !anchor.paused };
  });

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

  test("a song with no cover and no artist shows neither", async ({ page }) => {
    await openWithMediaSession(page);
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });

    await expect.poll(() => metadata(page)).toEqual({
      title: SIBLING_TITLE,
      artist: "",
      album: "",
      artwork: [],
    });
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
    await expect.poll(() => currentTime(page)).toBe(0);
  });

  test("pause and Stop keep the OS controls, paused, instead of letting them go", async ({ page }) => {
    await openWithMediaSession(page);

    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);
    await runAction(page, "pause");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_HELD);

    await runAction(page, "play");
    await expectPlaying(page, true);
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);
    await runAction(page, "stop");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_HELD);
  });

  test("next keeps the OS controls through the next song's load", async ({ page }) => {
    await openWithMediaSession(page);
    await page.evaluate((id) => {
      document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } }));
    }, SIBLING_JOB_ID);
    await expect.poll(() => handlerKind(page, "nexttrack")).toBe("set");
    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);

    await runAction(page, "nexttrack");
    expect((await anchorState(page)).loaded).toBe(true);
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
    await expectPlaying(page, true);
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);
    expect(await page.evaluate(() => window.__media.anchors.length)).toBe(1);
  });

  test("when the OS controls come back, they are told the state again", async ({ page }) => {
    await openWithMediaSession(page);
    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);
    await runAction(page, "pause");
    await expectPlaying(page, false);
    const sentBefore = await positionsSent(page);

    await page.evaluate(() => window.__media.anchors.at(-1).dispatchEvent(new Event("playing")));
    await expect.poll(() => positionsSent(page)).toBe(sentBefore + 1);
    expect(await playbackState(page)).toBe("paused");
  });

  test("the song's end with nothing queued lets the OS controls go", async ({ page }) => {
    await openWithMediaSession(page);
    await runAction(page, "seekto", { seekTime: NEAR_END_SEC });
    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);

    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_RELEASED);
    expect(await isPlaying(page)).toBe(false);
  });

  test("the song's end pauses the OS controls while the queued song opens", async ({ page }) => {
    await openWithMediaSession(page);
    await page.route((url) => url.href.includes(SIBLING_JOB_ID), function holdQueuedSong() {});
    await page.evaluate((id) => {
      document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } }));
    }, SIBLING_JOB_ID);
    await expect.poll(() => handlerKind(page, "nexttrack")).toBe("set");
    await runAction(page, "seekto", { seekTime: NEAR_END_SEC });
    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);

    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_HELD);
    expect(await isPlaying(page)).toBe(false);
  });

  test("the play key does not pause a start still waiting for its audio", async ({ page }) => {
    await openWithMediaSession(page);
    let releaseStems;
    const stemsHeld = new Promise((resolve) => { releaseStems = resolve; });
    await page.route("**/stems/**", async function holdStems(route) {
      await stemsHeld;
      await route.continue();
    });
    // The first two chunks load with the song; a seek past the first evicts it.
    await runAction(page, "seekto", { seekTime: SECOND_CHUNK_SEC });
    await runAction(page, "seekto", { seekTime: 0 });
    await runAction(page, "play");
    expect(await isPlaying(page)).toBe(true);

    await runAction(page, "play");
    expect(await isPlaying(page)).toBe(true);
    releaseStems();
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0);
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
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
    await expect.poll(async () => (await metadata(page))?.title).toBe(SIBLING_TITLE);
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

  test("previous with a loop on goes to the loop start, as Stop does", async ({ page }) => {
    await openWithMediaSession(page);
    await page.evaluate(async ([start, end]) => {
      (await import("/js/transport.js")).setLoopRange(start, end);
    }, [LOOP_START_SEC, LOOP_END_SEC]);
    await runAction(page, "seekto", { seekTime: 3.5 });
    await expect.poll(() => currentTime(page)).toBeCloseTo(3.5, 1);

    await runAction(page, "previoustrack");
    await expect.poll(() => currentTime(page)).toBeCloseTo(LOOP_START_SEC, 1);
  });

  test("during a count-in the OS is not sent a position it would advance", async ({ page }) => {
    await openWithMediaSession(page);
    await openClickOptions(page);
    await page.locator("#t-metro-countin").selectOption("1");
    const statesBefore = await statesSent(page);

    await runAction(page, "play");
    await expect.poll(() => anchorPlays(page)).toBe(1);
    await page.waitForTimeout(LEAD_IN_SETTLE_MS);
    const sentBefore = await positionsSent(page);
    await page.waitForTimeout(LEAD_IN_WATCH_MS);
    expect(await positionsSent(page)).toBe(sentBefore);
    expect(await playbackState(page)).toBe("paused");
    expect(await statesSince(page, statesBefore)).not.toContain("playing");

    await expectPlaying(page, true);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeGreaterThan(0);
  });

  test("the play key during a count-in cancels it, as the toggle did", async ({ page }) => {
    await openWithMediaSession(page);
    await openClickOptions(page);
    await page.locator("#t-metro-countin").selectOption("1");
    await runAction(page, "play");
    await page.waitForTimeout(LEAD_IN_SETTLE_MS);
    expect(await playbackState(page)).toBe("paused");

    await runAction(page, "play");
    // Well before the lead-in and the 6 s song could run out by themselves.
    await expect.poll(() => isPlaying(page), { timeout: CANCEL_WITHIN_MS }).toBe(false);
    expect(await currentTime(page)).toBeLessThan(SECONDS_CLOSE);
    await expect.poll(() => playbackState(page)).toBe("paused");
  });

  test("on the streaming path a seek from the keys is reported again", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("stemdeck.audioEngine", "0"));
    await recordMediaSession(page);
    await openStudio(page, { catalog: library() });
    await page.evaluate(() => document.activeElement?.blur());

    await page.keyboard.press("BracketRight");
    await expect.poll(() => currentTime(page)).toBeCloseTo(5, 1);
    await expect.poll(async () => (await lastPosition(page))?.position).toBeCloseTo(5, 1);
  });

  test("a speed change reaches the reported position state", async ({ page }) => {
    await openWithMediaSession(page);

    await runAction(page, "play");
    await expectPlaying(page, true);
    await openSpeedOptions(page);
    await page.locator("#t-speed-value").fill("0.5");
    await page.locator("#t-speed-value").press("Enter");
    await expect.poll(async () => (await lastPosition(page))?.playbackRate).toBe(0.5);
  });

  test("closing the song clears what the OS shows", async ({ page }) => {
    await openWithMediaSession(page);
    await expect.poll(() => metadata(page)).not.toBeNull();
    expect(await handlerKind(page, "previoustrack")).toBe("set");
    await runAction(page, "play");
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_PLAYING);

    await page.evaluate(async () => (await import("/js/job.js")).reset());
    await expect.poll(() => anchorState(page)).toEqual(ANCHOR_RELEASED);
    await expect.poll(() => metadata(page)).toBeNull();
    await expect.poll(() => playbackState(page)).toBe("none");
    expect(await lastPosition(page)).toBeNull();
    expect(await handlerKind(page, "previoustrack")).toBe("cleared");
  });
});
