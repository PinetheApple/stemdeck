// PROTOTYPE — throwaway. Mock data only; nothing here talks to the backend.
import { ICONS } from "./icons.js";

const LOOKS = {
  console: { name: "Console", note: "warm graphite · mint LCD readouts · meters", volume: "fader", meters: true, wave: { bar: 2, gap: 1, round: 0, steps: 0 } },
  instrument: { name: "Instrument", note: "flat blocks · hot orange · knobs · stepped waves", volume: "knob", meters: false, wave: { bar: 3, gap: 2, round: 0, steps: 7 } },
  stage: { name: "Stage", note: "big type · cyan · read it from the music stand", volume: "fader", meters: false, wave: { bar: 3, gap: 2, round: 1.5, steps: 0 } },
};

const STEMS = [
  { id: "vocals", name: "Vocals" },
  { id: "drums", name: "Drums" },
  { id: "bass", name: "Bass" },
  { id: "guitar", name: "Guitar" },
  { id: "piano", name: "Piano" },
  { id: "other", name: "Other" },
];

const LIBRARY = [
  { id: 1, title: "Morning Light", artist: "North Choir", dur: 501, key: "G#", bpm: 136, fav: true },
  { id: 2, title: "Open Fields", artist: "Unknown artist", dur: 282, key: "D", bpm: 72, fav: false },
  { id: 3, title: "Harbour Song (Live)", artist: "Unknown artist", dur: 320, key: "B", bpm: 68, fav: true },
  { id: 4, title: "Steady Ground", artist: "Ana Ruiz", dur: 334, key: "A", bpm: 74, fav: false },
  { id: 5, title: "Echoes", artist: "Lena Park", dur: 311, key: "C", bpm: 128, fav: false },
  { id: 6, title: "Evensong", artist: "Unknown artist", dur: 372, key: "E", bpm: 70, fav: false },
  { id: 7, title: "Wide Awake", artist: "The Lanterns", dur: 507, key: "F", bpm: 76, fav: false },
  { id: 8, title: "River Run (Live)", artist: "Kestrel", dur: 304, key: "G", bpm: 132, fav: false },
  { id: 9, title: "Higher Still", artist: "Unknown artist", dur: 176, key: "Bb", bpm: 76, fav: false },
  { id: 10, title: "Golden Hour", artist: "Sam Ito", dur: 422, key: "Ab", bpm: 140, fav: false },
  { id: 11, title: "Never Far", artist: "Mara Quinn", dur: 478, key: "D", bpm: 140, fav: false },
  { id: 12, title: "Bright Morning", artist: "Common Ground", dur: 378, key: "E", bpm: 74, fav: true },
];

const SETLISTS = [
  { id: "s1", name: "Weekend set", songs: [1, 5, 12, 4] },
  { id: "s2", name: "Rehearsal", songs: [8, 10, 11] },
];

const SECTIONS = [
  ["Intro", 0, 30], ["Verse 1", 30, 75], ["Chorus", 75, 120], ["Verse 2", 120, 165],
  ["Chorus", 165, 215], ["Bridge", 215, 290], ["Chorus", 290, 350], ["Chorus", 350, 410],
  ["Tag", 410, 470], ["Outro", 470, 501],
];

const LYRICS = {
  Intro: ["", ""], Outro: ["", ""],
  "Verse 1": ["Placeholder verse line one", "placeholder verse line two"],
  "Verse 2": ["Placeholder second verse line", "and its second line"],
  Chorus: ["Placeholder chorus line", "placeholder chorus answer"],
  Bridge: ["Placeholder bridge line", "rising into the last chorus"],
  Tag: ["Placeholder tag line", ""],
};

const ANALYSIS = {
  lufs: "-11.4", peak: "3.0 dB", dr: "14.3", stability: "96%",
  presence: { vocals: 100, drums: 88, bass: 80, guitar: 40, piano: 43, other: 45 },
};

const PALETTES = {
  "ink-coral": "Ink & coral — neutral charcoal, warm coral accent",
  "forest-lime": "Forest & lime — green-black, chartreuse accent",
  "plum-peach": "Plum & peach — aubergine-black, soft peach accent",
  "mono-red": "Mono & signal red — pure neutral greys, red accent",
  "sand-teal": "Sand & teal — warm stone, teal accent",
};

const BEATS_PER_BAR = 4;
const NUDGE_S = 0.01;
const BPM_STEP = 0.1;
const TAP_RESET_MS = 2000;
const MIN_LINE_PX = 7;
const METER_SEGMENTS = 14;
const KNOB_DRAG_PX = 160;

const state = {
  look: new URLSearchParams(location.search).get("look") || "stage",
  palette: new URLSearchParams(location.search).get("palette") || "ink-coral",
  stageMode: new URLSearchParams(location.search).get("stage") === "1",
  songId: 1, t: 144, playing: false, speed: 1, semitones: 0, loop: false,
  click: true, grid: true, tempoMode: "constant", bpm: 136, anchor: 0.42, countIn: "1 bar", clickVol: 0.6,
  queue: [5, 12, 4], libTab: "songs", tab: "tempo", q: "",
  stems: Object.fromEntries(STEMS.map((s) => [s.id, { vol: 0.8, m: false, s: false }])),
  taps: [],
};

// ─── helpers ───────────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const song = (id = state.songId) => LIBRARY.find((s) => s.id === id);
const beatLen = () => 60 / state.bpm;
const look = () => LOOKS[state.look];
const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const hash = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
const toDb = (v) => (v <= 0.001 ? "−∞" : (20 * Math.log10(v / 0.8)).toFixed(1));

const icon = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const tile = (s, cls = "") => `<span class="tile ${cls}" style="--tile:hsl(${(s.id * 53) % 360} 28% 26%)">${esc(s.title[0])}</span>`;
const lcd = (val, ghost, cls = "") => `<span class="lcd ${cls}"><span class="ghost">${ghost}</span><span class="val">${val}</span></span>`;
const rename = (s) => `<span class="rename" data-action="rename" data-id="${s.id}" title="Rename"><span class="txt">${esc(s.title)}</span>${icon("pencil")}</span>`;

const currentSection = (t = state.t) => SECTIONS.find(([, a, b]) => t >= a && t < b) || SECTIONS[SECTIONS.length - 1];

function beatTimeAt(n) {
  const base = state.anchor + n * beatLen();
  return state.tempoMode === "constant" ? base : base + 0.18 * Math.sin(n / 37) + 0.03 * Math.sin(n * 1.7);
}

function beatIndexAt(t) {
  let n = Math.floor((t - state.anchor) / beatLen());
  while (beatTimeAt(n + 1) <= t) n++;
  while (n > -4 && beatTimeAt(n) > t) n--;
  return n;
}

function envelope(stem, t) {
  switch (stem) {
    case "vocals": return t < 32 ? 0 : t > 488 ? 0.1 : 0.72 + 0.2 * Math.sin(t / 9);
    case "drums": return t < 140 ? (Math.abs(t - 95) < 1 || Math.abs(t - 108) < 1 ? 0.8 : 0) : t > 430 ? 0 : 0.85;
    case "bass": return t < 60 ? 0.08 : t < 120 ? 0.35 : t > 445 ? 0.05 : 0.6;
    case "guitar": return t < 140 ? 0.35 : 0.65 + 0.15 * Math.sin(t / 13);
    case "piano": return t < 140 ? 0.85 : t > 400 ? 0.8 : 0.12;
    default: return 0.45 + 0.1 * Math.sin(t / 7);
  }
}

function audible(id) {
  const st = state.stems[id];
  const anySolo = Object.values(state.stems).some((x) => x.s);
  return (!anySolo || st.s) && !st.m;
}

// ─── fragments ─────────────────────────────────────────────────────────────

const brand = () => `<div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="3" y="4" width="14" height="3" rx="1.5" fill="var(--accent)"/><rect x="3" y="10.5" width="18" height="3" rx="1.5" fill="var(--text)"/>
  <rect x="3" y="17" width="10" height="3" rx="1.5" fill="var(--text-3)"/></svg>StemDeck</div>`;

const beats = (cls = "") => `<span class="beats ${cls}" data-beats>${"<i></i>".repeat(BEATS_PER_BAR)}</span>`;

function volumeControl(s) {
  const v = state.stems[s.id].vol;
  if (look().volume === "knob") {
    return `<svg class="knob" viewBox="0 0 40 40" data-knob="${s.id}" role="slider" aria-label="${s.name} volume" aria-valuenow="${Math.round(v * 100)}" tabindex="0">${knobArt(v)}</svg>`;
  }
  return `<input class="fader" type="range" min="0" max="1" step="0.01" value="${v}" style="--p:${v * 100}%" data-input="vol" data-stem="${s.id}" aria-label="${s.name} volume">`;
}

function knobArt(v) {
  const r = 15;
  const start = -225;
  const sweep = 270;
  const pt = (deg) => [20 + r * Math.cos((deg * Math.PI) / 180), 20 + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (a, b) => {
    const [x1, y1] = pt(a);
    const [x2, y2] = pt(b);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const end = start + sweep * v;
  const [tx, ty] = pt(end);
  return `<path class="track" d="${arc(start, start + sweep)}" fill="none" stroke-width="3.5" stroke-linecap="butt"/>
    ${v > 0.005 ? `<path class="value" d="${arc(start, end)}" fill="none" stroke-width="3.5" stroke-linecap="butt"/>` : ""}
    <circle class="cap" cx="20" cy="20" r="10" stroke-width="1"/>
    <line class="tick" x1="20" y1="20" x2="${(20 + (tx - 20) * 0.6).toFixed(2)}" y2="${(20 + (ty - 20) * 0.6).toFixed(2)}" stroke-width="2" stroke-linecap="round"/>`;
}

function laneCtl(s) {
  const st = state.stems[s.id];
  return `<div class="stem-name">${s.name}</div>
    <div class="ms"><button type="button" class="toggle-ms mute ${st.m ? "on" : ""}" data-action="mute" data-stem="${s.id}" aria-pressed="${st.m}" title="Mute">M</button>
    <button type="button" class="toggle-ms solo ${st.s ? "on" : ""}" data-action="solo" data-stem="${s.id}" aria-pressed="${st.s}" title="Solo">S</button></div>
    <div class="vol">${volumeControl(s)}${look().meters ? `<span class="meter" data-meter="${s.id}">${"<i></i>".repeat(METER_SEGMENTS)}</span>` : ""}
    <span class="db" data-db="${s.id}">${toDb(st.vol)}</span></div>`;
}

function sectionsStrip() {
  const d = song().dur;
  const cur = currentSection();
  return `<div class="sections">${SECTIONS.map((sec) => {
    const [name, a, b] = sec;
    const kind = name === "Chorus" ? "chorus" : "";
    return `<button type="button" class="sec ${kind} ${sec === cur ? "current" : ""}" data-action="seek" data-t="${a}" title="${name} · ${fmt(a)}–${fmt(b)}"
      style="left:${(a / d) * 100}%;width:calc(${((b - a) / d) * 100}% - 3px)">${name}</button>`;
  }).join("")}</div>`;
}

function ruler() {
  const d = song().dur;
  let out = "";
  for (let t = 0; t < d; t += 60) out += `<span style="left:${(t / d) * 100}%">${fmt(t)}</span>`;
  return `<div class="ruler">${out}</div>`;
}

function songRow(s, extra = "") {
  return `<div class="song ${s.id === state.songId ? "active" : ""}" data-action="play-song" data-id="${s.id}">
    ${extra}${tile(s)}<div class="grow"><div class="title ellipsis">${esc(s.title)}</div><div class="sub ellipsis">${esc(s.artist)}</div></div>
    <span class="meta num">${s.key} · ${s.bpm}</span>
    <span class="actions">
      <button type="button" class="icon-btn" data-action="play-next" data-id="${s.id}" title="Play next">${icon("list-start")}</button>
      <button type="button" class="icon-btn" data-action="queue-add" data-id="${s.id}" title="Add to Up Next">${icon("list-plus")}</button>
      <button type="button" class="icon-btn" title="More">${icon("ellipsis")}</button>
    </span></div>`;
}

function library() {
  const q = state.q.toLowerCase();
  const songs = LIBRARY.filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));
  const list = state.libTab === "songs"
    ? (songs.length ? songs.map((s) => songRow(s)).join("") : `<div class="empty">${icon("search")}<strong>No matches</strong><span>Nothing in your library matches “${esc(state.q)}”.</span></div>`)
    : SETLISTS.map((sl) => `<div class="group-head"><span class="label">${esc(sl.name)}</span>
        <button type="button" class="btn sm quiet" data-action="play-setlist" data-sid="${sl.id}">${icon("play", "fill")}Play</button></div>
        ${sl.songs.map((id) => songRow(song(id))).join("")}`).join("")
      + `<div class="group-head"><button type="button" class="btn sm quiet" data-action="new-setlist">${icon("plus")}New setlist</button></div>`;
  return `<aside class="library">
    <div class="head">
      <div class="field-wrap">${icon("search")}<input class="field" placeholder="Search library" data-input="q" value="${esc(state.q)}"></div>
      <div class="seg"><button type="button" class="${state.libTab === "songs" ? "on" : ""}" data-action="lib-tab" data-v="songs">Songs <span class="t3 num">${LIBRARY.length}</span></button>
      <button type="button" class="${state.libTab === "setlists" ? "on" : ""}" data-action="lib-tab" data-v="setlists">Setlists <span class="t3 num">${SETLISTS.length}</span></button></div>
    </div>
    <div class="list" data-list>${list}</div>
    <div class="foot">
      <button type="button" class="btn sm quiet">${icon("heart")}Favorites</button>
      <button type="button" class="btn sm quiet">${icon("trash-2")}Trash</button>
      <button type="button" class="btn sm quiet">${icon("settings")}Settings</button>
    </div>
  </aside>`;
}

function tracks() {
  const s = song();
  return `<main class="tracks">
    <div class="song-head">${tile(s, "lg")}
      <div class="grow"><div class="name">${rename(s)}</div><div class="t2">${esc(s.artist)}</div></div>
      <div class="facts">
        <div class="fact"><span class="label">Key</span><span class="v">${s.key} maj${state.semitones ? ` → ${state.semitones > 0 ? "+" : ""}${state.semitones}` : ""}</span></div>
        <div class="fact"><span class="label">Tempo</span><span class="v">${state.bpm.toFixed(1)}</span></div>
        <div class="fact"><span class="label">Length</span><span class="v">${fmt(s.dur)}</span></div>
      </div>
      <button type="button" class="icon-btn ${s.fav ? "on" : ""}" data-action="fav" aria-label="Favorite">${icon("heart", s.fav ? "fill" : "")}</button>
      <button type="button" class="btn">${icon("download")}Export</button>
    </div>
    <div class="timeline-head"><div></div><div>${sectionsStrip()}${ruler()}</div></div>
    <div class="lanes">
      ${STEMS.map((st) => `<div class="lane ${audible(st.id) ? "" : "dim"}" style="--c:var(--${st.id})"><div class="ctl">${laneCtl(st)}</div>
        <div class="wave"><canvas data-wave="${st.id}"></canvas></div></div>`).join("")}
      <div class="lane-playhead"><div class="playhead" data-playhead></div></div>
    </div>
  </main>`;
}

function tempoPane() {
  const c = state.tempoMode === "constant";
  return `<div class="card"><div class="tempo-top">
      <div class="readout"><span class="label">Tempo · BPM</span>${lcd(state.bpm.toFixed(1), "888.8", "big")}</div>
      <div class="readout" style="align-items:flex-end"><span class="label">Bar · beat</span>${lcd("<span data-barbeat>—</span>", "888.8", "big")}</div>
    </div>
    <div class="row" style="margin-top:12px;justify-content:space-between">${beats()}
      <button type="button" class="btn sm ${state.click ? "on" : ""}" data-action="toggle-click">${icon("metronome")}Click ${state.click ? "on" : "off"}</button></div></div>
  <div class="seg" style="width:100%">
    <button type="button" class="grow ${c ? "on" : ""}" data-action="tempo-mode" data-v="constant">Constant tempo</button>
    <button type="button" class="grow ${c ? "" : "on"}" data-action="tempo-mode" data-v="follow">Follow the band</button></div>
  <p class="hint" style="margin:0">${c
    ? "One tempo for the whole song. The grid and the click come from the same beat, so they always agree — even where the drums drop out."
    : "The click follows the band as it speeds up and slows down. Live recordings can feel uneven."}</p>
  <div class="form-row"><span class="label">BPM</span><div class="bpm-edit">
    <button type="button" class="icon-btn" data-action="bpm-step" data-d="-1" aria-label="Slower">−</button>
    <input class="field" data-input="bpm" value="${state.bpm.toFixed(1)}" aria-label="Tempo" ${c ? "" : "disabled"}>
    <button type="button" class="icon-btn" data-action="bpm-step" data-d="1" aria-label="Faster">+</button></div></div>
  <div class="tool-grid">
    <button type="button" class="btn sm" data-action="tap">${icon("timer")}Tap</button>
    <button type="button" class="btn sm" data-action="bpm-mult" data-m="0.5">Half</button>
    <button type="button" class="btn sm" data-action="bpm-mult" data-m="2">Double</button>
    <button type="button" class="btn sm" data-action="nudge" data-d="-1">← 10 ms</button>
    <button type="button" class="btn sm" data-action="set-downbeat" title="Make the playhead beat 1">Beat 1 here</button>
    <button type="button" class="btn sm" data-action="nudge" data-d="1">10 ms →</button>
  </div>
  <div class="form-row"><span class="label">Count-in</span><div class="seg">${["Off", "1 bar", "2 bars"].map((o) =>
    `<button type="button" class="${state.countIn === o ? "on" : ""}" data-action="count-in" data-v="${o}">${o}</button>`).join("")}</div></div>
  <div class="form-row"><span class="label">Click level</span><input class="fader" style="--c:var(--accent);--p:${state.clickVol * 100}%;max-width:160px" type="range" min="0" max="1" step="0.01" value="${state.clickVol}" data-input="click-vol" aria-label="Click level"></div>
  <div class="form-row"><span class="label">Show grid</span><button type="button" class="btn sm ${state.grid ? "on" : ""}" data-action="toggle-grid">${state.grid ? "Shown" : "Hidden"}</button></div>`;
}

function queuePane() {
  const now = song();
  const up = state.queue.length
    ? state.queue.map((id, i) => songRow(song(id), `<span class="t3" title="Drag to reorder" style="cursor:grab">${icon("grip-vertical")}</span>`).replace('data-action="play-song"', `data-action="queue-play" data-i="${i}"`)).join("")
    : `<div class="empty">${icon("list-music")}<strong>Up Next is empty</strong><span>Hover a song and choose Play next, or play a setlist.</span></div>`;
  return `<div><div class="label" style="margin-bottom:6px">Now playing</div>${songRow(now)}</div>
    <div><div class="pane-head" style="margin-bottom:6px"><span class="label">Up next · ${state.queue.length}</span>
      <span class="row" style="gap:2px"><button type="button" class="btn sm quiet" data-action="save-queue">Save as setlist</button>
      <button type="button" class="btn sm quiet" data-action="clear-queue">Clear</button></span></div>${up}</div>
    <p class="hint" style="margin:0">When a song ends, the next one starts.</p>`;
}

function detailsPane() {
  const a = ANALYSIS;
  return `<div class="card stats">
      <div><div class="label">Loudness</div><div class="v">${a.lufs} LUFS</div></div>
      <div><div class="label">True peak</div><div class="v">${a.peak}</div></div>
      <div><div class="label">Dynamic range</div><div class="v">${a.dr}</div></div>
      <div><div class="label">Tempo stability</div><div class="v">${a.stability}</div></div></div>
    <div><div class="label" style="margin-bottom:8px">Stem presence</div><div class="presence">${STEMS.map((s) =>
      `<span>${s.name}</span><span class="bar" style="--c:var(--${s.id})"><b style="width:${a.presence[s.id]}%"></b></span><span class="num t3">${a.presence[s.id]}%</span>`).join("")}</div></div>
    <p class="hint" style="margin:0">YouTube · high quality · extracted Oct 31, 9:27 PM</p>`;
}

function inspector() {
  const tabs = [["tempo", "metronome", "Tempo"], ["queue", "list-music", "Up Next"], ["details", "info", "Details"]];
  const pane = { tempo: tempoPane, queue: queuePane, details: detailsPane }[state.tab]();
  return `<aside class="inspector"><div class="tabs">${tabs.map(([k, ic, label]) =>
    `<button type="button" class="${state.tab === k ? "on" : ""}" data-action="tab" data-v="${k}">${icon(ic)}${label}${k === "queue" ? `<span class="count">${state.queue.length}</span>` : ""}</button>`).join("")}</div>
    <div class="pane">${pane}</div></aside>`;
}

function stage() {
  const [name, a, b] = currentSection();
  const idx = SECTIONS.findIndex((x) => x[1] === a);
  const next = SECTIONS[idx + 1];
  const lines = LYRICS[name] || ["", ""];
  const first = (state.t - a) / (b - a) < 0.5;
  const line = (first ? lines[0] : lines[1] || lines[0]) || "Instrumental";
  return `<div class="stage"><div class="stage-main">
      <div class="stage-center">
        <div class="stage-section">${name}</div>
        <div class="stage-count">${lcd("<span data-barbeat>—</span>", "888.8")}${beats("huge")}</div>
        <div class="stage-lyric">${esc(line)}</div>
        <div class="stage-lyric next">${esc(first ? lines[1] : "")}</div>
        <div class="stage-next">${next ? `${icon("skip-forward")}Next: <strong>${next[0]}</strong> <span class="num t3">in <span data-next-in>—</span></span>` : "Last section"}</div>
      </div>
      <div class="overview-wrap">${sectionsStrip()}<div class="overview"><canvas data-wave="mix"></canvas><div class="playhead" data-playhead></div></div></div>
    </div>
    <aside class="stage-mixer"><span class="label">Mix</span>${STEMS.map((s) => {
      const st = state.stems[s.id];
      return `<div class="strip" style="--c:var(--${s.id})"><span class="stem-name">${s.name}</span>${volumeControl(s)}
        <span class="row" style="gap:4px"><button type="button" class="toggle-ms mute ${st.m ? "on" : ""}" data-action="mute" data-stem="${s.id}">M</button>
        <button type="button" class="toggle-ms solo ${st.s ? "on" : ""}" data-action="solo" data-stem="${s.id}">S</button></span></div>`;
    }).join("")}</aside></div>`;
}

function transport() {
  const s = song();
  return `<footer class="transport">
    <div class="group">
      <button type="button" class="icon-btn" data-action="restart" aria-label="Back to start">${icon("skip-back", "fill")}</button>
      <button type="button" class="play" data-action="toggle-play" aria-label="${state.playing ? "Pause" : "Play"}">${icon(state.playing ? "pause" : "play", "fill lg")}</button>
      <button type="button" class="icon-btn" data-action="next" aria-label="Next song">${icon("skip-forward", "fill")}</button>
    </div>
    <div class="time">${lcd(`<span data-time>${fmt(state.t)}</span>`, "88:88", "big")}<span class="num t3">/ ${fmt(s.dur)}</span></div>
    <span class="sep"></span>
    <button type="button" class="btn ${state.loop ? "on" : ""}" data-action="toggle-loop">${icon("repeat")}Loop section</button>
    <div class="group"><span class="label">Speed</span><div class="seg">${[0.5, 0.75, 0.9, 1].map((v) =>
      `<button type="button" class="${state.speed === v ? "on" : ""}" data-action="speed" data-v="${v}">${v}×</button>`).join("")}</div></div>
    <div class="group"><span class="label">Key</span>
      <button type="button" class="icon-btn" data-action="semi" data-d="-1" aria-label="Down a semitone">−</button>
      <span class="num" style="min-width:24px;text-align:center">${state.semitones > 0 ? "+" : ""}${state.semitones}</span>
      <button type="button" class="icon-btn" data-action="semi" data-d="1" aria-label="Up a semitone">+</button></div>
    <span class="sep"></span>
    <button type="button" class="btn ${state.click ? "on" : ""}" data-action="toggle-click" title="Click track">${icon("metronome")}<span class="num">${state.bpm.toFixed(1)}</span></button>
    ${beats()}
    <span class="grow"></span>
    <button type="button" class="btn ${state.stageMode ? "on" : ""}" data-action="stage-mode">${icon(state.stageMode ? "minimize-2" : "maximize-2")}${state.stageMode ? "Exit stage" : "Stage mode"}</button>
  </footer>`;
}

function app() {
  return `<div class="app">
    <header class="topbar">${brand()}
      <div class="import"><div class="field-wrap">${icon("link")}<input class="field" placeholder="Paste a YouTube or SoundCloud link, or drop an audio file"></div>
        <button type="button" class="btn primary">${icon("audio-waveform")}Extract stems</button></div>
      <div class="right"><button type="button" class="icon-btn" title="Help">${icon("info")}</button></div>
    </header>
    <div class="body ${state.stageMode ? "stage-mode" : ""}">${state.stageMode ? stage() : library() + tracks() + inspector()}</div>
    ${transport()}
  </div>`;
}

// ─── drawing ───────────────────────────────────────────────────────────────

function render() {
  if (!LOOKS[state.look]) state.look = "console";
  document.body.dataset.look = state.look;
  if (!PALETTES[state.palette]) state.palette = "ink-coral";
  document.body.dataset.palette = state.palette;
  $("#app").innerHTML = app();
  $("#protoLabel").textContent = PALETTES[state.palette];
  requestAnimationFrame(() => { drawWaves(); tick(); });
}

function drawWaves() {
  const d = song().dur;
  const w0 = look().wave;
  const playedFrac = state.t / d;
  $$("canvas[data-wave]").forEach((cv) => {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    const id = cv.dataset.wave;
    const color = id === "mix" ? cssVar("--text-2") : cssVar(`--${id}`);
    const k = STEMS.findIndex((s) => s.id === id) + 2;
    const step = w0.bar + w0.gap;
    const pad = 6;
    for (let x = 0; x < w; x += step) {
      const t = (x / w) * d;
      const env = id === "mix" ? 0.3 + 0.45 * Math.max(...STEMS.map((s) => envelope(s.id, t))) : envelope(id, t);
      let a = Math.max(0, env * (0.5 + 0.5 * hash(x, k)));
      if (w0.steps) a = Math.round(a * w0.steps) / w0.steps;
      const half = a * (h / 2 - pad);
      ctx.globalAlpha = x / w <= playedFrac ? 1 : 0.55;
      ctx.fillStyle = color;
      if (half < 0.75) { ctx.fillRect(x, h / 2 - 0.5, w0.bar, 1); continue; }
      if (w0.round && ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, h / 2 - half, w0.bar, half * 2, w0.round);
        ctx.fill();
      } else ctx.fillRect(x, h / 2 - half, w0.bar, half * 2);
    }
    ctx.globalAlpha = 1;
    if (state.grid) drawGrid(ctx, w, h, d);
  });
}

function drawGrid(ctx, w, h, d) {
  const pxBeat = (w * beatLen()) / d;
  const showBeats = pxBeat >= MIN_LINE_PX;
  const barEvery = Math.max(1, Math.ceil(MIN_LINE_PX / (pxBeat * BEATS_PER_BAR)));
  const strong = cssVar("--accent");
  const dots = state.look === "instrument";
  for (let n = Math.floor(-state.anchor / beatLen()) - 1; beatTimeAt(n) <= d; n++) {
    const t = beatTimeAt(n);
    if (t < 0) continue;
    const isBar = ((n % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
    const bar = Math.floor(n / BEATS_PER_BAR);
    if (!isBar && !showBeats) continue;
    if (isBar && !showBeats && bar % barEvery !== 0) continue;
    const x = Math.round((t / d) * w) + 0.5;
    const phrase = isBar && bar % 4 === 0;
    if (dots) {
      ctx.fillStyle = phrase ? strong : "rgba(255,255,255,.22)";
      for (let y = 3; y < h; y += 6) ctx.fillRect(x - 0.5, y, phrase ? 2 : 1, phrase ? 2 : 1);
      continue;
    }
    ctx.strokeStyle = phrase ? strong : isBar ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.05)";
    ctx.globalAlpha = phrase ? 0.4 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

let lastBeat = null;
let audioCtx = null;
let lastWaveRedraw = 0;

function blip(down) {
  if (!state.click) return;
  audioCtx = audioCtx || new AudioContext();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = down ? 1500 : 1000;
  g.gain.setValueAtTime(state.clickVol * 0.4, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.06);
}

function tick() {
  const d = song().dur;
  const frac = state.t / d;
  $$("[data-playhead]").forEach((p) => { p.style.left = `${frac * 100}%`; });
  $$("[data-time]").forEach((el) => { el.textContent = fmt(state.t); });
  const n = beatIndexAt(state.t);
  const pos = ((n % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  $$("[data-beats]").forEach((b) => [...b.children].forEach((dot, i) => {
    dot.classList.toggle("on", i === pos);
    dot.classList.toggle("down", i === 0);
  }));
  $$("[data-barbeat]").forEach((el) => { el.textContent = `${String(Math.floor(n / BEATS_PER_BAR) + 1).padStart(3, " ")}.${pos + 1}`; });
  const [, , end] = currentSection();
  $$("[data-next-in]").forEach((el) => { el.textContent = `${Math.max(0, Math.ceil((end - state.t) / (beatLen() * BEATS_PER_BAR)))} bars`; });
  $$("[data-meter]").forEach((m) => {
    const id = m.dataset.meter;
    const lvl = state.playing && audible(id) ? envelope(id, state.t) * state.stems[id].vol * 1.25 * (0.75 + 0.25 * Math.random()) : 0;
    const lit = Math.round(lvl * METER_SEGMENTS);
    [...m.children].forEach((seg, i) => {
      seg.className = i < lit ? `on${i >= METER_SEGMENTS - 2 ? " clip" : i >= METER_SEGMENTS - 4 ? " hot" : ""}` : "";
    });
  });
  if (state.playing && lastBeat !== null && n !== lastBeat) blip(pos === 0);
  lastBeat = n;
}

let lastFrame = 0;
let lastSection = null;

function loop(ts) {
  if (state.playing) {
    state.t += (lastFrame ? (ts - lastFrame) / 1000 : 0) * state.speed;
    const sec = currentSection();
    if (state.loop && state.t >= sec[2]) state.t = sec[1];
    if (state.t >= song().dur) advance();
    else if (state.stageMode && sec !== lastSection) render();
    else {
      tick();
      if (ts - lastWaveRedraw > 500) { drawWaves(); lastWaveRedraw = ts; }
    }
    lastSection = sec;
  }
  lastFrame = ts;
  requestAnimationFrame(loop);
}

// ─── actions ───────────────────────────────────────────────────────────────

function load(id) {
  state.songId = id;
  state.bpm = song().bpm;
  state.t = 0;
  state.playing = true;
  render();
}

function advance() {
  if (!state.queue.length) { state.playing = false; state.t = 0; render(); return; }
  load(state.queue.shift());
}

function startRename(el) {
  const s = song(Number(el.dataset.id));
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = s.title;
  input.setAttribute("aria-label", "Song title");
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim()) s.title = input.value.trim();
    render();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
}

function tap() {
  const now = performance.now();
  state.taps = state.taps.filter((x) => now - x < TAP_RESET_MS).concat(now);
  if (state.taps.length >= 2) {
    const iv = (state.taps[state.taps.length - 1] - state.taps[0]) / (state.taps.length - 1);
    state.bpm = Math.round((60000 / iv) * 10) / 10;
  }
}

function cycleLook(dir) {
  const keys = Object.keys(PALETTES);
  state.palette = keys[(keys.indexOf(state.palette) + dir + keys.length) % keys.length];
  const url = new URL(location.href);
  url.searchParams.set("look", state.look);
  url.searchParams.set("palette", state.palette);
  history.replaceState(null, "", url);
}

const ACTIONS = {
  "look-prev": () => cycleLook(-1),
  "look-next": () => cycleLook(1),
  "toggle-play": () => { state.playing = !state.playing; },
  restart: () => { state.t = 0; },
  next: advance,
  seek: (el) => { state.t = Number(el.dataset.t); },
  "toggle-loop": () => { state.loop = !state.loop; },
  speed: (el) => { state.speed = Number(el.dataset.v); },
  semi: (el) => { state.semitones = Math.max(-6, Math.min(6, state.semitones + Number(el.dataset.d))); },
  mute: (el) => { const s = state.stems[el.dataset.stem]; s.m = !s.m; },
  solo: (el) => { const s = state.stems[el.dataset.stem]; s.s = !s.s; },
  "toggle-click": () => { state.click = !state.click; },
  "toggle-grid": () => { state.grid = !state.grid; },
  "tempo-mode": (el) => { state.tempoMode = el.dataset.v; },
  "bpm-step": (el) => { state.bpm = Math.round((state.bpm + Number(el.dataset.d) * BPM_STEP) * 10) / 10; },
  "bpm-mult": (el) => { state.bpm = Math.round(state.bpm * Number(el.dataset.m) * 10) / 10; },
  tap,
  "set-downbeat": () => { const bar = beatLen() * BEATS_PER_BAR; state.anchor = ((state.t % bar) + bar) % bar; },
  nudge: (el) => { state.anchor = Math.round((state.anchor + Number(el.dataset.d) * NUDGE_S) * 1000) / 1000; },
  "count-in": (el) => { state.countIn = el.dataset.v; },
  "play-song": (el) => load(Number(el.dataset.id)),
  "play-next": (el) => { state.queue.unshift(Number(el.dataset.id)); },
  "queue-add": (el) => { state.queue.push(Number(el.dataset.id)); },
  "queue-play": (el) => { const i = Number(el.dataset.i); const id = state.queue[i]; state.queue.splice(0, i + 1); load(id); },
  "clear-queue": () => { state.queue = []; },
  "save-queue": () => { SETLISTS.push({ id: `s${SETLISTS.length + 1}`, name: `Setlist ${SETLISTS.length + 1}`, songs: [state.songId, ...state.queue] }); state.libTab = "setlists"; },
  "play-setlist": (el) => { const sl = SETLISTS.find((x) => x.id === el.dataset.sid); state.queue = sl.songs.slice(1); load(sl.songs[0]); },
  "new-setlist": () => { SETLISTS.push({ id: `s${SETLISTS.length + 1}`, name: `New setlist ${SETLISTS.length + 1}`, songs: [] }); },
  "lib-tab": (el) => { state.libTab = el.dataset.v; },
  tab: (el) => { state.tab = el.dataset.v; },
  fav: () => { song().fav = !song().fav; },
  "stage-mode": () => { state.stageMode = !state.stageMode; },
};

const SELF_RENDERING = new Set(["play-song", "queue-play", "play-setlist", "next"]);

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "rename") { startRename(el); return; }
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  if (el.closest(".actions")) e.stopPropagation();
  fn(el);
  if (!SELF_RENDERING.has(el.dataset.action)) render();
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.input === "vol") {
    const v = Number(el.value);
    state.stems[el.dataset.stem].vol = v;
    el.style.setProperty("--p", `${v * 100}%`);
    $$(`[data-db="${el.dataset.stem}"]`).forEach((x) => { x.textContent = toDb(v); });
  } else if (el.dataset.input === "click-vol") {
    state.clickVol = Number(el.value);
    el.style.setProperty("--p", `${state.clickVol * 100}%`);
  } else if (el.dataset.input === "q") {
    state.q = el.value;
    const list = $("[data-list]");
    const pos = el.selectionStart;
    render();
    const again = $("[data-input='q']");
    again.focus();
    again.setSelectionRange(pos, pos);
    if (!list) return;
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.input !== "bpm") return;
  const v = Number(e.target.value);
  if (v > 20 && v < 300) state.bpm = v;
  render();
});

let knobDrag = null;
document.addEventListener("pointerdown", (e) => {
  const knob = e.target.closest("[data-knob]");
  if (knob) {
    knobDrag = { id: knob.dataset.knob, y: e.clientY, v: state.stems[knob.dataset.knob].vol, el: knob };
    knob.setPointerCapture(e.pointerId);
    return;
  }
  const area = e.target.closest(".wave, .overview");
  if (!area) return;
  const r = area.getBoundingClientRect();
  state.t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * song().dur;
  drawWaves();
  tick();
});
document.addEventListener("pointermove", (e) => {
  if (!knobDrag) return;
  const v = Math.max(0, Math.min(1, knobDrag.v + (knobDrag.y - e.clientY) / KNOB_DRAG_PX));
  state.stems[knobDrag.id].vol = v;
  knobDrag.el.innerHTML = knobArt(v);
  $$(`[data-db="${knobDrag.id}"]`).forEach((x) => { x.textContent = toDb(v); });
});
document.addEventListener("pointerup", () => { knobDrag = null; });

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, [contenteditable]")) return;
  if (e.key === "ArrowLeft" && e.altKey) { cycleLook(-1); render(); }
  else if (e.key === "ArrowRight" && e.altKey) { cycleLook(1); render(); }
  else if (e.key === " ") { e.preventDefault(); state.playing = !state.playing; render(); }
  else if (e.key === "f") { state.stageMode = !state.stageMode; render(); }
});

window.addEventListener("resize", drawWaves);
document.fonts.ready.then(render);
render();
requestAnimationFrame(loop);
