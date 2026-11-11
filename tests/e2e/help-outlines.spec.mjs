// The glow Guide draws when it turns on: one outline per control a user can
// see, each the size of its control, inside the window and clear of the others.
// A crowded library with long titles is the case that used to break it: rows
// scrolled out of the list and their hover-only buttons were outlined too.

import { test, expect } from "@playwright/test";

import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE, fixtureTrack, openStudio } from "./helpers.mjs";

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
// Outlines are placed on whole pixels, so a control on a fractional edge is up to half a pixel off.
const RECT_TOLERANCE_PX = 1;
const MIN_OUTLINES = 20;
const EXTRA_SONGS = 24;
const LONG_TITLE = "A song whose title is far too long to fit on one row of the library";

function crowdedLibrary() {
  const extra = Array.from({ length: EXTRA_SONGS }, (_, i) => `e2e0long${String(i).padStart(4, "0")}`);
  const tracks = {
    [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
    [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
  };
  for (const id of extra) tracks[id] = fixtureTrack(id, `${LONG_TITLE} ${id}`);
  return {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, ...extra], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks,
  };
}

/** Every intro outline, the control it matches, and whether a user can see all of that control. */
function measureOutlines(tolerance) {
  const box = (el) => el.getBoundingClientRect();
  const close = (a, b) => ["left", "top", "right", "bottom"].every((k) => Math.abs(a[k] - b[k]) <= tolerance);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")}`;
  const inside = (r, frame) => r.left >= frame.left - tolerance && r.right <= frame.right + tolerance
    && r.top >= frame.top - tolerance && r.bottom <= frame.bottom + tolerance;
  const clippingPanels = (el) => {
    const panels = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(p);
      if (overflowX !== "visible" || overflowY !== "visible") panels.push(p);
    }
    return panels;
  };
  const onTop = (el, r) => {
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return Boolean(hit) && el.contains(hit);
  };
  const seen = (el) => {
    const r = box(el);
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      && clippingPanels(el).every((p) => inside(r, box(p)))
      && onTop(el, r);
  };
  const targets = [...document.querySelectorAll(".help-target")];
  return [...document.querySelectorAll(".help-intro-ring")].map((ring) => {
    const r = box(ring);
    const rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const target = targets.find((el) => close(box(el), r));
    return { rect, target: target ? describe(target) : null, seen: target ? seen(target) : false };
  });
}

function overlapping(outlines) {
  const pairs = [];
  outlines.forEach((a, i) => outlines.slice(i + 1).forEach((b) => {
    const apart = a.rect.right <= b.rect.left + RECT_TOLERANCE_PX
      || b.rect.right <= a.rect.left + RECT_TOLERANCE_PX
      || a.rect.bottom <= b.rect.top + RECT_TOLERANCE_PX
      || b.rect.bottom <= a.rect.top + RECT_TOLERANCE_PX;
    if (!apart) pairs.push([a.target, b.target]);
  }));
  return pairs;
}

test.describe("Guide outlines", () => {
  for (const viewport of VIEWPORTS) {
    test(`each outline fits a visible control at ${viewport.width} px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openStudio(page, { catalog: crowdedLibrary() });
      await page.locator("#helpModeBtn").click();
      const outlines = await page.evaluate(measureOutlines, RECT_TOLERANCE_PX);

      expect(outlines.length).toBeGreaterThan(MIN_OUTLINES);
      const outside = outlines.filter(({ rect }) => rect.left < 0 || rect.top < 0
        || rect.right > viewport.width || rect.bottom > viewport.height);
      expect(outside).toEqual([]);
      expect(outlines.filter((o) => !o.target)).toEqual([]);
      expect(outlines.filter((o) => !o.seen).map((o) => o.target)).toEqual([]);
      expect(overlapping(outlines)).toEqual([]);
    });
  }
});
