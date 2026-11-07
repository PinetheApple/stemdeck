import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack } from "./helpers.mjs";

const STORE_KEY = "stemdeck.inspector.hidden";
const WIDE_WINDOW = { width: 1600, height: 900 };
const PIXEL_TOLERANCE = 1;
const SLOW_STORE_MS = 200;
const ICON_AND_LABEL_IDS = ["#tempoTap", "#tempoNudgeEarlier", "#tempoNudgeLater", "#tempoBeatOne", "#t-metro-edit"];
const ICON_ONLY_IDS = ["#tempoBpmDown", "#tempoBpmUp", "#t-metro", "#t-metro-vol-btn"];

const NARROW_INSPECTOR_WINDOWS = [{ width: 1280, height: 720 }, { width: 1024, height: 800 }];
const LABEL_LANGUAGES = ["en", "de"];
const TEMPO_LABELS = [
  "#tempoModeConstant",
  "#tempoModeFollow",
  "#tempoTap > span",
  "#tempoNudgeEarlier > span",
  "#tempoBeatOne > span",
  "#tempoNudgeLater > span",
];

const toggleOf = (page) => page.locator("#inspectorToggleBtn");
const inspectorOf = (page) => page.locator("#inspector");
const reload = (page) => page.reload({ waitUntil: "domcontentloaded" });

const widthOf = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, selector);

const savedHidden = (page) =>
  page.evaluate((key) => localStorage.getItem(key), STORE_KEY);

async function openWide(page) {
  await page.setViewportSize(WIDE_WINDOW);
  await openStudio(page);
  await expect(inspectorOf(page)).toBeVisible();
}

async function expectShown(page) {
  await expect(inspectorOf(page)).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "true");
}

async function expectHidden(page) {
  await expect(inspectorOf(page)).toBeHidden();
  await expect(toggleOf(page)).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute("aria-expanded", "false");
}

async function stageRoundTrip(page) {
  await page.locator("#stageModeBtn").click();
  await expect(page.locator(".app")).toHaveClass(/stage-mode/);
  await expect(inspectorOf(page)).toBeHidden();
  await expect(toggleOf(page)).toBeHidden();
  await page.locator("#stageExitBtn").click();
  await expect(page.locator(".app")).not.toHaveClass(/stage-mode/);
}

test.describe("inspector hide and show", () => {
  test("the toggle hides and shows it, keeping its name and state", async ({ page }) => {
    await openWide(page);
    await expect(toggleOf(page)).toHaveAccessibleName("Toggle song tools");
    await expect(toggleOf(page)).toHaveAttribute("aria-controls", "inspector");
    await expectShown(page);

    await toggleOf(page).click();
    await expectHidden(page);

    await toggleOf(page).click();
    await expectShown(page);
  });

  test("the choice survives a reload, both ways", async ({ page }) => {
    await openWide(page);

    await toggleOf(page).click();
    expect(await savedHidden(page)).toBe("1");
    await reload(page);
    await expectHidden(page);

    await toggleOf(page).click();
    expect(await savedHidden(page)).toBe("0");
    await reload(page);
    await expectShown(page);
  });

  test("the stem tracks take the width it frees and give it back", async ({ page }) => {
    await openWide(page);
    const tracksShown = await widthOf(page, "#lanes");
    const inspectorWidth = await widthOf(page, "#inspector");
    expect(inspectorWidth).toBeGreaterThan(0);

    await toggleOf(page).click();
    await expectHidden(page);
    await expect
      .poll(async () => Math.abs((await widthOf(page, "#lanes")) - (tracksShown + inspectorWidth)))
      .toBeLessThanOrEqual(PIXEL_TOLERANCE);

    await toggleOf(page).click();
    await expectShown(page);
    await expect
      .poll(async () => Math.abs((await widthOf(page, "#lanes")) - tracksShown))
      .toBeLessThanOrEqual(PIXEL_TOLERANCE);
  });

  test("Stage mode leaves a hidden inspector hidden", async ({ page }) => {
    await openWide(page);
    await toggleOf(page).click();
    await expectHidden(page);

    await stageRoundTrip(page);

    await expectHidden(page);
    expect(await savedHidden(page)).toBe("1");
  });

  test("Stage mode leaves a shown inspector shown", async ({ page }) => {
    await openWide(page);

    await stageRoundTrip(page);

    await expectShown(page);
  });

  test("a reload while hidden has it hidden the moment the page is ready", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page, { tauri: true });
    await toggleOf(page).click();
    await expectHidden(page);

    // A slow store is the desktop's IPC round trip: a flag read through it lands late.
    await page.addInitScript((delayMs) => {
      const invoke = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = (cmd, args) =>
        cmd === "store_get"
          ? new Promise((done) => setTimeout(done, delayMs)).then(() => invoke(cmd, args))
          : invoke(cmd, args);
      document.addEventListener("DOMContentLoaded", () => {
        window.__inspectorDisplayAtReady = getComputedStyle(document.getElementById("inspector")).display;
      });
    }, SLOW_STORE_MS);
    await reload(page);

    expect(await page.evaluate(() => window.__inspectorDisplayAtReady)).toBe("none");
  });

  for (const size of NARROW_INSPECTOR_WINDOWS) {
    for (const language of LABEL_LANGUAGES) {
      test(`tempo labels aren't cut off at ${size.width} in ${language}`, async ({ page }) => {
        await page.setViewportSize(size);
        await openStudio(page);
        await waitForClickTrack(page);

        const cutOff = await page.evaluate(async ({ language, labels }) => {
          const { setLanguage } = await import("/js/i18n.js");
          await setLanguage(language);
          await document.fonts.ready;
          // Sub-pixel: an ellipsis can cut text by less than the integer scrollWidth shows.
          const naturalWidth = (label) => {
            const clone = label.cloneNode(true);
            clone.removeAttribute("id");
            Object.assign(clone.style, { position: "absolute", width: "max-content" });
            label.parentElement.append(clone);
            const { width } = clone.getBoundingClientRect();
            clone.remove();
            return width;
          };
          return labels
            .map((selector) => {
              const label = document.querySelector(selector);
              return { selector, needs: naturalWidth(label), has: label.getBoundingClientRect().width };
            })
            .filter(({ needs, has }) => needs > has)
            .map(({ selector, needs, has }) => `${selector}: ${needs} > ${has}`);
        }, { language, labels: TEMPO_LABELS });

        expect(cutOff).toEqual([]);
      });
    }
  }

  test("icons and labels survive a language change", async ({ page }) => {
    await page.setViewportSize(WIDE_WINDOW);
    await openStudio(page);
    await waitForClickTrack(page);

    const strings = await page.evaluate(async () => {
      const { setLanguage, t } = await import("/js/i18n.js");
      await setLanguage("de");
      return {
        beatOne: t("tempo.beatOne"),
        grid: t("click.grid"),
        nudge: t("tempo.nudgeAmount", { ms: 10 }),
        nudgeTitle: t("tempo.nudgeEarlierTitle", { ms: 10 }),
        toggle: t("inspector.toggle"),
      };
    });
    expect(strings.beatOne).not.toBe("Beat 1 here");

    for (const id of [...ICON_AND_LABEL_IDS, ...ICON_ONLY_IDS]) {
      await expect(page.locator(`${id} svg.ic`)).toHaveCount(1);
    }
    for (const id of ICON_AND_LABEL_IDS) await expect(page.locator(`${id} > span`)).not.toHaveText("");
    await expect(page.locator("#tempoBeatOne > span")).toHaveText(strings.beatOne);
    await expect(page.locator("#t-metro-edit > span")).toHaveText(strings.grid);
    await expect(page.locator("#tempoNudgeEarlier > span")).toHaveText(strings.nudge);
    await expect(page.locator("#tempoNudgeLater > span")).toHaveText(strings.nudge);
    await expect(page.locator("#tempoNudgeEarlier")).toHaveAccessibleName(strings.nudgeTitle);
    await expect(toggleOf(page)).toHaveAccessibleName(strings.toggle);
  });
});
