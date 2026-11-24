// What each control on a recording track does. `session` is takes.js's view of
// the open song: { jobId, listing, ui, refresh(), render() }.

import { t } from "./i18n.js";
import { announceMixChange, applyMix, updateLaneKnobVisual } from "./mixer.js";
import { confirmDialog } from "./confirmDialog.js";
import { openRowMenu } from "./rowMenu.js";
import { nextName } from "./takesState.js";
import { setTakeVolume, takeMixEntry, toggleTakeMute, toggleTakeSolo } from "./takesMix.js";
import { ARM_PROBLEM_SILENT, armTrack, armedTrack, disarm } from "./recorderArm.js";
import { listInputs } from "./recorderCapture.js";
import { setLatencyTestInput } from "./recorderSettings.js";
import * as api from "./takesApi.js";

const STEREO_PAIR = [0, 1];
const SECOND_INPUT = [1];
const FIRST_INPUT = [0];
const FIRST_CHANNEL_NUMBER = FIRST_INPUT[0] + 1;
const SECOND_CHANNEL_NUMBER = SECOND_INPUT[0] + 1;

function trackOf(session, trackId) {
  return session.listing.tracks.find((track) => track.id === trackId) ?? null;
}

async function act(session, work) {
  try {
    await work();
  } catch (err) {
    console.warn("[takes] change failed:", err);
  }
  await session.refresh();
}

function rearmIfArmed(session, trackId) {
  if (armedTrack()?.trackId !== trackId) return;
  const track = trackOf(session, trackId);
  if (track) armTrack(session.jobId, track);
}

export function addTrack(session, anchor) {
  openRowMenu(anchor, t("rec.addTrack"), [
    {
      text: t("rec.audioTrack"),
      icon: "mic",
      onChoose: function onAddAudioTrack() {
        act(session, function createAudioTrack() {
          const names = session.listing.tracks.map((track) => track.name);
          const name = nextName(names, (n) => t("rec.trackDefault", { n }));
          return api.createTrack(session.jobId, { name });
        });
      },
    },
  ]);
}

function inputEntry(session, trackId, device, channels, text) {
  const current = trackOf(session, trackId)?.input;
  const selected = current?.device_id === device.deviceId && String(current?.channels) === String(channels);
  return {
    text,
    icon: "mic",
    selected,
    onChoose: function onChooseInput() {
      act(session, async function saveInput() {
        const input = { device_id: device.deviceId, device_label: device.label || null, channels };
        await api.patchTrack(session.jobId, trackId, { input });
        rearmIfArmed(session, trackId);
      });
    },
  };
}

function channelEntries(session, trackId, device, index) {
  const name = device.label || t("rec.inputN", { n: index + 1 });
  const arm = armedTrack();
  const stereo = arm?.trackId === trackId && arm.info?.deviceId === device.deviceId && arm.info.channelCount > 1;
  if (!stereo) return [inputEntry(session, trackId, device, FIRST_INPUT, name)];
  return [
    inputEntry(session, trackId, device, FIRST_INPUT, t("rec.channel", { name, n: FIRST_CHANNEL_NUMBER })),
    inputEntry(session, trackId, device, SECOND_INPUT, t("rec.channel", { name, n: SECOND_CHANNEL_NUMBER })),
    inputEntry(session, trackId, device, STEREO_PAIR, t("rec.channels", { name })),
  ];
}

export async function chooseInput(session, trackId, anchor) {
  const devices = await listInputs().catch(() => []);
  const entries = devices.flatMap((device, i) => channelEntries(session, trackId, device, i));
  if (!entries.length) entries.push({ text: t("rec.problem.noDevice"), icon: "alert", disabled: true });
  openRowMenu(anchor, t("rec.inputFor", { name: trackOf(session, trackId)?.name ?? "" }), entries);
}

export function toggleArm(session, trackId) {
  if (armedTrack()?.trackId === trackId) {
    disarm();
    return;
  }
  const track = trackOf(session, trackId);
  if (track) armTrack(session.jobId, track);
}

export function setVolume(trackId, volume, knob) {
  setTakeVolume(trackId, volume);
  updateLaneKnobVisual(knob, takeMixEntry(trackId).volume);
  applyMix();
}

export function toggleMute(session, trackId) {
  toggleTakeMute(trackId);
  applyMix();
  session.render();
}

export function toggleSolo(session, trackId) {
  toggleTakeSolo(trackId);
  applyMix();
  session.render();
  announceMixChange();
}

// The track's own input, so the latency test measures what this track records.
function trackInputId(session, trackId) {
  const arm = armedTrack();
  if (arm?.trackId === trackId) return arm.info?.deviceId ?? arm.requestedInput ?? null;
  return trackOf(session, trackId)?.input?.device_id ?? null;
}

export function openRecordingSettings(session, trackId) {
  setLatencyTestInput(trackInputId(session, trackId));
  document.getElementById("settingsBtn")?.click();
  document.querySelector('.settings-tab[data-tab="recording"]')?.click();
}

async function removeTrack(session, trackId) {
  const track = trackOf(session, trackId);
  const yes = await confirmDialog({
    title: t("rec.deleteTrackTitle"),
    name: track?.name ?? "",
    body: t("rec.deleteTrackBody"),
    confirmLabel: t("rec.deleteTrack"),
    focusCancel: true,
  });
  if (!yes) return;
  if (armedTrack()?.trackId === trackId) disarm();
  await act(session, () => api.deleteTrack(session.jobId, trackId));
}

export function trackMenu(session, trackId, anchor) {
  openRowMenu(anchor, t("rec.trackOptions", { name: trackOf(session, trackId)?.name ?? "" }), [
    {
      text: t("rec.rename"),
      icon: "pencil",
      onChoose: function onRenameTrack() {
        session.startRename(trackId);
      },
    },
    {
      text: t("rec.recordingSettings"),
      icon: "sliders",
      onChoose: function onTrackRecordingSettings() {
        openRecordingSettings(session, trackId);
      },
    },
    { separator: true },
    {
      text: t("rec.deleteTrack"),
      icon: "trash",
      danger: true,
      onChoose: function onDeleteTrack() {
        removeTrack(session, trackId);
      },
    },
  ], { alignRight: true });
}

export function renameTrack(session, trackId, name) {
  const clean = name.trim();
  if (!clean || clean === trackOf(session, trackId)?.name) return session.render();
  return act(session, () => api.patchTrack(session.jobId, trackId, { name: clean }));
}

export function pickTake(session, trackId, takeId) {
  return act(session, () => api.patchTrack(session.jobId, trackId, { active_take_id: takeId }));
}

/** Keep: the take just recorded stays; an unfinished one is finished with what arrived. */
export function keepTake(session, row) {
  if (session.ui.review === row.id) {
    session.ui.review = null;
    session.render();
    return null;
  }
  return act(session, () => api.finishTake(session.jobId, row.id, {}));
}

export function discardTake(session, row) {
  if (session.ui.review === row.id) session.ui.review = null;
  return act(session, () => api.deleteTake(session.jobId, row.id));
}

export function answerProblem(session, problem, anchor) {
  const arm = armedTrack();
  if (!arm) return;
  if (problem === ARM_PROBLEM_SILENT) {
    chooseInput(session, arm.trackId, anchor);
    return;
  }
  const track = trackOf(session, arm.trackId);
  if (track) armTrack(session.jobId, track);
}

/** The input name a track row shows. */
export function inputLabelOf(view) {
  const arm = armedTrack();
  if (arm?.trackId === view.id && arm.info?.label) return arm.info.label;
  return view.input?.device_label || "";
}
