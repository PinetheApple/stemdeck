// The camera side of filming: whether this engine can record a picture, opening
// a camera, and the Camera choice in Settings > Recording.

import { t } from "./i18n.js";
import { cameraProblemOf, filmBlock, pickCameraMime, platformOf } from "./filmSupport.js";
import { filmPrefs, loadFilmPrefs, setFilmPrefs } from "./filmPrefs.js";

const CAMERA_WANTS = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

/** `{ mime, problem }`: the type to record and a CAMERA_PROBLEM when filming can't start. */
export function filmSupportHere() {
  const recorder = globalThis.MediaRecorder;
  const mime = recorder ? pickCameraMime(recorder.isTypeSupported?.bind(recorder)) : null;
  const problem = filmBlock({
    hasMediaRecorder: typeof recorder === "function",
    hasCamera: Boolean(navigator.mediaDevices?.getUserMedia),
    mime,
    platform: platformOf(navigator.userAgent),
  });
  return { mime, problem };
}

/** Opens the camera alone; rejects with an Error whose `problem` names a CAMERA_PROBLEM. */
export async function openCamera(deviceId) {
  const video = { ...CAMERA_WANTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    const problem = new Error("camera", { cause: err });
    problem.problem = cameraProblemOf(err);
    throw problem;
  }
}

export function closeCamera(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function cameraLabel(stream) {
  return stream?.getVideoTracks()[0]?.label ?? "";
}

export async function listCameras() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
  return devices.filter((device) => device.kind === "videoinput");
}

function cameraOption(value, text, selected) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  option.selected = selected;
  return option;
}

/** Settings > Recording's Camera select: the system default, then each camera. */
export async function cameraSelect() {
  await loadFilmPrefs();
  const select = document.createElement("select");
  select.className = "settings-select film-camera-select";
  select.setAttribute("aria-label", t("film.camera"));
  const chosen = filmPrefs().cameraId;
  const cameras = await listCameras().catch(() => []);
  select.append(cameraOption("", t("film.defaultCamera"), !chosen));
  cameras.forEach(function addCamera(device, i) {
    const name = device.label || t("film.cameraN", { n: i + 1 });
    select.append(cameraOption(device.deviceId, name, device.deviceId === chosen));
  });
  select.addEventListener("change", function onCameraChoice() {
    setFilmPrefs({ cameraId: select.value });
  });
  return select;
}
