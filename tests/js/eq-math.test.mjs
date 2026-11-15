// The EQ descriptor and coefficient maths (static/js/eqMath.js) against the
// golden file that tests/test_fx_filters.py holds the export side to.
//
// Run:  node tests/js/eq-math.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EQ_LIMITS, bandSections, encodeFxParam, eqIsFlat, eqResponseDb, eqToWire, flatEq, normalizeEq,
} from "../../static/js/eqMath.js";
import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", "eq_golden.json"), "utf8"));
const GOLDEN_TOLERANCE_DB = 1e-3;

function worstAgainstChromium(rate) {
  let worst = 0;
  let worstCase = "";
  for (const [name, raw] of Object.entries(golden.cases)) {
    const ours = eqResponseDb(normalizeEq(raw), golden.freqs, rate);
    const theirs = golden.chromium[rate][name];
    for (let i = 0; i < ours.length; i++) {
      const d = Math.abs(ours[i] - theirs[i]);
      if (d > worst) { worst = d; worstCase = name; }
    }
  }
  return { worst, worstCase };
}

for (const rate of golden.rates) {
  const { worst, worstCase } = worstAgainstChromium(rate);
  check(
    `eqMath matches Chromium's nodes at ${rate} Hz (worst ${worst.toExponential(2)} dB, ${worstCase})`,
    worst < GOLDEN_TOLERANCE_DB,
  );
}

{
  const n = normalizeEq({ params: { out: 99, bands: [
    { type: "peaking", f: 1e9, g: -500, q: 0 },
    null,
    { type: "nope" },
    { type: "lowpass", f: 1234.56, slope: 20 },
    { type: "bell", f: NaN, g: "3" },
  ] } });
  const [first, second, third] = n.params.bands;
  check("output gain is clamped", n.params.out === EQ_LIMITS.outMax);
  check("aliases map to the v1 names", first.type === "bell" && second.type === "highcut");
  check("unknown bands are dropped", n.params.bands.length === 3);
  check("numbers are clamped into range", first.f === 20000 && first.g === -30 && first.q === 0.025);
  check("frequency is rounded to 0.1 Hz", second.f === 1234.6);
  check("a slope snaps to the nearest offered one", second.slope === 24);
  check("non-numbers fall back to defaults", third.f === 1000 && third.g === 0);
  const newer = normalizeEq({ id: "eq", v: 2, params: { bands: [{ type: "bell", g: 6 }] } });
  check("a newer version reads as flat", newer.params.bands.length === 0);
  check("another effect id reads as flat", normalizeEq({ id: "master", params: {} }).params.bands.length === 0);
  const many = normalizeEq({ params: { bands: Array.from({ length: 30 }, () => ({ type: "bell", g: 1 })) } });
  check("at most maxBands bands", many.params.bands.length === EQ_LIMITS.maxBands);
  check("panel state is kept", normalizeEq({ params: { ui: { panel: "bass" } } }).params.ui?.panel === "bass");
  const big = normalizeEq({ params: { ui: { s: "x".repeat(EQ_LIMITS.maxUiChars) } } });
  check("oversized panel state is dropped", big.params.ui === undefined);
}

{
  const steep = bandSections({ on: true, type: "lowcut", f: 50, g: 0, q: 0.707, slope: 48 });
  check("48 dB/oct is four highpass sections", steep.length === 4 && steep.every((s) => s.type === "highpass"));
  const zeroBell = { on: true, type: "bell", f: 100, g: 0, q: 1, slope: 12 };
  check("bands at 0 dB add no section", bandSections(zeroBell).length === 0);
  const offNotch = { on: false, type: "notch", f: 100, g: 0, q: 1, slope: 12 };
  check("a band switched off adds no section", bandSections(offNotch).length === 0);
  const tilt = bandSections({ on: true, type: "tilt", f: 800, g: 4, q: 1, slope: 12 });
  check("tilt is two opposite shelves", tilt.map((s) => `${s.type}${s.g}`).join() === "lowshelf-2,highshelf2");
  const cut = normalizeEq({ params: { bands: [{ type: "highcut", f: 2000, slope: 36 }] } });
  const [atCorner] = eqResponseDb(cut, [2000], 48000);
  check("a Butterworth cut is 3 dB down at its frequency", near(atCorner, -3.01, 0.02), `${atCorner}`);
}

{
  const boost = normalizeEq({ params: { bands: [{ type: "bell", f: 1000, g: 3 }, { type: "bell", f: 200, g: 0 }] } });
  check("flatEq is flat", eqIsFlat(flatEq()));
  check("a boost is not flat", !eqIsFlat(boost));
  check("a bypassed boost is flat", eqIsFlat({ ...boost, bypass: true }));
  check("output gain alone is not flat", !eqIsFlat(normalizeEq({ params: { out: -3 } })));
  check(
    "the wire carries only bands that do something",
    JSON.stringify(eqToWire(boost)) === '{"id":"eq","out":0,"b":[["bell",1000,3,0.707,12]]}',
  );
  const silent = encodeFxParam({ vocals: flatEq(), bass: { ...boost, bypass: true } }, flatEq());
  check("no fx param when nothing changes the sound", silent === "");
  const param = encodeFxParam({ vocals: boost }, normalizeEq({ params: { out: -1 } }));
  const decoded = JSON.parse(Buffer.from(param, "base64url").toString("utf8"));
  check("fx param is base64url JSON", /^[A-Za-z0-9_-]+$/.test(param) && decoded.v === 1);
  check("fx param has the lane and the master", !!decoded.lanes.vocals && decoded.master[0].out === -1);
}

finish();
