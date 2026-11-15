// The OS media controls follow the song in the player. A song only shown over it
// ("trackshow") leaves the metadata and the held anchor alone; loading that song
// ("trackopen") moves them to it.
// Run:  node tests/js/media-session-shown.test.mjs

import { registerHooks } from "node:module";

const SONG_A = { id: "song-a", displayTitle: "Song A" };
const SONG_B = { id: "song-b", displayTitle: "Song B" };
const TRACK_OPEN = "trackopen";
const TRACK_SHOW = "trackshow";

const stubs = {
  "catalog.js": `
    export const getPlayingTrackInfo = () => globalThis.__playing;
    export const getLibraryTrack = () => null;
    export const displayTitle = (title) => title;
    export const libraryTitle = () => "";`,
  "transport.js": `
    export const togglePlayPause = () => {};
    export const stopTransport = () => {};
    export const setPlayheadTime = () => {};
    export const transport = () => null;`,
  "upNext.js": "export const playNextInUpNext = () => {};",
  "state.js": `
    export const totalDuration = 0;
    export const playbackSpeed = 1;
    export const playBtn = null;
    export const loopEnabled = false;
    export const loopStart = 0;`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split("/").pop();
    if (specifier.startsWith("./") && stubs[name] && context.parentURL?.endsWith("/mediaSession.js")) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const anchorPauses = { count: 0 };
class FakeAudio extends EventTarget {
  play() { return Promise.resolve(); }
  pause() { anchorPauses.count++; }
  removeAttribute() {}
  load() {}
}
const session = { metadata: null, playbackState: "none", setActionHandler() {}, setPositionState() {} };
globalThis.MediaMetadata = class { constructor(init) { Object.assign(this, init); } };
globalThis.Audio = FakeAudio;
globalThis.document = new EventTarget();
Object.defineProperty(globalThis, "navigator", { value: { mediaSession: session }, configurable: true });

const { initMediaSession, startMediaAnchor } = await import("../../static/js/mediaSession.js");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const send = (type, id) => document.dispatchEvent(new CustomEvent(type, { detail: { id } }));

initMediaSession();
globalThis.__playing = SONG_A;
send(TRACK_OPEN, SONG_A.id);
startMediaAnchor();
check("the loaded song names the OS controls", session.metadata?.title, SONG_A.displayTitle);

const pausesBefore = anchorPauses.count;
send(TRACK_SHOW, SONG_B.id);
check("a shown song leaves the metadata on the playing one", session.metadata?.title, SONG_A.displayTitle);
check("a shown song does not pause the held anchor", anchorPauses.count, pausesBefore);

globalThis.__playing = SONG_B;
send(TRACK_OPEN, SONG_B.id);
check("playing the shown song moves the metadata to it", session.metadata?.title, SONG_B.displayTitle);
check("playing the shown song resets the anchor", anchorPauses.count, pausesBefore + 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
