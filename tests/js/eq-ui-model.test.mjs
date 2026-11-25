// Run:  node tests/js/eq-ui-model.test.mjs

import {
  MARK_STATE,
  STARTER_BANDS,
  createSuggestSession,
  eqFromSuggestion,
  graphBands,
  markPath,
  markState,
  panelTitleKey,
  readoutParts,
  suggestEqUrl,
  suggestMasterUrl,
  targetCurvePoints,
} from "../../static/js/eq/eqPanelModel.js";
import {
  LOUDNESS_CHOICE,
  addExportParams,
  choosePresetFor,
  exportCeiling,
  exportMasterLabel,
  grFraction,
  loudnessChoice,
  loudnessReadout,
  masterFromSuggestion,
  stepCeiling,
} from "../../static/js/eq/masterPanelModel.js";
import { eqIsFlat, flatEq, normalizeEq } from "../../static/js/eqMath.js";
import { applyPreset, normalizeMaster } from "../../static/js/masterMath.js";
import { REFUSED_KEY, suggestErrorKey } from "../../static/js/eq/eqSuggest.js";
import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const BOOST = normalizeEq({ params: { bands: [{ type: "bell", f: 500, g: 4 }] } });
const MINUS = "−";
// As the removed Bass EQ knob panel stored it: seven fixed bands plus its knob state in params.ui.
const KNOB_PANEL_SAVE = {
  id: "eq",
  v: 1,
  bypass: false,
  params: {
    out: 0,
    bands: [
      { on: false, type: "lowcut", f: 10, g: 0, q: 0.707, slope: 12 },
      { on: true, type: "lowshelf", f: 75, g: 0, q: 0.707, slope: 12 },
      { on: true, type: "bell", f: 132.3, g: 3, q: 2.5, slope: 12 },
      { on: true, type: "bell", f: 400, g: 0, q: 2.5, slope: 12 },
      { on: true, type: "bell", f: 1907.2, g: 0, q: 2.5, slope: 12 },
      { on: true, type: "highshelf", f: 1000, g: 4, q: 0.707, slope: 12 },
      { on: false, type: "highcut", f: 20000, g: 0, q: 0.707, slope: 12 },
    ],
    ui: { panel: "bass", c: { lg: 3, hs: 4 } },
  },
};

{
  check("a flat EQ draws a dim mark", markState(flatEq()) === MARK_STATE.flat);
  check("an EQ that changes the sound is active", markState(BOOST) === MARK_STATE.active);
  check("a bypassed EQ with settings reads bypassed", markState({ ...BOOST, bypass: true }) === MARK_STATE.bypassed);
  check("a bypassed flat EQ is still flat", markState({ ...flatEq(), bypass: true }) === MARK_STATE.flat);
  const flatPath = markPath(flatEq(), { w: 18, h: 10 });
  const ys = [...flatPath.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  check("the flat mark is a straight line through the middle", ys.length > 2 && ys.every((y) => y === 5), flatPath);
  const boostYs = [...markPath(BOOST, { w: 18, h: 10 }).matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
  check("a boost bends the mark upwards", Math.min(...boostYs) < 5);
  check("the mark stays inside its box", Math.min(...boostYs) >= 0 && Math.max(...boostYs) <= 10);
}

{
  const starter = graphBands(flatEq());
  check("a flat graph lane shows four starter bands", starter.length === 4 && starter.length === STARTER_BANDS.length);
  check("the starter bands change nothing", eqIsFlat(normalizeEq({ params: { bands: starter } })));
  starter[0].g = 6;
  check("editing a starter band leaves the template alone", STARTER_BANDS[0].g === 0);
  check("a lane with bands shows its own", graphBands(BOOST).length === 1 && graphBands(BOOST)[0].f === 500);
  const knobSaved = normalizeEq(KNOB_PANEL_SAVE);
  check("an EQ saved by the old knob panel shows all its bands", JSON.stringify(graphBands(knobSaved)) === JSON.stringify(knobSaved.params.bands));
}

{
  check("drums: Parametric EQ", panelTitleKey("drum") === "eq.parametric");
  check("general lanes: EQ", panelTitleKey("graph") === "eq.title");
}

{
  const bell = readoutParts({ on: true, type: "bell", f: 420, g: -4.5, q: 1.6, slope: 12 });
  check("a bell reads its type, frequency, gain and Q", bell.typeKey === "eq.type.bell"
    && bell.f === "420 Hz" && bell.g === `${MINUS}4.5 dB` && bell.q === "Q 1.6");
  const cut = readoutParts({ on: true, type: "lowcut", f: 38, g: 0, q: 0.707, slope: 24 });
  check("a cut reads its slope instead of a gain", cut.g === "24 dB/oct");
  const shelf = readoutParts({ on: true, type: "highshelf", f: 9000, g: 2, q: 0.707, slope: 12 });
  check("a shelf shows no Q", shelf.q === "");
}

{
  const url = suggestEqUrl("e2e0deadbeef", "bass");
  check("lane suggest asks for the lane and leaves the layout to it", url.startsWith("/api/jobs/e2e0deadbeef/suggest/eq?")
    && new URL(url, "http://x").searchParams.get("lane") === "bass"
    && !new URL(url, "http://x").searchParams.has("layout"));
  check("lane suggest replaces the EQ", new URL(url, "http://x").searchParams.get("mode") === "replace");
}

{
  const source = { jobId: "e2e0deadbeef", query: "stems=drums%2Cbass&gains=1.000%2C0.500&fx=abc" };
  const url = new URL(suggestMasterUrl(source), "http://x");
  check(
    "master suggest asks for the readout's mix",
    url.pathname === "/api/jobs/e2e0deadbeef/suggest/master"
      && url.searchParams.get("stems") === "drums,bass"
      && url.searchParams.get("gains") === "1.000,0.500"
      && url.searchParams.get("fx") === "abc",
  );
  check(
    "master suggest replaces and never sends master=",
    url.searchParams.get("mode") === "replace"
      && !url.searchParams.has("master"),
  );
  const m = masterFromSuggestion({ master: { preset: "louder", target_lufs: -9, ceiling_dbtp: -1, comp: 0.5 } });
  check("a suggested preset switches mastering on", m.bypass === false && m.id === "master" && m.v === 1);
  check(
    "a suggested preset keeps its numbers",
    m.params.preset === "louder"
      && m.params.target_lufs === -9
      && m.params.comp === 0.5,
  );
  check(
    "a suggested gentle preset is limiter only",
    masterFromSuggestion({ master: { preset: "gentle", comp: 0 } }).params.target_lufs === null,
  );
}

{
  const body = { bands: [{ type: "bell", f: 310, g: -3, q: 1.4, slope: 12 }], out: 0.5 };
  const eq = eqFromSuggestion(body);
  check("a graph suggestion becomes the lane's bands", eq.params.bands.length === 1 && eq.params.out === 0.5);
  check("a suggestion is never bypassed", eq.bypass === false);
  check("suggested bands are switched on", eq.params.bands.every((b) => b.on === true));
  const pedal = {
    bands: [
      { type: "lowcut", f: 40, g: 0, q: 0.707, slope: 12, slot: "hpf" },
      { type: "bell", f: 132, g: 3, q: 2.5, slope: 12, slot: "low" },
      { type: "bell", f: 400, g: -2, q: 2.5, slope: 12, slot: "mid" },
      { type: "bell", f: 1900, g: 1.5, q: 2.5, slope: 12, slot: "high" },
      { type: "highshelf", f: 1000, g: 4, q: 0.707, slope: 12, slot: "hs" },
    ],
    out: -1,
  };
  const slotted = eqFromSuggestion(pedal);
  check("a bass answer's slotted bands become graph bands", slotted.params.bands.map((b) => b.f).join() === "40,132,400,1900,1000"
    && slotted.params.out === -1 && slotted.params.bands.every((b) => !("slot" in b)));
  check("a malformed answer reads flat", eqIsFlat(eqFromSuggestion({ bands: "x" })));
}

{
  const played = [];
  const saved = [];
  const session = createSuggestSession({
    preview: (lane, eq) => played.push([lane, eq]),
    commit: (lane, eq) => saved.push([lane, eq]),
  });
  session.show("drums", BOOST);
  check("Suggest plays the fitted bands at once", played.length === 1 && played[0][1] === BOOST && session.active);
  check("nothing is saved before Apply", saved.length === 0);
  session.undo();
  check("Undo goes back to the saved EQ", played.at(-1)[1] === null && !session.active && saved.length === 0);
  session.show("drums", BOOST);
  session.apply();
  check("Apply saves the suggestion", saved.length === 1 && saved[0][0] === "drums" && saved[0][1] === BOOST);
  check("after Apply there is nothing to undo", !session.active);
  const before = played.length;
  session.undo();
  session.apply();
  check("Undo and Apply with nothing pending do nothing", played.length === before && saved.length === 1);
}

const on = (preset) => ({ ...applyPreset(null, preset), bypass: false });

{
  check("mastering off reads Off", loudnessChoice(normalizeMaster(null)) === LOUDNESS_CHOICE.off);
  check("streaming reads Streaming", loudnessChoice(on("streaming")) === LOUDNESS_CHOICE.streaming);
  check("louder reads Loud", loudnessChoice(on("louder")) === LOUDNESS_CHOICE.loud);
  check("Streaming picks the streaming preset", choosePresetFor(LOUDNESS_CHOICE.streaming) === "streaming");
  check("Loud picks the louder preset", choosePresetFor(LOUDNESS_CHOICE.loud) === "louder");
  check("Off picks no preset", choosePresetFor(LOUDNESS_CHOICE.off) === null);
  const lower = stepCeiling(on("streaming"), -1);
  check("a ceiling step moves 0.1 dB", lower.params.ceiling_dbtp === -1.1);
  check("a ceiling step keeps the target", lower.params.target_lufs === -14 && !lower.bypass);
  check("a custom ceiling still reads Streaming", loudnessChoice(lower) === LOUDNESS_CHOICE.streaming);
  check("the ceiling stops at its top", stepCeiling(on("streaming"), 50).params.ceiling_dbtp === -0.1);
}

{
  const plan = { pre: { i: -17.2 }, gain_db: 3.2 };
  const ready = loudnessReadout(on("streaming"), plan, "ready");
  check("target and ceiling read in their units", ready.target === `${MINUS}14` && ready.ceiling === `${MINUS}1.0`);
  check("loudness now and the export gain", ready.now === `${MINUS}17.2` && ready.gain === "+3.2");
  const measuring = loudnessReadout(on("streaming"), null, "measuring");
  check("while measuring the numbers wait", measuring.now === "…" && measuring.gain === "…");
  const off = loudnessReadout(normalizeMaster(null), plan, "ready");
  check("off shows no target and no gain", off.target === "—" && off.gain === "—");
  check("gain reduction fills a bar", near(grFraction(-3, 6), 0.5, 1e-9) && grFraction(-40, 6) === 1 && grFraction(0, 6) === 0);
  check("no reduction reading is an empty bar", grFraction(null, 6) === 0);
}

{
  check("the export row names target and ceiling", exportMasterLabel(on("streaming"), "wav") === `${MINUS}14 LUFS · ${MINUS}1 dBTP`);
  check("lossy formats show the capped ceiling", exportMasterLabel(on("streaming"), "mp3") === `${MINUS}14 LUFS · ${MINUS}1.5 dBTP`);
  check("video's AAC is capped too", exportCeiling(-1, "mp4") === -1.5 && exportCeiling(-1, "ogg") === -1.5);
  check("a lower ceiling than the cap stays", exportCeiling(-2, "mp3") === -2 && exportCeiling(-1, "flac") === -1);
}

{
  const q = new URLSearchParams({ stems: "drums" });
  addExportParams(q, { fx: "", master: "" });
  check("a flat EQ and mastering off add nothing", q.toString() === "stems=drums");
  addExportParams(q, { fx: "abc", master: "xyz" });
  check("fx and master are added when they say something", q.get("fx") === "abc" && q.get("master") === "xyz");
}

{
  check("too little sound says so", suggestErrorKey({ status: 422, detail: "not enough signal" }) === "eq.suggestNoSignal");
  check("another refusal is about the lane", suggestErrorKey({ status: 422, detail: "layout must be drum for drums" }) === "eq.suggestLaneFailed");
  check("a missing lane file is about the lane", suggestErrorKey({ status: 404, detail: "lane not found" }) === "eq.suggestLaneFailed");
  check("a server failure says try again", suggestErrorKey({ status: 500, detail: "" }) === "eq.suggestFailed");
  check("a network failure says try again", suggestErrorKey(new TypeError("Failed to fetch")) === "eq.suggestFailed");
  const mixKey = (detail) => suggestErrorKey({ status: 422, detail }, REFUSED_KEY.mix);
  check("a refused mix is about the mix", mixKey("fx: malformed") === "eq.suggestMixFailed");
  check("too little sound in the mix says so", mixKey("not enough signal") === "eq.suggestNoSignal");
}

{
  const pts = targetCurvePoints({ target_curve: [[20, -2], [1000, 0], ["x", 1], [16000, 3.5]] });
  check("the target curve keeps its numeric points", pts.length === 3 && pts[1][0] === 1000 && pts[2][1] === 3.5);
  check("no target curve draws nothing", targetCurvePoints({ bands: [] }) === null);
  check("a malformed target curve draws nothing", targetCurvePoints({ target_curve: "x" }) === null);
}

finish();
