// Run:  node tests/js/help-geometry.test.mjs
//
// Guide's pointer ring around a control in a clipping panel. The DOM is
// stubbed: each element is a fixed rect, and the panel clips both axes.

const WINDOW = { innerWidth: 1024, innerHeight: 768 };
const CLIPPING = { overflowX: "hidden", overflowY: "hidden" };
const BODY = { style: {}, parentElement: null };

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const node = (box, parentElement, style = {}) => ({ getBoundingClientRect: () => box, parentElement, style });

let drawing = rect(0, 0, 0, 0);
globalThis.window = WINDOW;
globalThis.getComputedStyle = (el) => ({ overflowX: "visible", overflowY: "visible", ...el.style });
globalThis.document = {
  body: BODY,
  createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => drawing }),
};

const { BOX_RING_PAD_PX, DRAWING_RING_PAD_PX, hoverRect } = await import("../../static/js/helpGeometry.js");

const PANEL_RIGHT = 100;
const PANEL = node(rect(0, 0, PANEL_RIGHT, 400), BODY, CLIPPING);
const BUTTON_ACROSS_EDGE = rect(80, 50, 140, 90);
const ICON_IN_VIEW = rect(84, 64, 96, 76);
const ICON_OUT_OF_VIEW = rect(120, 64, 132, 76);
const BUTTON_IN_VIEW = rect(BUTTON_ACROSS_EDGE.left, BUTTON_ACROSS_EDGE.top, PANEL_RIGHT, BUTTON_ACROSS_EDGE.bottom);

const grown = (r, pad) => ({ left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad });
const sameEdges = (got, want) => ["left", "top", "right", "bottom"].every((k) => got[k] === want[k]);

const CASES = [
  {
    name: "an icon inside the panel takes the icon's ring",
    icon: ICON_IN_VIEW,
    check: (r) => sameEdges(r, grown(ICON_IN_VIEW, DRAWING_RING_PAD_PX)),
  },
  {
    name: "an icon clipped out of view rings what is in view of its button",
    icon: ICON_OUT_OF_VIEW,
    check: (r) => r.width > 0 && r.height > 0 && sameEdges(r, grown(BUTTON_IN_VIEW, BOX_RING_PAD_PX)),
  },
];

let failed = 0;
for (const { name, icon, check } of CASES) {
  drawing = icon;
  const got = hoverRect(node(BUTTON_ACROSS_EDGE, PANEL));
  const ok = check(got);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- got ${JSON.stringify(got)}`}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
