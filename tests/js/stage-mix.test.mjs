// Stage mode's mixer column and song overview: which stems get a strip, which are silent,
// the dB each shows, and where sections sit on the whole-song strip.
// Run:  node tests/js/stage-mix.test.mjs

const noElement = () => null;
const announced = [];
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = {
  getElementById: noElement,
  querySelector: noElement,
  querySelectorAll: () => [],
  addEventListener() {},
  dispatchEvent: (event) => announced.push(event.type),
  documentElement: { getAttribute: () => null },
  createElement: () => ({ style: {} }),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { sectionSpans, stripStems } = await import('../../static/js/stageModel.js');
const {
  clearSilencedStems,
  isLaneSilenced,
  laneGainDbText,
  loadedLaneNames,
  MIX_CHANGE_EVENT,
  setSilencedStems,
} = await import('../../static/js/mixer.js');
const { mixerState, setTrackIndex } = await import('../../static/js/state.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- got ${got}, want ${want}`);
  }
}

const lanes = (...names) => Object.fromEntries(names.map((name, i) => [name, i]));
const entry = (muted = false, soloed = false) => ({ volume: 1, muted, soloed, pitch: 0 });
function mixOf(entries) {
  for (const key of Object.keys(mixerState)) delete mixerState[key];
  Object.assign(mixerState, entries);
}

setTrackIndex(lanes('original', 'vocals', 'drums', 'guitar', 'piano'));
check(
  'a lane kept for a stem the song lacks gets no strip, and the original none',
  stripStems(loadedLaneNames(), ['original', 'vocals', 'drums']),
  ['vocals', 'drums'],
);
setTrackIndex(lanes('drums', 'lead_vocals', 'backing_vocals', 'bass'));
check(
  'a vocal split shows lead and backing in lane order, no plain vocals',
  stripStems(loadedLaneNames(), ['vocals', 'bass', 'drums', 'lead_vocals', 'backing_vocals']),
  ['drums', 'lead_vocals', 'backing_vocals', 'bass'],
);

setTrackIndex(lanes('original', 'drums', 'bass'));
mixOf({ drums: entry(), bass: entry() });
check('a plain lane is heard', isLaneSilenced('drums'), false);
mixOf({ drums: entry(true), bass: entry() });
check('a muted lane is silent', isLaneSilenced('drums'), true);
mixOf({ drums: entry(), bass: entry(false, true) });
check('another lane soloed silences this one', isLaneSilenced('drums'), true);
check('the soloed lane is heard', isLaneSilenced('bass'), false);
mixOf({ drums: entry(), bass: entry(), piano: entry(false, true) });
check('a solo on a lane the song lacks silences nothing', isLaneSilenced('drums'), false);
mixOf({ drums: entry(), bass: entry(false, true) });
announced.length = 0;
setSilencedStems(['bass']);
check('silencing announces a mix change, so Stage repaints', announced, [MIX_CHANGE_EVENT]);
check('a silenced lane is silent even soloed', isLaneSilenced('bass'), true);
check('a silenced lane\'s solo silences nothing else', isLaneSilenced('drums'), false);
clearSilencedStems();
check('clearing announces a mix change too', announced, [MIX_CHANGE_EVENT, MIX_CHANGE_EVENT]);
check('cleared, the solo counts again', isLaneSilenced('drums'), true);

check('silence reads -∞', laneGainDbText(0), '-∞');
check('half reads -6.0', laneGainDbText(0.5), '-6.0');
check('unity reads 0.0', laneGainDbText(1), '0.0');
check('double reads +6.0', laneGainDbText(2), '+6.0');

check(
  'sections sit at their share of the song',
  sectionSpans([{ start: 0, end: 3, name: 'A' }, { start: 3, end: 6, name: 'B' }], 6),
  [{ start: 0, end: 3, name: 'A', left: 0, width: 50 }, { start: 3, end: 6, name: 'B', left: 50, width: 50 }],
);
check(
  'a section without an end runs to the next one, the last to the end of the song',
  sectionSpans([{ start: 0, name: 'A' }, { start: 2, name: 'B' }], 8),
  [{ start: 0, end: 2, name: 'A', left: 0, width: 25 }, { start: 2, end: 8, name: 'B', left: 25, width: 75 }],
);
check(
  'a section past the end of the song is clipped to it',
  sectionSpans([{ start: 4, end: 12, name: 'A' }], 8),
  [{ start: 4, end: 8, name: 'A', left: 50, width: 50 }],
);
check('no duration yet, no spans', sectionSpans([{ start: 0, end: 3, name: 'A' }], 0), []);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
