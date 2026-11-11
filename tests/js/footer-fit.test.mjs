// footerFit's one decision, one row or "rows", against a model of the strip's flex layout.
// The model only has to place cluster edges where the browser would; widths match a real track.

const GAP = 16;
const HEIGHT = 34;
// Transport, Position, divider, Speed, divider, Global key.
const WIDTHS = [144, 433, 1, 179, 1, 225];
const BREAK = 2; // the divider that becomes the line break at "rows"
const NATURAL = WIDTHS.reduce((s, v) => s + v, 0) + GAP * (WIDTHS.length - 1);
const ROWS_CLASS = 'collapse-rows';

// ── A strip that lays itself out from its classes ─────────────────────────────

let width = 2000; // the strip's own width, fractional like the real one

const classes = new Set();
const classList = {
  add: (c) => classes.add(c),
  remove: (c) => classes.delete(c),
  contains: (c) => classes.has(c),
  toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
};

function singleRow() {
  let x = 0;
  return WIDTHS.map((w) => {
    const r = { left: x, right: x + w, width: w, height: HEIGHT };
    x += w + GAP;
    return r;
  });
}

// flex-wrap: a forced break after Position, then each item wraps when it would cross the edge.
function wrapped() {
  let x = 0;
  return WIDTHS.map((w, i) => {
    if (i === BREAK) {
      x = 0;
      return { left: 0, right: width, width, height: 0 };
    }
    if (x > 0 && x + w > width) x = 0;
    const r = { left: x, right: x + w, width: w, height: HEIGHT };
    x += w + GAP;
    return r;
  });
}

const layout = () => (classes.has(ROWS_CLASS) ? wrapped() : singleRow());
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

// The observer reports the new width and the fit runs on the next frame, as in the browser.
function resizeTo(w, height = 54) {
  width = w;
  observe([{ contentRect: { width: w, height } }]);
  flush();
}

const levelNow = () => (classes.has(ROWS_CLASS) ? 'rows' : 'inline');

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

const changes = (seen) => seen.filter((l, i) => i && l !== seen[i - 1]).length;

// Width alternating between `a` and `b`, the way a scrollbar arriving and leaving moves it.
function wobble(a, b, n = 20) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    resizeTo(i % 2 ? b : a);
    seen.push(levelNow());
  }
  return seen;
}

initFooterFit();
flush();

resizeTo(NATURAL + 50);
check('a wide strip stays on one row', levelNow() === 'inline', levelNow());
resizeTo(NATURAL - 20);
check('a strip 20px short wraps into rows', levelNow() === 'rows', levelNow());
resizeTo(400);
check('a very narrow strip only ever wraps', levelNow() === 'rows' && classes.size === 1, [...classes].join(' '));

{
  resizeTo(NATURAL + 200);
  events.length = 0;
  const seen = wobble(NATURAL - 6, NATURAL + 11);
  check(
    'a scrollbar-sized wobble across the threshold collapses once and stays',
    new Set(seen).size === 1 && seen[0] === 'rows' && events.join() === 'rows',
    `levels=${[...new Set(seen)].join(',')} footerfit events=${events.join()}`,
  );
}

{
  resizeTo(NATURAL + 200);
  events.length = 0;
  const seen = wobble(NATURAL + 0.4, NATURAL - 0.4);
  check(
    'a sub-pixel wobble across the threshold settles',
    changes(seen) <= 1 && events.length <= 1,
    `levels=${[...new Set(seen)].join(',')} footerfit events=${events.length}`,
  );
}

{
  resizeTo(NATURAL - 20);
  resizeTo(NATURAL + 10);
  check('rows holds until the single row has REOPEN_SLACK to spare', levelNow() === 'rows', levelNow());
  events.length = 0;
  resizeTo(NATURAL + 30);
  check('the strip returns to one row once the room really returns', levelNow() === 'inline' && events.length === 1 && events[0] === null, `${levelNow()} events=${events.length}`);
}

{
  resizeTo(NATURAL + 30);
  resizeTo(NATURAL - 0.5);
  check('half a pixel short is still short', levelNow() === 'rows', levelNow());
}

{
  // Height is an output of the fit; a height-only notification must not schedule another pass.
  resizeTo(NATURAL - 20);
  observe([{ contentRect: { width, height: 97 } }]);
  check('a height-only resize does not re-fit', frames.length === 0, `queued=${frames.length}`);
  flush();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
