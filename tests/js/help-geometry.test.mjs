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

const { hoverRect } = await import("../../static/js/helpGeometry.js");

const PANEL = node(rect(0, 0, 100, 400), BODY, CLIPPING);
const BUTTON_ACROSS_EDGE = rect(80, 50, 140, 90);

const CASES = [
  {
    name: "an icon inside the panel takes the icon's ring",
    icon: rect(84, 64, 96, 76),
    check: (r) => r.left === 78 && r.right === 102 && r.top === 58 && r.bottom === 82,
  },
  {
    name: "an icon clipped out of view rings what is in view of its button",
    icon: rect(120, 64, 132, 76),
    check: (r) => r.width > 0 && r.height > 0 && r.left === 77 && r.right === 103 && r.top === 47 && r.bottom === 93,
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
