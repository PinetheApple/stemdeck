// The Key popover's value, limits and the key the playing song sounds in once moved.

import { t } from "./i18n.js";
import { formatKey } from "./keyLabel.js";
import { $ } from "./utils.js";

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const SEMITONES_PER_OCTAVE = SHARPS.length;

let readPlayingKey = () => null;

/** A stored key such as "D min" moved by `semitones`, named with sharps; "" when it cannot be read. */
export function transposeKey(key, semitones) {
  const [tonic, ...rest] = String(key ?? "").trim().split(/\s+/);
  const at = Math.max(SHARPS.indexOf(tonic), FLATS.indexOf(tonic));
  if (at < 0) return "";
  const moved = (((at + semitones) % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
  return [SHARPS[moved], ...rest].join(" ");
}

function keyName(semitones) {
  const playing = readPlayingKey();
  const moved = transposeKey(playing?.key, semitones);
  return moved ? formatKey(moved, playing.scale, t) : "";
}

/** The popover's value, its - and + limits, and the key `semitones` gives. */
export function paintKeyPanel({ semitones, label, canDown, canUp }) {
  const value = $("t-key-panel-value");
  if (!value) return;
  value.textContent = label;
  $("t-key-panel-down").disabled = !canDown;
  $("t-key-panel-up").disabled = !canUp;
  $("t-key-panel-name").textContent = keyName(semitones);
}

/** `playingKey` returns the playing song's `{ key, scale }`, or null. */
export function initFooterKey(playingKey) {
  readPlayingKey = playingKey;
}
