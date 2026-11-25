// The footer Repeat button's states, what a song's end plays again in each, and its words per language.
//
// Run:  node tests/js/repeat-model.test.mjs

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { LIST_AT, REPEAT, REPEAT_START, nextRepeat, readRepeat, repeatAtEnd } = await import("../../static/js/repeatModel.js");

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
const KEYS = ["studio.footer.repeatOff", "studio.footer.repeatQueue", "studio.footer.repeatSong", "studio.help.repeat"];
const end = (over) => repeatAtEnd({ mode: REPEAT.QUEUE, queued: false, runLength: 1, list: LIST_AT.NONE, ...over });

check("a click goes off, queue, song, then off", nextRepeat(REPEAT.OFF) === REPEAT.QUEUE
  && nextRepeat(REPEAT.QUEUE) === REPEAT.SONG && nextRepeat(REPEAT.SONG) === REPEAT.OFF);
check("a stored state is read back", readRepeat(REPEAT.SONG) === REPEAT.SONG);
check("anything else stored reads as off", readRepeat("all") === REPEAT.OFF && readRepeat(null) === REPEAT.OFF);

check("off repeats nothing", end({ mode: REPEAT.OFF }) === null);
check("Repeat song plays the song again, even with songs queued", end({ mode: REPEAT.SONG, queued: true }) === REPEAT_START.SONG);
check("Repeat queue leaves a song with more queued to Up Next", end({ queued: true, runLength: 3 }) === null);
check("Repeat queue plays the run through Up Next again", end({ runLength: 2, list: LIST_AT.AHEAD }) === REPEAT_START.RUN);
check("Repeat queue plays a list again after its last song", end({ list: LIST_AT.END }) === REPEAT_START.LIST);
check("Repeat queue does not end a list early", end({ list: LIST_AT.AHEAD }) === null);
check("Repeat queue with one song and no list plays it again", end({}) === REPEAT_START.SONG);

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
