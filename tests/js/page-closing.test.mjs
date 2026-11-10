// The page-closing flag through the events that set and clear it.
// Run:  node tests/js/page-closing.test.mjs

// The module listens on the global, which Node only has once it is given a target.
const page = new EventTarget();
globalThis.addEventListener = page.addEventListener.bind(page);
const { isPageClosing } = await import('../../static/js/pageClosing.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- got ${actual}, want ${expected}`);
  }
}

const fire = (type) => page.dispatchEvent(new Event(type));

check('a fresh page is not closing', isPageClosing(), false);
fire('beforeunload');
check('beforeunload marks the page closing', isPageClosing(), true);
fire('pointerdown');
check('a pointer press clears it', isPageClosing(), false);
fire('beforeunload');
fire('keydown');
check('a key press clears it', isPageClosing(), false);
fire('pagehide');
check('pagehide marks the page closing without a beforeunload', isPageClosing(), true);
fire('pageshow');
check('pageshow clears it', isPageClosing(), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
