// Run:  node tests/js/eq-panels.test.mjs

import { PANEL_KINDS, laneHasPanel, panelKindFor } from "../../static/js/eq/eqPanelKinds.js";
import {
  DB_RANGE, F_MAX, F_MIN, SPEC_MIN_DB, columnBins, createHistory, curveFreqs, dbToY, defaultBandAt, dragBand,
  fmtDb, fmtFreq, fmtQ, freqToX, hitTest, keyStep, nodeXY, parseFreq, parseNumber, plotRect, resetBand,
  retypeBand, soloEq, spectrumFrame, wheelQ, xToFreq, yToDb,
} from "../../static/js/eq/eqGraphMath.js";
import { normalizeBand } from "../../static/js/eqMath.js";
import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();

{
  check("drums: Drum EQ", panelKindFor("drums") === "drum");
  for (const lane of ["bass", "guitar", "piano", "vocals", "lead_vocals", "backing_vocals", "original", "other"]) {
    check(`${lane}: the general parametric EQ`, panelKindFor(lane) === "graph");
  }
  check("only the graph kinds are offered", PANEL_KINDS.join() === "graph,drum");
  check("the master slot has no lane panel", !laneHasPanel("__master") && laneHasPanel("bass"));
}

{
  const r = plotRect(800, 300);
  check("20 Hz at the left edge", near(freqToX(F_MIN, r), r.x, 1e-9));
  check("20 kHz at the right edge", near(freqToX(F_MAX, r), r.x + r.w, 1e-9));
  check("200 Hz a third across", near(freqToX(200, r), r.x + r.w / 3, 1e-9));
  let worst = 0;
  for (const f of [20, 31.5, 100, 440, 1000, 5000, 12345, 20000]) {
    worst = Math.max(worst, Math.abs(xToFreq(freqToX(f, r), r) - f) / f);
  }
  check("x <-> frequency round trip", worst < 1e-12, String(worst));
  check("0 dB in the middle, +range at the top", near(dbToY(0, r), r.y + r.h / 2, 1e-9) && near(dbToY(DB_RANGE, r), r.y, 1e-9));
  check("y <-> dB round trip", near(yToDb(dbToY(-7.25, r), r), -7.25, 1e-9));
  check("clicks off the right edge clamp to 20 kHz", xToFreq(r.x + r.w + 50, r) === F_MAX);
}

{
  const r = plotRect(800, 300);
  const bands = [normalizeBand({ type: "bell", f: 1000, g: 6, q: 1 }), normalizeBand({ type: "lowcut", f: 80 })];
  const handle = nodeXY(bands[0], r);
  check("a cut's handle sits on the 0 dB line", near(nodeXY(bands[1], r).y, dbToY(0, r), 1e-9));
  check("a hit on a handle finds its band", hitTest(bands, handle.x + 3, handle.y - 3, r) === 0);
  check("a hit 20 px away finds nothing", hitTest(bands, handle.x + 20, handle.y, r) === -1);
  const twins = [normalizeBand({ type: "bell", f: 1000 }), normalizeBand({ type: "bell", f: 1000 })];
  const spot = nodeXY(twins[0], r);
  check("two handles on one spot: the later one wins", hitTest(twins, spot.x, spot.y, r) === 1);
}

{
  const r = plotRect(900, 300);
  const start = normalizeBand({ type: "bell", f: 1000, g: 0, q: 1 });
  const octave = r.w / Math.log2(1000);
  check("dragging one octave right doubles the frequency", near(dragBand(start, octave, 0, r).f, 2000, 1));
  check("dragging up a third of the half height adds a third of the range",
    near(dragBand(start, 0, -(r.h / 2) / 3, r).g, DB_RANGE / 3, 0.02));
  check("Shift drags a fifth as far", near(Math.log2(dragBand(start, octave, 0, r, { fine: true }).f / 1000), 0.2, 0.002));
  check("a drag keeps the gain inside the graph", dragBand(start, 0, -5000, r).g === DB_RANGE);
  const cut = dragBand(normalizeBand({ type: "lowcut", f: 100 }), 0, -100, r);
  check("a cut only moves in frequency", cut.g === 0 && cut.f === 100);
  check("wheel up narrows", wheelQ(1, -100) > 1);
  check("wheel up then down returns", near(wheelQ(wheelQ(2, -120), 120), 2, 0.01));
  check("wheel stays in the engine's Q range", wheelQ(39, -100000) === 40 && wheelQ(0.03, 100000) === 0.025);
  check("Right arrow: a semitone up", near(keyStep(start, "ArrowRight").f, 1000 * 2 ** (1 / 12), 0.1));
  check("Up arrow: +0.5 dB, Shift: +0.1 dB", keyStep(start, "ArrowUp").g === 0.5 && keyStep(start, "ArrowUp", true).g === 0.1);
  check("an unknown key changes nothing", keyStep(start, "x") === start);
}

{
  check("a click at 25 Hz adds a low cut at 24 dB/oct", defaultBandAt(25, 6).type === "lowcut" && defaultBandAt(25, 6).slope === 24);
  check("a click at 60 Hz adds a low shelf", defaultBandAt(60, -4).type === "lowshelf" && defaultBandAt(60, -4).g === -4);
  check("a click at 1 kHz adds a bell", defaultBandAt(1000, 3).type === "bell");
  check("a click at 12 kHz adds a high shelf", defaultBandAt(12000, 3).type === "highshelf");
  check("a click at 18 kHz adds a high cut", defaultBandAt(18000, 3).type === "highcut");
  const reset = resetBand(normalizeBand({ type: "bell", f: 700, g: 9, q: 5 }));
  check("reset keeps the frequency", reset.g === 0 && reset.q === 1 && reset.f === 700);
  const retyped = retypeBand(normalizeBand({ type: "bell", f: 700, g: 9, q: 5 }), "lowcut");
  check("a bell retyped to a cut", retyped.g === 0 && retyped.slope === 24 && retyped.q === 0.707);
  const solo = soloEq(normalizeBand({ type: "bell", f: 2000, g: 4, q: 3 })).params.bands[0];
  check("solo is a band pass at the band", solo.type === "bandpass" && solo.f === 2000 && solo.q === 3);
}

{
  check("frequency formats", fmtFreq(62.5) === "62.5 Hz" && fmtFreq(440) === "440 Hz"
    && fmtFreq(1250) === "1.25 kHz" && fmtFreq(12500) === "12.5 kHz" && fmtFreq(1000) === "1 kHz");
  check("dB formats", fmtDb(3) === "+3.0 dB" && fmtDb(-12) === "−12.0 dB" && fmtDb(0.01) === "0.0 dB");
  check("Q formats", fmtQ(0.707) === "0.71" && fmtQ(4) === "4.0" && fmtQ(12) === "12");
  check("typed frequencies", parseFreq("1.2k") === 1200 && parseFreq("1,5 kHz") === 1500 && parseFreq("80 Hz") === 80);
  check("typed nonsense", Number.isNaN(parseFreq("abc")) && Number.isNaN(parseNumber("")));
  check("typed signs", parseNumber("−6") === -6 && parseNumber("+3,5") === 3.5);
}

{
  const h = createHistory(3);
  const s = (n) => ({ n });
  check("empty: nothing to undo", !h.canUndo && h.undo(s(0)) === null);
  h.push(s(1));
  h.push(s(1));
  check("equal neighbours stored once", h.undo(s(2)).n === 1 && !h.canUndo);
  check("redo returns what was undone", h.redo(s(1)).n === 2);
  h.push(s(3));
  check("a new change clears redo", !h.canRedo);
  for (let i = 0; i < 10; i++) h.push(s(10 + i));
  let undone = 0;
  while (h.canUndo) { h.undo(s(0)); undone++; }
  check("bounded to its limit", undone === 3);
}

{
  const r = plotRect(600, 200);
  const cols = Math.round(r.w);
  const bins = columnBins(cols, 4096, 48000, r);
  let valid = true;
  for (let c = 0; c < cols; c++) if (bins.lo[c] > bins.hi[c] || bins.lo[c] < 1 || bins.hi[c] > 4095) valid = false;
  check("every column covers at least one valid bin", valid);
  const data = new Float32Array(4096).fill(-120);
  data[Math.round(1000 / (24000 / 4096))] = -12;
  const out = new Float32Array(cols).fill(SPEC_MIN_DB);
  spectrumFrame(bins, data, out, 0.6);
  const c1k = Math.floor(freqToX(1000, r) - r.x);
  const window = () => Math.max(...out.slice(Math.max(0, c1k - 2), c1k + 3));
  check("a 1 kHz peak lands in the 1 kHz column", window() === -12);
  data.fill(-120);
  spectrumFrame(bins, data, out, 0.6);
  check("a peak falls back slowly", near(window(), -12.6, 1e-5));
  check("display tilt is negative below 1 kHz", columnBins(cols, 4096, 48000, r, 4.5).tilt[0] < -20);
  check("curve frequencies span 20 Hz to 20 kHz", near(curveFreqs(r)[0], 20, 1e-9) && near(curveFreqs(r).at(-1), 20000, 1e-6));
}

finish();
