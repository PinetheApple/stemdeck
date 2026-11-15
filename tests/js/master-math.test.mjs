// The master's pure maths (static/js/masterMath.js): descriptor, wire form,
// presets and what the live preview needs. The server parser it must match
// is tests/test_mastering.py.
//
// Run:  node tests/js/master-math.test.mjs

import {
  DEFAULT_PRESET, LOSSY_CEILING_DBTP, MASTER_LIMITS, applyPreset, compressorMakeupGain, defaultMaster,
  encodeMasterParam, glueSettings, holdFall, kWeightingCoefficients, limiterSettings,
  loudnessFromMeanSquares, masterIsOn, matchedLevels, meanSquareTail, normalizeMaster, peakDb,
} from "../../static/js/masterMath.js";
import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const decode = (param) => JSON.parse(Buffer.from(param, "base64url").toString("utf8"));
const on = (preset) => ({ ...applyPreset(null, preset), bypass: false });

{
  const off = normalizeMaster(null);
  check("no descriptor reads as off", off.bypass === true && !masterIsOn(off));
  check("a newer version reads as off", normalizeMaster({ id: "master", v: 2, params: {} }).bypass === true);
  check("another id reads as off", normalizeMaster({ id: "eq", v: 1, params: {} }).bypass === true);
  const d = defaultMaster();
  check("the default is streaming -14 LUFS / -1 dBTP / comp 0, on", DEFAULT_PRESET === "streaming"
    && d.params.target_lufs === -14 && d.params.ceiling_dbtp === -1 && d.params.comp === 0 && masterIsOn(d));
  const forged = normalizeMaster({
    id: "master", v: 1, params: { preset: "streaming", target_lufs: -6, ceiling_dbtp: -0.1 },
  });
  check("a named preset carries its own numbers", forged.params.target_lufs === -14 && forged.params.ceiling_dbtp === -1);
  const custom = normalizeMaster({
    id: "master", v: 1, params: { preset: "custom", target_lufs: -40, ceiling_dbtp: 5, comp: 3 },
  });
  check("custom is clamped to the server's ranges", custom.params.target_lufs === MASTER_LIMITS.targetMin
    && custom.params.ceiling_dbtp === MASTER_LIMITS.ceilingMax && custom.params.comp === 1);
  const junk = normalizeMaster({ id: "master", v: 1, params: { preset: "nope", comp: "x", target_lufs: NaN } });
  check("junk falls back to defaults", junk.params.preset === "streaming" && junk.params.comp === 0);
  const rounded = normalizeMaster({
    id: "master", v: 1, params: { preset: "custom", target_lufs: -13.94, ceiling_dbtp: -1.04, comp: 0.333 },
  });
  check("custom values are rounded to the wire's steps", rounded.params.target_lufs === -13.9
    && rounded.params.ceiling_dbtp === -1 && rounded.params.comp === 0.33);
  const louder = applyPreset(d, "louder");
  check("gentle has no target", applyPreset(d, "gentle").params.target_lufs === null);
  check("louder: -9 with the glue at 0.5", louder.params.target_lufs === -9 && louder.params.comp === 0.5);
  const toCustom = applyPreset(louder, "custom");
  check("custom starts from the current numbers", toCustom.params.target_lufs === -9 && toCustom.params.comp === 0.5);
  const edited = { ...toCustom, params: { ...toCustom.params, target_lufs: -11 } };
  check("custom again keeps the user's numbers", applyPreset(edited, "custom").params.target_lufs === -11);
}

{
  check("off sends nothing", encodeMasterParam(null) === "" && encodeMasterParam(normalizeMaster(null)) === "");
  const streaming = encodeMasterParam(defaultMaster());
  check("the parameter is base64url without padding", /^[A-Za-z0-9_-]+$/.test(streaming));
  check("streaming wire", JSON.stringify(decode(streaming)) === JSON.stringify({ v: 1, target: -14, ceiling: -1 }));
  const gentle = decode(encodeMasterParam(on("gentle")));
  check("gentle wire has a null target", gentle.target === null && gentle.ceiling === -1);
  const louder = decode(encodeMasterParam(on("louder")));
  check("louder wire carries the compressor", louder.comp === 0.5 && louder.target === -9);
}

{
  for (const [threshold, ratio] of [[-1.1, 20], [-6, 4], [-20, 2], [-30, 3]]) {
    const expected = (1 / 10 ** ((threshold + (0 - threshold) / ratio) / 20)) ** 0.6;
    const got = compressorMakeupGain(threshold, 0, ratio);
    check(`makeup, hard knee T ${threshold} R ${ratio}`, near(got, expected, 1e-5), `${got} vs ${expected}`);
  }
  check("ratio 1 has no makeup", near(compressorMakeupGain(0, 0, 1), 1, 1e-6));
  const soft = compressorMakeupGain(-20, 6, 2);
  check("a soft knee's makeup sits between the hard knees around it",
    soft > compressorMakeupGain(-14, 0, 2) * 0.99 && soft < compressorMakeupGain(-20, 0, 2) * 1.01, String(soft));
  const glue = glueSettings(0.5, -15);
  check("glue: 2:1, 6 dB knee, 20 ms / 250 ms", glue.ratio === 2 && glue.knee === 6
    && glue.attack === 0.02 && glue.release === 0.25 && glue.threshold === -15);
  check("glue off without an amount or a threshold", glueSettings(0, -15) === null && glueSettings(0.5, null) === null);
  const limiter = limiterSettings(-1);
  check("limiter: the export's limit, ratio 20", near(limiter.threshold, -1.1, 1e-9) && limiter.ratio === 20 && limiter.knee === 0);
  check("lossy ceiling is -1.5", LOSSY_CEILING_DBTP === -1.5);
  const louder = matchedLevels(4.4, true);
  check("matched: a louder master is turned down", near(louder.master, 10 ** (-4.4 / 20), 1e-12) && louder.original === 1);
  const quieter = matchedLevels(-3, true);
  check("matched: a louder original is turned down", quieter.master === 1 && near(quieter.original, 10 ** (-3 / 20), 1e-12));
  check("not matched: both at their own level", matchedLevels(4.4, false).master === 1);
  check("no measurement: both at their own level", matchedLevels(NaN, true).master === 1);
}

{
  const k = kWeightingCoefficients(48000);
  const nearAll = (a, b, tolerance) => a.every((v, i) => near(v, b[i], tolerance));
  const shelfB = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const shelfA = [1, -1.69065929318241, 0.73248077421585];
  check("K-weighting shelf matches BS.1770 at 48 kHz",
    nearAll(k.shelf.feedforward, shelfB, 2e-4) && nearAll(k.shelf.feedback, shelfA, 2e-4));
  const scale = k.highpass.feedforward[0];
  check("K-weighting high-pass matches BS.1770 at 48 kHz",
    nearAll(k.highpass.feedforward.map((v) => v / scale), [1, -2, 1], 1e-9)
    && nearAll(k.highpass.feedback, [1, -1.99004745483398, 0.99007225036621], 5e-5));
  check("mean square 0.5 in one channel reads -3.70 LUFS", near(loudnessFromMeanSquares([0.5]), -3.70, 0.01));
  check("silence is -Infinity LUFS", loudnessFromMeanSquares([0, 0]) === -Infinity);
  const buf = new Float32Array([0, 0.5, -0.25, 0.1]);
  check("mean square of the tail", near(meanSquareTail(buf, 2), (0.25 ** 2 + 0.1 ** 2) / 2, 1e-9));
  check("peak in dBFS", near(peakDb(buf), 20 * Math.log10(0.5), 1e-6) && peakDb(new Float32Array(4)) === -Infinity);
  check("a meter rises at once and falls slowly", holdFall(-10, -3, 1.5) === -3 && holdFall(-3, -20, 1.5) === -4.5);
}

finish();
