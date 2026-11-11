// The footer's fit-to-width decision, against a model of the strip's layout.
//
// #633: a footer sitting on a single threshold "breathed" -- every wobble
// across it flipped the level and re-triggered the observer. These checks pin
// the two thresholds that replaced it, so a strip on the boundary collapses
// once and stays put, and still opens back up when the room really returns.
//
// The layout is a model, not a browser. What it has to get right is only what
// footerFit reads: where each cluster's edges fall at each level.

const GAP = 16;
const TIGHT_GAP = 8;
const HEIGHT = 34;
// Transport, Position, divider, Speed, divider, Global key.
const WIDTHS = [144, 433, 1, 179, 1, 225];
const BREAK = 2; // the divider that becomes the line break at "rows"
const FIRST_ROW = WIDTHS.slice(0, BREAK);
const SECOND_ROW = WIDTHS.slice(BREAK + 1);
// What the tight and compact levels take off Position, modelled as one sum each.
const TIGHT_SAVING = 60;
const COMPACT_SAVING = 100;
const POSITION = 1;

const rowWidth = (row, gap) => row.reduce((s, v) => s + v, 0) + gap * (row.length - 1);
const NATURAL = rowWidth(WIDTHS, GAP);
const ROWS_W = Math.max(rowWidth(FIRST_ROW, GAP), rowWidth(SECOND_ROW, GAP));
const TIGHT_W = Math.max(rowWidth(FIRST_ROW, TIGHT_GAP) - TIGHT_SAVING, rowWidth(SECOND_ROW, TIGHT_GAP));
const COMPACT_W = TIGHT_W - COMPACT_SAVING;

// ── A strip that lays itself out from its classes ─────────────────────────────

let width = 2000; // the strip's own width, fractional like the real one

const classes = new Set();
const classList = {
  add: (c) => classes.add(c),
  remove: (c) => classes.delete(c),
  contains: (c) => classes.has(c),
};

function placeRow(widths, gap, top) {
  let x = 0;
  return widths.map((w) => {
    const r = { left: x, right: x + w, width: w, height: top === null ? 0 : HEIGHT };
    x += w + gap;
    return r;
  });
}

function layout() {
  const gap = classes.has('collapse-tight') ? TIGHT_GAP : GAP;
  const widths = [...WIDTHS];
  if (classes.has('collapse-tight')) widths[POSITION] -= TIGHT_SAVING;
  if (classes.has('collapse-compact')) widths[POSITION] -= COMPACT_SAVING;
  if (!classes.has('collapse-rows')) return placeRow(widths, gap, 0);
  const lineBreak = { left: 0, right: width, width, height: 0 };
  return [
    ...placeRow(widths.slice(0, BREAK), gap, 0),
    lineBreak,
    ...placeRow(widths.slice(BREAK + 1), gap, 1),
  ];
}

const children = WIDTHS.map((_, i) => ({ getBoundingClientRect: () => layout()[i] }));

const strip = {
  isConnected: true,
  classList,
  children,
  get clientWidth() { return Math.round(width); },
  getBoundingClientRect: () => ({ left: 0, right: width, width }),
};

globalThis.document = {
  querySelector: (sel) => (sel === '.footer-clusters' ? strip : null),
};

const events = [];
globalThis.window = {
  dispatchEvent: (e) => events.push(e.detail.level),
  addEventListener: () => {},
};
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
}

const frames = [];
globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };

let observe = null;
globalThis.ResizeObserver = class {
  constructor(cb) { observe = cb; }
  observe() {}
};

const { initFooterFit } = await import('../../static/js/footerFit.js');

// ── Driving it ────────────────────────────────────────────────────────────────

function flush() {
  while (frames.length) frames.shift()();
}

// The strip becomes `w` wide: the observer reports it, and the fit runs on the
// next frame the way it does in the browser.
function resizeTo(w, height = 54) {
  width = w;
  observe([{ contentRect: { width: w, height } }]);
  flush();
}

const levelNow = () => ['collapse-rows', 'collapse-tight', 'collapse-compact'].filter((c) => classes.has(c)).join(' ') || 'inline';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}

// How many times the level changed along the way.
const changes = (seen) => seen.filter((l, i) => i && l !== seen[i - 1]).length;

// Width alternating between `a` and `b` for `n` frames, the way a scrollbar
// arriving and leaving moves it. Returns every level the strip passed through.
function wobble(a, b, n = 20) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    resizeTo(i % 2 ? b : a);
    seen.push(levelNow());
  }
  return seen;
}

function checkWobble(name, from, a, b, expected) {
  resizeTo(from);
  events.length = 0;
  const seen = wobble(a, b);
  check(
    name,
    new Set(seen).size === 1 && seen[0] === expected && events.length === 1,
    `levels=${[...new Set(seen)].join(',')} footerfit events=${events.length}`,
  );
}

initFooterFit();
flush();

// Sanity: the model's thresholds are where the test thinks they are.
resizeTo(NATURAL + 50);
check('a wide strip stays fully inline', levelNow() === 'inline', levelNow());
resizeTo(NATURAL - 20);
check('a strip 20px short moves Speed and Global key to a second row', levelNow() === 'collapse-rows', levelNow());
resizeTo(ROWS_W - 10);
check('a strip too short for two rows tightens', levelNow() === 'collapse-rows collapse-tight', levelNow());

checkWobble(
  'a scrollbar-sized wobble across the inline threshold collapses once and stays',
  NATURAL + 200, NATURAL - 6, NATURAL + 11, 'collapse-rows',
);
checkWobble(
  'a wobble across the rows/tight threshold collapses once and stays',
  ROWS_W + 200, ROWS_W - 6, ROWS_W + 11, 'collapse-rows collapse-tight',
);
checkWobble(
  'a wobble across the tight/compact threshold collapses once and stays',
  TIGHT_W + 30, TIGHT_W - 6, TIGHT_W + 11, 'collapse-rows collapse-tight collapse-compact',
);

{
  // The 250% case, where one layout reads either side of the line depending on how it rounds.
  resizeTo(NATURAL + 200);
  events.length = 0;
  const seen = wobble(NATURAL + 0.4, NATURAL - 0.4);
  check(
    'a sub-pixel wobble across the inline threshold settles',
    changes(seen) <= 1 && events.length <= 1,
    `levels=${[...new Set(seen)].join(',')} footerfit events=${events.length}`,
  );
}

{
  resizeTo(TIGHT_W - 6);
  resizeTo(TIGHT_W + 30);
  check('compact opens back up once the room really returns', levelNow() === 'collapse-rows collapse-tight', levelNow());
  resizeTo(COMPACT_W - 10);
  check('a strip too short even for compact keeps every level', levelNow() === 'collapse-rows collapse-tight collapse-compact', levelNow());
}

{
  // Hysteresis must not turn into a ratchet: real room still opens it back up.
  resizeTo(ROWS_W - 10);
  resizeTo(NATURAL + 30);
  check('the strip opens fully back up once the room really returns', levelNow() === 'inline', levelNow());
}

{
  // A second row that fits only within the slack stays a second row.
  resizeTo(NATURAL - 20);
  resizeTo(NATURAL + 10);
  check('rows holds until the single row has REOPEN_SLACK to spare', levelNow() === 'collapse-rows', levelNow());
}

{
  // And it never keeps a level that overflows: collapsing needs no slack.
  resizeTo(NATURAL + 30);
  resizeTo(NATURAL - 0.5);
  check('half a pixel short is still short', levelNow() !== 'inline', levelNow());
}

{
  // The strip's height is an output of the fit. A notification that only
  // changes it must not schedule another pass.
  resizeTo(NATURAL - 20);
  observe([{ contentRect: { width, height: 97 } }]);
  check('a height-only resize does not re-fit', frames.length === 0, `queued=${frames.length}`);
  flush();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
