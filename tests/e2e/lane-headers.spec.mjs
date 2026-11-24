// A stem's header: name, M, S, fader and level on one row, EQ, Key and Stem under them,
// a thin meter at the right edge; a ⋯ menu instead of the second row when lanes are short.
import { test, expect } from "@playwright/test";
import { TALL_WINDOW, openStudio } from "./helpers.mjs";

const SHORT_WINDOW = { width: 1366, height: 768 };
// Short enough that the lanes scroll.
const SCROLLING_WINDOW = { width: 1366, height: 600 };
const SCROLL_PX = 40;
const MIN_MS_PX = 36;
const MAX_METER_W_PX = 6;
const METER_EDGE_PX = 10;
const LEVEL_SAMPLES = 12;
const SAMPLE_GAP_MS = 80;
const DB_TEXT = /^(-∞|[-+]?\d+\.\d)$/;
const HEADER_STYLE_PROPS = ["color", "backgroundColor", "opacity", "filter", "boxShadow", "borderColor"];

const header = (page, stem) => page.locator(`.lane-header[data-stem="${stem}"]`);
const waveRow = (page, stem) => page.locator(`.stem-waveform-row[data-stem="${stem}"]`);

async function box(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not laid out");
  return b;
}

/** Every header part's look, and the level each meter shows, once per sample. */
function sampleHeaders(page) {
  return page.evaluate(async ({ props, samples, gapMs }) => {
    const rows = [...document.querySelectorAll(".mixer-column .lane-header[data-stem]:not(.hidden):not(.unavailable)")];
    const look = (el) => props.map((p) => getComputedStyle(el)[p]).join("|");
    const snap = () => ({
      looks: rows.map((row) => [row, ...row.querySelectorAll("*")]
        .filter((el) => !el.closest(".lane-vu"))
        .map(look)
        .join("\n")),
      levels: rows.map((row) => row.querySelector(".lane-vu")?.style.getPropertyValue("--vu-level") ?? ""),
    });
    const out = [];
    for (let i = 0; i < samples; i++) {
      out.push(snap());
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    return out;
  }, { props: HEADER_STYLE_PROPS, samples: LEVEL_SAMPLES, gapMs: SAMPLE_GAP_MS });
}

test.describe("a stem's header on a tall window", () => {
  test.use({ viewport: TALL_WINDOW });

  test("name, M, S, fader and dB on one row; EQ, Key and Stem under them; the meter at the edge", async ({ page }) => {
    await openStudio(page);
    const vocals = header(page, "vocals");
    const name = vocals.locator(".mx-name");
    await expect(name).toHaveText("Vocals");
    for (const sel of [".mute", ".solo"]) {
      const b = await box(vocals.locator(sel));
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(MIN_MS_PX);
    }
    await expect(vocals.locator(".lane-knob")).toBeVisible();
    await expect(vocals.locator(".mx-val")).toHaveText(DB_TEXT);
    await expect(vocals.locator(".lane-more")).toBeHidden();

    const second = vocals.locator(".lane-x");
    await expect(second.locator(".eq-lane-mark")).toContainText("EQ");
    await expect(second.locator(".lane-key")).toContainText("Key");
    await expect(second.locator(".lane-key-value")).toHaveText("0");
    await expect(second.locator(".lane-dl")).toContainText("Stem");
    const firstRow = await box(vocals.locator(".lane-main"));
    expect((await box(second)).y).toBeGreaterThanOrEqual(firstRow.y + firstRow.height);

    const meter = await box(vocals.locator(".lane-vu"));
    const head = await box(vocals);
    expect(meter.width).toBeLessThanOrEqual(MAX_METER_W_PX);
    expect(head.x + head.width - (meter.x + meter.width)).toBeLessThanOrEqual(METER_EDGE_PX);
    await expect(page.getByText("Drag fader")).toHaveCount(0);
  });

  test("clicking a stem's name mutes it, and M shows it", async ({ page }) => {
    await openStudio(page);
    const drums = header(page, "drums");
    const mute = drums.locator(".mute");
    const name = drums.locator(".mx-name");
    const offLook = await mute.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(name).toHaveAttribute("aria-pressed", "false");
    await name.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await expect(mute).toHaveClass(/\bactive\b/);
    await expect(name).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => mute.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(offLook);
    await name.click();
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await expect(name).toHaveAttribute("aria-pressed", "false");
  });

  test("a muted lane and a lane silenced by another's solo are greyed, header and waveform", async ({ page }) => {
    await openStudio(page);
    const heardColor = await header(page, "vocals").locator(".mx-name").evaluate((el) => getComputedStyle(el).color);
    await header(page, "drums").locator(".mute").click();
    await expect(header(page, "drums")).toHaveClass(/\bis-silent\b/);
    await expect(waveRow(page, "drums")).toHaveClass(/\bis-silent\b/);
    await expect(header(page, "vocals")).not.toHaveClass(/\bis-silent\b/);

    await header(page, "bass").locator(".solo").click();
    await expect(header(page, "vocals")).toHaveClass(/\bis-silent\b/);
    await expect(waveRow(page, "vocals")).toHaveClass(/\bis-silent\b/);
    await expect(header(page, "bass")).not.toHaveClass(/\bis-silent\b/);
    const greyColor = await header(page, "vocals").locator(".mx-name").evaluate((el) => getComputedStyle(el).color);
    expect(greyColor).not.toBe(heardColor);

    await header(page, "bass").locator(".solo").click();
    await header(page, "drums").locator(".mute").click();
    await expect(page.locator(".lane-header.is-silent, .stem-waveform-row.is-silent")).toHaveCount(0);
  });

  test("while playing only the meters move; the meter is one colour", async ({ page }) => {
    await openStudio(page);
    await page.mouse.move(0, 0);
    await page.locator("#t-play").click();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".lane-vu")]
      .some((vu) => parseFloat(vu.style.getPropertyValue("--vu-level")) > 0))).toBe(true);
    const samples = await sampleHeaders(page);
    await page.locator("#t-play").click();
    expect(new Set(samples.map((s) => JSON.stringify(s.looks))).size).toBe(1);
    expect(new Set(samples.map((s) => JSON.stringify(s.levels))).size).toBeGreaterThan(1);
    const fill = header(page, "vocals").locator(".lane-vu .mx-meter-fill");
    expect(await fill.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  });
});

test.describe("a stem's header on a short window", () => {
  test.use({ viewport: SHORT_WINDOW });

  const menu = (page) => page.getByRole("menu");
  const entryTexts = (page) => menu(page).locator(".lib-menu-item > span:not(.row-menu-hint)");
  const entryHints = (page) => menu(page).locator(".row-menu-hint");

  test("EQ, Key and Stem move into the lane's ⋯ menu", async ({ page }) => {
    await openStudio(page);
    const vocals = header(page, "vocals");
    await expect(vocals.locator(".lane-x")).toBeHidden();
    await vocals.locator(".lane-more").click();
    await expect(entryTexts(page)).toHaveText([
      "Vocals EQ", "Transpose up a semitone", "Transpose down a semitone", "Download Vocals",
    ]);
    await expect(entryHints(page)).toHaveText(["EQ off", "Key 0"]);
    const m = await box(menu(page));
    expect(m.y + m.height).toBeLessThanOrEqual(SHORT_WINDOW.height);
    expect(m.x + m.width).toBeLessThanOrEqual(SHORT_WINDOW.width);

    await menu(page).getByRole("menuitem", { name: "Transpose up a semitone" }).click();
    await expect(vocals.locator(".lane-key-value")).toHaveText("+1");
    await expect(entryHints(page)).toHaveText(["EQ off", "Key +1"]);
  });

  test("drums' transpose entries are disabled with the reason; EQ opens the lane's EQ", async ({ page }) => {
    await openStudio(page);
    await header(page, "drums").locator(".lane-more").click();
    const up = menu(page).getByRole("menuitem", { name: "Transpose up a semitone" });
    await expect(up).toBeDisabled();
    await expect(up).toHaveAttribute("title", "Drums are never transposed");
    await menu(page).getByRole("menuitem", { name: "Drums EQ" }).click();
    await expect(page.locator("#eqScopeName")).toHaveText("Drums");
  });

  test("Esc closes the lane menu and gives focus back to ⋯", async ({ page }) => {
    await openStudio(page);
    const more = header(page, "bass").locator(".lane-more");
    await more.click();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("a transposed lane marks ⋯ and says so, and its menu shows the key", async ({ page }) => {
    await openStudio(page);
    const more = header(page, "vocals").locator(".lane-more");
    await expect(more).not.toHaveClass(/\bis-changed\b/);
    await expect(more).toHaveAttribute("aria-label", "More for Vocals");
    await more.click();
    const up = menu(page).getByRole("menuitem", { name: "Transpose up a semitone" });
    await up.click();
    await up.click();
    await expect(more).toHaveClass(/\bis-changed\b/);
    await expect(more).toHaveAttribute("aria-label", "More for Vocals: Key +2");
    await expect(entryHints(page)).toHaveText(["EQ off", "Key +2"]);
  });

  test("the menu's download is a stem link like the header's, so it saves and drags out", async ({ page }) => {
    await openStudio(page);
    const headerLink = header(page, "bass").locator("a.lane-dl");
    await header(page, "bass").locator(".lane-more").click();
    const entry = menu(page).locator("a.lane-dl");
    await expect(entry).toHaveRole("menuitem");
    await expect(entry).not.toHaveAttribute("href", "#");
    await expect(entry).toHaveAttribute("href", await headerLink.getAttribute("href"));
    await expect(entry).toHaveAttribute("download", await headerLink.getAttribute("download"));
    const download = page.waitForEvent("download");
    await entry.click();
    expect((await download).suggestedFilename()).toBe(await headerLink.getAttribute("download"));
    await expect(menu(page)).toHaveCount(0);
  });
});

test("the lane menu closes when the lanes scroll", async ({ page }) => {
  await page.setViewportSize(SCROLLING_WINDOW);
  await openStudio(page);
  const more = header(page, "vocals").locator(".lane-more");
  await more.click();
  await expect(page.getByRole("menu")).toBeVisible();
  const scrolled = await more.evaluate((btn, px) => {
    for (let el = btn.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
        el.scrollTop += px;
        return el.scrollTop > 0;
      }
    }
    return false;
  }, SCROLL_PX);
  expect(scrolled, "the lanes scroll").toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
});
