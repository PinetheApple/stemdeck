import { isLoaded } from "./batchImportModel.js";

const DURATION_READ_TIMEOUT_MS = 5000;

function readDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const src = URL.createObjectURL(file);
    const timer = setTimeout(onDurationSettled, DURATION_READ_TIMEOUT_MS);
    function onDurationSettled() {
      clearTimeout(timer);
      URL.revokeObjectURL(src);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.removeAttribute("src");
    }
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", onDurationSettled, { once: true });
    audio.addEventListener("error", onDurationSettled, { once: true });
    audio.src = src;
  });
}

export const lengthOf = (target, file) => {
  if (isLoaded(file)) return readDuration(file);
  return target.measure ? target.measure(file) : null;
};
