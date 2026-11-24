// A song's menu: what it offers, in order, from what is true of the song now.
//
// Run:  node tests/js/song-menu.test.mjs

import { ROW_STATE, SONG_ACTION as A, buildSongMenuModel } from '../../static/js/songMenuModel.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- expected ${e}, got ${a}`);
  }
}

const SONG = 'song-1';
const OTHER = 'song-2';
const SEP = 'sep';
const LABEL = 'label';
const SETLISTS = [
  { id: 'set-a', name: 'Gig', song_ids: [SONG] },
  { id: 'set-b', name: 'Practice', song_ids: [OTHER] },
];
const FOLDERS = [
  { id: 'f-unsorted', name: 'Unsorted', depth: 0, color: '#4f9de8', current: false },
  { id: 'f-rock', name: 'Rock', depth: 0, color: '#ff6f59', current: true },
  { id: 'f-live', name: 'Live', depth: 1, color: '#64c86f', current: false },
];

function song(overrides = {}) {
  return {
    id: SONG,
    state: ROW_STATE.DONE,
    favorite: false,
    rename: true,
    queuedIds: [],
    extracting: false,
    canExtractMore: true,
    upload: false,
    pickAgain: false,
    setlists: SETLISTS,
    folders: FOLDERS,
    ...overrides,
  };
}

const shape = (model) => model.map((entry) => entry.action ?? entry.kind);
const itemOf = (model, action, arg) => model.find((entry) => entry.action === action && (arg === undefined || entry.arg === arg));
const flags = (entry) => ({ checked: Boolean(entry?.checked), disabled: Boolean(entry?.disabled) });

check('items come in the issue\'s order', shape(buildSongMenuModel(song())), [
  A.PLAY, A.UP_NEXT, A.FAVORITE, SEP,
  A.RENAME, A.EXTRACT, A.ABOUT,
  LABEL, A.ADD_TO_SETLIST, A.ADD_TO_SETLIST, A.NEW_SETLIST,
  LABEL, A.MOVE_TO_FOLDER, A.MOVE_TO_FOLDER, A.MOVE_TO_FOLDER, A.NEW_FOLDER,
  SEP, A.TRASH,
]);
check('Move to Trash is the danger item', Boolean(itemOf(buildSongMenuModel(song()), A.TRASH).danger), true);
check('the setlist and folder headings read Add to setlist and Move to folder',
  buildSongMenuModel(song()).filter((entry) => entry.kind === LABEL).map((entry) => entry.labelKey),
  ['trackMenu.addToSetlist', 'trackMenu.moveToFolder']);

check('head menu has no Rename…', itemOf(buildSongMenuModel(song({ rename: false })), A.RENAME), undefined);
check('head menu keeps everything else', buildSongMenuModel(song({ rename: false })).length, buildSongMenuModel(song()).length - 1);

const running = buildSongMenuModel(song({ extracting: true }));
check('Stop extracting replaces Extract while running', [Boolean(itemOf(running, A.STOP_EXTRACT)), itemOf(running, A.EXTRACT)], [true, undefined]);
check('a song with every stem has no Extract item', itemOf(buildSongMenuModel(song({ canExtractMore: false })), A.EXTRACT), undefined);

const filed = buildSongMenuModel(song());
check('a setlist holding the song is checked and disabled', flags(itemOf(filed, A.ADD_TO_SETLIST, 'set-a')), { checked: true, disabled: true });
check('a setlist without the song can be chosen', flags(itemOf(filed, A.ADD_TO_SETLIST, 'set-b')), { checked: false, disabled: false });
check('the song\'s folder is checked and disabled', flags(itemOf(filed, A.MOVE_TO_FOLDER, 'f-rock')), { checked: true, disabled: true });
check('another folder can be chosen', flags(itemOf(filed, A.MOVE_TO_FOLDER, 'f-unsorted')), { checked: false, disabled: false });
check('a subfolder keeps its depth', itemOf(filed, A.MOVE_TO_FOLDER, 'f-live').depth, 1);
check('a folder shows its colour', itemOf(filed, A.MOVE_TO_FOLDER, 'f-live').color, '#64c86f');
check('setlists and folders show their own names', [itemOf(filed, A.ADD_TO_SETLIST, 'set-b').text, itemOf(filed, A.MOVE_TO_FOLDER, 'f-live').text], ['Practice', 'Live']);

check('Add to Up Next is disabled for the playing song',
  Boolean(itemOf(buildSongMenuModel(song({ queuedIds: [SONG] })), A.UP_NEXT).disabled), true);
check('Add to Up Next is disabled for a queued song',
  Boolean(itemOf(buildSongMenuModel(song({ queuedIds: [OTHER, SONG] })), A.UP_NEXT).disabled), true);
check('Add to Up Next is open for a song not queued',
  Boolean(itemOf(buildSongMenuModel(song({ queuedIds: [OTHER] })), A.UP_NEXT).disabled), false);

check('a favorite offers Remove from Favorites', itemOf(buildSongMenuModel(song({ favorite: true })), A.FAVORITE).labelKey, 'track.unfavorite');
check('a song not a favorite offers Add to Favorites', itemOf(buildSongMenuModel(song()), A.FAVORITE).labelKey, 'track.favorite');

check('a trashed song offers only Restore', shape(buildSongMenuModel(song({ state: ROW_STATE.TRASHED }))), [A.RESTORE]);
check('an importing song offers Cancel and Move to Trash', shape(buildSongMenuModel(song({ state: ROW_STATE.IMPORTING }))), [A.CANCEL_IMPORT, SEP, A.TRASH]);
check('an import the library does not list yet offers only Cancel',
  shape(buildSongMenuModel(song({ state: ROW_STATE.IMPORTING, inLibrary: false }))), [A.CANCEL_IMPORT]);
check('cancelling an upload asks first', itemOf(buildSongMenuModel(song({ state: ROW_STATE.IMPORTING, upload: true })), A.CANCEL_IMPORT).confirmKey, 'queue.cancelConfirm');
check('cancelling a link import does not ask', itemOf(buildSongMenuModel(song({ state: ROW_STATE.IMPORTING })), A.CANCEL_IMPORT).confirmKey, undefined);
check('a failed import offers Retry and Move to Trash', shape(buildSongMenuModel(song({ state: ROW_STATE.FAILED }))), [A.RETRY, SEP, A.TRASH]);
check('a failed upload whose file is gone offers Pick the file again',
  itemOf(buildSongMenuModel(song({ state: ROW_STATE.FAILED, pickAgain: true })), A.RETRY).labelKey, 'importFail.pickAgain');
check('a stopped song offers Extract and Move to Trash', shape(buildSongMenuModel(song({ state: ROW_STATE.STOPPED }))), [A.EXTRACT_AGAIN, SEP, A.TRASH]);
check('an unavailable song offers Move to Trash', shape(buildSongMenuModel(song({ state: ROW_STATE.UNAVAILABLE }))), [A.TRASH]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
