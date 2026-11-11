// The glow Guide draws when it turns on: one outline per control a user can
// see, each the size of its control, inside the window and clear of the others.
// A crowded library with long titles is the case that used to break it: rows
// scrolled out of the list and their hover-only buttons were outlined too.
// The help pill must leave every outlined control and the transport uncovered.

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
const NATIVE_CHECK = "__e2eCheckVisibility";
// Three ways a rendered control can still be unseen: its own opacity, its
// visibility, and a see-through ancestor.
const HIDDEN_CONTROLS = ["t-loop", "t-stop", "t-pitch-reset"];
const HIDDEN_CONTROLS_CSS = `
  #t-loop { opacity: 0; }
  #t-stop { visibility: hidden; }
  :has(> #t-pitch-reset) { opacity: 0; }
`;
const TRANSPORT_CONTROLS = '.daw-footer :is(button, input, select, [role="slider"])';

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

/** The WebKit builds the desktop app may get: no Element.checkVisibility for the app to call. */
async function withoutCheckVisibility(page) {
  await page.addInitScript((stash) => {
    window[stash] = Element.prototype.checkVisibility;
    delete Element.prototype.checkVisibility;
  }, NATIVE_CHECK);
}

/** Every intro outline, the control it matches, and whether a user can see all of that control. */
function measureOutlines({ tolerance, stash }) {
  const checkVisibility = Element.prototype.checkVisibility ?? window[stash];
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
    return checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true })
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

/** The help pill, and every transport control a user can see. */
function measurePill(selector) {
  const edges = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const controls = [...document.querySelectorAll(selector)]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility === "visible")
    .map((el) => ({ target: el.id || el.className, rect: edges(el) }));
  return { pill: edges(document.querySelector(".help-pill")), controls };
}

function crossing(a, b) {
  return a.right > b.left + RECT_TOLERANCE_PX
    && b.right > a.left + RECT_TOLERANCE_PX
    && a.bottom > b.top + RECT_TOLERANCE_PX
    && b.bottom > a.top + RECT_TOLERANCE_PX;
}

function overlapping(outlines) {
  const pairs = [];
  outlines.forEach((a, i) => outlines.slice(i + 1).forEach((b) => {
    if (crossing(a.rect, b.rect)) pairs.push([a.target, b.target]);
  }));
  return pairs;
}

async function guideOn(page, viewport, { native }) {
  await page.setViewportSize(viewport);
  if (!native) await withoutCheckVisibility(page);
  await openStudio(page, { catalog: crowdedLibrary() });
  await page.addStyleTag({ content: HIDDEN_CONTROLS_CSS });
  expect(await page.evaluate(() => typeof Element.prototype.checkVisibility)).toBe(native ? "function" : "undefined");
  await page.locator("#helpModeBtn").click();
  await expect(page.locator(".help-pill")).toBeVisible();
}

const ENGINES = [
  { native: true, label: "" },
  { native: false, label: " without checkVisibility" },
];

test.describe("Guide outlines", () => {
  for (const viewport of VIEWPORTS) for (const engine of ENGINES) {
    test(`each outline fits a visible control at ${viewport.width} px${engine.label}`, async ({ page }) => {
      await guideOn(page, viewport, engine);
      const outlines = await page.evaluate(measureOutlines, { tolerance: RECT_TOLERANCE_PX, stash: NATIVE_CHECK });

      expect(outlines.length).toBeGreaterThan(MIN_OUTLINES);
      const outside = outlines.filter(({ rect }) => rect.left < 0 || rect.top < 0
        || rect.right > viewport.width || rect.bottom > viewport.height);
      expect(outside).toEqual([]);
      expect(outlines.filter((o) => !o.target)).toEqual([]);
      const hidden = outlines.filter((o) => HIDDEN_CONTROLS.some((id) => o.target.includes(`#${id}.`)));
      expect(hidden.map((o) => o.target)).toEqual([]);
      expect(outlines.filter((o) => !o.seen).map((o) => o.target)).toEqual([]);
      expect(overlapping(outlines)).toEqual([]);
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`the help pill covers no control at ${viewport.width} px`, async ({ page }) => {
      await guideOn(page, viewport, { native: true });
      const outlines = await page.evaluate(measureOutlines, { tolerance: RECT_TOLERANCE_PX, stash: NATIVE_CHECK });
      const { pill, controls } = await page.evaluate(measurePill, TRANSPORT_CONTROLS);

      expect(controls.length).toBeGreaterThan(0);
      const covered = [...outlines, ...controls].filter(({ rect }) => crossing(pill, rect)).map((c) => c.target);
      expect(covered).toEqual([]);
    });
  }
});
