import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_ACTION,
  BULK_ACTIONS,
  SELECTION_SCOPES,
  createSelection,
} from "../../static/js/librarySelection.js";

const VISIBLE = ["a", "b", "c", "d", "e"];
const PLAIN = { shift: false, ctrl: false };
const CTRL = { ctrl: true };
const SHIFT = { shift: true };
const CTRL_SHIFT = { ctrl: true, shift: true };

function picking() {
  const selection = createSelection();
  selection.start();
  return selection;
}

test("start and done switch picking, and done clears the picks", () => {
  const selection = picking();
  assert.equal(selection.picking, true);
  selection.toggle("a");
  selection.done();
  assert.equal(selection.picking, false);
  assert.equal(selection.count(), 0);
});

test("a plain click outside picking is left to the caller", () => {
  const selection = createSelection();
  assert.equal(selection.click("a", PLAIN, VISIBLE), false);
  assert.equal(selection.count(), 0);
});

test("a plain click while picking toggles the song", () => {
  const selection = picking();
  assert.equal(selection.click("b", PLAIN, VISIBLE), true);
  assert.deepEqual(selection.ids(), ["b"]);
  selection.click("b", PLAIN, VISIBLE);
  assert.deepEqual(selection.ids(), []);
});

test("a Ctrl click toggles, and starts picking", () => {
  const selection = createSelection();
  selection.click("a", CTRL, VISIBLE);
  selection.click("c", CTRL, VISIBLE);
  selection.click("a", CTRL, VISIBLE);
  assert.equal(selection.picking, true);
  assert.deepEqual(selection.ids(), ["c"]);
});

test("Shift picks the range down from the anchor", () => {
  const selection = picking();
  selection.click("b", PLAIN, VISIBLE);
  selection.click("d", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
});

test("Shift picks the range up from the anchor, replacing earlier picks", () => {
  const selection = picking();
  selection.click("a", PLAIN, VISIBLE);
  selection.click("e", PLAIN, VISIBLE);
  selection.click("d", PLAIN, VISIBLE);
  selection.click("b", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
});

test("Ctrl+Shift adds the range to the picks", () => {
  const selection = picking();
  selection.click("a", PLAIN, VISIBLE);
  selection.click("c", PLAIN, VISIBLE);
  selection.click("e", CTRL_SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["a", "c", "d", "e"]);
});

test("Shift without an anchor picks the one song", () => {
  const selection = picking();
  selection.click("c", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["c"]);
});

test("Shift without an anchor never unpicks the song", () => {
  const selection = picking();
  selection.click("c", PLAIN, VISIBLE);
  selection.click("b", PLAIN, VISIBLE);
  selection.prune(["a", "c", "d"]);
  selection.click("c", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["c"]);
});

test("prune forgets an anchor that is no longer shown", () => {
  const selection = picking();
  selection.click("a", PLAIN, VISIBLE);
  selection.click("b", PLAIN, VISIBLE);
  selection.prune(["a", "c", "d"]);
  selection.click("d", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["a", "d"]);
});

test("select all starts picking and anchors a Shift range at the first song", () => {
  const selection = createSelection();
  selection.selectAll(VISIBLE);
  assert.equal(selection.picking, true);
  selection.click("c", SHIFT, VISIBLE);
  assert.deepEqual(selection.ids(), ["a", "b", "c"]);
});

test("select all picks every shown song, and prune drops hidden ones", () => {
  const selection = picking();
  selection.selectAll(VISIBLE);
  assert.equal(selection.count(), VISIBLE.length);
  selection.prune(["b", "d"]);
  assert.deepEqual(selection.ids(), ["b", "d"]);
  assert.equal(selection.has("b"), true);
  assert.equal(selection.has("a"), false);
});

test("each scope has its bulk actions", () => {
  assert.deepEqual(BULK_ACTIONS[SELECTION_SCOPES.LIBRARY], [
    BULK_ACTION.UP_NEXT,
    BULK_ACTION.ADD_TO_SETLIST,
    BULK_ACTION.MOVE_TO_FOLDER,
    BULK_ACTION.FAVORITE,
    BULK_ACTION.TRASH,
  ]);
  assert.deepEqual(BULK_ACTIONS[SELECTION_SCOPES.TRASH], [BULK_ACTION.RESTORE]);
});
