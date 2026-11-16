export const POLICY_AUTO = "auto";
export const POLICY_CPU = "cpu";
export const CPU_ENCODER = "libx264";

export const ROW_STATE = { idle: "idle", testing: "testing", works: "works", failed: "failed" };

const ENCODER_NAMES = {
  h264_nvenc: ["NVENC", "NVIDIA"],
  h264_vaapi: ["VAAPI", "AMD, Intel"],
  h264_qsv: ["QSV", "Intel"],
  h264_amf: ["AMF", "AMD"],
  h264_videotoolbox: ["VideoToolbox", "Apple"],
  [CPU_ENCODER]: ["CPU", "x264"],
};
const INVALID_PREFIX = "invalid-";
const REASON_INVALID = "invalid";
const ALWAYS_ON = new Set([POLICY_AUTO, POLICY_CPU]);

/** The short name an encoder goes by, such as NVENC; an unknown one as it is. */
export function encoderName(encoder) {
  return ENCODER_NAMES[encoder]?.[0] ?? encoder;
}

function testedRow(status, encoder) {
  return status?.last_test?.rows?.find((row) => row.encoder === encoder) ?? null;
}

function results(row) {
  return Object.values(row?.results ?? {});
}

function failedTest(row) {
  return results(row).some((result) => !result.ok);
}

/** `[{value, failed, disabled, pick}]`: `pick` is the encoder Auto would use; an encoder that failed its test, or is off this session, can't be picked. */
export function encoderChoices(status) {
  const off = new Set(status?.disabled ?? []);
  const current = status?.policy?.value;
  // Only while Auto is the policy: under a forced CPU or encoder it would mislead.
  const autoPick = current === POLICY_AUTO ? status?.auto_pick ?? null : null;
  return (status?.choices ?? []).map(function choice(value) {
    const failed = failedTest(testedRow(status, value));
    const blocked = (failed || off.has(value)) && !ALWAYS_ON.has(value) && value !== current;
    return { value, failed, disabled: blocked, pick: value === POLICY_AUTO ? autoPick : null };
  });
}

function reasonOf(row) {
  const reason = results(row).find((result) => !result.ok)?.reason ?? null;
  return reason?.startsWith(INVALID_PREFIX) ? REASON_INVALID : reason;
}

function rowState(row, testing) {
  if (testing) return ROW_STATE.testing;
  if (!row) return ROW_STATE.idle;
  return failedTest(row) ? ROW_STATE.failed : ROW_STATE.works;
}

/** One row per candidate and the CPU: its names, state, failure reason and slowest speed. */
export function testRows(status, { testing }) {
  const encoders = [...(status?.candidates ?? []), CPU_ENCODER];
  return encoders.map(function row(encoder) {
    const tested = testedRow(status, encoder);
    const state = rowState(tested, testing);
    const speeds = results(tested).map((result) => result.speed).filter(Number.isFinite);
    const [name, maker] = ENCODER_NAMES[encoder] ?? [encoder, ""];
    return {
      encoder,
      name,
      maker,
      state,
      reason: state === ROW_STATE.failed ? reasonOf(tested) : null,
      speed: state === ROW_STATE.works && speeds.length ? Math.min(...speeds) : null,
    };
  });
}
