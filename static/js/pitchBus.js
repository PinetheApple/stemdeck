// Which worklet input a mixer lane belongs on.
//
// The SoundTouch worklet exposes one input per semitone it offers, so a lane's
// transpose is expressed as a *connection*, not as a parameter: routing the
// lane to input k is what makes it sound k - ZERO_INPUT semitones away. Both
// audio engines have to agree on that mapping exactly, which is why it lives
// here rather than twice.

export const PITCH_MIN = -6;
export const PITCH_MAX = 6;
export const INPUT_COUNT = PITCH_MAX - PITCH_MIN + 1;
// Input for semitone 0. It is the plain delay line, so it carries drums, the
// click, and every lane sitting at its own key.
export const ZERO_INPUT = -PITCH_MIN;

export function clampPitch(semitones) {
  const n = Math.round(Number(semitones) || 0);
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, n));
}

/**
 * The shift a lane actually gets.
 *
 * A lane's stored key is absolute, not an offset from the global control. The
 * global control moves every lane by the amount it changed, so the number on a
 * lane is always the key that lane is actually in, and there is never a second
 * number to add in your head to know what you are hearing.
 *
 * Drums are never transposed, whatever any control says. Resampling a snare
 * does not move it to another key, it makes it a different drum.
 * `pitchable === false` covers the same refusal for a rendered complement lane
 * that still has drums mixed into it.
 */
export function effectivePitch(name, semitones, pitchable) {
  if (name === "drums" || pitchable === false) return 0;
  return clampPitch(semitones);
}

export const GLOBAL_PITCH_FIELD = "globalPitch";

/** Saved global key; older records fall back to the lane vote. */
export function savedGlobalPitch(record, laneNames) {
  const saved = record?.[GLOBAL_PITCH_FIELD];
  return Number.isFinite(saved) ? clampPitch(saved) : globalPitchFromLanes(record, laneNames);
}

/**
 * The key most of the song's pitched lanes are in. A tie goes to the key
 * nearer the original, then to the lower one, so stem order never decides.
 */
export function globalPitchFromLanes(record, laneNames) {
  const laneCounts = new Map();
  for (const name of laneNames || []) {
    const lanePitch = record?.[name]?.pitch;
    if (name === "drums" || !Number.isFinite(lanePitch)) continue;
    const semitones = clampPitch(lanePitch);
    laneCounts.set(semitones, (laneCounts.get(semitones) || 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [semitones, count] of laneCounts) {
    if (beatsVote(semitones, count, best, bestCount)) {
      best = semitones;
      bestCount = count;
    }
  }
  return best;
}

function beatsVote(semitones, count, best, bestCount) {
  if (count !== bestCount) return count > bestCount;
  if (Math.abs(semitones) !== Math.abs(best)) return Math.abs(semitones) < Math.abs(best);
  return semitones < best;
}

/** Worklet input index for a given shift. */
export function inputForPitch(semitones) {
  return clampPitch(semitones) + ZERO_INPUT;
}

/**
 * The i18n key explaining why transpose is unavailable.
 *
 * Here for the same reason the input mapping is: the transport control and the
 * lane steppers both have to say it, and two copies of this answer would drift
 * into two different answers to one question.
 *
 * AudioWorklet is a secure-context API. A browser on http://<lan-ip> is never
 * given it, so the SoundTouch stage cannot be built at all -- which is the
 * common case by far, StemDeck hosted on the network and opened from another
 * machine. "Needs Web Audio" sent those people looking for a missing browser
 * feature when Web Audio was working fine and the origin was the problem
 * (#552). Only on an already-secure origin is a genuine worklet failure the
 * remaining explanation.
 */
export function pitchBlockedKey() {
  return window.isSecureContext === false ? "pitch.insecureOrigin" : "pitch.unavailable";
}
