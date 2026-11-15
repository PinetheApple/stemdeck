// Whether this engine can film a take, and the plain-words reason when not.
// Pure: the browser facts come in as arguments. Stock Linux WebKitGTK can lack
// MediaRecorder, or have it with no encoder, until the GStreamer plugins are in.

export const CAMERA_MIMES = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/mp4"];

export const CAMERA_PROBLEM = {
  noCamera: "noCamera",
  denied: "denied",
  packages: "packages",
  noEncoder: "noEncoder",
};

export const PLATFORM = { linux: "linux", mac: "mac", windows: "windows", other: "other" };

const DENIED_ERRORS = new Set(["NotAllowedError", "SecurityError"]);

const APT = "sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav gstreamer1.0-pipewire";
// Matched against os-release ID, then each ID_LIKE; apt when nothing matches.
const INSTALL_COMMANDS = [
  ["arch", "sudo pacman -S gst-plugins-good gst-plugin-pipewire"],
  ["debian", APT],
  ["ubuntu", APT],
  ["fedora", "sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-free pipewire-gstreamer"],
  ["suse", "sudo zypper install gstreamer-plugins-good gstreamer-plugins-bad pipewire-gstreamer"],
  ["opensuse", "sudo zypper install gstreamer-plugins-good gstreamer-plugins-bad pipewire-gstreamer"],
];

export function platformOf(userAgent) {
  const ua = String(userAgent || "");
  if (/Mac OS X|Macintosh/.test(ua)) return PLATFORM.mac;
  if (/Windows/.test(ua)) return PLATFORM.windows;
  if (/Linux/.test(ua) && !/Android/.test(ua)) return PLATFORM.linux;
  return PLATFORM.other;
}

function supported(isTypeSupported, type) {
  try {
    return Boolean(isTypeSupported(type));
  } catch (err) {
    console.warn("[film] isTypeSupported threw for", type, err);
    return false;
  }
}

/** The first type of CAMERA_MIMES this engine records; "" when it cannot say, null when none. */
export function pickCameraMime(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return "";
  return CAMERA_MIMES.find((type) => supported(isTypeSupported, type)) ?? null;
}

/** A CAMERA_PROBLEM that stops filming before any camera opens, or null. */
export function filmBlock({ hasMediaRecorder, hasCamera, mime, platform }) {
  if (hasMediaRecorder && hasCamera && mime !== null) return null;
  return platform === PLATFORM.linux ? CAMERA_PROBLEM.packages : CAMERA_PROBLEM.noEncoder;
}

/** The CAMERA_PROBLEM for a getUserMedia rejection. */
export function cameraProblemOf(err) {
  return DENIED_ERRORS.has(err?.name) ? CAMERA_PROBLEM.denied : CAMERA_PROBLEM.noCamera;
}

/** The install command for the GStreamer plugins, from os-release facts (or none). */
export function installCommand(os) {
  const ids = [os?.distro, ...(os?.distro_like ?? [])].filter(Boolean);
  for (const id of ids) {
    const hit = INSTALL_COMMANDS.find(([name]) => name === id);
    if (hit) return hit[1];
  }
  return APT;
}
