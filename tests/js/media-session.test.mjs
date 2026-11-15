// What the OS media controls are told: the song's metadata, and a position
// state the browser accepts (it throws on a duration that is not positive and
// finite, a zero rate, or a position past the end).
// Run:  node tests/js/media-session.test.mjs

import {
  metadataInit,
  positionStateFor,
  positionDrifted,
  nextMotion,
  playKeyStarts,
  silentWav,
  STILL,
  POSITION_DRIFT_SEC,
  WAV_CHUNK,
  WAV_FIELD,
  WAV_HEADER_BYTES,
  PCM_FORMAT,
  MONO,
  BITS_PER_SAMPLE,
  BYTES_PER_SAMPLE,
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

// ─── What the play key does ───

check('paused: it starts', playKeyStarts({ playing: false, moving: false, clockReady: false }), true);
check(
  'a start still loading its first audio: it waits, it does not pause',
  playKeyStarts({ playing: true, moving: false, clockReady: false }),
  false,
);
check(
  'a count-in: it cancels, as the toggle does',
  playKeyStarts({ playing: true, moving: false, clockReady: true }),
  true,
);
check('already playing: nothing', playKeyStarts({ playing: true, moving: true, clockReady: true }), false);

// ─── The silent loop that keeps the OS controls ───

const SAMPLE_RATE = 8000;
const SECONDS = 2;
const CHUNK_ID_BYTES = 4;
const RIFF_SIZE_EXCLUDES = 8;
const DATA_BYTES = SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const wav = silentWav(SECONDS, SAMPLE_RATE);
const view = new DataView(wav.buffer);
const chunkId = (at) => String.fromCharCode(...wav.slice(at, at + CHUNK_ID_BYTES));
check(
  'a RIFF WAVE file',
  [WAV_FIELD.RIFF_ID, WAV_FIELD.WAVE_ID, WAV_FIELD.FMT_ID, WAV_FIELD.DATA_ID].map(chunkId),
  [WAV_CHUNK.RIFF, WAV_CHUNK.WAVE, WAV_CHUNK.FMT, WAV_CHUNK.DATA],
);
check(
  '16-bit mono PCM at the asked rate',
  [
    view.getUint16(WAV_FIELD.FORMAT, true),
    view.getUint16(WAV_FIELD.CHANNELS, true),
    view.getUint32(WAV_FIELD.SAMPLE_RATE, true),
    view.getUint16(WAV_FIELD.BITS_PER_SAMPLE, true),
  ],
  [PCM_FORMAT, MONO, SAMPLE_RATE, BITS_PER_SAMPLE],
);
check(
  'the sizes in the header match the file',
  [view.getUint32(WAV_FIELD.RIFF_SIZE, true), view.getUint32(WAV_FIELD.DATA_SIZE, true), wav.length],
  [wav.length - RIFF_SIZE_EXCLUDES, DATA_BYTES, WAV_HEADER_BYTES + DATA_BYTES],
);
check('every sample is zero', wav.slice(WAV_HEADER_BYTES).every((b) => b === 0), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
