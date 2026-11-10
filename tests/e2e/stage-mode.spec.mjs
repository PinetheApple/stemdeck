// The lyrics are shared with the Lyrics tab, so this tests what Stage asks of
// them: loading with the tab never opened, and never showing the song it left.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  fixtureTrack,
  seedCatalogState,
  stubAudioTags,
  stubExportEndpoints,
  stubUpdateCheck,
  LYRICS_LOOKUP,
  LYRICS_REMOVED,
  answerLyricsChoice,
} from "./helpers.mjs";

const BEAT_PERIOD = 0.5;
const BEATS_PER_BAR = 4;
const FRAME_SLOP_SEC = 0.1;
// Nothing announces that something did not happen, so these wait this long for it.
const NOTHING_HAPPENS_MS = 300;
const fixtureBeats = (count = 12, start = 0) => Array.from({ length: count }, (_, i) => start + i * BEAT_PERIOD);
const gridOf = (beats, bars) => ({
  version: 1, bpm: 120, confidence: 0.9, duration: 6, onsets: beats, beats, bars,
  tempo: { mode: "follow", beats_per_bar: 4, source: "detected", user_keys: [], detected: null },
});
const lyricsOf = (track, synced, plain = "") => ({
  v: 1, source: "lrclib", track, artist: "Fixture Band", album: "", duration: 6, synced, plain,
  instrumental: false, lrclib_id: 1, others: [],
});
const SERVER_LYRICS = lyricsOf("Fixture Song", "[00:01.00] Line one\n[00:02.00]\n[00:03.00] Line three");
const FIXTURE_TAGS = { artist: "Fixture Band", title: "Fixture Song" };
const heldPromise = () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return { held, release };
};
// The server refuses a section without a colour.
const SECTION_COLOR = "#4a7fff";
const LONG_LINE = "A line long enough that it has to wrap over several rows on any desktop window rather than run out past the sides of it";

const ui = (page) => ({
  count: page.locator("#stageCount"),
  dots: page.locator("#stageBeats i"),
  lyrics: page.locator("#stageLyrics"),
  lyric: page.locator("#stageLyric"),
  next: page.locator("#stageLyricNext"),
});

const clickHidden = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const seek = (page, seconds) =>
  page.evaluate(async (at) => (await import("/js/transport.js")).setPlayheadTime(at), seconds);
const SEEK_SETTLE_MS = 1000;
const SEEK_RETRY_NUDGE_SEC = 0.001;

// Asked again because an engine still coming up can drop a seek, and each time
// a hair apart because the same position again leaves the footer's fill untouched.
const seekShows = (page, seconds, locator, text) => {
  let tries = 0;
  return expect(async () => {
    await seek(page, seconds + tries++ * SEEK_RETRY_NUDGE_SEC);
    await expect(locator).toHaveText(text, { timeout: SEEK_SETTLE_MS });
  }).toPass();
};

async function openTrack(page, id) {
  await clickHidden(page, `.cat-item[data-id="${id}"]`);
  await page.waitForFunction(
    async (track) => (await import("/js/catalog.js")).getCurrentTrackInfo()?.id === track,
    id,
  );
}

const enterStage = (page) => page.locator("#stageModeBtn").click();

// Through the server, which outranks the library's copy when a track opens.
async function saveSections(page, id, sections) {
  const res = await page.request.patch(`/api/jobs/${id}/sections`, { data: { sections } });
  expect(res.ok(), "saving sections").toBe(true);
}

test.afterEach(async ({ page }) => {
  await saveSections(page, JOB_ID, []);
  await saveSections(page, SIBLING_JOB_ID, []);
});

async function waitForGrid(page) {
  await page.waitForFunction(async () => (await import("/js/beatgrid.js")).getBeats().length > 0);
}

/**
 * The studio with the first track open and the tab never opened. `lyrics` and
 * `lookup` map a job id to its answer; a pick or removal is kept in `lyrics`
 * as answerLyricsChoice keeps it, and listed in `choices`. `embedded` is what
 * the first track's file carried; `gate()` holds each read of it.
 */
async function setUp(page, {
  grid = null,
  lyrics = {},
  lookup = {},
  sections = [],
  firstTrackTags = FIXTURE_TAGS,
  lateTags = null,
  embedded = null,
} = {}) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const lookups = [];
  await page.route(LYRICS_LOOKUP, (route) => {
    const id = route.request().url().split("/")[5];
    lookups.push(id);
    return route.fulfill({ status: 200, json: lookup[id] ?? { track: "", others: [] } });
  });
  const choices = [];
  await page.route("**/api/jobs/*/lyrics", async (route) => {
    const id = route.request().url().split("/")[5];
    const held = { lyrics: await lyrics[id] };
    if (await answerLyricsChoice(route, held, choices)) {
      lyrics[id] = held.lyrics;
      return;
    }
    if (!held.lyrics) return route.fulfill({ status: 404, json: { detail: "no lyrics" } });
    return route.fulfill({ status: held.lyrics.source ? 200 : 404, json: held.lyrics });
  });
  await page.route("**/api/jobs/*/vocal-envelope", (route) => route.fulfill({ status: 404, json: {} }));
  if (grid) await page.route("**/api/jobs/*/beats", async (route) => route.fulfill(await grid()));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await stubAudioTags(page, lateTags?.tags ?? null, { hold: lateTags?.held ?? null });
  if (embedded) {
    await page.route(`**/api/jobs/${JOB_ID}`, async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      await embedded.gate();
      await route.fulfill({ response, json: { ...state, audio_tags: { ...FIXTURE_TAGS, lyrics: embedded.lyrics } } });
    });
  }
  await saveSections(page, JOB_ID, sections.map((s) => ({ color: SECTION_COLOR, ...s })));
  await saveSections(page, SIBLING_JOB_ID, []);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: {
        ...fixtureTrack(JOB_ID, "First"),
        ...(firstTrackTags ? { audioTags: firstTrackTags } : {}),
        // Stops the tag backfill, so the embedded read is the only read of this job once it is open.
        ...(embedded ? { workChecked: true } : {}),
      },
      [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, "Second"), audioTags: { artist: "Fixture Band", title: "Other Song" } },
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await page.waitForFunction(
    () => !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00"),
    null,
    { timeout: 20000 },
  );
  return { errors, lookups, choices };
}

const gridAnswer = (beats, bars) => async () => ({ status: 200, json: gridOf(beats, bars) });

test.describe("stage mode counter", () => {
  test("follows a late first mark and a changing bar length, dots and all", async ({ page }) => {
    await setUp(page, {
      grid: gridAnswer(fixtureBeats(), [{ beat: 5, beats_per_bar: 4 }, { beat: 9, beats_per_bar: 2 }]),
    });
    await waitForGrid(page);
    await enterStage(page);
    const { count, dots } = ui(page);

    await expect(count).toHaveText("1.4");
    await expect(dots).toHaveCount(4);
    await expect(dots.nth(3)).toHaveClass(/on/);

    await seekShows(page, 0.6, count, "2.1");
    await expect(dots.nth(0)).toHaveClass(/on/);
    await expect(dots.nth(0)).toHaveClass(/down/);
    await expect(dots.nth(3)).not.toHaveClass(/on/);

    await seekShows(page, 4.6, count, "4.1");
    await expect(dots).toHaveCount(2);

    await seekShows(page, 5.1, count, "4.2");
    await expect(dots.nth(1)).toHaveClass(/on/);
    await expect(dots.nth(1)).not.toHaveClass(/down/);
  });

  test("shows the empty value before the first beat, and runs from it", async ({ page }) => {
    await setUp(page, { grid: gridAnswer(fixtureBeats(8, 2), [{ beat: 0, beats_per_bar: 4 }]) });
    await waitForGrid(page);
    await enterStage(page);
    const { count, dots } = ui(page);
    await expect(count).toHaveText("—");
    await expect(dots).toHaveCount(4);
    await expect(page.locator("#stageBeats i.on")).toHaveCount(0);

    await seekShows(page, 2.1, count, "1.1");
  });

  test("with empty bars, counts at the fallback bar length", async ({ page }) => {
    await setUp(page, { grid: gridAnswer(fixtureBeats(), []) });
    await waitForGrid(page);
    await enterStage(page);
    await seekShows(page, 2.1, ui(page).count, "2.1");
    await expect(ui(page).dots).toHaveCount(4);
  });

  test("with no grid, shows the empty value and no dots", async ({ page }) => {
    await setUp(page, { grid: async () => ({ status: 404, json: { detail: "no grid" } }) });
    await enterStage(page);
    await expect(ui(page).count).toHaveText("—");
    await expect(ui(page).dots).toHaveCount(0);
  });

  test("picks up a grid that arrives after stage opened", async ({ page }) => {
    const { held, release } = heldPromise();
    await setUp(page, {
      grid: async () => {
        await held;
        return { status: 200, json: gridOf(fixtureBeats(), [{ beat: 0, beats_per_bar: 4 }]) };
      },
    });
    await enterStage(page);
    await expect(ui(page).count).toHaveText("—");
    release();
    await expect(ui(page).count).toHaveText("1.1");
  });

  test("rebuilds when the tempo mode switches while in stage", async ({ page }) => {
    await setUp(page);
    await waitForGrid(page);
    await page.locator("#tempoModeConstant").waitFor({ state: "attached" });
    await enterStage(page);
    await seekShows(page, 2.1, ui(page).count, "2.1");

    await page.evaluate(() => {
      const bpm = document.querySelector("#tempoBpm");
      bpm.value = "60";
      bpm.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(ui(page).count).toHaveText("1.3");

    await clickHidden(page, "#tempoReset");
    await expect(ui(page).count).toHaveText("2.1");
  });

  test("keeps to the song's own time at a slowed speed", async ({ page }) => {
    await setUp(page, { grid: gridAnswer(fixtureBeats(), [{ beat: 0, beats_per_bar: 4 }]) });
    await waitForGrid(page);
    await page.locator("#t-speed-075").click();
    await enterStage(page);
    await page.locator("#stagePlayBtn").click();
    await expect(ui(page).count).toHaveText(/^2\./, { timeout: 15000 });

    const { bar, beat, elapsed } = await page.evaluate(async () => {
      const { transport } = await import("/js/transport.js");
      const [shownBar, shownBeat] = document.querySelector("#stageCount").textContent.split(".").map(Number);
      return { bar: shownBar, beat: shownBeat, elapsed: transport().getCurrentTime() };
    });
    const beatTime = ((bar - 1) * BEATS_PER_BAR + beat - 1) * BEAT_PERIOD;
    expect(elapsed - beatTime).toBeGreaterThanOrEqual(0);
    expect(elapsed - beatTime).toBeLessThan(BEAT_PERIOD + FRAME_SLOP_SEC);
  });
});

test("the section, tempo, next section and clock stay beside the counter", async ({ page }) => {
  await setUp(page, {
    sections: [
      { id: "a", start: 0, end: 3, name: "Verse one" },
      { id: "b", start: 3, end: 6, name: "Big chorus" },
    ],
  });
  await waitForGrid(page);
  await enterStage(page);
  await seekShows(page, 1.1, ui(page).count, "1.3");
  await expect(page.locator("#stageSection")).toHaveText("Verse one");
  await expect(page.locator("#stageNext")).toHaveText("Big chorus in 00:01");
  await expect(page.locator("#stageTempo")).toHaveText("120.0 BPM");
});

test.describe("stage mode lyrics", () => {
  test("show the first line as next, then advance, with a gap as a note", async ({ page }) => {
    await setUp(page, { lyrics: { [JOB_ID]: SERVER_LYRICS } });
    await enterStage(page);
    const { lyrics, lyric, next } = ui(page);
    await expect(lyrics).toBeVisible();
    await expect(lyric).toHaveText("");
    await expect(next).toHaveText("Line one");

    await seekShows(page, 1.1, lyric, "Line one");
    await expect(next).toHaveText("♪");

    await seekShows(page, 2.1, lyric, "♪");
    await expect(next).toHaveText("Line three");

    await seekShows(page, 3.1, lyric, "Line three");
    await expect(next).toHaveText("");
  });

  test("advance with playback on stage's own clock, the tab never opened", async ({ page }) => {
    await setUp(page, { lyrics: { [JOB_ID]: SERVER_LYRICS } });
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
    await page.locator("#stagePlayBtn").click();
    await expect(ui(page).lyric).toHaveText("Line one", { timeout: 15000 });
  });

  test("the kept lyrics' Align offset shifts them", async ({ page }) => {
    const kept = { ...lyricsOf("Fixture Song", "[00:01.00] Line one\n[00:03.00] Line three"), offset_sec: 2 };
    await setUp(page, { lyrics: { [JOB_ID]: kept } });
    await enterStage(page);
    const { lyric, next } = ui(page);
    await seekShows(page, 1.1, next, "Line one");
    await expect(lyric).toHaveText("");
    await seekShows(page, 3.1, lyric, "Line one");
    await expect(next).toHaveText("Line three");
  });

  test("a lookup's hit reaches them", async ({ page }) => {
    const { lookups } = await setUp(page, { lookup: { [JOB_ID]: SERVER_LYRICS } });
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
    expect(lookups).toEqual([JOB_ID]);
  });

  test("fall back to no block without lyrics, the counter still running", async ({ page }) => {
    await setUp(page);
    await waitForGrid(page);
    await enterStage(page);
    await expect(ui(page).count).toHaveText("1.1");
    await expect(ui(page).lyrics).toBeHidden();
    await expect(page.locator("#stageView")).not.toContainText("Instrumental");
  });

  test("text without timing gets the same fallback rather than fake lines", async ({ page }) => {
    await setUp(page, { lyrics: { [JOB_ID]: lyricsOf("Fixture Song", "", "Plain one\nPlain two") } });
    await enterStage(page);
    await page.waitForFunction(() => document.querySelector("#lyricsBody .lyrics-text"));
    await expect(ui(page).lyrics).toBeHidden();
  });

  test("Sync lines open on plain text gives the fallback until a line is timed", async ({ page }) => {
    await page.route("**/lyrics/user-synced", (route) => route.fulfill({ status: 200, json: {} }));
    const plain = { ...lyricsOf("Fixture Song", "", "Plain one\nPlain two"), source: "user" };
    await setUp(page, { lyrics: { [JOB_ID]: plain } });
    await page.locator(".rail-lyrics").click();
    await page.locator(".lyrics-sync-toggle").click();
    await expect(page.locator("#lyricsSync")).toBeVisible();
    await enterStage(page);
    await expect(ui(page).count).toBeVisible();
    await page.waitForTimeout(NOTHING_HAPPENS_MS);
    await expect(ui(page).lyrics).toBeHidden();

    await clickHidden(page, ".lyrics-sync-tap");
    await expect(ui(page).lyrics).toBeVisible();
    await expect(ui(page).lyric).toHaveText("Plain one");
  });

  test("a long line wraps inside the view", async ({ page }) => {
    await setUp(page, { lyrics: { [JOB_ID]: lyricsOf("Fixture Song", `[00:00.00] ${LONG_LINE}\n[00:05.00] ${LONG_LINE}`) } });
    await enterStage(page);
    await expect(ui(page).lyric).toHaveText(LONG_LINE);
    const { wraps, overflowsX, overflowsY } = await page.evaluate(() => {
      const view = document.querySelector("#stageView");
      const lyric = document.querySelector("#stageLyric");
      return {
        wraps: lyric.getBoundingClientRect().height > parseFloat(getComputedStyle(lyric).lineHeight) * 1.5,
        overflowsX: view.scrollWidth > view.clientWidth,
        overflowsY: view.scrollHeight > view.clientHeight,
      };
    });
    expect({ wraps, overflowsX, overflowsY }).toEqual({ wraps: true, overflowsX: false, overflowsY: false });
  });

  test("repaint while paused when the Align offset moves them", async ({ page }) => {
    await page.route("**/lyrics/offset", (route) => route.fulfill({ status: 200, json: {} }));
    await setUp(page, { lyrics: { [JOB_ID]: lyricsOf("Fixture Song", "[00:01.00] Line one\n[00:03.00] Line three") } });
    await page.locator(".rail-lyrics").click();
    await page.locator(".lyrics-align-toggle").click();
    await enterStage(page);
    await seekShows(page, 1.2, ui(page).lyric, "Line one");

    await page.evaluate(() => document.querySelectorAll(".lyrics-align-nudge")[3].click());
    await expect(ui(page).lyric).toHaveText("");
    await expect(ui(page).next).toHaveText("Line one");
  });

  test("repaint while paused when Sync lines moves them", async ({ page }) => {
    await page.route("**/lyrics/user-synced", (route) => route.fulfill({ status: 200, json: {} }));
    await setUp(page, { lyrics: { [JOB_ID]: lyricsOf("Fixture Song", "[00:01.00] Line one\n[00:03.00] Line three") } });
    await page.locator(".rail-lyrics").click();
    await page.locator(".lyrics-sync-toggle").click();
    await enterStage(page);
    await seekShows(page, 1.2, ui(page).lyric, "Line one");

    await clickHidden(page, ".lyrics-sync-tap");
    await seekShows(page, 1.5, ui(page).lyric, "Line one");
    await clickHidden(page, ".lyrics-sync-tap");
    await expect(ui(page).lyric).toHaveText("Line three");
  });
});

test.describe("stage mode entered again", () => {
  test("the same song, back before the first line, shows no current line", async ({ page }) => {
    await setUp(page, { lyrics: { [JOB_ID]: SERVER_LYRICS } });
    await enterStage(page);
    await seekShows(page, 1.1, ui(page).lyric, "Line one");
    await page.locator("#stageExitBtn").click();
    await seek(page, 0);

    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
    await expect(ui(page).lyric).toHaveText("");
  });

  test("a song with no sections shows no section", async ({ page }) => {
    await setUp(page, { sections: [{ id: "a", start: 0, end: 6, name: "Verse one" }] });
    await enterStage(page);
    await expect(page.locator("#stageSection")).toHaveText("Verse one");
    await page.locator("#stageExitBtn").click();
    await openTrack(page, SIBLING_JOB_ID);

    await enterStage(page);
    await expect(page.locator("#stageTitle")).toContainText("Other Song");
    await expect(page.locator("#stageSection")).toHaveText("");
  });

  test("another song before its first line shows no line of the last song", async ({ page }) => {
    await setUp(page, {
      lyrics: { [JOB_ID]: SERVER_LYRICS, [SIBLING_JOB_ID]: lyricsOf("Other Song", "[00:01.00] Other one") },
    });
    await enterStage(page);
    await seekShows(page, 1.1, ui(page).lyric, "Line one");
    await page.locator("#stageExitBtn").click();
    await openTrack(page, SIBLING_JOB_ID);

    await enterStage(page);
    await expect(ui(page).next).toHaveText("Other one");
    await expect(ui(page).lyric).toHaveText("");
  });
});

test.describe("stage mode and the Lyrics tab's load", () => {
  test("a lookup that found nothing this session is not repeated", async ({ page }) => {
    const { lookups } = await setUp(page);
    await enterStage(page);
    await expect.poll(() => lookups).toEqual([JOB_ID]);

    await openTrack(page, SIBLING_JOB_ID);
    await expect.poll(() => lookups).toEqual([JOB_ID, SIBLING_JOB_ID]);
    await openTrack(page, JOB_ID);
    await expect(ui(page).lyrics).toBeHidden();
    await expect(page.locator("#lyricsStatus")).toContainText("Fixture Song");
    expect(lookups).toEqual([JOB_ID, SIBLING_JOB_ID]);
  });

  test("lyrics the user removed stay removed", async ({ page }) => {
    const { lookups } = await setUp(page, { lyrics: { [JOB_ID]: LYRICS_REMOVED } });
    await enterStage(page);
    await page.waitForFunction(() => document.querySelector("#lyricsStatus")?.textContent);
    await expect(ui(page).lyrics).toBeHidden();
    await expect(page.locator("#lyricsStatus")).toHaveText("Lyrics removed for this track.");
    expect(lookups).toEqual([]);
  });

  test("the tab opened after stage shows the open track's lyrics, not stale ones", async ({ page }) => {
    const { errors } = await setUp(page, {
      lyrics: { [JOB_ID]: SERVER_LYRICS, [SIBLING_JOB_ID]: lyricsOf("Other Song", "[00:01.00] Other one") },
    });
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
    await openTrack(page, SIBLING_JOB_ID);
    await expect(ui(page).next).toHaveText("Other one");
    await page.locator("#stageExitBtn").click();

    await page.locator(".rail-lyrics").click();
    await expect(page.locator(".lyrics-line")).toHaveText(["Other one"]);
    await expect(page.locator(".lyrics-match-title")).toHaveText("Other Song");
    expect(errors).toEqual([]);
  });

  test("a page without the tab's elements still opens stage", async ({ page }) => {
    await page.route("**/", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('id="lyricsBody"', 'id="lyricsBodyGone"') });
    });
    const { errors } = await setUp(page);
    await waitForGrid(page);
    await enterStage(page);
    await expect(ui(page).count).toHaveText("1.1");
    await expect(ui(page).lyrics).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("a track switch during a load never paints the old song", async ({ page }) => {
    const { held, release } = heldPromise();
    await setUp(page, {
      lyrics: {
        [JOB_ID]: held,
        [SIBLING_JOB_ID]: lyricsOf("Other Song", "[00:01.00] Other one"),
      },
    });
    await enterStage(page);
    await openTrack(page, SIBLING_JOB_ID);
    await expect(ui(page).next).toHaveText("Other one");

    const painted = [];
    await page.exposeFunction("__lyricPainted", (text) => painted.push(text));
    await page.evaluate(() => {
      const observer = new MutationObserver(() => window.__lyricPainted(document.querySelector("#stageLyricNext").textContent));
      observer.observe(document.querySelector("#stageLyrics"), { childList: true, subtree: true, characterData: true });
    });
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${JOB_ID}/lyrics`));
    release(SERVER_LYRICS);
    await answered;
    await page.waitForTimeout(NOTHING_HAPPENS_MS);
    expect(painted).toEqual([]);
    await expect(ui(page).next).toHaveText("Other one");
  });

  test("a load left behind by a switch saves nothing under the new track, and runs again on return", async ({ page }) => {
    const firstLoad = heldPromise();
    let gate = Promise.resolve();
    const { choices } = await setUp(page, {
      firstTrackTags: { ...FIXTURE_TAGS, hasLyrics: true },
      embedded: { lyrics: "[00:01.00] Line one", gate: () => gate },
    });
    gate = firstLoad.held;
    const read = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${JOB_ID}`));
    await enterStage(page);
    await read;
    await page.locator("#stageExitBtn").click();
    await openTrack(page, SIBLING_JOB_ID);

    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${JOB_ID}`));
    firstLoad.release();
    await answered;
    await page.waitForTimeout(NOTHING_HAPPENS_MS);
    expect(choices).toEqual([]);

    gate = Promise.resolve();
    await openTrack(page, JOB_ID);
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
  });

  test("a version picked in the visible tab is saved to its track", async ({ page }) => {
    const live = { ...lyricsOf("Fixture Song", "", "Live words"), album: "Live", lrclib_id: 2 };
    const { choices } = await setUp(page, { lyrics: { [JOB_ID]: { ...SERVER_LYRICS, others: [live] } } });
    await page.locator(".rail-lyrics").click();
    await page.locator(".lyrics-versions-toggle").click();
    await page.locator(".lyrics-version", { hasText: "Live" }).click();

    await expect(page.locator(".lyrics-text").first()).toHaveText("Live words");
    expect(choices.map((c) => [c.method, new URL(c.url).pathname, c.body.lrclib_id])).toEqual([
      ["PUT", `/api/jobs/${JOB_ID}/lyrics`, live.lrclib_id],
    ]);
  });

  test("tags that arrive after stage said nothing is known bring the lookup", async ({ page }) => {
    const tags = heldPromise();
    const { lookups } = await setUp(page, {
      firstTrackTags: null,
      lookup: { [JOB_ID]: SERVER_LYRICS },
      lateTags: { tags: FIXTURE_TAGS, held: tags.held },
    });
    await enterStage(page);
    await expect(page.locator("#lyricsStatus")).not.toHaveText("");
    expect(lookups).toEqual([]);

    tags.release();
    await expect(ui(page).next).toHaveText("Line one");
    expect(lookups).toEqual([JOB_ID]);
  });

  test("a rename's new lookup shows at once in an open stage", async ({ page }) => {
    const lyrics = { [JOB_ID]: SERVER_LYRICS };
    await setUp(page, { lyrics });
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");

    lyrics[JOB_ID] = lyricsOf("Fixture Song", "[00:01.00] Renamed one");
    await page.evaluate(async (id) => (await import("/js/catalog.js")).relookupTrack(id), JOB_ID);
    await expect(ui(page).next).toHaveText("Renamed one");
  });

  test("a rename's new lookup shows on the next stage, the tab still hidden", async ({ page }) => {
    const lyrics = { [JOB_ID]: SERVER_LYRICS };
    await setUp(page, { lyrics });
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Line one");
    await page.locator("#stageExitBtn").click();

    lyrics[JOB_ID] = lyricsOf("Fixture Song", "[00:01.00] Renamed one");
    await page.evaluate(async (id) => (await import("/js/catalog.js")).relookupTrack(id), JOB_ID);
    await enterStage(page);
    await expect(ui(page).next).toHaveText("Renamed one");
  });
});
