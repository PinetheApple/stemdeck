// PROTOTYPE - throwaway. Shared data, fake playback and components for the layout mockups.
import { ICONS } from '/prototype/icons.js';

const EXTRA = {
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  minus: '<path d="M5 12h14"/>',
  'panel-left': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  'panel-right': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  square: '<rect width="16" height="16" x="4" y="4" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  text: '<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
};

export const icon = (name, size = 16, cls = '') =>
  `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || EXTRA[name] || ''}</svg>`;

export const STEMS = [
  { id: 'vocals', name: 'Vocals' },
  { id: 'drums', name: 'Drums' },
  { id: 'bass', name: 'Bass' },
  { id: 'guitar', name: 'Guitar' },
  { id: 'piano', name: 'Piano' },
  { id: 'other', name: 'Other' },
];
const SECTION_PLAN = [['Intro', 0.06, 0.35], ['Verse 1', 0.13, 0.6], ['Chorus', 0.12, 1], ['Verse 2', 0.12, 0.65], ['Chorus', 0.12, 1], ['Bridge', 0.17, 0.85], ['Chorus', 0.14, 1], ['Outro', 0.14, 0.4]];
const FALLBACK_SONGS = ['Morning Light', 'Open Sky', 'Steady Ground', 'Harbour', 'Northern Road', 'Quiet Fire', 'Every Season', 'Clear Water'].map((title, i) => ({
  id: 'demo' + i, title, artist: 'Demo Band', dur: 220 + i * 17, bpm: 72 + i * 9, key: ['C maj', 'G maj', 'D maj', 'A min'][i % 4], cover: '', presence: null,
}));
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BARS = 220;
const SPEED_STEP = 0.05;
const PRESETS = {
  full: () => [],
  minus: () => [S.mine],
  only: () => STEMS.map(s => s.id).filter(id => id !== S.mine),
  vocals: () => STEMS.map(s => s.id).filter(id => id !== 'vocals'),
};

export const S = { songs: [], song: null, sections: [], lyrics: [], env: {}, playing: false, t: 0, speed: 1, key: 0, click: false, countIn: false, loop: null, mine: 'guitar', stems: {}, tabs: {}, secIdx: -1, lyIdx: -2 };
STEMS.forEach(s => { S.stems[s.id] = { mute: false, solo: false, vol: 0.8 }; });

let rerender = () => {};
const $$ = sel => document.querySelectorAll(sel);
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const hash = str => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSections(song) {
  let at = 0;
  return SECTION_PLAN.map(([name, share, energy]) => {
    const sec = { name, a: at, b: at + share * song.dur, share, energy };
    at = sec.b;
    return sec;
  });
}

function buildEnv(song, sections) {
  const env = {};
  STEMS.forEach((stem, si) => {
    const rand = rng(hash(song.id) + si * 97);
    const presence = (song.presence?.[stem.id] ?? 70) / 100;
    const active = sections.map(sec => sec.energy > 0.9 ? presence > 0.1 : rand() < 0.3 + presence * 0.7);
    env[stem.id] = Array.from({ length: BARS }, (_, i) => {
      const k = sections.findIndex(sec => ((i + 0.5) / BARS) * song.dur < sec.b);
      const sec = sections[k < 0 ? sections.length - 1 : k];
      return active[sections.indexOf(sec)] ? sec.energy * (0.45 + 0.55 * presence) * (0.5 + 0.5 * rand()) : 0.03 + 0.04 * rand();
    });
  });
  env.mix = Array.from({ length: BARS }, (_, i) => clamp(STEMS.reduce((sum, s) => sum + env[s.id][i], 0) / 3.2, 0.04, 1));
  return env;
}

async function loadSongs() {
  try {
    const jobs = await (await fetch('/api/jobs')).json();
    const list = jobs.filter(j => j.status === 'done' && !j.trashed_at).map(j => ({
      id: j.job_id, title: j.title || 'Untitled', artist: j.display_artist || '', dur: j.duration || 240,
      bpm: Math.round(j.bpm || 120), key: j.key || '', cover: j.thumbnail || '', presence: j.stem_presence,
    }));
    if (list.length) return list;
  } catch { /* offline: demo data */ }
  return FALLBACK_SONGS;
}

async function loadLyrics(song, sections) {
  try {
    const res = await fetch('/api/jobs/' + song.id + '/lyrics');
    if (res.ok) {
      const lines = ((await res.json()).synced || '').split('\n').map(line => {
        const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
        return m && { t: m[1] * 60 + Number(m[2]), text: m[3].replace(/<[^>]*>/g, '').trim() };
      }).filter(l => l && l.text);
      if (lines.length) return lines;
    }
  } catch { /* fall through to placeholders */ }
  return sections.flatMap(sec => [0, 1, 2, 3].map(n => ({ t: sec.a + (n * (sec.b - sec.a)) / 4, text: sec.name + ' lyric line ' + (n + 1) })));
}

export const audible = id => {
  const anySolo = STEMS.some(s => S.stems[s.id].solo);
  return anySolo ? S.stems[id].solo : !S.stems[id].mute;
};
const level = (id, si) => {
  if (!S.playing || !audible(id)) return 0;
  const i = clamp(Math.floor((S.t / S.song.dur) * BARS), 0, BARS - 1);
  return clamp(S.env[id][i] * (0.4 + S.stems[id].vol) * (0.7 + 0.3 * Math.abs(Math.sin(S.t * 9 + si * 2))), 0, 1);
};
const keyName = () => {
  const m = (S.song.key || '').match(/^([A-G]#?)\s*(.*)$/);
  if (!m) return '';
  return NOTES[(NOTES.indexOf(m[1]) + S.key + 120) % 12] + ' ' + m[2];
};
const activePreset = () => Object.keys(PRESETS).find(name => {
  const muted = PRESETS[name]();
  return STEMS.every(s => S.stems[s.id].mute === muted.includes(s.id) && !S.stems[s.id].solo);
});

async function setSong(song) {
  S.song = song;
  S.sections = buildSections(song);
  S.env = buildEnv(song, S.sections);
  S.t = 0; S.loop = null; S.secIdx = -1; S.lyIdx = -2; S.lyrics = [];
  rerender(); syncAll();
  S.lyrics = await loadLyrics(song, S.sections);
  rerender(); syncAll();
}

const ACT = {
  noop() {},
  play() { S.playing = !S.playing; },
  stop() { S.playing = false; S.t = S.loop ? S.loop.a : 0; },
  mute(id) { S.stems[id].mute = !S.stems[id].mute; },
  solo(id) { S.stems[id].solo = !S.stems[id].solo; },
  mine(id) { S.mine = id; hidePops(); },
  preset(name) { const muted = PRESETS[name](); STEMS.forEach(s => { S.stems[s.id].mute = muted.includes(s.id); S.stems[s.id].solo = false; }); },
  sec(i) { S.t = S.sections[i].a + 0.01; },
  loopsec(i) { const sec = S.sections[i]; S.loop = S.loop && S.loop.i === Number(i) ? null : { i: Number(i), a: sec.a, b: sec.b }; },
  loop() { ACT.loopsec(S.loop ? S.loop.i : Math.max(0, S.secIdx)); },
  line(i) { S.t = S.lyrics[i].t; },
  speed(d) { S.speed = clamp(Math.round((S.speed + d * SPEED_STEP) * 100) / 100, 0.5, 1.5); },
  key(d) { S.key = clamp(S.key + Number(d), -6, 6); },
  toggle(k) { S[k] = !S[k]; },
  song(id) { hidePops(); setSong(S.songs.find(s => s.id === id)); },
  next() { ACT.song(S.songs[(S.songs.indexOf(S.song) + 1) % S.songs.length].id); },
  pop(name) { const el = document.querySelector('[data-pop="' + name + '"]'); const show = el.hidden; hidePops(); el.hidden = !show; },
  tab(group, name) { S.tabs[group] = name; },
  flip(group) { S.tabs[group] = S.tabs[group] === 'off' ? 'on' : 'off'; },
  palette(name) { document.documentElement.dataset.palette = name; localStorage.setItem('mock-palette', name); },
  font(name) { document.documentElement.dataset.font = name; localStorage.setItem('mock-font', name); },
  wash() { const root = document.documentElement; root.dataset.wash = root.dataset.wash === 'off' ? 'on' : 'off'; localStorage.setItem('mock-wash', root.dataset.wash); },
};
const hidePops = () => $$('[data-pop]').forEach(el => { el.hidden = true; });

function syncTick() {
  const root = document.documentElement;
  const pn = S.t / S.song.dur;
  root.style.setProperty('--p', (pn * 100).toFixed(3) + '%');
  root.style.setProperty('--pn', pn.toFixed(5));
  $$('[data-b="time"]').forEach(el => { el.textContent = fmt(S.t); });
  STEMS.forEach((s, si) => { const lvl = level(s.id, si).toFixed(3); $$('[data-stem="' + s.id + '"]').forEach(el => el.style.setProperty('--lvl', lvl)); });
  const beat = Math.floor((S.t * S.song.bpm) / 60) % 4;
  $$('[data-beat]').forEach(el => el.classList.toggle('is-on', S.playing && Number(el.dataset.beat) === beat));
  const secIdx = S.sections.findIndex(sec => S.t < sec.b);
  if (secIdx !== S.secIdx) { S.secIdx = secIdx; syncSection(); }
  const sec = S.sections[Math.max(0, S.secIdx)];
  $$('[data-b="bars"]').forEach(el => { el.textContent = Math.max(1, Math.ceil(((sec.b - S.t) * S.song.bpm) / 240)); });
  let lyIdx = -1;
  S.lyrics.forEach((l, i) => { if (l.t <= S.t) lyIdx = i; });
  if (lyIdx !== S.lyIdx) { S.lyIdx = lyIdx; syncLyrics(); }
}

function syncSection() {
  const cur = S.sections[Math.max(0, S.secIdx)];
  const next = S.sections[S.secIdx + 1];
  $$('[data-sec]').forEach(el => {
    el.classList.toggle('is-current', Number(el.dataset.sec) === S.secIdx);
    el.classList.toggle('is-looped', !!S.loop && S.loop.i === Number(el.dataset.sec));
  });
  $$('[data-b="secname"]').forEach(el => { el.textContent = cur.name; });
  $$('[data-b="nextsec"]').forEach(el => { el.textContent = S.loop && S.loop.i === S.secIdx ? cur.name + ' again' : next ? next.name : 'End'; });
}

function syncLyrics() {
  const text = i => (S.lyrics[i] ? S.lyrics[i].text : '');
  $$('[data-b="ly-prev"]').forEach(el => { el.textContent = text(S.lyIdx - 1); });
  $$('[data-b="ly-cur"]').forEach(el => { el.textContent = text(S.lyIdx) || (S.lyrics.length ? '· · ·' : ''); });
  $$('[data-b="ly-next"]').forEach(el => { el.textContent = text(S.lyIdx + 1); });
  $$('[data-li]').forEach(el => {
    const i = Number(el.dataset.li);
    el.classList.toggle('is-current', i === S.lyIdx);
    el.classList.toggle('is-past', i < S.lyIdx);
    if (i === S.lyIdx) el.parentElement.parentElement.scrollTo({ top: el.offsetTop - el.parentElement.parentElement.clientHeight / 2, behavior: 'smooth' });
  });
}

export function syncAll() {
  if (!S.song) return;
  const root = document.documentElement;
  root.style.setProperty('--cover', S.song.cover ? 'url("' + S.song.cover + '")' : 'linear-gradient(135deg, var(--surface-4), var(--surface-2))');
  if (S.loop) { root.dataset.loop = '1'; root.style.setProperty('--la', (S.loop.a / S.song.dur) * 100 + '%'); root.style.setProperty('--lw', ((S.loop.b - S.loop.a) / S.song.dur) * 100 + '%'); } else delete root.dataset.loop;
  const texts = {
    title: S.song.title, artist: S.song.artist, dur: fmt(S.song.dur), bpm: Math.round(S.song.bpm * S.speed) + ' BPM',
    speed: S.speed.toFixed(2) + '×', key: (S.key > 0 ? '+' : '') + S.key, keyname: keyName(),
    loopname: S.loop ? 'Looping ' + S.sections[S.loop.i].name : 'Loop section',
    minename: STEMS.find(s => s.id === S.mine).name,
    loopshort: S.loop ? S.sections[S.loop.i].name : 'Loop',
  };
  Object.entries(texts).forEach(([k, v]) => $$('[data-b="' + k + '"]').forEach(el => { el.textContent = v; }));
  $$('[data-playicon]').forEach(el => { el.innerHTML = icon(S.playing ? 'pause' : 'play', Number(el.dataset.playicon) || 22, 'ic--fill'); });
  STEMS.forEach(s => $$('[data-stem="' + s.id + '"]').forEach(el => {
    el.classList.toggle('is-off', !audible(s.id));
    el.classList.toggle('is-m', S.stems[s.id].mute);
    el.classList.toggle('is-solo', S.stems[s.id].solo);
    el.classList.toggle('is-mine', S.mine === s.id);
    el.style.setProperty('--vol', S.stems[s.id].vol);
  }));
  $$('[data-vol]').forEach(el => { el.value = S.stems[el.dataset.vol].vol; });
  const on = { click: S.click, countIn: S.countIn, loop: !!S.loop, playing: S.playing };
  $$('[data-on]').forEach(el => el.classList.toggle('is-on', !!on[el.dataset.on]));
  const preset = activePreset();
  $$('[data-preset]').forEach(el => el.classList.toggle('is-on', el.dataset.preset === preset));
  $$('[data-songrow]').forEach(el => el.classList.toggle('is-current', el.dataset.songrow === S.song.id));
  $$('[data-tabbtn]').forEach(el => { const [g, n] = el.dataset.tabbtn.split(':'); el.classList.toggle('is-on', (S.tabs[g] || el.dataset.default) === n); });
  $$('[data-tabpanel]').forEach(el => { const [g, n] = el.dataset.tabpanel.split(':'); el.hidden = (S.tabs[g] || el.dataset.default) !== n; });
  Object.entries(S.tabs).forEach(([k, v]) => { root.dataset['tab' + k] = v; });
  $$('[data-act^="flip:"]').forEach(el => { const on = S.tabs[el.dataset.act.slice(5)] !== 'off'; el.classList.toggle('is-on', on); el.setAttribute('aria-pressed', on); });
  $$('[data-pal]').forEach(el => el.classList.toggle('is-on', (root.dataset.palette || 'coral') === el.dataset.pal));
  $$('[data-fnt]').forEach(el => el.classList.toggle('is-on', (root.dataset.font || 'manrope') === el.dataset.fnt));
  $$('[data-washbtn]').forEach(el => el.classList.toggle('is-on', root.dataset.wash !== 'off'));
  syncSection(); syncLyrics(); syncTick();
}

let last = 0;
function frame(ts) {
  const dt = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  if (S.playing && S.song) {
    S.t += dt * S.speed;
    if (S.loop && S.t >= S.loop.b) S.t = S.loop.a;
    if (S.t >= S.song.dur) { S.t = 0; S.playing = false; syncAll(); }
    syncTick();
  }
  requestAnimationFrame(frame);
}

export async function boot(render) {
  const root = document.documentElement;
  root.dataset.palette = localStorage.getItem('mock-palette') || 'coral';
  root.dataset.wash = localStorage.getItem('mock-wash') || 'on';
  root.dataset.font = localStorage.getItem('mock-font') || 'manrope';
  rerender = () => { document.getElementById('app').innerHTML = render(); };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!e.target.closest('.pop') && !(el && el.dataset.act.startsWith('pop:'))) hidePops();
    if (!el) return;
    const [name, ...args] = el.dataset.act.split(':');
    if (name === 'seek') { const r = el.getBoundingClientRect(); S.t = clamp((e.clientX - r.left) / r.width, 0, 0.999) * S.song.dur; } else ACT[name](...args);
    syncAll();
  });
  document.addEventListener('input', e => { if (e.target.dataset.vol) { S.stems[e.target.dataset.vol].vol = Number(e.target.value); syncAll(); } });
  document.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); ACT.play(); syncAll(); } });
  S.songs = await loadSongs();
  await setSong(S.songs.find(s => /break open/i.test(s.title)) || S.songs[0]);
  requestAnimationFrame(frame);
}

// ── Components ──────────────────────────────────────────────────────────────

export const mockbar = active => `<div class="mockbar">
  ${[['index', 'Overview'], ['a', 'A · Pads'], ['b', 'B · Lanes'], ['c', 'C · Focus'], ['stage', 'Stage']].map(([f, label]) => `<a href="${f}.html" class="${f === active ? 'is-on' : ''}">${label}</a>`).join('')}
  <div class="sp"></div><span>palette</span>
  ${[['coral', 'Ink & coral'], ['ice', 'Ink & ice'], ['dusk', 'Dusk & coral']].map(([p, label]) => `<button data-act="palette:${p}" data-pal="${p}">${label}</button>`).join('')}
  <span>font</span>
  ${[["manrope","Manrope"],["inter","Inter"],["geist","Geist"],["figtree","Figtree"],["dm-sans","DM Sans"],["plus-jakarta-sans","Jakarta"],["bricolage-grotesque","Bricolage"]].map(([f, label]) => `<button data-act="font:${f}" data-fnt="${f}">${label}</button>`).join('')}
  <span></span><button data-act="wash" data-washbtn>wash</button>
</div>`;

export const logo = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 10v4M7.5 6v12M12 3v18M16.5 7v10M21 10v4"/></svg>';
const smallCover = url => url.replace('maxresdefault', 'mqdefault');
const coverStyle = song => (song.cover ? `style="background-image:url('${smallCover(song.cover)}')"` : '');

export const addPop = () => `<div class="pop add" data-pop="add" hidden>
  <h3>Add a song</h3>
  <div class="field">${icon('link')} Paste a YouTube link or playlist…</div>
  <div class="drop">${icon('upload', 20)}<br>Drop audio files or a folder here, or <u>choose files</u></div>
  <div><div class="lbl" style="margin-bottom:8px">Stems to extract</div>
    <div class="chips"><span class="chip" style="--c:var(--text)">All 6</span>${STEMS.map(s => `<span class="chip" style="--c:var(--${s.id})">${s.name}</span>`).join('')}</div></div>
  <div style="display:flex;align-items:center;gap:10px"><span class="dim" style="font-size:12.5px">Detect song sections (experimental)</span><div class="sp"></div><button class="btn btn--accent">Extract stems</button></div>
</div>`;

export const toolsPop = () => `<div class="pop menu" data-pop="tools" hidden>
  <button>${icon('metronome')} Tempo and click track…</button>
  <button>${icon('sliders-horizontal')} EQ and mastering…</button>
  <button>${icon('info')} Song details and analysis…</button>
  <button>${icon('pencil')} Edit sections…</button>
  <hr>
  <button>${icon('audio-waveform')} Extract more stems…</button>
  <button>${icon('download')} Export mix…</button>
</div>`;

export const minePop = () => `<div class="pop menu" data-pop="mine" hidden style="right:auto;left:0">
  ${STEMS.map(s => `<button data-act="mine:${s.id}"><span style="width:10px;height:10px;border-radius:50%;background:var(--${s.id})"></span> ${s.name}</button>`).join('')}
</div>`;

export const topbar = (extra = '') => `<header class="topbar">
  <div class="brand">${logo} StemDeck</div>
  ${extra}
  <div class="sp"></div>
  <div class="anchor"><button class="btn" data-act="pop:add">${icon('plus')} Add song</button>${addPop()}</div>
  <button class="iconbtn" title="Alerts">${icon('bell', 18)}</button>
  <button class="iconbtn" title="Guide">${icon('help', 18)}</button>
  <button class="iconbtn" title="Settings">${icon('settings', 18)}</button>
</header>`;

export const songRow = (song, size = 40) => `<button class="row" data-act="song:${song.id}" data-songrow="${song.id}">
  <div class="cover" style="width:${size}px;height:${size}px;${song.cover ? `background-image:url('${smallCover(song.cover)}')` : ''}"></div>
  <div class="row__txt"><div class="row__t ell">${song.title}</div><div class="row__s ell">${song.artist} · ${fmt(song.dur)}</div></div>
</button>`;

export const library = () => `<aside class="lib">
  <div class="lib__top">
    <div class="search">${icon('search')} Search library <kbd>Ctrl K</kbd></div>
    <div class="seg"><button class="is-on">Songs ${S.songs.length}</button><button>Setlists 1</button><button>${icon('heart', 13)}</button></div>
  </div>
  <div class="lib__list">
    <div class="group">${icon('folder', 13)} Unsorted <div class="sp"></div>${S.songs.length}</div>
    ${S.songs.map(s => songRow(s)).join('')}
  </div>
  <div class="lib__foot"><button class="btn btn--quiet">${icon('folder')} New folder</button><button class="btn btn--quiet">${icon('trash-2')} Trash</button></div>
</aside>`;

export const songHead = (actions = '') => `<div class="head">
  <div class="cover cover--now" style="width:64px;height:64px;border-radius:12px"></div>
  <div class="head__txt"><div class="head__title ell" data-b="title"></div>
    <div class="head__meta"><span class="ell" data-b="artist"></span><span class="tag" data-b="keyname"></span><span class="tag" data-b="bpm"></span><span class="tag" data-b="dur"></span></div></div>
  <button class="iconbtn" title="Favourite">${icon('heart', 18)}</button>
  <button class="iconbtn" title="Add to Up Next">${icon('list-plus', 18)}</button>
  <div class="anchor"><button class="btn" data-act="pop:tools">${icon('sliders-horizontal')} Song tools ${icon('chevron-down', 14)}</button>${toolsPop()}</div>
  ${actions}
  <a class="btn" href="stage.html">${icon('maximize-2')} Stage mode</a>
</div>`;

export const sectionsBar = () => `<div class="secs">${S.sections.map((sec, i) => `<div class="sec" role="button" data-sec="${i}" data-act="sec:${i}" style="--w:${sec.share * 100}" title="Jump to ${sec.name}">
  <span class="ell">${sec.name}</span><span class="sec__t mono">${fmt(sec.a)}</span><button class="sec__loop" data-act="loopsec:${i}" title="Loop ${sec.name}">${icon('repeat', 13)}</button></div>`).join('')}</div>`;

export function wave(id, opts = {}) {
  const bars = opts.bars || BARS;
  const src = S.env[id] || [];
  const rects = Array.from({ length: bars }, (_, i) => {
    const h = Math.max(2, src[Math.floor((i / bars) * BARS)] * 96);
    return `<rect x="${i + 0.2}" y="${(50 - h / 2).toFixed(1)}" width="0.6" height="${h.toFixed(1)}" rx="0.3"/>`;
  }).join('');
  const svg = cls => `<svg class="${cls}" viewBox="0 0 ${bars} 100" preserveAspectRatio="none" fill="currentColor">${rects}</svg>`;
  return `<div class="wave" data-act="seek" ${id === 'mix' ? '' : `style="--c:var(--${id})"`}>${svg('wave__base')}${svg('wave__played')}${opts.loop ? '<div class="loopreg"></div>' : ''}${opts.playhead === false ? '' : '<div class="playhead"></div>'}</div>`;
}

export const overview = () => `<div class="ov">${sectionsBar()}<div class="ov__wave">${wave('mix', { loop: true })}</div></div>`;

const stepper = (label, key, valueBind) => `<div class="step"><span class="step__label">${label}</span>
  <button data-act="${key}:-1" title="${label} down">${icon('minus', 14)}</button><span class="step__val mono" data-b="${valueBind}"></span><button data-act="${key}:1" title="${label} up">${icon('plus', 14)}</button></div>`;

export const practice = () => `<div class="tp-practice">
  <button class="tgl" data-on="loop" data-act="loop">${icon('repeat')} <span data-b="loopname"></span></button>
  ${stepper('Speed', 'speed', 'speed')}${stepper('Key', 'key', 'key')}
  <button class="tgl" data-on="click" data-act="toggle:click">${icon('metronome')} Click</button>
  <button class="tgl" data-on="countIn" data-act="toggle:countIn">${icon('timer')} Count-in</button>
</div>`;

export const transport = () => `<footer class="transport">
  <div class="tp-now"><div class="cover cover--now" style="width:48px;height:48px"></div>
    <div class="row__txt"><div class="row__t ell" data-b="title"></div><div class="row__s ell"><span data-b="secname"></span> · next <span data-b="nextsec"></span></div></div></div>
  <div class="tp-main">
    <button class="iconbtn" data-act="stop" title="Stop">${icon('square', 18, 'ic--fill')}</button>
    <button class="playbtn" data-act="play" data-playicon="24" title="Play (Space)"></button>
    <button class="iconbtn" data-act="next" title="Next song">${icon('skip-forward', 18, 'ic--fill')}</button>
    <button class="iconbtn" title="Record a take">${icon('circle', 18)}</button>
    <div class="tp-time mono"><span data-b="time">0:00</span><span class="dim"> / <span data-b="dur"></span></span></div>
  </div>
  ${practice()}
</footer>`;

export const lyricsList = () => (S.lyrics.length
  ? `<div class="ly">${S.lyrics.map((l, i) => `<p data-li="${i}" data-act="line:${i}">${l.text}</p>`).join('')}</div>`
  : '<div class="empty">Loading lyrics…</div>');

export const queueList = () => `<div class="group">Now playing</div>${songRow(S.song, 44)}
  <div class="group">Up next <div class="sp"></div><button class="btn btn--quiet" style="height:26px;padding:0 8px;font-size:12px;text-transform:none;letter-spacing:0">Save as setlist</button></div>
  ${S.songs.filter(s => s !== S.song).slice(0, 4).map(s => songRow(s, 44)).join('')}`;

export const sidePanel = () => `<aside class="side">
  <div class="tabs"><button data-act="tab:side:lyrics" data-tabbtn="side:lyrics" data-default="lyrics">${icon('text', 14)} Lyrics</button>
    <button data-act="tab:side:queue" data-tabbtn="side:queue" data-default="lyrics">${icon('list-music', 14)} Up Next</button></div>
  <div class="panel" data-tabpanel="side:lyrics" data-default="lyrics">${lyricsList()}</div>
  <div class="panel" data-tabpanel="side:queue" data-default="lyrics" hidden>${queueList()}</div>
</aside>`;

export const presets = () => `<div class="anchor"><button class="pill" data-act="pop:mine">${icon('user', 14)} My part: <b data-b="minename"></b> ${icon('chevron-down', 13)}</button>${minePop()}</div>
  <button class="pill" data-preset="full" data-act="preset:full">Full band</button>
  <button class="pill" data-preset="minus" data-act="preset:minus">Without my part</button>
  <button class="pill" data-preset="only" data-act="preset:only">Only my part</button>
  <button class="pill" data-preset="vocals" data-act="preset:vocals">Vocals only</button>`;

const pToggle = (on, act, ic, label) => `<button class="pseg" data-on="${on}" data-act="${act}">${icon(ic, 18)}<span>${label}</span></button>`;
const pStepper = (label, key) => `<div class="pstep"><button data-act="${key}:-1" title="${label} down">${icon('minus', 14)}</button>
  <div class="pstep__v"><span>${label}</span><b class="mono" data-b="${key}"></b></div><button data-act="${key}:1" title="${label} up">${icon('plus', 14)}</button></div>`;

export const footerB = () => `<footer class="transport tb">
  <div class="tp-now"><div class="cover cover--now" style="width:52px;height:52px"></div>
    <div class="row__txt"><div class="row__t ell" data-b="title"></div><div class="row__s ell"><span data-b="secname"></span> · next <span data-b="nextsec"></span></div></div></div>
  <div class="tpc">
    <div class="tpc__btns">
      <button class="iconbtn" data-act="stop" title="Back to start">${icon('skip-back', 18, 'ic--fill')}</button>
      <button class="playbtn" data-act="play" data-playicon="20" title="Play (Space)"></button>
      <button class="iconbtn" data-act="next" title="Next song">${icon('skip-forward', 18, 'ic--fill')}</button>
    </div>
    <div class="tpc__seek mono"><span data-b="time">0:00</span><div class="seekbar" data-act="seek"><i></i></div><span data-b="dur"></span></div>
  </div>
  <div class="tpr"><button class="recbtn" title="Record a take"><i></i> Record</button><div class="prac">
    ${pToggle('loop', 'loop', 'repeat', '<span data-b="loopshort"></span>')}
    ${pStepper('Speed', 'speed')}${pStepper('Key', 'key')}
    ${pToggle('click', 'toggle:click', 'metronome', 'Click')}
    ${pToggle('countIn', 'toggle:countIn', 'timer', 'Count-in')}
  </div></div>
</footer>`;

