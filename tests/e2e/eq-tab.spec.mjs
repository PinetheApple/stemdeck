// The EQ inspector tab: lane and master views, the lane marks, Suggest.

import { test, expect } from "@playwright/test";
import { openStudio, openInspectorTab } from "./helpers.mjs";

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
};
const SUGGESTED_HZ = 310;
const STARTER_BANDS = 4;
const DRAG_UP_PX = 30;
const PLAYED_DB = -3;

const mark = (page, lane) => page.locator(`.eq-lane-mark[data-lane="${lane}"]`);
const handles = (page) => page.locator("#eqGraphLane .eq-handle");

function laneEq(page, lane) {
  return page.evaluate(async (name) => (await import("/js/mixFx.js")).getLaneEq(name), lane);
}

function playedDb(page, lane, hz) {
  return page.evaluate(async ([name, f]) => {
    const db = (await import("/js/eqEngine.js")).getNodeResponse(name, [f]);
    return db ? db[0] : null;
  }, [lane, hz]);
}

async function stubSuggest(page) {
  const asked = [];
  await page.route(SUGGEST_EQ, (route) => {
    asked.push(new URL(route.request().url()));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUGGESTED) });
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
    await expect(page.locator("#eqMasterView .eq-actions button")).toHaveCount(1);
  });

  test("a lane's mark opens its EQ: drums get the graph, bass the pedal", async ({ page }) => {
    await mark(page, "bass").click();
    await expect(page.locator('.inspector-tab[data-tab="eq"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#eqScopeName")).toHaveText("Bass");
    await expect(page.locator("#eqKnobs .eq-knob")).toHaveCount(4);
    await expect(handles(page)).toHaveCount(0);

    await mark(page, "drums").click();
    await expect(page.locator("#eqScopeName")).toHaveText("Drums");
    await expect(handles(page)).toHaveCount(STARTER_BANDS);
    await expect(page.locator("#eqKnobs")).toBeHidden();
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

  test("a pedal knob turns with the keyboard", async ({ page }) => {
    await mark(page, "bass").click();
    const low = page.locator('#eqKnobs .eq-knob[data-knob="low"]');
    await low.focus();
    await page.keyboard.press("ArrowUp");
    await expect(low).toHaveAttribute("aria-valuenow", "0.5");
    await expect(mark(page, "bass")).toHaveAttribute("data-eq", "active");
  });

  test("Suggest plays the fit at once; Undo goes back, Apply keeps it", async ({ page }) => {
    const asked = await stubSuggest(page);
    await mark(page, "drums").click();

    await page.locator("#eqSuggestLane").click();
    await expect(page.locator("#eqSuggestBar")).toBeVisible();
    expect(asked[0].searchParams.get("lane")).toBe("drums");
    expect(asked[0].searchParams.get("layout")).toBe("drum");
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
});
