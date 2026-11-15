// Sing along in Stage: the look is remembered, the voice comes out of the song without
// touching its saved mix, the lyrics fill word by word, and Up Next hands over at song end.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE } from "./helpers.mjs";

const FIXTURE_SECONDS = 6;
const LYRICS = {
  v: 1, source: "lrclib", track: "Fixture Song", artist: "Fixture Band", album: "", duration: FIXTURE_SECONDS,
  synced: "[00:02.00] Hold the line until the morning\n[00:04.00] Every word a little closer",
  plain: "", instrumental: false, lrclib_id: 1, others: [],
};
const TRANSCRIBE_IDLE = { state: "idle", available: true, unavailable: null, device: "cuda" };
const TRANSCRIBE_RUNNING = { state: "running", phase: "queued", progress: 0, available: true, unavailable: null, device: "cuda" };
const FIRST_LINE ="Hold the line until the morning";
const NEXT_LINE = "Every word a little closer";
const MID_FIRST_LINE_SEC = 2.9;
const LOOK_KEY = "stemdeck.stage.look";
const UP_NEXT_KEY = "stemdeck.upNext";
const VOICE_KEY = `stemdeck:singalong:${JOB_ID}`;
const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const HEARD = "drums";
const HEARD_LEVEL = 0.5;
const SPLIT = ["lead_vocals", "backing_vocals"];
const COUNTDOWN_SECONDS = "5";
const COUNTDOWN_RUNS_OUT_MS = 8000;
// Longer than the countdown, to see that nothing starts after Stay here.
const PAST_COUNTDOWN_MS = 6000;
const SONG_OPEN_TIMEOUT_MS = 20000;
const WINDOWS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

const call = (page, module, name, ...args) => page.evaluate(
  async ([path, fn, callArgs]) => (await import(path))[fn](...callArgs),
  [module, name, args],
);
const silenced = (page, stem) => call(page, "/js/mixer.js", "isLaneSilenced", stem);
const openSongId = (page) => page.evaluate(async () => (await import("/js/catalog.js")).getCurrentTrackInfo()?.id);
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
const voice = (page) => page.locator("#singVoiceBtn");
const backing = (page) => page.locator("#singBackingBtn");

async function serveLyrics(page, lyrics = LYRICS) {
  await page.route("**/api/jobs/*/lyrics", (route) => (lyrics
    ? route.fulfill({ status: 200, json: lyrics })
    : route.fulfill({ status: 404, json: { detail: "no lyrics" } })));
  await page.route(/\/api\/jobs\/[a-f0-9]{12}\/lyrics\/lookup$/, (route) => route.fulfill({ status: 404, json: { detail: "no lyrics" } }));
}

async function queueSibling(page) {
  await page.addInitScript(([key, id]) => localStorage.setItem(key, JSON.stringify([id])), [UP_NEXT_KEY, SIBLING_JOB_ID]);
}

async function enterSingAlong(page) {
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView")).toBeVisible();
  await page.locator("#stageLookSing").click();
  await expect(page.locator("#stageView")).toHaveClass(/\bsing\b/);
}

async function seekTo(page, seconds) {
  await page.evaluate(async (at) => (await import("/js/transport.js")).setPlayheadTime(at), seconds);
}

const endSong = (page) => page.evaluate((id) => document.dispatchEvent(new CustomEvent("trackended", { detail: { id } })), JOB_ID);

/** The fixture's vocals served again as a lead/backing split. */
function withSplit(state) {
  const vocals = state.stems.find((s) => s.name === "vocals");
  return {
    ...state,
    selected_stems: [...(state.selected_stems ?? state.stems.map((s) => s.name)), ...SPLIT],
    stems: [...state.stems, ...SPLIT.map((name) => ({ ...vocals, name }))],
  };
}

test.describe("sing along", () => {
  test("the chosen look is remembered, and Sing along hides the mixer and the overview", async ({ page }) => {
    await serveLyrics(page);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#stageLookSing")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#stageMixer")).toBeHidden();
    await expect(page.locator("#stageOverview")).toBeHidden();
    await expect(page.locator("#stageMixBtn")).toBeHidden();
    expect(await page.evaluate((k) => localStorage.getItem(k), LOOK_KEY)).toBe("sing");

    await page.reload();
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
    await page.keyboard.press("f");
    await expect(page.locator("#stageView")).toHaveClass(/\bsing\b/);
    await page.locator("#stageLookPlay").click();
    await expect(page.locator("#stageMixer")).toBeVisible();
    await expect(page.locator("#stageOverview")).toBeVisible();
  });

  test("voice is off on every song until turned on, remembered per song, and the saved mix never changes", async ({ page }) => {
    await serveLyrics(page);
    await openStudio(page);
    await call(page, "/js/mixer.js", "setLaneVolume", HEARD, HEARD_LEVEL);
    await expect.poll(() => stored(page, MIX_KEY).then((mix) => mix?.[HEARD]?.volume)).toBe(HEARD_LEVEL);
    const savedMix = await stored(page, MIX_KEY);

    await enterSingAlong(page);
    await expect(voice(page)).toHaveAttribute("aria-checked", "false");
    await expect(backing(page)).toBeDisabled();
    await expect.poll(() => silenced(page, "vocals")).toBe(true);
    await voice(page).click();
    await expect(voice(page)).toHaveAttribute("aria-checked", "true");
    expect(await silenced(page, "vocals")).toBe(false);
    expect(await stored(page, VOICE_KEY)).toEqual({ voice: true });
    await voice(page).click();
    await expect.poll(() => silenced(page, "vocals")).toBe(true);
    await voice(page).click();

    await call(page, "/js/catalog.js", "loadTrackIntoStudio", SIBLING_JOB_ID);
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(voice(page)).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => silenced(page, "vocals"), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(true);
    await call(page, "/js/catalog.js", "loadTrackIntoStudio", JOB_ID);
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(JOB_ID);
    await expect(voice(page)).toHaveAttribute("aria-checked", "true");

    await page.locator("#stageExitBtn").click();
    expect(await silenced(page, "vocals")).toBe(false);
    expect(await stored(page, MIX_KEY)).toEqual(savedMix);
    expect(savedMix.vocals?.muted ?? false).toBe(false);
  });

  test("with a vocal split, Backing starts on and only the lead goes quiet", async ({ page }) => {
    await serveLyrics(page);
    await page.route(`**/api/jobs/${JOB_ID}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withSplit(await response.json()) });
    });
    await openStudio(page);
    await enterSingAlong(page);
    await expect(backing(page)).toBeEnabled();
    await expect(backing(page)).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => silenced(page, "lead_vocals")).toBe(true);
    expect(await silenced(page, "backing_vocals")).toBe(false);
    await backing(page).click();
    await expect.poll(() => silenced(page, "backing_vocals")).toBe(true);
  });

  test("words fill as they are sung, after a countdown to the first line", async ({ page }) => {
    await serveLyrics(page);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#singIntro")).toBeVisible();
    await expect(page.locator("#singIntroTime")).toHaveText("0:02");
    await expect(page.locator("#singLineNow")).toHaveText(FIRST_LINE);

    await seekTo(page, MID_FIRST_LINE_SEC);
    await expect(page.locator("#singIntro")).toBeHidden();
    await expect(page.locator("#singLineNear")).toHaveText(NEXT_LINE);
    await expect(page.locator("#singLineNow .sing-word.sung").first()).toBeVisible();
    await expect(page.locator("#singLineNow .sing-word:not(.sung)").first()).toBeVisible();
  });

  test("song end in Sing along counts down to the next song, and Stay here keeps this one", async ({ page }) => {
    await serveLyrics(page);
    await queueSibling(page);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#singUpNextTitle")).toHaveText(SIBLING_TITLE);
    await endSong(page);
    await expect(page.locator("#singHandoff")).toBeVisible();
    await expect(page.locator("#singHandoffTitle")).toHaveText(SIBLING_TITLE);
    await expect(page.locator("#singRingNum")).toHaveText(COUNTDOWN_SECONDS);
    await expect(page.locator("#singLyrics")).toBeHidden();
    await page.locator("#singStayBtn").click();
    await expect(page.locator("#singHandoff")).toBeHidden();
    await page.waitForTimeout(PAST_COUNTDOWN_MS);
    expect(await openSongId(page)).toBe(JOB_ID);
  });

  test("song end in Sing along: Play now starts the next song, and so does the countdown running out", async ({ page }) => {
    await serveLyrics(page);
    await queueSibling(page);
    await openStudio(page);
    await enterSingAlong(page);
    await endSong(page);
    await page.locator("#singPlayNowBtn").click();
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(page.locator("#singHandoff")).toBeHidden();

    await call(page, "/js/upNext.js", "queueUpNext", JOB_ID);
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent("trackended", { detail: { id } })), SIBLING_JOB_ID);
    await expect(page.locator("#singHandoff")).toBeVisible();
    await expect.poll(() => openSongId(page), { timeout: COUNTDOWN_RUNS_OUT_MS }).toBe(JOB_ID);
  });

  test("song end in Play along goes straight to the next song", async ({ page }) => {
    await serveLyrics(page);
    await queueSibling(page);
    await openStudio(page);
    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageLookPlay")).toHaveAttribute("aria-checked", "true");
    await endSong(page);
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(page.locator("#singHandoff")).toBeHidden();
  });

  test("a song with no lyrics says so, and Open lyrics leaves Stage for the Lyrics tab", async ({ page }) => {
    await serveLyrics(page, null);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#singEmptyText")).toHaveText("No lyrics for this song");
    await expect(page.locator("#singLyrics")).toBeHidden();
    await page.locator("#singOpenLyricsBtn").click();
    await expect(page.locator("#stageView")).toBeHidden();
    await expect(page.locator(".rail-lyrics")).toHaveAttribute("aria-pressed", "true");
  });

  test("on a song with no lyrics, Transcribe starts the Lyrics tab's own transcription", async ({ page }) => {
    const starts = [];
    await serveLyrics(page, null);
    await page.route(`**/api/jobs/${JOB_ID}/lyrics/transcribe`, (route) => {
      if (route.request().method() !== "POST") return route.fulfill({ status: 200, json: TRANSCRIBE_IDLE });
      starts.push(JOB_ID);
      return route.fulfill({ status: 202, json: TRANSCRIBE_RUNNING });
    });
    await openStudio(page);
    await enterSingAlong(page);
    await page.locator("#singTranscribeBtn").click();
    await expect.poll(() => starts.length).toBe(1);
    await expect(page.locator("#singTranscribeBtn")).toBeHidden();
    await expect(page.locator("#stageView")).toBeVisible();
  });

  test("the Up Next chip lends the studio's list to a side panel, Alt+Down reorders it, and it goes back", async ({ page }) => {
    await serveLyrics(page);
    await page.addInitScript(([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)), [UP_NEXT_KEY, [SIBLING_JOB_ID, JOB_ID]]);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#singUpNextCount")).toHaveText("2");
    await page.locator("#singUpNextBtn").click();
    await expect(page.locator("#singPanel #upNextList .upnext-row")).toHaveCount(2);
    await expect(page.locator("#singUpNextBtn")).toBeHidden();
    await page.locator(`#singPanel .upnext-row[data-id="${SIBLING_JOB_ID}"]`).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => stored(page, UP_NEXT_KEY)).toEqual([JOB_ID, SIBLING_JOB_ID]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#singPanel")).toBeHidden();
    await expect(page.locator("#stageView")).toBeVisible();
    await expect(page.locator("#inspectorPaneUpNext #upNextList")).toHaveCount(1);
  });
});

for (const size of WINDOWS) {
  test(`sing along fits ${size.width}x${size.height} with the lyrics and Up Next open`, async ({ page }) => {
    await page.setViewportSize(size);
    await serveLyrics(page);
    await queueSibling(page);
    await openStudio(page);
    await enterSingAlong(page);
    await seekTo(page, MID_FIRST_LINE_SEC);
    await page.locator("#singUpNextBtn").click();
    const fit = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const view = document.getElementById("stageView");
      const viewRect = view.getBoundingClientRect();
      const transport = document.querySelector(".stage-transport").getBoundingClientRect();
      const lyrics = rect("singLyrics");
      const panel = rect("singPanel");
      const header = ["stageUpNextBtn", "stageMoreBtn", "stageLook", "stageExitBtn"].map(rect);
      const voice = rect("singBackingBtn");
      const play = rect("stageStopBtn");
      return {
        overflows: view.scrollHeight > view.clientHeight || view.scrollWidth > view.clientWidth,
        headerInOrder: header.every((r, i) => i === 0 || header[i - 1].right <= r.left),
        headerClearOfTitle: rect("stageTitle").right <= header[0].left,
        lyricsAboveTransport: lyrics.bottom <= transport.top,
        lyricsBesidePanel: lyrics.right <= panel.left,
        panelInside: panel.right <= viewRect.right && panel.bottom <= viewRect.bottom,
        transportInside: transport.bottom <= viewRect.bottom,
        voiceClearOfButtons: voice.right <= play.left,
      };
    });
    expect(fit).toEqual({
      overflows: false,
      headerInOrder: true,
      headerClearOfTitle: true,
      lyricsAboveTransport: true,
      lyricsBesidePanel: true,
      panelInside: true,
      transportInside: true,
      voiceClearOfButtons: true,
    });
  });
}
