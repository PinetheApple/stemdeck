// The fixture is a steady 120 BPM, 4/4 from beat 0, six seconds long, so the
// server fits it as constant tempo anchored at 0.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, waitForClickTrack } from "./helpers.mjs";

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
  accentWrap: page.locator("#t-metro-bar").locator("xpath=.."),
  accentAuto: page.locator('#t-metro-bar option[value="-1"]'),
  override: page.locator("#tempoAccentOverride"),
  overrideText: page.locator("#tempoAccentOverrideText"),
  useAuto: page.locator("#tempoAccentUseAuto"),
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

function spyClickAccent(page) {
  return page.evaluate(async () => {
    const { metronome } = await import("/js/state.js");
    const { setBarPositionFn, setDownbeatFn, setBeatsPerBar } = metronome;
    metronome.setBarPositionFn = (fn) => { window.clickBarPosition = fn; setBarPositionFn(fn); };
    metronome.setDownbeatFn = (fn) => { window.clickDownbeat = fn; setDownbeatFn(fn); };
    metronome.setBeatsPerBar = (n) => { window.clickEvery = n; setBeatsPerBar(n); };
  });
}

function accentAndBarLines(page) {
  return page.evaluate(async () => {
    const grid = await import("/js/beatgrid.js");
    const position = window.clickBarPosition;
    return {
      clickDownbeats: grid.getBeats().filter((_, i) => position?.(i)?.[0] === 0),
      barLines: grid.getShownGridLines().filter((line) => line.bar).map((line) => line.t),
      clickEvery: window.clickEvery,
      barMarksDropped: window.clickBarPosition === null && window.clickDownbeat === null,
    };
  });
}

/** A bar edit in the grid, saved with the page still open. */
function editGridBars(page, beatsPerBar) {
  return page.evaluate(async (n) => {
    const grid = await import("/js/beatgrid.js");
    grid.setBarLengthAt(0, n);
    await grid.flushBeatGrid();
  }, beatsPerBar);
}

/** Hidden by its own attribute: toBeHidden would also pass on a closed Tempo tab. */
async function expectNoOverride(ui) {
  await expect(ui.override).toHaveJSProperty("hidden", true);
  await expect(ui.overrideText).toHaveText("");
  await expect(ui.accentWrap).not.toHaveClass(/active/);
}

async function expectOverride(ui, text) {
  await expect(ui.override).toBeVisible();
  await expect(ui.overrideText).toHaveText(text);
  await expect(ui.accentWrap).toHaveClass(/active/);
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

test.describe("the accent select as an override of the grid's bars", () => {
  test.afterEach(async ({ request }) => {
    await request.delete(BEATS_URL);
    await request.patch(BEATS_URL, { data: { tempo: RESET } });
  });

  test("on Auto the click accents the grid's bar lines and follows beats per bar", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await expect(ui.accentAuto).toHaveText("Auto · 4");
    await expect(ui.accent).toHaveAccessibleName("Accent: Auto, following the grid's 4 beats per bar");
    await spyClickAccent(page);

    await patchFrom(page, async () => {
      await ui.perBar.fill("3");
      await ui.perBar.press("Enter");
    });

    await expect(ui.accent).toHaveValue("-1");
    await expect(ui.accentAuto).toHaveText("Auto · 3");
    await expectNoOverride(ui);
    const { clickDownbeats, barLines } = await accentAndBarLines(page);
    expect(clickDownbeats.slice(0, 4)).toEqual([0, 1.5, 3, 4.5]);
    expect(clickDownbeats).toEqual(barLines);
  });

  test("a number that differs from the grid shows the note and the override state", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await expectNoOverride(ui);
    await spyClickAccent(page);

    await ui.accent.selectOption("3");

    await expectOverride(ui, "Click accents every 3 beats, grid has 4.");
    await expect(ui.accent).toHaveAccessibleName("Accent every 3 beats, overriding the grid's bar lines");
    const accent = await accentAndBarLines(page);
    expect(accent.clickEvery).toBe(3);
    expect(accent.barMarksDropped).toBe(true);
  });

  test("a custom number and Off count as overrides too", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    await ui.accent.selectOption("custom");
    const custom = page.locator("#t-metro-bar-custom");
    await custom.fill("11");
    await custom.blur();
    await expectOverride(ui, "Click accents every 11 beats, grid has 4.");

    await ui.accent.selectOption("0");
    await expectOverride(ui, "Click accents are off, so they don't mark the grid's bar lines.");
    await expect(ui.accent).toHaveAccessibleName("Accent off, overriding the grid's bar lines");
  });

  test("a number equal to the grid's bar shows nothing", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    await ui.accent.selectOption("3");
    await expectOverride(ui, "Click accents every 3 beats, grid has 4.");

    await ui.accent.selectOption("4");
    await expect(ui.accent).toHaveValue("4");
    await expectNoOverride(ui);
    await expect(ui.accent).toHaveAccessibleName("Accent every 4 beats, matching the grid's bar lines");
  });

  test("an equal number counted from another beat is still shown as an override", async ({ page, request }) => {
    await request.patch(BEATS_URL, { data: { tempo: { anchor: 0.5 } } });
    await openTempo(page);
    const ui = tools(page);
    await expect(ui.perBar).toHaveValue("4");
    await expectNoOverride(ui);

    await ui.accent.selectOption("4");

    await expectOverride(ui, "Click accents every 4 beats from the first beat, which doesn't match the grid's bar lines.");
  });

  test("going back to Auto clears it, from the select or from the note", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    const patches = [];
    page.on("request", (r) => { if (r.method() === "PATCH") patches.push(r.url()); });

    await ui.accent.selectOption("3");
    await ui.accent.selectOption("-1");
    await expectNoOverride(ui);
    await expect(ui.accentAuto).toHaveText("Auto · 4");

    await ui.accent.selectOption("5");
    await expectOverride(ui, "Click accents every 5 beats, grid has 4.");
    await ui.useAuto.click();
    await expect(ui.accent).toHaveValue("-1");
    await expect(ui.accent).toBeFocused();
    await expectNoOverride(ui);
    expect(patches).toEqual([]);
  });

  test("Use Auto survives a reload", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await ui.accent.selectOption("3");
    await expectOverride(ui, "Click accents every 3 beats, grid has 4.");

    await openTempo(page);
    await expect(ui.accent).toHaveValue("3");
    await ui.useAuto.click();
    await expect(ui.accent).toHaveValue("-1");

    await openTempo(page);
    await expect(ui.accent).toHaveValue("-1");
    await expectNoOverride(ui);
  });

  test("bars edited in the grid replace beats per bar, which goes read-only", async ({ page, request }) => {
    const beats = Array.from({ length: 12 }, (_, i) => i * 0.5);
    await request.patch(BEATS_URL, { data: { beats, bars: [{ beat: 0, beats_per_bar: 6 }] } });
    await openTempo(page);
    const ui = tools(page);

    await expect(ui.perBar).toHaveValue("6");
    await expect(ui.perBar).toBeDisabled();
    await expect(ui.perBar).toHaveAttribute("title", "Bars were edited in the grid. Change them there, or reset the grid to use this field.");
    await expect(ui.accentAuto).toHaveText("Auto · 6");
    await ui.accent.selectOption("3");
    await expectOverride(ui, "Click accents every 3 beats, grid has 6.");
  });

  test("bars of mixed length in the grid leave beats per bar empty", async ({ page, request }) => {
    const beats = Array.from({ length: 12 }, (_, i) => i * 0.5);
    const bars = [{ beat: 0, beats_per_bar: 4 }, { beat: 8, beats_per_bar: 3 }];
    await request.patch(BEATS_URL, { data: { beats, bars } });
    await openTempo(page);
    const ui = tools(page);

    await expect(ui.perBar).toHaveValue("");
    await expect(ui.perBar).toBeDisabled();
    await expect(ui.accentAuto).toHaveText("Auto");
  });

  test("a grid edit, then Constant, then Follow leaves the field read-only on the grid's value", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);

    await expect(ui.note).toContainText("accenting 4/4");
    await editGridBars(page, 6);
    await expect(ui.perBar).toBeDisabled();
    await expect(ui.perBar).toHaveValue("6");
    await expect(ui.note).toContainText("accenting 6/4");

    await patchFrom(page, () => ui.constant.click());
    await expect(ui.perBar).toBeEnabled();
    await expect(ui.perBar).toHaveValue("4");

    await patchFrom(page, () => ui.follow.click());
    await expect(ui.perBar).toBeDisabled();
    await expect(ui.perBar).toHaveValue("6");
  });

  test("resetting the grid gives the field back without a reload", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await editGridBars(page, 6);
    await expect(ui.perBar).toBeDisabled();
    await expect(ui.note).toContainText("accenting 6/4");

    await page.evaluate(async () => {
      const grid = await import("/js/beatgrid.js");
      await grid.resetBeatGrid();
    });

    await expect(ui.perBar).toBeEnabled();
    await expect(ui.perBar).toHaveValue("4");
    await expect(ui.note).toContainText("accenting 4/4");
  });

  test("switching songs compares the kept number with the new song's bars", async ({ page }) => {
    await openTempo(page);
    const ui = tools(page);
    await ui.accent.selectOption("3");
    await expectOverride(ui, "Click accents every 3 beats, grid has 4.");

    let releaseSibling;
    const siblingHeld = new Promise((resolve) => { releaseSibling = resolve; });
    await page.route(`**/api/jobs/${SIBLING_JOB_ID}/beats`, async (route) => {
      await siblingHeld;
      const response = await route.fetch();
      const grid = await response.json();
      await route.fulfill({
        response,
        json: {
          ...grid,
          bars: [{ beat: 0, beats_per_bar: 3 }],
          tempo: { ...grid.tempo, beats_per_bar: 3 },
        },
      });
    });

    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().click();
    await expectNoOverride(ui);

    releaseSibling();
    await expect(ui.accentAuto).toHaveText("Auto · 3");
    await expect(ui.accent).toHaveValue("3");
    await expectNoOverride(ui);

    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(ui.accentAuto).toHaveText("Auto · 4");
    await expectOverride(ui, "Click accents every 3 beats, grid has 4.");
  });
});
