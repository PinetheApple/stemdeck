// Sing along in Stage: the look is remembered, the voice comes out of the song without
// touching its saved mix, the lyrics fill word by word, and Up Next opens beside them.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID, SIBLING_JOB_ID } from "./helpers.mjs";
import {
  LYRICS,
  SONG_OPEN_TIMEOUT_MS,
  UP_NEXT_KEY,
  call,
  enterSingAlong,
  openSongId,
  rewriteJobState,
  seedUpNext,
  seekTo,
  serveLyrics,
  silenced,
  stored,
} from "./singAlongHelpers.mjs";
import { singStoreKey } from "../../static/js/stageSingModel.js";

const TRANSCRIBE_IDLE = { state: "idle", available: true, unavailable: null, device: "cuda" };
const TRANSCRIBE_RUNNING = {
  state: "running",
  phase: "queued",
  progress: 0,
  available: true,
  unavailable: null,
  device: "cuda",
};
const UNTIMED_LYRICS = { ...LYRICS, synced: "", plain: "Hold the line\nEvery word" };
const FIRST_LINE = "Hold the line until the morning";
const NEXT_LINE = "Every word a little closer";
const MID_FIRST_LINE_SEC = 2.9;
const LOOK_KEY = "stemdeck.stage.look";
const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const HEARD = "drums";
const HEARD_LEVEL = 0.5;
const SPLIT = ["lead_vocals", "backing_vocals"];
const LEAD_ONLY = ["lead_vocals"];
const WINDOWS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

const voice = (page) => page.locator("#singVoiceBtn");
const backing = (page) => page.locator("#singBackingBtn");

/** The fixture's vocals served again under `names`, so a split (or half of one) loads. */
const withVocalsAs = (names) => (state) => {
  const vocals = state.stems.find((s) => s.name === "vocals");
  return {
    ...state,
    selected_stems: [...(state.selected_stems ?? state.stems.map((s) => s.name)), ...names],
    stems: [...state.stems, ...names.map((name) => ({ ...vocals, name }))],
  };
};

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

  test("voice is off per song until turned on, then remembered; the saved mix never changes", async ({ page }) => {
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
    expect(await stored(page, singStoreKey(JOB_ID))).toEqual({ voice: true });
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

  test("a mix reloaded for the same song, as a version switch does, keeps the voice out", async ({ page }) => {
    await serveLyrics(page);
    await openStudio(page);
    await enterSingAlong(page);
    await expect.poll(() => silenced(page, "vocals")).toBe(true);
    const loaded = await call(page, "/js/player.js", "getLoadedStemNames");
    await call(page, "/js/mixer.js", "loadMixIntoState", JOB_ID, loaded);
    await call(page, "/js/mixer.js", "refreshMixerVisuals");
    expect(await silenced(page, "vocals")).toBe(true);
  });

  test("with a vocal split, Backing starts on and only the lead goes quiet", async ({ page }) => {
    await serveLyrics(page);
    await rewriteJobState(page, JOB_ID, withVocalsAs(SPLIT));
    await openStudio(page);
    await enterSingAlong(page);
    await expect(backing(page)).toBeEnabled();
    await expect(backing(page)).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => silenced(page, "lead_vocals")).toBe(true);
    expect(await silenced(page, "backing_vocals")).toBe(false);
    await backing(page).click();
    await expect.poll(() => silenced(page, "backing_vocals")).toBe(true);
  });

  test("with half a split on the server, Backing is off and Voice silences what loaded", async ({ page }) => {
    await serveLyrics(page);
    await rewriteJobState(page, JOB_ID, withVocalsAs(LEAD_ONLY));
    await openStudio(page);
    await enterSingAlong(page);
    await expect(backing(page)).toBeDisabled();
    const loaded = await call(page, "/js/player.js", "getLoadedStemNames");
    const vocals = loaded.filter((name) => ["vocals", ...SPLIT].includes(name));
    expect(vocals.length).toBeGreaterThan(0);
    for (const name of vocals) await expect.poll(() => silenced(page, name)).toBe(true);
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
    await expect(page.locator("#singLineNow .lw.sung").first()).toBeVisible();
    await expect(page.locator("#singLineNow .lw:not(.sung)").first()).toBeVisible();
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

  test("untimed lyrics say they are not timed, with Open lyrics and no Transcribe", async ({ page }) => {
    await serveLyrics(page, UNTIMED_LYRICS);
    await openStudio(page);
    await enterSingAlong(page);
    await expect(page.locator("#singEmptyText")).toHaveText("These lyrics aren't timed");
    await expect(page.locator("#singOpenLyricsBtn")).toBeVisible();
    await expect(page.locator("#singTranscribeBtn")).toBeHidden();
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

  test("the Up Next chip lends the studio's list to a panel, Alt+Down reorders it, it goes back", async ({ page }) => {
    await serveLyrics(page);
    await seedUpNext(page, [SIBLING_JOB_ID, JOB_ID]);
    await openStudio(page);
    await enterSingAlong(page);
    const chip = page.locator("#singUpNextBtn");
    await expect(page.locator("#singUpNextCount")).toHaveText("2");
    await chip.click();
    await expect(page.locator("#singPanel #upNextList .upnext-row")).toHaveCount(2);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await page.locator(`#singPanel .upnext-row[data-id="${SIBLING_JOB_ID}"]`).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => stored(page, UP_NEXT_KEY)).toEqual([JOB_ID, SIBLING_JOB_ID]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#singPanel")).toBeHidden();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#stageView")).toBeVisible();
    await expect(page.locator("#inspectorPaneUpNext #upNextList")).toHaveCount(1);

    await chip.click();
    await page.locator("#stageExitBtn").click();
    await expect(page.locator("#stageModeBtn")).toBeFocused();
    await expect(page.locator("#inspectorPaneUpNext #upNextList")).toHaveCount(1);
  });
});

for (const size of WINDOWS) {
  test(`sing along fits ${size.width}x${size.height} with the lyrics and Up Next open`, async ({ page }) => {
    await page.setViewportSize(size);
    await serveLyrics(page);
    await seedUpNext(page, [SIBLING_JOB_ID]);
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
      const chip = rect("singUpNextBtn");
      return {
        overflows: view.scrollHeight > view.clientHeight || view.scrollWidth > view.clientWidth,
        headerInOrder: header.every((r, i) => i === 0 || header[i - 1].right <= r.left),
        headerClearOfTitle: rect("stageTitle").right <= header[0].left,
        lyricsAboveTransport: lyrics.bottom <= transport.top,
        lyricsBesidePanel: lyrics.right <= panel.left,
        panelInside: panel.right <= viewRect.right && panel.bottom <= viewRect.bottom,
        transportInside: transport.bottom <= viewRect.bottom,
        voiceClearOfButtons: rect("singBackingBtn").right <= rect("stageStopBtn").left,
        chipClearOfButtons: rect("stageNextBtn").right <= chip.left && chip.right <= panel.left,
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
      chipClearOfButtons: true,
    });
  });
}
