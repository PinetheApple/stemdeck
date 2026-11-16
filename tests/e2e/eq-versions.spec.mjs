import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, resetVersions, versionsUrl } from "./helpers.mjs";
import { STEM_NAMES } from "../../static/js/constants.js";
import { EQ_ID, EQ_VERSION } from "../../static/js/eqMath.js";

const MIX_KEY = `stemdeck:mix:${JOB_ID}`;
const VERSION_NAME = "Flat drums";
const CUT_HZ = 310;
const CUT_DB = -9;
const PLAYED_CUT_DB = -3;
const FLAT_DB = 0.1;
const CUT_EQ = {
  id: EQ_ID,
  v: EQ_VERSION,
  bypass: false,
  params: { out: 0, bands: [{ on: true, type: "bell", f: CUT_HZ, g: CUT_DB, q: 1.4, slope: 12 }] },
};

const drumsMix = (fx) => ({ drums: { volume: 1, muted: false, soloed: false, pitch: 0, fx } });
const storedMix = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);
const drumsMark = (page) => page.locator('.eq-lane-mark[data-lane="drums"]');

function playedDb(page) {
  return page.evaluate(async (f) => {
    const db = (await import("/js/eqEngine.js")).getNodeResponse("drums", [f]);
    return db ? db[0] : null;
  }, CUT_HZ);
}

async function seedMixes(page, mixes) {
  await page.addInitScript((entries) => {
    if (window.sessionStorage.getItem("e2e.mixes")) return;
    window.sessionStorage.setItem("e2e.mixes", "1");
    for (const [key, value] of entries) window.localStorage.setItem(key, JSON.stringify(value));
  }, Object.entries(mixes));
}

test.afterEach(async ({ request }) => {
  await resetVersions(request, JOB_ID);
});

test("a version with the same lanes plays and marks its own EQ", async ({ page, request }) => {
  const res = await request.post(versionsUrl(JOB_ID), { data: { name: VERSION_NAME, stems: STEM_NAMES, open: false } });
  expect(res.status()).toBe(201);
  const { version } = await res.json();
  await seedMixes(page, { [MIX_KEY]: drumsMix([CUT_EQ]), [`${MIX_KEY}:${version.id}`]: drumsMix([]) });
  await openStudio(page);
  await expect(drumsMark(page)).toHaveAttribute("data-eq", "active");
  await expect.poll(() => playedDb(page)).toBeLessThan(PLAYED_CUT_DB);
  const originalBefore = await storedMix(page, MIX_KEY);

  await page.locator("#npVersionBtn").click();
  await page.getByRole("menuitemradio", { name: VERSION_NAME }).click();
  await expect.poll(() => page.evaluate(async () => (await import("/js/state.js")).currentVersionId)).toBe(version.id);

  await expect.poll(async () => Math.abs((await playedDb(page)) ?? 0)).toBeLessThan(FLAT_DB);
  await expect(drumsMark(page)).toHaveAttribute("data-eq", "flat");
  expect(await storedMix(page, MIX_KEY)).toBe(originalBefore);
});
