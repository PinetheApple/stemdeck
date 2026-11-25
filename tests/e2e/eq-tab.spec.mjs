import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, TALL_WINDOW, openStudio, openInspectorTab } from "./helpers.mjs";
import { EQ_ID, EQ_VERSION } from "../../static/js/eqMath.js";

test.use({ viewport: TALL_WINDOW });

const SUGGEST_EQ = /\/api\/jobs\/[a-f0-9]{12}\/suggest\/eq\?/;
const SUGGESTED = {
  bands: [
    { type: "lowcut", f: 34, g: 0, q: 0.707, slope: 24, slot: "lowcut" },
    { type: "bell", f: 310, g: -6, q: 1.4, slope: 12, slot: "bell" },
  ],
  out: 0,
  reasons: [{ key: "suggest.why.mud", vars: { db: 6 } }],
  loudness: -20,
  target: "default",
  targets: [{ id: "default", label_key: "suggest.target.default" }],
  target_curve: [[20, -4], [100, 2], [1000, 0], [10000, 1.5], [20000, -6]],
};
const SUGGESTED_PEDAL = {
  ...SUGGESTED,
  bands: [
    { type: "bell", f: 132, g: 3, q: 2.5, slope: 12, slot: "low" },
    { type: "highshelf", f: 1000, g: -2, q: 0.707, slope: 12, slot: "hs" },
  ],
};
const SIBLING_READY = /\/\s*00:02\s*$/;
const SUGGESTED_HZ = 310;
const STARTER_BANDS = 4;
const DRAG_UP_PX = 30;
const PLAYED_DB = -3;
const BELL_HANDLE = 1;
const STARTER_BELL_Q = 1;
const WHEEL_UP = -200;
const SETTLED_MS = 600;
const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const KNOB_BOOST_HZ = 132.3;
const KNOB_BOOST_DB = 3;
const PLAYED_TOLERANCE_DB = 0.5;
// As the removed Bass EQ knob panel saved it: seven fixed bands plus its knob state in params.ui.
const KNOB_PANEL_EQ = {
  id: EQ_ID,
  v: EQ_VERSION,
  bypass: false,
  params: {
    out: 0,
    bands: [
      { on: false, type: "lowcut", f: 10, g: 0, q: 0.707, slope: 12 },
      { on: true, type: "lowshelf", f: 75, g: 0, q: 0.707, slope: 12 },
      { on: true, type: "bell", f: KNOB_BOOST_HZ, g: KNOB_BOOST_DB, q: 2.5, slope: 12 },
      { on: true, type: "bell", f: 400, g: 0, q: 2.5, slope: 12 },
      { on: true, type: "bell", f: 1907.2, g: 0, q: 2.5, slope: 12 },
      { on: true, type: "highshelf", f: 1000, g: 0, q: 0.707, slope: 12 },
      { on: false, type: "highcut", f: 20000, g: 0, q: 0.707, slope: 12 },
    ],
    ui: { panel: "bass", c: { lf: KNOB_BOOST_HZ, lg: KNOB_BOOST_DB } },
  },
};

const mark = (page, lane) => page.locator(`.eq-lane-mark[data-lane="${lane}"]`);
const handles = (page) => page.locator("#eqGraphLane .eq-handle");

function laneEq(page, lane) {
  return page.evaluate(async (name) => (await import("/js/mixFx.js")).getLaneEq(name), lane);
}

function storedEq(page, lane) {
  return page.evaluate(([key, name]) => {
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    return stored?.[name]?.fx?.find((d) => d?.id === "eq") ?? null;
  }, [`stemdeck:mix:${JOB_ID}`, lane]);
}

function playedDb(page, lane, hz) {
  return page.evaluate(async ([name, f]) => {
    const db = (await import("/js/eqEngine.js")).getNodeResponse(name, [f]);
    return db ? db[0] : null;
  }, [lane, hz]);
}

/** A Suggest that answers only when the returned release() is called. */
async function holdSuggest(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(SUGGEST_EQ, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUGGESTED) });
  });
  return release;
}

async function stubSuggest(page, answer = SUGGESTED) {
  const asked = [];
  await page.route(SUGGEST_EQ, (route) => {
    const url = new URL(route.request().url());
    asked.push(url);
    const body = url.searchParams.get("lane") === "bass" ? SUGGESTED_PEDAL : answer;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return asked;
}

test.describe("EQ tab", () => {
  test.beforeEach(async ({ page }) => {
    await openStudio(page);
  });

  test("opens on a lane, and Master switches to the master view", async ({ page }) => {
    await openInspectorTab(page, "eq");
    await expect(page.locator("#eqScopeLane")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#eqScopeName")).not.toBeEmpty();
    await expect(page.locator("#eqLaneView")).toBeVisible();

    await page.locator("#eqScopeMaster").click();
    await expect(page.locator("#eqScopeMaster")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#eqMasterView")).toBeVisible();
    await expect(page.locator("#eqLaneView")).toBeHidden();
    await expect(page.locator("#eqGlue")).toBeVisible();
    await expect(page.locator("#eqLoudness [role=radio]")).toHaveCount(3);
    await expect(page.locator('#eqLoudness [data-choice="off"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#eqMasterView .eq-actions button")).toHaveCount(2);
  });

  test("a lane's mark opens its EQ, and bass gets the same graph as drums", async ({ page }) => {
    await mark(page, "bass").click();
    await expect(page.locator('.inspector-tab[data-tab="eq"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#eqScopeName")).toHaveText("Bass");
    await expect(page.locator("#eqLaneTitle")).toHaveText("EQ");
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
    await expect(page.locator(".eq-knob")).toHaveCount(0);

    await mark(page, "drums").click();
    await expect(page.locator("#eqScopeName")).toHaveText("Drums");
    await expect(page.locator("#eqLaneTitle")).toHaveText("Parametric EQ");
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
  });

  test("the mark is dim while flat and turns active once a band moves", async ({ page }) => {
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "flat");
    await mark(page, "drums").click();
    const box = await handles(page).nth(1).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - DRAG_UP_PX, { steps: 4 });
    await page.mouse.up();
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "active");
    const eq = await laneEq(page, "drums");
    expect(eq.params.bands.some((b) => b.g > 0)).toBe(true);
    await expect(page.locator("#eqReadout")).toContainText("dB");
  });

  test("Suggest plays the fit at once; Undo goes back, Apply keeps it", async ({ page }) => {
    const asked = await stubSuggest(page);
    await mark(page, "drums").click();

    await page.locator("#eqSuggestLane").click();
    await expect(page.locator("#eqSuggestBar")).toBeVisible();
    expect(asked[0].searchParams.get("lane")).toBe("drums");
    expect(asked[0].searchParams.has("layout")).toBe(false);
    await expect(page.locator("#eqGraphLane .eq-handle.fitted")).toHaveCount(SUGGESTED.bands.length);
    await expect.poll(() => playedDb(page, "drums", SUGGESTED_HZ)).toBeLessThan(PLAYED_DB);
    expect((await laneEq(page, "drums")).params.bands).toHaveLength(0);
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "flat");

    await page.locator("#eqSuggestUndo").click();
    await expect(page.locator("#eqSuggestBar")).toBeHidden();
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
    await expect.poll(() => playedDb(page, "drums", SUGGESTED_HZ)).toBeGreaterThan(PLAYED_DB);

    await page.locator("#eqSuggestLane").click();
    await page.locator("#eqSuggestApply").click();
    await expect(page.locator("#eqSuggestBar")).toBeHidden();
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "active");
    const saved = await laneEq(page, "drums");
    expect(saved.params.bands.map((b) => b.f)).toEqual(SUGGESTED.bands.map((b) => b.f));
  });

  test("Flat puts a lane back", async ({ page }) => {
    await stubSuggest(page);
    await mark(page, "drums").click();
    await page.locator("#eqSuggestLane").click();
    await page.locator("#eqSuggestApply").click();
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "active");
    await page.locator("#eqFlatLane").click();
    await expect(mark(page, "drums")).toHaveAttribute("data-eq", "flat");
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
  });

  test("a Suggest answer for the previous song is dropped", async ({ page }) => {
    const release = await holdSuggest(page);
    await mark(page, "drums").click();
    const asked = page.waitForRequest(SUGGEST_EQ);
    await page.locator("#eqSuggestLane").click();
    await asked;
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator("#t-time")).toHaveText(SIBLING_READY, { timeout: 20000 });
    release();
    await page.waitForTimeout(500);
    await expect(page.locator("#eqSuggestBar")).toBeHidden();
    expect((await laneEq(page, "drums")).params.bands).toHaveLength(0);
    const db = await playedDb(page, "drums", SUGGESTED_HZ);
    expect(db === null || Math.abs(db) < 0.1).toBe(true);
  });

  test("a Suggest answer for the previous lane is dropped", async ({ page }) => {
    const release = await holdSuggest(page);
    await mark(page, "drums").click();
    const asked = page.waitForRequest(SUGGEST_EQ);
    await page.locator("#eqSuggestLane").click();
    await asked;
    await mark(page, "vocals").click();
    await expect(page.locator("#eqScopeName")).toHaveText("Vocals");
    release();
    await page.waitForTimeout(SETTLED_MS);
    await expect(page.locator("#eqSuggestBar")).toBeHidden();
    expect((await laneEq(page, "vocals")).params.bands).toHaveLength(0);
    expect((await laneEq(page, "drums")).params.bands).toHaveLength(0);
  });

  test("a wheel turn saves to its own lane when another lane opens at once", async ({ page }) => {
    await mark(page, "drums").click();
    const box = await handles(page).nth(BELL_HANDLE).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, WHEEL_UP);
    await mark(page, "vocals").click();
    await expect(page.locator("#eqScopeName")).toHaveText("Vocals");
    await page.waitForTimeout(SETTLED_MS);
    expect(await storedEq(page, "vocals")).toBeNull();
    expect((await laneEq(page, "vocals")).params.bands).toHaveLength(0);
    const drums = await storedEq(page, "drums");
    expect(drums.params.bands[BELL_HANDLE].q).not.toBe(STARTER_BELL_Q);
  });

  test("a bass Suggest lands on the graph, and the power button waits while it plays", async ({ page }) => {
    const asked = await stubSuggest(page);
    await mark(page, "bass").click();
    await page.locator("#eqSuggestLane").click();
    await expect(page.locator("#eqSuggestBar")).toBeVisible();
    expect(asked[0].searchParams.has("layout")).toBe(false);
    await expect(page.locator("#eqGraphLane .eq-handle.fitted")).toHaveCount(SUGGESTED_PEDAL.bands.length);
    await expect(page.locator("#eqPowerLane")).toBeDisabled();
    expect((await laneEq(page, "bass")).params.bands).toHaveLength(0);
    await page.locator("#eqSuggestUndo").click();
    await expect(page.locator("#eqPowerLane")).toBeEnabled();
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
  });

  test("Suggest draws the target curve with its legend", async ({ page }) => {
    await stubSuggest(page);
    await mark(page, "drums").click();
    await expect(page.locator("#eqGraphLane path.eq-target")).toHaveAttribute("d", "");
    await page.locator("#eqSuggestLane").click();
    await expect(page.locator("#eqGraphLane path.eq-target")).toHaveAttribute("d", /^M/);
    await expect(page.locator("#eqLegendTarget")).toBeVisible();
    await page.locator("#eqSuggestUndo").click();
    await expect(page.locator("#eqGraphLane path.eq-target")).toHaveAttribute("d", "");
  });

  test("without a target curve the legend shows only Before", async ({ page }) => {
    const { target_curve: _omitted, ...noCurve } = SUGGESTED;
    await stubSuggest(page, noCurve);
    await mark(page, "drums").click();
    await page.locator("#eqSuggestLane").click();
    await expect(page.locator("#eqLegend")).toBeVisible();
    await expect(page.locator("#eqLegendTarget")).toBeAttached();
    await expect(page.locator("#eqLegendTarget")).toBeHidden();
    await expect(page.locator("#eqLegend")).toContainText("Before");
    await expect(page.locator("#eqGraphLane path.eq-target")).toHaveAttribute("d", "");
  });

  test("the Lane and Master switch moves with the arrow keys", async ({ page }) => {
    await openInspectorTab(page, "eq");
    const lane = page.locator("#eqScopeLane");
    const master = page.locator("#eqScopeMaster");
    await expect(lane).toHaveAttribute("tabindex", "0");
    await expect(master).toHaveAttribute("tabindex", "-1");
    await lane.focus();
    await page.keyboard.press("ArrowRight");
    await expect(master).toHaveAttribute("aria-checked", "true");
    await expect(master).toBeFocused();
    await expect(master).toHaveAttribute("tabindex", "0");
    await expect(page.locator("#eqMasterView")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(lane).toHaveAttribute("aria-checked", "true");
    await expect(lane).toBeFocused();
  });
});

test("a bass EQ saved by the old knob panel opens in the graph and plays as before", async ({ page }) => {
  await page.addInitScript(([key, eq]) => {
    if (window.sessionStorage.getItem("e2e.mixes")) return;
    window.sessionStorage.setItem("e2e.mixes", "1");
    const bass = { volume: 1, muted: false, soloed: false, pitch: 0, fx: [eq] };
    window.localStorage.setItem(key, JSON.stringify({ bass }));
  }, [MIX_KEY, KNOB_PANEL_EQ]);
  await openStudio(page);
  await expect.poll(() => playedDb(page, "bass", KNOB_BOOST_HZ)).toBeGreaterThan(KNOB_BOOST_DB - PLAYED_TOLERANCE_DB);
  await mark(page, "bass").click();
  await expect(page.locator("#eqLaneTitle")).toHaveText("EQ");
  await expect(handles(page)).toHaveCount(KNOB_PANEL_EQ.params.bands.length);
  expect(await storedEq(page, "bass")).toEqual(KNOB_PANEL_EQ);
});
