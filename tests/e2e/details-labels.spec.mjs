// Every fact in the Details tab is labelled, and every figure says what it
// measures or is gone (#50).
//
// The File card used to read "03:45 · 4 stems · Local · WAV · Extracted ...",
// and the key card showed a bare "100%".

import { test, expect } from "@playwright/test";
import {
  JOB_ID, SIBLING_JOB_ID, TRACK_TITLE, SIBLING_TITLE,
  fixtureTrack, openInspectorTab, seedCatalogState, stubExportEndpoints, stubUpdateCheck, uiText,
} from "./helpers.mjs";

const KEY_CONFIDENCE = 72;
const YOUTUBE_URL = "https://www.youtube.com/watch?v=e2e";
const SOUNDCLOUD_URL = "https://soundcloud.com/e2e/song";
const NEW_KEYS = ["inspector.fileSource", "inspector.fileFormat", "meta.keyConfidence"];
const FIGURE_CARDS = { key: "help.meta.key", lufs: "help.meta.lufs", dr: "help.meta.dr", stability: "help.meta.stability" };

// The server's record wins over the store once the page syncs, so a source is
// rewritten on the way in.
async function routeSource(page, sourceUrl) {
  await page.route("**/api/jobs**", async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] || "").includes("json")) return route.fulfill({ response });
    const body = (await response.text()).replaceAll('"local:e2e-fixture"', JSON.stringify(sourceUrl));
    await route.fulfill({ response, body });
  });
}

async function openDetails(page, { language = "en", sourceUrl } = {}) {
  await page.addInitScript((code) => window.localStorage.setItem("stemdeck.language", JSON.stringify(code)), language);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), keyConfidence: KEY_CONFIDENCE },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  if (sourceUrl) await routeSource(page, sourceUrl);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page, { available: false });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
  await openInspectorTab(page, "details");
}

const fileCard = (page) => page.locator(".inspector-card.details-song");
const fact = (page, valueId) => fileCard(page).locator(".details-fact", { has: page.locator(`#${valueId}`) });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("every fact on the File card has a label, and the duration is not repeated", async ({ page }) => {
  await openDetails(page);
  await expect(fact(page, "track-source").locator(".details-fact-label")).toHaveText(await uiText(page, "inspector.fileSource"));
  await expect(page.locator("#track-source")).toHaveText(await uiText(page, "track.localFile"));
  await expect(fact(page, "track-quality").locator(".details-fact-label")).toHaveText(await uiText(page, "inspector.fileFormat"));
  await expect(page.locator("#track-quality")).toHaveText("WAV");
  await expect(fact(page, "track-extracted").locator(".details-fact-label")).toHaveText(await uiText(page, "footer.extractedLabel"));
  await expect(page.locator("#t-meta-duration")).toBeHidden();
  await expect(page.locator("#t-stems-chip")).toHaveText(/\d+ stems/);
});

test("a YouTube song shows no made-up format", async ({ page }) => {
  await openDetails(page, { sourceUrl: YOUTUBE_URL });
  await expect(page.locator("#track-source")).toHaveText("YouTube");
  await expect(fact(page, "track-quality")).toBeHidden();
  await expect(fileCard(page)).not.toContainText(await uiText(page, "track.qualityHigh"));
});

test("a SoundCloud song shows no guessed MP3", async ({ page }) => {
  await openDetails(page, { sourceUrl: SOUNDCLOUD_URL });
  await expect(page.locator("#track-source")).toHaveText("SoundCloud");
  await expect(fact(page, "track-quality")).toBeHidden();
  await expect(fileCard(page)).not.toContainText("MP3");
});

test("the key confidence says what it measures", async ({ page }) => {
  await openDetails(page);
  const ring = page.locator("#summary-confidence");
  const meaning = await uiText(page, "meta.keyConfidence", { value: KEY_CONFIDENCE });
  await expect(ring).toHaveText(`${KEY_CONFIDENCE}%`);
  await expect(ring).toHaveAttribute("title", meaning);
  await expect(ring).toHaveAccessibleName(meaning);
});

test("each figure card and stem card explains its number on hover", async ({ page }) => {
  await openDetails(page);
  for (const [meta, key] of Object.entries(FIGURE_CARDS)) {
    await expect(page.locator(`.daw-meta-card[data-meta="${meta}"]`)).toHaveAttribute("title", await uiText(page, key));
  }
  for (const card of await page.locator(".stem-presence-panel .stem-card").all()) {
    const name = await uiText(page, `stem.${await card.getAttribute("data-stem")}`);
    await expect(card).toHaveAttribute("title", await uiText(page, "help.presence", { name }));
  }
});

test("a keyboard reaches each figure card and hears what it measures", async ({ page }) => {
  await openDetails(page);
  await page.locator("#inspectorTabDetails").focus();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("data-meta", "key");
  await expect(focused).toHaveAccessibleName(new RegExp(`${await uiText(page, "meta.key")}.+major`, "i"));
  await expect(focused).toHaveAccessibleDescription(await uiText(page, "help.meta.key"));
  await page.keyboard.press("Tab");
  await expect(focused).toHaveAttribute("data-meta", "lufs");
  await expect(focused).toHaveAccessibleDescription(await uiText(page, "help.meta.lufs"));

  const drums = page.locator('.stem-card[data-stem="drums"]');
  await drums.focus();
  await expect(drums).toBeFocused();
  await expect(drums).toHaveAccessibleName(new RegExp(`${await uiText(page, "presence.drum")}.+80%`, "i"));
  const name = await uiText(page, "stem.drums");
  await expect(drums).toHaveAccessibleDescription(await uiText(page, "help.presence", { name }));
});

test("the labels and explanations follow the language", async ({ page }) => {
  await openDetails(page, { language: "de" });
  await expect(fact(page, "track-source").locator(".details-fact-label")).toHaveText("Quelle");
  await expect(page.locator("#summary-confidence")).toHaveAttribute("title", await uiText(page, "meta.keyConfidence", { value: KEY_CONFIDENCE }));
  const untranslated = await page.evaluate(async (keys) => {
    const { TRANSLATIONS } = await import("/js/i18n.js");
    const bases = Object.entries(TRANSLATIONS).filter(([code]) => code !== "pt-PT");
    return bases.flatMap(([code, table]) => keys.filter((key) => !table[key]).map((key) => `${code}:${key}`));
  }, NEW_KEYS);
  expect(untranslated).toEqual([]);
});
