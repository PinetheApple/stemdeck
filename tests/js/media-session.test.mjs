// What the OS media controls are told: the song's metadata, and a position
// state the browser accepts (it throws on a duration that is not positive and
// finite, a zero rate, or a position past the end).
// Run:  node tests/js/media-session.test.mjs

import {
  metadataInit,
  positionStateFor,
  positionDrifted,
  nextMotion,
  STILL,
  POSITION_DRIFT_SEC,
} from '../../static/js/mediaSessionModel.js';

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

// ─── Metadata ───

check(
  'a song with every field',
  metadataInit({ title: 'Song', artist: 'Band', album: 'Record', artwork: '/thumb.jpg' }),
  { title: 'Song', artist: 'Band', album: 'Record', artwork: [{ src: '/thumb.jpg' }] },
);
check(
  'missing names become empty strings and no cover means no artwork',
  metadataInit({ title: 'Song' }),
  { title: 'Song', artist: '', album: '', artwork: [] },
);
check('no title means no song to show', metadataInit({ title: '', artist: 'Band' }), null);

// ─── Position state ───

check(
  'a playing position inside the song',
  positionStateFor({ duration: 6, position: 2.5, rate: 0.75 }),
  { duration: 6, position: 2.5, playbackRate: 0.75 },
);
check(
  'a position past the end is held at the end',
  positionStateFor({ duration: 6, position: 6.2, rate: 1 }),
  { duration: 6, position: 6, playbackRate: 1 },
);
check(
  'a negative position is held at the start',
  positionStateFor({ duration: 6, position: -0.1, rate: 1 }),
  { duration: 6, position: 0, playbackRate: 1 },
);
check(
  'a position that is not a number reads as the start',
  positionStateFor({ duration: 6, position: Number.NaN, rate: 1 }),
  { duration: 6, position: 0, playbackRate: 1 },
);
for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  check(
    `no position state for a duration of ${duration}`,
    positionStateFor({ duration, position: 0, rate: 1 }),
    null,
  );
}
for (const rate of [0, Number.NaN]) {
  check(
    `a rate of ${rate} reads as normal speed`,
    positionStateFor({ duration: 6, position: 1, rate }).playbackRate,
    1,
  );
}

// ─── When to report again ───

const state = { duration: 6, position: 1, playbackRate: 1 };
const sent = { state, playing: true, atMs: 1000 };

check('nothing reported yet', positionDrifted(null, state, true, 1000), true);
check(
  'playing on as the OS expects',
  positionDrifted(sent, { ...state, position: 3 }, true, 3000),
  false,
);
check(
  'a jump the OS cannot have extrapolated',
  positionDrifted(sent, { ...state, position: 1 + POSITION_DRIFT_SEC * 2 }, true, 1000),
  true,
);
check('pausing', positionDrifted(sent, state, false, 1000), true);
check('a new rate', positionDrifted(sent, { ...state, playbackRate: 0.5 }, true, 1000), true);
check('a new duration', positionDrifted(sent, { ...state, duration: 7 }, true, 1000), true);
check(
  'paused stays put',
  positionDrifted({ state, playing: false, atMs: 1000 }, state, false, 9000),
  false,
);
check(
  'a slowed song extrapolates at its rate',
  positionDrifted(
    { state: { ...state, playbackRate: 0.5 }, playing: true, atMs: 0 },
    { ...state, position: 2, playbackRate: 0.5 },
    true,
    2000,
  ),
  false,
);

// ─── Whether the playhead is moving ───

check('paused is still', nextMotion(STILL, false, 2), STILL);
const started = nextMotion(STILL, true, 2);
check('a play starts still, at where it starts', started, { from: 2, moving: false });
check('a count-in holds the playhead: still', nextMotion(started, true, 2), started);
const moving = nextMotion(started, true, 2.1);
check('the playhead leaves the start: moving', moving, { from: 2, moving: true });
check('a loop wrap back to the start stays moving', nextMotion(moving, true, 2), moving);
check('a pause stops it', nextMotion(moving, false, 3), STILL);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
