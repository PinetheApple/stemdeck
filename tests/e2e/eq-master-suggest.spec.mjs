import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, openInspectorTab } from "./helpers.mjs";

const SUGGEST_MASTER = /\/api\/jobs\/[a-f0-9]{12}\/suggest\/master\?/;
const LOUDNESS = /\/api\/jobs\/[a-f0-9]{12}\/mixdown\/loudness\?/;
const MASTER_LANE = "__master";
const SUGGESTED_PRESET = { preset: "louder", target_lufs: -9, ceiling_dbtp: -1, comp: 0.5 };
const SUGGESTED = {
  bands: [
    { type: "lowshelf", f: 80, g: -2, q: 0.707, slope: 12, slot: null },
    { type: "bell", f: 2500, g: -6, q: 1.2, slope: 12, slot: null },
  ],
  out: 0.5,
  reasons: [{ key: "suggest.why.master.louder", vars: { i: -16, tp: -3, plr: 13 } }],
  loudness: -16,
  target: "mix.balanced",
  targets: [{ id: "mix.balanced", label_key: "suggest.target.mix.balanced" }],
  target_curve: [[20, -4], [100, 2], [1000, 0], [10000, 1.5], [20000, -6]],
  master: SUGGESTED_PRESET,
};
const PLAN = {
  target: -9, ceiling: -1, comp: 0.5, comp_ratio: 2,
  pre: { i: -16, tp: -3, lra: 6 }, comp_threshold_db: -20, comp_i: -16.5, gain_db: 7.5,
  post: { i: -9, tp: -1, lra: 5 }, reached: true,
};
const SUGGESTED_HZ = 2500;
const PLAYED_DB = -3;
const SIBLING_READY = /\/\s*00:02\s*$/;
const SETTLED_MS = 600;
const NO_SIGNAL_TEXT = "Not enough sound here to suggest an EQ.";
const MIX_REFUSED_TEXT = "Couldn't suggest for this mix.";

const masterEq = (page) => page.evaluate(async (lane) => (await import("/js/mixFx.js")).getLaneEq(lane), MASTER_LANE);
const savedMaster = (page) => page.evaluate(async () => (await import("/js/mixFx.js")).getMaster());
const liveMaster = (page) => page.evaluate(async () => (await import("/js/masterEngine.js")).liveParams());

function storedMasterFx(page) {
  return page.evaluate(([key, lane]) => JSON.parse(localStorage.getItem(key) || "null")?.[lane]?.fx ?? null, [
    `stemdeck:mix:${JOB_ID}`,
    MASTER_LANE,
  ]);
}

function playedMasterDb(page, hz) {
  return page.evaluate(async ([lane, f]) => {
    const db = (await import("/js/eqEngine.js")).getNodeResponse(lane, [f]);
    return db ? db[0] : null;
  }, [MASTER_LANE, hz]);
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubSuggest(page, status = 200, body = SUGGESTED) {
  const asked = [];
  await page.route(SUGGEST_MASTER, (route) => {
    asked.push(new URL(route.request().url()));
    return json(route, status, body);
  });
  return asked;
}

/** A Suggest that answers only when the returned release() is called. */
async function holdSuggest(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(SUGGEST_MASTER, async (route) => {
    await held;
    await json(route, 200, SUGGESTED);
  });
  return release;
}

async function openMaster(page) {
  await openInspectorTab(page, "eq");
  await page.locator("#eqScopeMaster").click();
  await expect(page.locator("#eqMasterView")).toBeVisible();
}

test.describe("Master Suggest", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(LOUDNESS, (route) => json(route, 200, PLAN));
    await openStudio(page);
  });

  test("previews the master EQ and preset at once, unsaved, with the controls locked", async ({ page }) => {
    const asked = await stubSuggest(page);
    await openMaster(page);
    await page.locator("#eqSuggestMaster").click();

    await expect(page.locator("#eqSuggestBarMaster")).toBeVisible();
    expect(asked[0].searchParams.get("stems")).toBeTruthy();
    expect(asked[0].searchParams.get("gains")).toBeTruthy();
    expect(asked[0].searchParams.has("master")).toBe(false);
    await expect(page.locator("#eqGraphMaster .eq-handle.fitted")).toHaveCount(SUGGESTED.bands.length);
    await expect(page.locator("#eqGraphMaster path.eq-target")).toHaveAttribute("d", /^M/);
    await expect(page.locator("#eqLegendTargetMaster")).toBeVisible();
    await expect(page.locator('#eqLoudness [data-choice="loud"]')).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => playedMasterDb(page, SUGGESTED_HZ)).toBeLessThan(PLAYED_DB);
    expect((await liveMaster(page))?.comp).toBe(SUGGESTED_PRESET.comp);

    expect((await savedMaster(page)).bypass).toBe(true);
    expect((await masterEq(page)).params.bands).toHaveLength(0);
    for (const id of ["#eqGlue", "#eqPowerMaster", "#eqCeilingDown", "#eqCeilingUp"]) {
      await expect(page.locator(id)).toBeDisabled();
    }
    await expect(page.locator("#eqLoudness [role=radio]:enabled")).toHaveCount(0);
    await expect(page.locator("#eqMasterActions")).toBeHidden();
  });

  test("Undo restores the previous master exactly", async ({ page }) => {
    await stubSuggest(page);
    await openMaster(page);
    await page.locator('#eqLoudness [data-choice="streaming"]').click();
    await page.locator("#eqCeilingDown").click();
    const before = await savedMaster(page);
    await expect.poll(() => storedMasterFx(page)).toEqual([before]);

    await page.locator("#eqSuggestMaster").click();
    await expect(page.locator("#eqSuggestBarMaster")).toBeVisible();
    await page.locator("#eqSuggestUndoMaster").click();

    await expect(page.locator("#eqSuggestBarMaster")).toBeHidden();
    expect(await savedMaster(page)).toEqual(before);
    expect(await liveMaster(page)).toMatchObject({ comp: before.params.comp, ceiling: before.params.ceiling_dbtp });
    await page.waitForTimeout(SETTLED_MS);
    expect(await storedMasterFx(page)).toEqual([before]);
    await expect.poll(() => playedMasterDb(page, SUGGESTED_HZ)).toBeGreaterThan(PLAYED_DB);
    await expect(page.locator("#eqGlue")).toBeEnabled();
    await expect(page.locator("#eqMasterActions")).toBeVisible();
  });

  test("Apply stores the master EQ and applies the preset", async ({ page }) => {
    await stubSuggest(page);
    await openMaster(page);
    await page.locator("#eqSuggestMaster").click();
    await page.locator("#eqSuggestApplyMaster").click();

    await expect(page.locator("#eqSuggestBarMaster")).toBeHidden();
    const master = await savedMaster(page);
    expect(master.bypass).toBe(false);
    expect(master.params).toEqual(SUGGESTED_PRESET);
    expect((await masterEq(page)).params.bands.map((b) => b.f)).toEqual(SUGGESTED.bands.map((b) => b.f));
    await expect(page.locator('#eqLoudness [data-choice="loud"]')).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await storedMasterFx(page))?.map((d) => d.id)).toEqual(["eq", "master"]);
    expect((await liveMaster(page))?.comp).toBe(SUGGESTED_PRESET.comp);
  });

  test("an answer for the previous song is dropped", async ({ page }) => {
    const release = await holdSuggest(page);
    await openMaster(page);
    const asked = page.waitForRequest(SUGGEST_MASTER);
    await page.locator("#eqSuggestMaster").click();
    await asked;
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator("#t-time")).toHaveText(SIBLING_READY, { timeout: 20000 });
    release();
    await page.waitForTimeout(SETTLED_MS);

    await expect(page.locator("#eqSuggestBarMaster")).toBeHidden();
    expect((await savedMaster(page)).bypass).toBe(true);
    expect(await liveMaster(page)).toBeNull();
    expect((await masterEq(page)).params.bands).toHaveLength(0);
  });

  test("a refusal says why and changes nothing", async ({ page }) => {
    let detail = "not enough signal";
    await page.route(SUGGEST_MASTER, (route) => json(route, 422, { detail }));
    await openMaster(page);

    await page.locator("#eqSuggestMaster").click();
    await expect(page.locator("#eqMasterStatus")).toHaveText(NO_SIGNAL_TEXT);
    detail = "fx: malformed";
    await page.locator("#eqSuggestMaster").click();
    await expect(page.locator("#eqMasterStatus")).toHaveText(MIX_REFUSED_TEXT);

    await expect(page.locator("#eqSuggestBarMaster")).toBeHidden();
    await expect(page.locator("#eqSuggestMaster")).toBeEnabled();
    expect((await savedMaster(page)).bypass).toBe(true);
  });
});
