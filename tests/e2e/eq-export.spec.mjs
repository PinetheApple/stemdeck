// What the EQ and master add to export URLs: fx= only when an EQ changes the
// sound, master= only on the mix when the export row is ticked, and never on
// the bundle or the stems zip.

import { test, expect } from "@playwright/test";
import { openStudio, exportUi } from "./helpers.mjs";

const MIXDOWN = /\/api\/jobs\/[a-f0-9]{12}\/mixdown\.(wav|mp3)\?/;
const BUNDLE = /\/api\/jobs\/[a-f0-9]{12}\/bundle\.zip\?/;
const STEMS_ZIP = /\/api\/jobs\/[a-f0-9]{12}\/stems\/all\.zip\?/;
const LOUDNESS = /\/api\/jobs\/[a-f0-9]{12}\/mixdown\/loudness\?/;
const PLAN = {
  target: -14, ceiling: -1, comp: 0, comp_ratio: null,
  pre: { i: -17.2, tp: -0.4, lra: 6.1 }, comp_threshold_db: null, comp_i: null,
  gain_db: 3.2, post: { i: -14.03, tp: -1.02, lra: 5.8 }, reached: true,
};
const BOOST = { id: "eq", v: 1, bypass: false, params: { out: 0, bands: [{ type: "bell", f: 500, g: 4 }] } };
const MINUS = "−";

const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

async function stubDownloads(page) {
  await page.route(LOUDNESS, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLAN) }));
  await page.route(BUNDLE, (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from("PK") }));
  await page.route(STEMS_ZIP, (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from("PK") }));
}

async function exportUrl(page, item, pattern) {
  const ui = exportUi(page);
  await ui.open();
  const request = page.waitForRequest((r) => pattern.test(r.url()));
  await item(ui).click();
  return new URL((await request).url());
}

const exportMix = (page) => exportUrl(page, (ui) => ui.mix, MIXDOWN);

async function setMasterRow(page, on) {
  await exportUi(page).open();
  await page.locator("#t-export-master").setChecked(on);
  await page.keyboard.press("Escape");
}

function setLaneEq(page, lane, eq) {
  return page.evaluate(async ([name, desc]) => {
    (await import("/js/mixFx.js")).setLaneEq(name, desc);
  }, [lane, eq]);
}

test.describe("EQ and master in export URLs", () => {
  test.beforeEach(async ({ page }) => {
    await openStudio(page);
    await stubDownloads(page);
  });

  test("a flat EQ with mastering off sends neither fx nor master", async ({ page }) => {
    const url = await exportMix(page);
    expect(url.searchParams.has("fx")).toBe(false);
    expect(url.searchParams.has("master")).toBe(false);
  });

  test("an active lane EQ sends fx for that lane", async ({ page }) => {
    await setLaneEq(page, "drums", BOOST);
    const url = await exportMix(page);
    const fx = decode(url.searchParams.get("fx"));
    expect(Object.keys(fx.lanes)).toEqual(["drums"]);
    expect(fx.lanes.drums[0].b[0]).toEqual(["bell", 500, 4, 0.707, 12]);
  });

  test("the Master row adds master= to the mix, and unticking drops it", async ({ page }) => {
    await setMasterRow(page, true);
    const on = await exportMix(page);
    expect(decode(on.searchParams.get("master"))).toEqual({ v: 1, target: -14, ceiling: -1 });

    await setMasterRow(page, false);
    const off = await exportMix(page);
    expect(off.searchParams.has("master")).toBe(false);
  });

  test("the Master row shows the target, capped for lossy formats", async ({ page }) => {
    await setMasterRow(page, true);
    await exportUi(page).open();
    await expect(page.locator("#t-export-master-preset")).toHaveText(`${MINUS}14 LUFS · ${MINUS}1 dBTP`);
    await exportUi(page).fmt("mp3").click();
    await expect(page.locator("#t-export-master-preset")).toHaveText(`${MINUS}14 LUFS · ${MINUS}1.5 dBTP`);
  });

  test("the bundle and the stems zip are never EQ'd or mastered", async ({ page }) => {
    await setLaneEq(page, "drums", BOOST);
    await setMasterRow(page, true);
    for (const [item, pattern] of [[(ui) => ui.stems, STEMS_ZIP], [(ui) => page.locator("#t-export-bundle"), BUNDLE]]) {
      const url = await exportUrl(page, item, pattern);
      expect(url.searchParams.has("fx")).toBe(false);
      expect(url.searchParams.has("master")).toBe(false);
      await expect(exportUi(page).label).toHaveText("Export Mix");
    }
  });
});
