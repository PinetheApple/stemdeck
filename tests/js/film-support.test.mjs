// Whether the Film view can record, why not in plain words, the command that
// fixes a missing package, and which stems "I play" silences.
//
// Run:  node tests/js/film-support.test.mjs

import {
  CAMERA_MIMES,
  CAMERA_PROBLEM,
  cameraProblemOf,
  filmBlock,
  installCommand,
  pickCameraMime,
  platformOf,
} from "../../static/js/filmSupport.js";
import { pickableStems, silencedLanes } from "../../static/js/filmIPlayModel.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
check("Linux user agent", platformOf(LINUX_UA) === "linux");
check("Android is not Linux", platformOf("Mozilla/5.0 (Linux; Android 14)") === "other");
check("macOS user agent", platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)") === "mac");
check("Windows user agent", platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)") === "windows");

check("vp8 first", pickCameraMime(() => true) === CAMERA_MIMES[0]);
check("then vp9", pickCameraMime((type) => type.includes("vp9")) === "video/webm;codecs=vp9");
check("then mp4 (WebKit)", pickCameraMime((type) => type === "video/mp4") === "video/mp4");
check("no type at all", pickCameraMime(() => false) === null);
check("an engine that cannot say lets the recorder choose", pickCameraMime(undefined) === "");
check("a throwing isTypeSupported counts as no", pickCameraMime(() => { throw new Error("x"); }) === null);

const ready = { hasMediaRecorder: true, hasCamera: true, mime: "video/webm;codecs=vp8", platform: "linux" };
check("everything there: no block", filmBlock(ready) === null);
check("no MediaRecorder on Linux: the packages", filmBlock({ ...ready, hasMediaRecorder: false }) === CAMERA_PROBLEM.packages);
check("no encoder on Linux: the packages", filmBlock({ ...ready, mime: null }) === CAMERA_PROBLEM.packages);
check("no encoder elsewhere: another browser", filmBlock({ ...ready, mime: null, platform: "mac" }) === CAMERA_PROBLEM.noEncoder);
check("no camera API: no encoder words off Linux", filmBlock({ ...ready, hasCamera: false, platform: "windows" }) === CAMERA_PROBLEM.noEncoder);

check("denied", cameraProblemOf({ name: "NotAllowedError" }) === CAMERA_PROBLEM.denied);
check("in use by another app", cameraProblemOf({ name: "NotReadableError" }) === CAMERA_PROBLEM.noCamera);
check("not found", cameraProblemOf({ name: "NotFoundError" }) === CAMERA_PROBLEM.noCamera);

check("Arch by ID", installCommand({ distro: "arch" }).startsWith("sudo pacman -S "));
check("Manjaro through ID_LIKE", installCommand({ distro: "manjaro", distro_like: ["arch"] }).startsWith("sudo pacman -S "));
check("Ubuntu through ID_LIKE", installCommand({ distro: "ubuntu", distro_like: ["debian"] }).startsWith("sudo apt install "));
check("Fedora", installCommand({ distro: "fedora" }).startsWith("sudo dnf install "));
check("openSUSE", installCommand({ distro: "opensuse-tumbleweed", distro_like: ["opensuse", "suse"] }).startsWith("sudo zypper install "));
check("an unknown Linux falls back to apt", installCommand({ distro: "nixos" }).startsWith("sudo apt install "));
check("no OS facts on Linux fall back to apt", installCommand(null).startsWith("sudo apt install "));

const LANES = ["original", "vocals", "drums", "bass", "other"];
check("the picker offers the song's stems, not the original", same(pickableStems(LANES), ["vocals", "drums", "bass", "other"]));
check("nothing played silences nothing", same(silencedLanes([], LANES), []));
check("played stems are silenced", same(silencedLanes(["drums", "bass"], LANES), ["drums", "bass"]));
check(
  "vocals silences both of its halves",
  same(silencedLanes(["vocals"], ["lead_vocals", "backing_vocals", "drums"]), ["lead_vocals", "backing_vocals"]),
);
check("a played stem the song lacks silences nothing", same(silencedLanes(["guitar"], LANES), []));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
