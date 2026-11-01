// The fixture is a steady 120 BPM, 4/4 from beat 0, six seconds long, so the
// server fits it as constant tempo anchored at 0.

import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, waitForClickTrack } from "./helpers.mjs";

const BEATS_URL = `/api/jobs/${JOB_ID}/beats`;
const RESET = { mode: null, bpm: null, anchor: null, beats_per_bar: null };

const tools = (page) => ({
  readout: page.locator("#tempoReadout"),
  source: page.locator("#tempoSource"),
  constant: page.locator("#tempoModeConstant"),
  follow: page.locator("#tempoModeFollow"),
  bpm: page.locator("#tempoBpm"),
  tap: page.locator("#tempoTap"),
  half: page.locator("#tempoHalf"),
  double: page.locator("#tempoDouble"),
  later: page.locator("#tempoNudgeLater"),
  beatOne: page.locator("#tempoBeatOne"),
  perBar: page.locator("#tempoBeatsPerBar"),
  reset: page.locator("#tempoReset"),
  note: page.locator("#t-metro-note"),
  anchor: page.locator("#tempoAnchor"),
  bpmDetected: page.locator("#tempoBpmDetected"),
  anchorDetected: page.locator("#tempoAnchorDetected"),
  perBarDetected: page.locator("#tempoBeatsPerBarDetected"),
  accent: page.locator("#t-metro-bar"),
});

/** The next tempo PATCH's body, and the grid reload that follows it. */
async function patchFrom(page, action) {
  const reloaded = page.waitForResponse((r) => r.url().endsWith(BEATS_URL) && r.request().method() === "GET");
  const sent = page.waitForRequest((r) => r.url().endsWith(BEATS_URL) && r.method() === "PATCH");
  await action();
  const body = (await sent).postDataJSON();
  await reloaded;
  return body;
}

/** The lines the grid over the lanes draws, beside the click's beat count. */
function drawn(page) {
  return page.evaluate(async () => {
    const grid = await import("/js/beatgrid.js");
    const { metronome } = await import("/js/state.js");
    return { lines: grid.getShownGridLines().map((l) => l.t), clickCount: metronome.getBeatCount() };
  });
}

/** What the lanes draw and what the click plays. */
function heard(page) {
  return page.evaluate(async () => {
    const grid = await import("/js/beatgrid.js");
    const { metronome } = await import("/js/state.js");
    const beats = grid.getBeats();
    return {
      first: beats[0],
      period: Number((beats[1] - beats[0]).toFixed(6)),
      count: beats.length,
      bars: grid.getBars(),
      clickCount: metronome.getBeatCount(),
      clickBpm: Number(metronome.getEffectiveBpm().toFixed(3)),
    };
  });
}

async function openTempo(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page);
  await expect(tools(page).constant).toBeEnabled();
}

test.describe("tempo tools", () => {
  test.afterEach(async ({ request }) => {
    await request.patch(BEATS_URL, { data: { tempo: RESET } });
  });

  test("the detected tempo shows as constant and detected", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    await expect(ui.constant).toHaveAttribute("aria-checked", "true");
    await expect(ui.readout).toHaveText("120.0");
    await expect(ui.source).toHaveText("Detected");
    await expect(ui.reset).toBeDisabled();
    await expect(ui.perBar).toHaveValue("4");
    await expect(ui.anchor).toHaveText("0.000 s");
    for (const chip of [ui.bpmDetected, ui.anchorDetected, ui.perBarDetected]) await expect(chip).toBeHidden();
  });

  test("an edited field shows the detected value beside it and resets on its own", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    await patchFrom(page, async () => {
      await ui.bpm.fill("100");
      await ui.bpm.press("Enter");
    });
    await expect(ui.bpmDetected).toHaveText("Detected 120.0");
    await expect(ui.anchorDetected).toBeHidden();
    await patchFrom(page, () => ui.later.click());
    await expect(ui.anchor).toHaveText("0.010 s");
    await expect(ui.anchorDetected).toHaveText("Detected 0.000 s");

    expect(await patchFrom(page, () => ui.bpmDetected.click())).toEqual({ tempo: { bpm: null } });
    await expect(ui.readout).toHaveText("120.0");
    await expect(ui.bpmDetected).toBeHidden();
    await expect(ui.source).toHaveText("Your tempo");
    await expect(ui.reset).toBeEnabled();

    expect(await patchFrom(page, () => ui.anchorDetected.click())).toEqual({ tempo: { anchor: null } });
    await expect(ui.anchor).toHaveText("0.000 s");
    await expect(ui.source).toHaveText("Detected");
    await expect(ui.reset).toBeDisabled();
  });

  test("changing beats per bar puts the accent back on the grid's bar lines", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await ui.accent.selectOption("3");

    await patchFrom(page, async () => {
      await ui.perBar.fill("5");
      await ui.perBar.press("Enter");
    });
    await expect(ui.accent).toHaveValue("-1");
    await expect(ui.perBarDetected).toHaveText("Detected 4");
  });

  test("a typed BPM sends only the BPM, and the grid and click follow it", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    const body = await patchFrom(page, async () => {
      await ui.bpm.fill("100");
      await ui.bpm.press("Enter");
    });
    expect(body).toEqual({ tempo: { bpm: 100 } });

    await expect(ui.readout).toHaveText("100.0");
    await expect(ui.source).toHaveText("Your tempo");
    await expect(ui.reset).toBeEnabled();
    await expect(ui.note).toContainText("100.0 BPM");
    const now = await heard(page);
    expect(now.period).toBe(0.6);
    expect(now.clickCount).toBe(now.count);
    expect(now.clickBpm).toBe(100);
  });

  test("half, double, nudge and beat 1 each send their own field", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    expect(await patchFrom(page, () => ui.double.click())).toEqual({ tempo: { bpm: 240 } });
    expect((await heard(page)).period).toBe(0.25);
    expect(await patchFrom(page, () => ui.half.click())).toEqual({ tempo: { bpm: 120 } });
    expect((await heard(page)).period).toBe(0.5);

    expect(await patchFrom(page, () => ui.later.click())).toEqual({ tempo: { anchor: 0.01 } });
    expect((await heard(page)).first).toBeCloseTo(0.01, 6);

    // The playhead is at the top of the song, so beat 1 goes back to 0.
    expect(await patchFrom(page, () => ui.beatOne.click())).toEqual({ tempo: { anchor: 0 } });
    expect((await heard(page)).first).toBe(0);

    const body = await patchFrom(page, async () => {
      await ui.perBar.fill("3");
      await ui.perBar.press("Enter");
    });
    expect(body).toEqual({ tempo: { beats_per_bar: 3 } });
    expect((await heard(page)).bars).toEqual([{ beat: 0, beats_per_bar: 3 }]);
  });

  test("tapping sets the tempo from the gaps between taps", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    const body = await patchFrom(page, async () => {
      for (let i = 0; i < 4; i++) {
        await ui.tap.click();
        await page.waitForTimeout(400);
      }
    });
    expect(Object.keys(body.tempo)).toEqual(["bpm"]);
    expect(body.tempo.bpm).toBeGreaterThan(110);
    expect(body.tempo.bpm).toBeLessThan(160);
    await expect(ui.readout).toHaveText(body.tempo.bpm.toFixed(1));
  });

  test("reset sends every field as null and brings the detected grid back", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await patchFrom(page, async () => {
      await ui.bpm.fill("90");
      await ui.bpm.press("Enter");
    });
    await expect(ui.source).toHaveText("Your tempo");

    expect(await patchFrom(page, () => ui.reset.click())).toEqual({ tempo: RESET });
    await expect(ui.readout).toHaveText("120.0");
    await expect(ui.source).toHaveText("Detected");
    await expect(ui.reset).toBeDisabled();
    expect((await heard(page)).period).toBe(0.5);
  });

  test("following the band, half and double change the click rate and save nothing", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    expect(await patchFrom(page, () => ui.follow.click())).toEqual({ tempo: { mode: "follow" } });
    await expect(ui.follow).toHaveAttribute("aria-checked", "true");
    await expect(ui.bpm).toBeDisabled();
    await expect(ui.later).toBeDisabled();

    const patches = [];
    page.on("request", (r) => { if (r.method() === "PATCH") patches.push(r.url()); });
    const atNormal = await drawn(page);
    expect(atNormal.lines.length).toBe(atNormal.clickCount);

    await ui.double.click();
    await expect(ui.double).toHaveAttribute("aria-pressed", "true");
    await expect(ui.note).toContainText("240.0 BPM");
    const atDouble = await drawn(page);
    expect(atDouble.lines.length).toBe(atDouble.clickCount);
    expect(atDouble.lines[1]).toBeCloseTo((atNormal.lines[0] + atNormal.lines[1]) / 2, 6);

    await ui.half.click();
    const atHalf = await drawn(page);
    expect(atHalf.lines.length).toBe(atHalf.clickCount);
    expect(atHalf.lines[1]).toBeCloseTo(atNormal.lines[2], 6);

    await ui.half.click();
    await expect(ui.double).toHaveAttribute("aria-pressed", "false");
    await expect(ui.note).toContainText("120.0 BPM");
    expect(patches).toEqual([]);
  });

  test("stage mode shows the tempo being clicked", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await patchFrom(page, async () => {
      await ui.bpm.fill("100");
      await ui.bpm.press("Enter");
    });

    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageTempo")).toHaveText("100.0 BPM");
  });
});
