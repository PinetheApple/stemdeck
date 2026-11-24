// My part: one stem named as yours, three choices that mute around it, in the studio and Stage's Mix panel.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio, uiText } from "./helpers.mjs";

// seed.py writes these stems; the fixture has no guitar, the default part.
const FIXTURE_STEMS = ["vocals", "drums", "bass", "other"];
const MINE = "bass";
const MINE_NAME = "Bass";
const MISSING_NAME = "Guitar";
const PART_STORE_KEY = "stemdeck:my-part";
const MIX_STORE_KEY = `stemdeck:mix:${JOB_ID}`;
const HALF_GAIN = 0.5;
const KEY_UP_TWO = 2;
const SONG_OPEN_TIMEOUT_MS = 20000;

const studioBar = (page) => page.locator("#myPartStudio");
const stageBar = (page) => page.locator("#stageMixer .my-part");
const choice = (bar, preset) => bar.locator(`.my-part-choice[data-preset="${preset}"]`);
const lane = (page, stem) => page.locator(`#mixer .lane-header[data-stem="${stem}"]`);
const mixOf = (page) =>
  page.evaluate(async () => structuredClone((await import("/js/state.js")).mixerState));
const storedMix = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), MIX_STORE_KEY);
const mixer = (page, call, ...args) => page.evaluate(
  async ([name, callArgs]) => (await import("/js/mixer.js"))[name](...callArgs),
  [call, args],
);
const withoutMutes = (mix) => Object.fromEntries(
  Object.entries(mix).map(([lane, entry]) => [lane, typeof entry === "object" ? { ...entry, muted: null, soloed: null } : entry]),
);

async function expectOn(bar, preset) {
  for (const other of ["full", "without", "only"]) {
    await expect(choice(bar, other)).toHaveAttribute("aria-pressed", String(other === preset));
  }
}

async function expectMuted(page, muted) {
  const mix = await mixOf(page);
  for (const stem of FIXTURE_STEMS) expect(mix[stem].muted, stem).toBe(muted.includes(stem));
}

async function pickPart(page, stem) {
  await studioBar(page).locator(".my-part-select").selectOption(stem);
}

test.describe("my part", () => {
  test("the default part the song lacks leaves Without me and Only me disabled, saying why", async ({ page }) => {
    await openStudio(page);
    const bar = studioBar(page);
    await expect(bar.locator(".my-part-name")).toHaveText(MISSING_NAME);
    const reason = await uiText(page, "studio.myPart.missing", { part: MISSING_NAME });
    for (const preset of ["without", "only"]) {
      await expect(choice(bar, preset)).toBeDisabled();
      await expect(choice(bar, preset)).toHaveAttribute("title", reason);
    }
    await expect(bar.locator(".my-part-choices")).toHaveAttribute("title", reason);
    await expect(choice(bar, "full")).toBeEnabled();
    await expectOn(bar, "full");
    await expect(page.locator("#mixer .my-part-tag")).toHaveCount(0);
  });

  test("picking a part from the menu labels its lane and is kept", async ({ page }) => {
    await openStudio(page);
    const bar = studioBar(page);
    await bar.locator(".my-part-select").click();
    await page.locator(".select-menu-option", { hasText: MINE_NAME }).click();
    await expect(bar.locator(".my-part-name")).toHaveText(MINE_NAME);
    await expect(lane(page, MINE).locator(".my-part-tag")).toHaveText(await uiText(page, "studio.myPart.label"));
    await expect(page.locator("#mixer .my-part-tag")).toHaveCount(1);
    await expect(lane(page, MINE)).toHaveClass(/is-my-part/);
    await expect(choice(bar, "without")).toBeEnabled();
    await expect(choice(bar, "without")).not.toHaveAttribute("title");
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PART_STORE_KEY)).toBe(MINE);
  });

  test("the choices set mutes and clear solos, leaving faders and keys alone", async ({ page }) => {
    await openStudio(page);
    await pickPart(page, MINE);
    const bar = studioBar(page);
    await mixer(page, "setLaneVolume", "vocals", HALF_GAIN);
    await mixer(page, "setLanePitch", "other", KEY_UP_TWO);
    await mixer(page, "toggleStemSolo", "drums");
    await expect.poll(async () => (await storedMix(page))?.drums?.soloed).toBe(true);
    await expectOn(bar, null);
    const before = withoutMutes(await storedMix(page));

    await choice(bar, "without").click();
    await expectMuted(page, [MINE]);
    await expectOn(bar, "without");
    await expect(lane(page, MINE)).toHaveClass(/muted/);
    await expect(lane(page, "drums").locator(".solo")).not.toHaveClass(/active/);
    await expect.poll(async () => (await storedMix(page))?.[MINE]?.muted).toBe(true);
    const after = await storedMix(page);
    expect(FIXTURE_STEMS.every((stem) => after[stem].soloed === false)).toBe(true);
    expect(withoutMutes(after)).toEqual(before);

    await choice(bar, "only").click();
    await expectMuted(page, FIXTURE_STEMS.filter((stem) => stem !== MINE));
    await expectOn(bar, "only");

    await choice(bar, "full").click();
    await expectMuted(page, []);
    await expectOn(bar, "full");
    const mix = await mixOf(page);
    expect(mix.vocals.volume).toBe(HALF_GAIN);
  });

  test("a manual mute that matches no choice turns every choice off", async ({ page }) => {
    await openStudio(page);
    await pickPart(page, MINE);
    const bar = studioBar(page);
    await choice(bar, "without").click();
    await expectOn(bar, "without");
    await lane(page, "drums").locator(".mute").click();
    await expectOn(bar, null);
    await lane(page, "drums").locator(".mute").click();
    await expectOn(bar, "without");
  });

  test("my part outlasts a reload and carries to another song", async ({ page }) => {
    await openStudio(page);
    await pickPart(page, MINE);
    await expect(lane(page, MINE).locator(".my-part-tag")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().click();
    await page.waitForFunction(
      () => !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00"),
      null,
      { timeout: SONG_OPEN_TIMEOUT_MS },
    );
    await expect(studioBar(page).locator(".my-part-name")).toHaveText(MINE_NAME);
    await expect(lane(page, MINE).locator(".my-part-tag")).toBeVisible();
  });

  test("Stage's Mix panel has the same controls, bound to the studio", async ({ page }) => {
    await openStudio(page);
    await pickPart(page, MINE);
    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageView")).toBeVisible();
    const bar = stageBar(page);
    await expect(bar.locator(".my-part-name")).toHaveText(MINE_NAME);
    await expect(page.locator(`.stage-strip[data-stem="${MINE}"] .my-part-tag`)).toBeVisible();

    await choice(bar, "only").click();
    await expectMuted(page, FIXTURE_STEMS.filter((stem) => stem !== MINE));
    await expectOn(bar, "only");
    await expectOn(studioBar(page), "only");
    await expect(page.locator(`.stage-strip[data-stem="drums"] .stage-ms.mute`)).toHaveAttribute("aria-pressed", "true");

    await bar.locator(".my-part-select").selectOption("drums");
    await expectOn(bar, null);
    await expect(studioBar(page).locator(".my-part-name")).toHaveText("Drums");
  });
});
