// Saved grid and tempo edits across the player's own switch from the chunked
// engine to the full decode. The switch is the one a song without waveform peaks
// takes, so holding the peaks answer lets the edits land on the chunked engine first.
import { test, expect } from "@playwright/test";
import { JOB_ID } from "./helpers.mjs";
import { beatsUrl, savedTempo, savedBarLength, openTempo, resetSongs } from "./saveRaces.mjs";

test.afterEach(resetSongs);

const PEAKS_URL = `**/api/jobs/${JOB_ID}/peaks`;
const NO_PEAKS = {};
const DETECTED_BPM = 120;
const EDITED_BEATS_PER_BAR = 3;
const BPM_DECIMALS = 3;

/** Hold every peaks request until `release()`, then answer that the song has none. */
async function holdPeaks(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(PEAKS_URL, async function answerNoPeaks(route) {
    await held;
    await route.fulfill({ json: NO_PEAKS });
  });
  return { release };
}

/** The grid shown, the tempo shown and the click's beats, with the engine playing them. */
function playerGrid(page) {
  return page.evaluate(async (decimals) => {
    const grid = await import("/js/beatgrid.js");
    const { metronome, audioEngine } = await import("/js/state.js");
    return {
      readout: document.querySelector("#tempoReadout").textContent,
      shownBars: grid.getBars(),
      shownBeats: grid.getBeats(),
      clickCount: metronome.getBeatCount(),
      clickBpm: Number(metronome.getEffectiveBpm().toFixed(decimals)),
      fullDecode: audioEngine.getBuffers().size > 0,
    };
  }, BPM_DECIMALS);
}

async function saveTempoStep(page) {
  const reloaded = page.waitForResponse((r) => r.url().endsWith(beatsUrl(JOB_ID)) && r.request().method() === "GET");
  await page.locator("#tempoBpmUp").click();
  await reloaded;
}

function saveGridBars(page, beatsPerBar) {
  return page.evaluate(async (n) => {
    const grid = await import("/js/beatgrid.js");
    grid.setBarLengthAt(0, n);
    await grid.flushBeatGrid();
  }, beatsPerBar);
}

/** Resolves once a click other than the one running now is built over a new engine. */
async function nextEngineClick(page) {
  await page.evaluate(async () => {
    window.playerState = await import("/js/state.js");
    window.clickBeforeSwitch = window.playerState.metronome;
  });
  return () => page.waitForFunction(() => {
    const { metronome } = window.playerState;
    return metronome && metronome !== window.clickBeforeSwitch;
  });
}

test("saved grid and tempo edits stay shown and clicked after the switch to the full decode", async ({ page, request }) => {
  const peaks = await holdPeaks(page);
  await openTempo(page);
  await saveTempoStep(page);
  const savedBpm = (await savedTempo(request, JOB_ID)).bpm;
  expect(savedBpm).toBeGreaterThan(DETECTED_BPM);
  await saveGridBars(page, EDITED_BEATS_PER_BAR);
  await expect.poll(() => savedBarLength(request, JOB_ID)).toBe(EDITED_BEATS_PER_BAR);
  const edited = await playerGrid(page);
  expect(edited.fullDecode).toBe(false);
  expect(edited.clickBpm).toBeCloseTo(savedBpm, BPM_DECIMALS);

  const switched = await nextEngineClick(page);
  peaks.release();
  await switched();

  const after = await playerGrid(page);
  expect(after.fullDecode).toBe(true);
  expect(after).toEqual({ ...edited, fullDecode: true });
});
