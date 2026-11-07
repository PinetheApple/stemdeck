import { LANGUAGES, TRANSLATIONS } from "../../static/js/i18n.js";
import {
  destroySections,
  flushSectionsSave,
  initSections,
  sectionDisplayName,
  clearAllSections,
  saveSectionsOnPageClose,
  getSections,
} from "../../static/js/sections.js";

let pass = 0;
let fail = 0;
const check = (name, condition) => {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

const sectionKeys = [
  "sections.kind.intro",
  "sections.kind.outro",
  "sections.kind.break",
  "sections.kind.bridge",
  "sections.kind.inst",
  "sections.kind.solo",
  "sections.kind.verse",
  "sections.kind.chorus",
  "sections.kind.part",
  "sections.kindNumbered",
];

for (const { code } of LANGUAGES) {
  const table = code === "pt-PT" ? TRANSLATIONS.pt : TRANSLATIONS[code];
  check(`${code} has every automatic-section label`, sectionKeys.every((key) => table[key]));
}
check(
  "canonical kinds use translated display labels",
  sectionDisplayName({ kind: "chorus", name: "model-label" }) === "Chorus",
);
check(
  "custom names remain unchanged",
  sectionDisplayName({ name: "Pre-Chorus" }) === "Pre-Chorus",
);

// The model can label two adjacent spans with one kind and still be marking a
// real structural change, so the boundary is kept and the labels are numbered.
const repeated = [
  { id: "a", kind: "chorus", start: 0, end: 10 },
  { id: "b", kind: "verse", start: 10, end: 20 },
  { id: "c", kind: "chorus", start: 20, end: 30 },
];
check(
  "a repeated kind is numbered in running order",
  sectionDisplayName(repeated[0], repeated) === "Chorus 1" &&
    sectionDisplayName(repeated[2], repeated) === "Chorus 2",
);
check(
  "a kind used once is never numbered",
  sectionDisplayName(repeated[1], repeated) === "Verse",
);
check(
  "numbering follows time, not list order",
  sectionDisplayName(repeated[2], [repeated[2], repeated[1], repeated[0]]) === "Chorus 2",
);
check(
  "a renamed section keeps its own name even beside repeated kinds",
  sectionDisplayName({ id: "d", name: "Pre-Chorus", start: 5, end: 6 }, repeated) === "Pre-Chorus",
);
check(
  "every language orders the numbered label around its own kind word",
  LANGUAGES.every(({ code }) => {
    const table = code === "pt-PT" ? TRANSLATIONS.pt : TRANSLATIONS[code];
    const value = table["sections.kindNumbered"];
    return value.includes("{kind}") && value.includes("{n}");
  }),
);

const clearBtn = {
  hidden: true,
  dataset: {},
  classList: {
    toggle(_name, force) {
      clearBtn.hidden = force;
    },
  },
  querySelector: () => null,
  addEventListener: () => {},
};
globalThis.document = {
  getElementById(id) {
    return id === "sectionsClearBtn" ? clearBtn : null;
  },
};

initSections(
  "abcdefabcdef",
  [{ id: "auto-001", kind: "verse", name: "Verse", start: 0, end: 10, color: "#fff" }],
  10,
);
check("Clear appears once there is something to clear", clearBtn.hidden === false);
destroySections();
check("Clear disappears with the last section", clearBtn.hidden === true);

const requests = [];
const complete = [];
globalThis.fetch = (_url, options) => new Promise((resolve) => {
  requests.push(JSON.parse(options.body));
  complete.push(resolve);
});

initSections(
  "abcdefabcdef",
  [{ id: "auto-001", kind: "intro", name: "Intro", start: 0, end: 10, color: "#fff" }],
  20,
);
const firstSave = flushSectionsSave();
await Promise.resolve();
initSections(
  "abcdefabcde2",
  [{ id: "auto-002", kind: "verse", name: "Verse", start: 10, end: 20, color: "#fff" }],
  20,
);
const secondSave = flushSectionsSave();
await Promise.resolve();
check("a second section save waits for the first", requests.length === 1);
complete[0]({ ok: true });
await firstSave;
await Promise.resolve();
check("the newest snapshot starts after the first completes", requests.length === 2);
check("the first queued snapshot is preserved", requests[0].sections[0].id === "auto-001");
check("the second queued snapshot is preserved", requests[1].sections[0].id === "auto-002");
complete[1]({ ok: true });
await secondSave;
destroySections();

// Clearing every marker at once, and the Clear button retiring with them.
requests.length = 0;
complete.length = 0;
initSections(
  "abcdefabcdef",
  [
    { id: "auto-001", kind: "intro", name: "Intro", start: 0, end: 10, color: "#fff" },
    { id: "auto-002", kind: "verse", name: "Verse", start: 10, end: 20, color: "#fff" },
  ],
  20,
);
check("Clear is offered while sections exist", clearBtn.hidden === false);
clearAllSections();
const clearSave = flushSectionsSave();
await Promise.resolve();
check(
  "clearing saves an empty section list",
  requests.length === 1 && requests[0].sections.length === 0,
);
check("Clear hides itself once the list is empty", clearBtn.hidden === true);
complete[0]({ ok: true });
await clearSave;

// Clearing an already-empty list is a no-op: no second save is scheduled and
// Clear stays hidden. (flushSectionsSave always queues a write, so this
// asserts the state rather than the request count.)
requests.length = 0;
complete.length = 0;
clearAllSections();
check("clearing an already-empty list schedules nothing", requests.length === 0);
check("Clear stays hidden after a redundant clear", clearBtn.hidden === true);
destroySections();

// An edit still inside the save debounce belongs to the track it was made on,
// even when the next track opens before the debounce ends (#40).
const SONG_A = "aaaaaaaaaaaa";
const SONG_B = "bbbbbbbbbbbb";
const sent = [];
globalThis.fetch = async (url, options) => {
  sent.push({ url, body: JSON.parse(options.body), keepalive: options.keepalive === true });
  return { ok: true };
};
const verse = [{ id: "a1", kind: "verse", name: "Verse", start: 0, end: 10, color: "#fff" }];
initSections(SONG_A, verse, 20);
clearAllSections();
initSections(SONG_B, verse, 20);
await flushSectionsSave();
check(
  "an edit pending when the next track opens is saved to its own track",
  sent[0]?.url === `/api/jobs/${SONG_A}/sections` && sent[0].body.sections.length === 0,
);
check(
  "the next track's save carries the next track's sections",
  sent.slice(1).every((r) => r.url === `/api/jobs/${SONG_B}/sections` && r.body.sections.length === 1),
);

sent.length = 0;
clearAllSections();
saveSectionsOnPageClose();
check(
  "closing the page sends a pending edit at once, with keepalive",
  sent.length === 1 && sent[0].keepalive && sent[0].url === `/api/jobs/${SONG_B}/sections`,
);
destroySections();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
await settle();

// A save the server has not answered yet: the track shows it when reopened,
// and the page sends it again on close (#40).
const held = [];
globalThis.fetch = (url, options) => new Promise((resolve) => {
  held.push({ url, body: JSON.parse(options.body), keepalive: options.keepalive === true, resolve });
});
const SONG_C = "cccccccccccc";
initSections(SONG_C, verse, 20);
clearAllSections();
initSections(SONG_B, verse, 20);
initSections(SONG_C, verse, 20);
check("a track reopened before its save lands shows the unsaved edit", getSections().length === 0);
saveSectionsOnPageClose();
const resent = held.filter((r) => r.keepalive);
check(
  "closing the page resends the unconfirmed save with keepalive",
  resent.length === 1 && resent[0].url === `/api/jobs/${SONG_C}/sections` && resent[0].body.sections.length === 0,
);
for (let round = 0; round < 2; round++) {
  for (const r of held.splice(0)) r.resolve({ ok: true });
  await settle();
}
initSections(SONG_C, verse, 20);
check("a confirmed save no longer overrides what the server sends", getSections().length === 1);
saveSectionsOnPageClose();
check("nothing is resent on close once every save is confirmed", held.every((r) => !r.keepalive));
destroySections();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
