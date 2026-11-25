// The footer Repeat button's states, what a song's end plays again in each, and its words and captions per language.
//
// Run:  node tests/js/repeat-model.test.mjs

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { REPEAT, SONG_END_STEP, nextRepeat, readRepeat, songEndStep } = await import("../../static/js/repeatModel.js");

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};

const FALLBACK = { "pt-PT": "pt" };
const KEYS = [
  "studio.footer.repeatOff",
  "studio.footer.repeatQueue",
  "studio.footer.repeatSong",
  "studio.footer.repeatCaptionOff",
  "studio.footer.repeatCaptionQueue",
  "studio.footer.repeatCaptionSong",
  "studio.help.repeat",
];
const NOTHING_AHEAD = Object.freeze({ mode: REPEAT.OFF, queued: false, listAhead: false, upNextPlayed: false, setlist: false, listPlayable: false });
const end = (over) => songEndStep({ ...NOTHING_AHEAD, ...over });
const EVERYTHING = { queued: true, listAhead: true, upNextPlayed: true, setlist: true, listPlayable: true };

check("a click goes off, queue, song, then off", nextRepeat(REPEAT.OFF) === REPEAT.QUEUE
  && nextRepeat(REPEAT.QUEUE) === REPEAT.SONG && nextRepeat(REPEAT.SONG) === REPEAT.OFF);
check("a stored state is read back", readRepeat(REPEAT.SONG) === REPEAT.SONG);
check("anything else stored reads as off", readRepeat("all") === REPEAT.OFF && readRepeat(null) === REPEAT.OFF);

check("Repeat song wins over everything", end({ ...EVERYTHING, mode: REPEAT.SONG }) === SONG_END_STEP.SONG_AGAIN);
check("Up Next comes before the list", end({ ...EVERYTHING, mode: REPEAT.QUEUE }) === SONG_END_STEP.UP_NEXT);
check("a setlist goes on before Repeat queue goes back", end({ ...EVERYTHING, mode: REPEAT.QUEUE, queued: false }) === SONG_END_STEP.LIST_NEXT);
check("Repeat queue plays the song again in a list that is not a setlist", end({ mode: REPEAT.QUEUE, listAhead: true, listPlayable: true }) === SONG_END_STEP.SONG_AGAIN);
check("the list goes on with Repeat off", end({ listAhead: true }) === SONG_END_STEP.LIST_NEXT);
check("Repeat queue plays Up Next's songs again before the list", end({ mode: REPEAT.QUEUE, upNextPlayed: true, listPlayable: true }) === SONG_END_STEP.UP_NEXT_AGAIN);
check("Repeat queue plays a setlist again after its last song", end({ mode: REPEAT.QUEUE, setlist: true, listPlayable: true }) === SONG_END_STEP.LIST_AGAIN);
check("Repeat queue with a lone song plays it again", end({ mode: REPEAT.QUEUE }) === SONG_END_STEP.SONG_AGAIN);
check("off stops at the end of Up Next and the list", end({ upNextPlayed: true, setlist: true, listPlayable: true }) === null);

for (const { code } of LANGUAGES) {
  const table = { ...(FALLBACK[code] ? TRANSLATIONS[FALLBACK[code]] : {}), ...TRANSLATIONS[code] };
  for (const key of KEYS) {
    const text = table[key];
    check(`${code}: ${key} exists`, typeof text === "string" && text.trim() !== "");
    if (code !== "en" && text) check(`${code}: ${key} is translated`, text !== TRANSLATIONS.en[key]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
