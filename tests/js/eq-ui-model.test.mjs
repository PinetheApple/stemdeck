// Run:  node tests/js/eq-ui-model.test.mjs

import {
  KNOB_IDS,
  MARK_STATE,
  STARTER_BANDS,
  controlsFromSuggestion,
  createSuggestSession,
  eqFromSuggestion,
  eqWithKnob,
  graphBands,
  knobAngle,
  knobDragValue,
  knobValue,
  markPath,
  markState,
  panelTitleKey,
  pedalKnobs,
  readoutParts,
  suggestEqUrl,
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
  stepCeiling,
} from "../../static/js/eq/masterPanelModel.js";
import { eqIsFlat, eqResponseDb, flatEq, normalizeEq } from "../../static/js/eqMath.js";
import { applyPreset, normalizeMaster } from "../../static/js/masterMath.js";
import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const BOOST = normalizeEq({ params: { bands: [{ type: "bell", f: 500, g: 4 }] } });
const MINUS = "−";

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
}

{
  check("drums: Parametric EQ", panelTitleKey("drum") === "eq.parametric");
  check("general lanes: EQ", panelTitleKey("graph") === "eq.title");
  check("bass: Bass EQ", panelTitleKey("bass") === "eq.bassEq");
  check("piano: Keys EQ", panelTitleKey("keys") === "eq.keysEq");
}

for (const kind of ["bass", "guitar", "keys"]) {
  const knobs = pedalKnobs(kind);
  check(`${kind}: Low, Mid, High and Presence`, knobs.map((k) => k.id).join() === KNOB_IDS.join());
  check(`${kind}: every knob is centred on 0 dB`, knobs.every((k) => k.min === -k.max && k.max > 0));
  let eq = flatEq();
  check(`${kind}: knobs start at 0`, KNOB_IDS.every((id) => knobValue(kind, eq, id) === 0));
  eq = eqWithKnob(kind, eq, "low", 3);
  eq = eqWithKnob(kind, eq, "presence", 4);
  check(`${kind}: a turned knob reads back`, knobValue(kind, eq, "low") === 3 && knobValue(kind, eq, "presence") === 4);
  check(`${kind}: the other knobs stay put`, knobValue(kind, eq, "mid") === 0);
  check(`${kind}: turning knobs changes the sound`, !eqIsFlat(eq));
  const top = knobs.find((k) => k.id === "high").max;
  check(`${kind}: a knob stops at its range`, knobValue(kind, eqWithKnob(kind, eq, "high", 99), "high") === top);
  check(`${kind}: bypass survives a knob turn`, eqWithKnob(kind, { ...eq, bypass: true }, "mid", 1).bypass === true);
}

{
  check("low and presence pull opposite ends of the bass pedal", (() => {
    const eq = eqWithKnob("bass", eqWithKnob("bass", flatEq(), "low", 6), "presence", -6);
    const [lo, hi] = eqResponseDb(eq, [132, 8000], 44100);
    return lo > 2 && hi < -2;
  })());
  check("0 dB points straight up", knobAngle(0, -12, 12) === 0);
  check("full boost is the end of the sweep", knobAngle(12, -12, 12) === 135);
  check("full cut is the start of the sweep", knobAngle(-12, -12, 12) === -135);
  check("dragging up raises the value", knobDragValue(0, -30, -12, 12) > 0);
  check("a drag stops at the range", knobDragValue(0, -10000, -12, 12) === 12);
  check("fine drags move less", knobDragValue(0, -30, -12, 12, true) < knobDragValue(0, -30, -12, 12));
  check("drag values land on half dB steps", Number.isInteger(knobDragValue(0, -37, -12, 12) * 2));
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
  const url = suggestEqUrl("e2e0deadbeef", "drums", "drum");
  check("lane suggest asks for the lane and its layout", url.startsWith("/api/jobs/e2e0deadbeef/suggest/eq?")
    && new URL(url, "http://x").searchParams.get("lane") === "drums"
    && new URL(url, "http://x").searchParams.get("layout") === "drum");
  check("lane suggest replaces the EQ", new URL(url, "http://x").searchParams.get("mode") === "replace");
}

{
  const body = { bands: [{ type: "bell", f: 310, g: -3, q: 1.4, slope: 12 }], out: 0.5 };
  const eq = eqFromSuggestion(body, "drum");
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
  const c = controlsFromSuggestion("bass", pedal);
  check("a pedal suggestion turns the knobs by slot", c.lg === 3 && c.mg === -2 && c.hg === 1.5 && c.hs === 4 && c.lvl === -1);
  check("a slot sets its frequency too", c.lf === 132 && c.hpf === 40);
  const pedalEq = eqFromSuggestion(pedal, "bass");
  check("a pedal suggestion reads back on its knobs", knobValue("bass", pedalEq, "presence") === 4);
  check("a band with no slot is ignored", controlsFromSuggestion("bass", { bands: [{ type: "bell", g: 9, slot: null }] }).lg === 0);
  const keys = controlsFromSuggestion("keys", { bands: [{ type: "bell", f: 3000, g: 2, slot: "presence" }] });
  check("keys slots land on the keys controls", keys.presence === 2 && keys.presF === 3000);
  check("a malformed answer reads flat", eqIsFlat(eqFromSuggestion({ bands: "x" }, "graph")));
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

finish();
