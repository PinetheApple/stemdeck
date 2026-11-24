import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPEARANCE_STORE_KEYS,
  DEFAULT_APPEARANCE,
  FONTS,
  THEMES,
  WASH_OFF,
  resolveChoice,
} from "../../static/js/appearanceModel.js";

test("the three themes, Ink & coral first", () => {
  assert.deepEqual(THEMES.map((theme) => theme.id), ["ink-coral", "ink-ice", "dusk-coral"]);
});

test("Manrope first, plus at least three more fonts", () => {
  assert.equal(FONTS[0].label, "Manrope");
  assert.ok(FONTS.length >= 4);
});

test("defaults are Ink & coral, Manrope and the wash on", () => {
  assert.deepEqual({ ...DEFAULT_APPEARANCE }, { theme: "ink-coral", font: "manrope", wash: "on" });
});

test("a stored choice still on offer is kept", () => {
  assert.equal(resolveChoice("theme", "dusk-coral"), "dusk-coral");
  assert.equal(resolveChoice("font", "inter"), "inter");
  assert.equal(resolveChoice("wash", WASH_OFF), WASH_OFF);
});

test("nothing stored, or a choice no longer offered, falls back to the default", () => {
  assert.equal(resolveChoice("theme", null), "ink-coral");
  assert.equal(resolveChoice("theme", "solarized"), "ink-coral");
  assert.equal(resolveChoice("font", 42), "manrope");
  assert.equal(resolveChoice("wash", "maybe"), "on");
});

test("each choice is kept under its own device key", () => {
  assert.deepEqual(Object.keys(APPEARANCE_STORE_KEYS), ["theme", "font", "wash"]);
});
