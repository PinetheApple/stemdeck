// The glow Guide draws when it turns on: one outline per control a user can
// see, each the size of its control, inside the window and clear of the others.
// A crowded library with long titles is the case that used to break it: rows
// scrolled out of the list and their hover-only buttons were outlined too.
// The help pill must leave every control and the transport uncovered, and keep
// doing so when the studio's layout changes under it.

import { test, expect } from "@playwright/test";

import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE, fixtureTrack, openStudio } from "./helpers.mjs";
import { clickFrozen, freezeTimers } from "./saveRaces.mjs";

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
// Guide treats anything bigger than this share of the window as an area to point into, not a control.
const AREA_SHARE = 0.04;
const NO_TRACK_AREA_CSS = ".waves-column { display: none !important; }";

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

/**
 * The help pill; every control a user can see right now (each transport control,
 * and each explainable one that is not an area and is not covered); and the
 * middle of the waveforms' visible part, if they are shown.
 */
function measurePill({ transport, areaShare }) {
  const edges = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const big = window.innerWidth * window.innerHeight * areaShare;
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return r.width * r.height > 0 && r.width * r.height <= big && Boolean(hit) && el.contains(hit);
  };
  const controls = [...document.querySelectorAll(`${transport}, .help-target`)]
    .filter((el) => getComputedStyle(el).visibility === "visible" && seen(el))
    .map((el) => ({ target: el.id || el.className, rect: edges(el) }));
  const track = document.querySelector(".waves-column");
  let area = track?.getClientRects().length ? edges(track) : null;
  for (let p = track?.parentElement; area && p && p !== document.body; p = p.parentElement) {
    const { overflowX } = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    if (overflowX !== "visible") area = { ...area, left: Math.max(area.left, r.left), right: Math.min(area.right, r.right) };
  }
  const trackCentre = area ? (area.left + area.right) / 2 : null;
  return { pill: edges(document.querySelector(".help-pill")), controls, trackCentre };
}

const pillCentre = ({ pill }) => (pill.left + pill.right) / 2;
const coveredBy = ({ pill, controls }) => controls.filter(({ rect }) => crossing(pill, rect)).map((c) => c.target);
const measurePillNow = (page) => page.evaluate(measurePill, { transport: TRANSPORT_CONTROLS, areaShare: AREA_SHARE });

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

/** Guide on in a crowded studio. `hold` stops the page's clock first, so the intro's outlines stay up to be measured. */
async function guideOn(page, viewport, { native, hold = false, css = HIDDEN_CONTROLS_CSS }) {
  await page.setViewportSize(viewport);
  if (!native) await withoutCheckVisibility(page);
  if (hold) await page.clock.install();
  await openStudio(page, { catalog: crowdedLibrary() });
  await page.addStyleTag({ content: css });
  expect(await page.evaluate(() => typeof Element.prototype.checkVisibility)).toBe(native ? "function" : "undefined");
  if (hold) {
    await freezeTimers(page);
    await clickFrozen(page, "#helpModeBtn");
  } else {
    await page.locator("#helpModeBtn").click();
  }
  await expect(page.locator(".help-pill")).toBeVisible();
}

const ENGINES = [
  { native: true, label: "" },
  { native: false, label: " without checkVisibility" },
];

test.describe("Guide outlines", () => {
  for (const viewport of VIEWPORTS) for (const engine of ENGINES) {
    test(`each outline fits a visible control at ${viewport.width} px${engine.label}`, async ({ page }) => {
      await guideOn(page, viewport, { ...engine, hold: true });
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

  for (const viewport of VIEWPORTS) for (const engine of ENGINES) {
    test(`the help pill covers no control at ${viewport.width} px${engine.label}`, async ({ page }) => {
      await guideOn(page, viewport, engine);
      const measured = await measurePillNow(page);

      expect(measured.controls.length).toBeGreaterThan(MIN_OUTLINES);
      expect(coveredBy(measured)).toEqual([]);
      expect(Math.abs(pillCentre(measured) - measured.trackCentre)).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
    });
  }

  test("the help pill follows the waveforms when the library is put away", async ({ page }) => {
    await guideOn(page, VIEWPORTS[0], { native: true });
    const before = await measurePillNow(page);
    await page.evaluate(async () => (await import("/js/catalog.js")).setSidebarCollapsed(true));

    await expect.poll(async () => (await measurePillNow(page)).trackCentre).not.toBe(before.trackCentre);
    await expect.poll(async () => {
      const measured = await measurePillNow(page);
      return Math.abs(pillCentre(measured) - measured.trackCentre);
    }).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
    expect(coveredBy(await measurePillNow(page))).toEqual([]);
  });

  test("with no waveforms shown, the help pill sits above the transport, centred", async ({ page }) => {
    const viewport = VIEWPORTS[0];
    await guideOn(page, viewport, { native: true, css: NO_TRACK_AREA_CSS });
    const measured = await measurePillNow(page);

    expect(measured.trackCentre).toBeNull();
    expect(Math.abs(pillCentre(measured) - viewport.width / 2)).toBeLessThanOrEqual(RECT_TOLERANCE_PX);
    const footerTop = await page.locator(".daw-footer").evaluate((el) => el.getBoundingClientRect().top);
    expect(measured.pill.bottom).toBeLessThanOrEqual(footerTop);
  });
});
