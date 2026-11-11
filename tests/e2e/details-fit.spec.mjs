// The song details box closes from a comfortable target, and the Details tab
// shows every label whole, however long the language spells it.

import { test, expect } from "@playwright/test";
import { openInspectorTab, openStudio } from "./helpers.mjs";

const NARROW_WIDTH = 1024;
const WIDE_WIDTH = 1600;
const HEIGHT = 800;
const DETAILS_LABELS = ".inspector .meta-card-label, .inspector .stem-card-label";
const LONG_LABEL_LANGUAGES = ["en", "de", "fr"];

function useLanguage(page, code) {
  return page.addInitScript(
    (language) => window.localStorage.setItem("stemdeck.language", JSON.stringify(language)),
    code,
  );
}

function boxSize(locator) {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
}

function rootToken(page, name) {
  return page.evaluate(
    (token) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)),
    name,
  );
}

test("the song details close button is as easy to hit as the other dialogs'", async ({ page }) => {
  await page.setViewportSize({ width: WIDE_WIDTH, height: HEIGHT });
  await openStudio(page);

  await page.locator("#settingsBtn").click();
  const settings = await boxSize(page.locator(".library-editor-close"));
  await page.keyboard.press("Escape");

  await page.locator("#aboutBtn").click();
  const about = await boxSize(page.locator("#aboutClose"));
  await page.keyboard.press("Escape");

  await page.locator("#artistDialog").evaluate((el) => el.classList.remove("hidden"));
  const artist = await boxSize(page.locator("#artistClose"));
  const comfortable = await rootToken(page, "--ctl-h-sm");

  for (const side of ["width", "height"]) {
    expect(artist[side]).toBeGreaterThanOrEqual(comfortable);
    expect(artist[side]).toBeGreaterThanOrEqual(settings[side]);
    expect(artist[side]).toBeGreaterThanOrEqual(about[side]);
  }
});

for (const language of LONG_LABEL_LANGUAGES) {
  test(`${language} at ${NARROW_WIDTH}px: every Details label shows whole`, async ({ page }) => {
    await page.setViewportSize({ width: NARROW_WIDTH, height: HEIGHT });
    await useLanguage(page, language);
    await openStudio(page);
    await openInspectorTab(page, "details");

    const smallest = await rootToken(page, "--fs-2xs");
    const unreadable = await page.evaluate(
      ({ selector, minSize }) => {
        const shown = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length);
        return shown
          .filter((el) => {
            const card = el.parentElement.getBoundingClientRect();
            const label = el.getBoundingClientRect();
            const shrunk = parseFloat(getComputedStyle(el).fontSize) < minSize;
            const clipped = el.scrollWidth > el.clientWidth || label.right > card.right;
            return shrunk || clipped;
          })
          .map((el) => el.textContent);
      },
      { selector: DETAILS_LABELS, minSize: smallest },
    );
    expect(unreadable).toEqual([]);
  });
}

// The File card's markup comes from the Details labels change; until that is
// merged this builds the same shape so the layout is measured on it.
const LABELLED_FILE_FACTS = `
  <span id="t-stems-chip">6 stems</span>
  <span class="daw-track-sep" aria-hidden="true">·</span>
  <span class="details-fact"><span class="details-fact-label">Source</span> <span>YouTube</span></span>
  <span class="daw-track-sep" aria-hidden="true">·</span>
  <span class="details-fact"><span class="details-fact-label">Format</span> <span>WAV</span></span>
  <span class="daw-track-sep" aria-hidden="true">·</span>
  <span class="details-fact"><span class="details-fact-label">Extracted</span> <span>Nov 4, 8:32 PM</span></span>`;

test(`at ${NARROW_WIDTH}px the File card lines its labels up beside their values`, async ({ page }) => {
  await page.setViewportSize({ width: NARROW_WIDTH, height: HEIGHT });
  await openStudio(page);
  await openInspectorTab(page, "details");
  const line = page.locator(".details-song .daw-track-meta-line");
  await line.evaluate((el, html) => { el.innerHTML = html; }, LABELLED_FILE_FACTS);

  const facts = await line.evaluate((el) =>
    [...el.querySelectorAll(".details-fact")].map((fact) => {
      const label = fact.querySelector(".details-fact-label").getBoundingClientRect();
      const value = fact.lastElementChild.getBoundingClientRect();
      const labelStyle = getComputedStyle(fact.firstElementChild);
      const valueStyle = getComputedStyle(fact.lastElementChild);
      return {
        labelLeft: label.left,
        labelRight: label.right,
        labelTop: label.top,
        labelBottom: label.bottom,
        valueLeft: value.left,
        valueTop: value.top,
        valueBottom: value.bottom,
        labelSmaller: parseFloat(labelStyle.fontSize) < parseFloat(valueStyle.fontSize),
        labelMuted: labelStyle.color !== valueStyle.color,
      };
    }),
  );
  expect(facts).toHaveLength(3);
  for (const fact of facts) {
    expect(fact.valueTop).toBeLessThan(fact.labelBottom);
    expect(fact.labelTop).toBeLessThan(fact.valueBottom);
    expect(fact.valueLeft).toBeGreaterThan(fact.labelRight);
    expect(fact.labelSmaller).toBe(true);
    expect(fact.labelMuted).toBe(true);
  }
  expect(new Set(facts.map((fact) => Math.round(fact.labelLeft))).size).toBe(1);
  expect(new Set(facts.map((fact) => Math.round(fact.valueLeft))).size).toBe(1);
  expect(new Set(facts.map((fact) => Math.round(fact.labelTop))).size).toBe(facts.length);
});

test(`at ${NARROW_WIDTH}px the key's confidence figure fits inside its ring`, async ({ page }) => {
  await page.setViewportSize({ width: NARROW_WIDTH, height: HEIGHT });
  await openStudio(page);
  await openInspectorTab(page, "details");
  const ring = page.locator("#summary-confidence");
  await ring.evaluate((el) => {
    el.innerHTML = "<span>100%</span>";
    el.classList.remove("hidden");
  });

  const fit = await ring.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const figure = el.firstElementChild.getBoundingClientRect();
    return { left: figure.left >= outer.left, right: figure.right <= outer.right, overflow: el.scrollWidth > el.clientWidth };
  });
  expect(fit).toEqual({ left: true, right: true, overflow: false });
});
