// PROTOTYPE - throwaway. State, demo data, fake playback and the action registry.
import { clamp } from './ui.js';

export const STEMS = [
  { id: 'vocals', name: 'Vocals' }, { id: 'drums', name: 'Drums' }, { id: 'bass', name: 'Bass' },
  { id: 'guitar', name: 'Guitar' }, { id: 'piano', name: 'Piano' }, { id: 'other', name: 'Other' },
];
const SECTION_PLAN = [['Intro', 0.06, 0.35], ['Verse 1', 0.13, 0.6], ['Chorus', 0.12, 1], ['Verse 2', 0.12, 0.65], ['Chorus', 0.12, 1], ['Bridge', 0.17, 0.85], ['Chorus', 0.14, 1], ['Outro', 0.14, 0.4]];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const BARS = 220;
const SPEED_STEP = 0.05;
const ARM_MS = 4000;
const TOAST_MS = 6000;
const RESTART_AFTER_S = 3;
const DAY_MS = 86400000;
const FAVORITES = 5;
const FOLDER_COLORS = { coral: '#ff6f59', rose: '#ff8fab', green: '#7ddc9a', blue: '#7fb4ff', violet: '#a9a2ff' };
export const folderColor = name => FOLDER_COLORS[name] || 'var(--text-3)';
export const FOLDER_COLOR_NAMES = Object.keys(FOLDER_COLORS);

export const S = {
  songs: [], folders: [], setlists: [], upNext: [], data: {},
  viewId: null, playId: null, playing: false, t: 0,
  speed: 1, slowSpeed: 0.75, key: 0, click: false, countIn: 0, loop: null, loopOn: false,
  mine: 'guitar', stems: {}, secIdx: -1, lyIdx: -2, history: [], histAt: -1, views: [], viewAt: -1, context: { label: 'Library', ids: [] },
  ui: {
    sidebar: true, panel: true, tab: 'lyrics', browse: null, sel: null, menu: null, pop: null, dialog: null,
    guide: false, stage: false, stageMode: 'play', stageMix: true, sectionsShown: true, autoScroll: true,
    offline: false, alerts: false, armed: null, scenario: 'default', error: null, tabArg: null, toast: null,
    lib: { sort: 'added', dir: 'desc', favOnly: false, tempo: '', mode: '', picking: false, picked: [] },
  },
};
STEMS.forEach(s => { S.stems[s.id] = { mute: false, solo: false, vol: 0.8, key: 0 }; });

// ── Action registry ─────────────────────────────────────────────────────────
// A handler gets (ctx, ...args) where ctx = {el, event}. It returns the regions to
// re-render (array), nothing for all of them, or false for none.
export const actions = {};
export const act = (name, fn) => { actions[name] = fn; };
let updater = () => {};
export const setUpdater = fn => { updater = fn; };
export const update = (...regions) => updater(...regions);

// ── Selectors ───────────────────────────────────────────────────────────────
export const song = id => S.songs.find(s => s.id === id);
export const viewSong = () => song(S.viewId);
export const playSong = () => song(S.playId);
export const viewingOther = () => !!S.viewId && !!S.playId && S.viewId !== S.playId;
export const library = () => S.songs.filter(s => !s.trashed);
export const trashed = () => S.songs.filter(s => s.trashed);
export const favorites = () => library().filter(s => s.fav);
export const importing = () => library().filter(s => s.status === 'processing' || s.status === 'queued');
export const playable = s => s && s.status === 'done' && !s.trashed;
export const folder = id => S.folders.find(f => f.id === id);
export const setlist = id => S.setlists.find(l => l.id === id);
export const folderTree = (parent = null, depth = 0) => S.folders.filter(f => f.parent === parent).flatMap(f => [{ ...f, depth }, ...folderTree(f.id, depth + 1)]);
export const armed = key => S.ui.armed === key;

const hash = str => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSections(s) {
  let at = 0;
  return SECTION_PLAN.map(([name, share, energy]) => {
    const sec = { name, a: at, b: at + share * s.dur, share, energy, locked: false };
    at = sec.b;
    return sec;
  });
}

function buildEnv(s, sections) {
  const env = {};
  STEMS.forEach((stem, si) => {
    const rand = rng(hash(s.id) + si * 97);
    const presence = (s.presence?.[stem.id] ?? 70) / 100;
    const active = sections.map(sec => (sec.energy > 0.9 ? presence > 0.1 : rand() < 0.3 + presence * 0.7));
    env[stem.id] = Array.from({ length: BARS }, (_, i) => {
      const k = sections.findIndex(sec => ((i + 0.5) / BARS) * s.dur < sec.b);
      const idx = k < 0 ? sections.length - 1 : k;
      return active[idx] ? sections[idx].energy * (0.45 + 0.55 * presence) * (0.5 + 0.5 * rand()) : 0.03 + 0.04 * rand();
    });
  });
  env.mix = Array.from({ length: BARS }, (_, i) => clamp(STEMS.reduce((sum, st) => sum + env[st.id][i], 0) / 3.2, 0.04, 1));
  return env;
}

async function loadLyrics(s, sections) {
  try {
    const res = await fetch('/api/jobs/' + s.id + '/lyrics');
    if (res.ok) {
      const lines = ((await res.json()).synced || '').split('\n').map(line => {
        const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
        return m && { t: m[1] * 60 + Number(m[2]), text: m[3].replace(/<[^>]*>/g, '').trim() };
      }).filter(l => l && l.text);
      if (lines.length) return lines;
    }
  } catch { /* placeholders below */ }
  return sections.flatMap(sec => [0, 1, 2, 3].map(n => ({ t: sec.a + (n * (sec.b - sec.a)) / 4, text: sec.name + ' lyric line ' + (n + 1) })));
}

/** Sections, waveform envelopes and lyrics of a song; lyrics arrive a moment later. */
export function dataOf(id) {
  if (S.data[id]) return S.data[id];
  const s = song(id);
  const sections = buildSections(s);
  const data = { sections, env: buildEnv(s, sections), lyrics: [], lyricsState: 'loading' };
  S.data[id] = data;
  loadLyrics(s, sections).then(lines => { data.lyrics = lines; data.lyricsState = 'ready'; S.lyIdx = -2; update('panel', 'main', 'stage'); });
  return data;
}

export const audible = id => (STEMS.some(s => S.stems[s.id].solo) ? S.stems[id].solo : !S.stems[id].mute);
export const level = (id, si) => {
  if (!S.playing || !S.playId || !audible(id)) return 0;
  const i = clamp(Math.floor((S.t / playSong().dur) * BARS), 0, BARS - 1);
  return clamp(dataOf(S.playId).env[id][i] * (0.4 + S.stems[id].vol) * (0.7 + 0.3 * Math.abs(Math.sin(S.t * 9 + si * 2))), 0, 1);
};
export const keyName = (s, shift = S.key) => {
  const m = ((s && s.key) || '').match(/^([A-G]#?)\s*(.*)$/);
  return m ? NOTES[(NOTES.indexOf(m[1]) + shift + 120) % 12] + ' ' + m[2] : '';
};
const PRESETS = {
  full: () => [],
  minus: () => [S.mine],
  only: () => STEMS.map(s => s.id).filter(id => id !== S.mine),
};
export const activePreset = () => Object.keys(PRESETS).find(name => {
  const muted = PRESETS[name]();
  return STEMS.every(s => S.stems[s.id].mute === muted.includes(s.id) && !S.stems[s.id].solo);
});

// ── Demo data ───────────────────────────────────────────────────────────────
const DEMO_TITLES = ['Morning Light', 'Open Sky', 'Steady Ground', 'Harbour', 'Northern Road', 'Quiet Fire', 'Every Season', 'Clear Water', 'Paper Boats', 'Low Tide', 'Signal Hill', 'Ember'];
const demoSongs = () => DEMO_TITLES.map((title, i) => ({ id: 'demo' + i, title, artist: 'Demo Band', dur: 220 + i * 17, bpm: 72 + i * 7, key: ['C maj', 'G maj', 'D maj', 'A min'][i % 4], cover: '', presence: null, source: 'https://example.com/watch?v=demo' + i, tags: ['demo'] }));

async function fetchSongs() {
  try {
    const jobs = await (await fetch('/api/jobs')).json();
    const list = jobs.filter(j => j.status === 'done' && !j.trashed_at).map(j => ({
      id: j.job_id, title: j.title || 'Untitled', artist: j.display_artist || '', dur: j.duration || 240, bpm: Math.round(j.bpm || 120),
      key: j.key || '', cover: j.thumbnail || '', presence: j.stem_presence, source: j.source_url || '', tags: j.tags || [], added: (j.created_at || 0) * 1000,
    }));
    if (list.length) return list;
  } catch { /* offline: demo data */ }
  return demoSongs();
}

const IMPORT_ROWS = [
  { id: 'imp1', title: 'Goodness of God (Live)', artist: 'Bethel Music', status: 'processing', progress: 0.42, stage: 'Separating stems' },
  { id: 'imp2', title: 'YouTube link', artist: '', status: 'queued', progress: 0, stage: 'Queued - #2 in line' },
  { id: 'imp3', title: 'rehearsal-take-3.wav', artist: '', status: 'failed', reason: "There wasn't enough memory to finish. Close other apps, then retry.", file: true },
  { id: 'imp4', title: 'Way Maker', artist: 'Sinach', status: 'stopped' },
];

export async function loadLibrary() {
  const songs = await fetchSongs();
  S.folders = [
    { id: 'unsorted', name: 'Unsorted', color: '', parent: null, system: true },
    { id: 'f1', name: 'Sunday service', color: 'coral', parent: null },
    { id: 'f2', name: 'Opening songs', color: 'rose', parent: 'f1' },
    { id: 'f3', name: 'Youth night', color: 'green', parent: null },
  ];
  S.songs = songs.map((s, i) => ({
    status: 'done', fav: i < FAVORITES, trashed: i === 9 || i === 13, added: Date.now() - i * DAY_MS * 1.3,
    folder: i % 5 === 1 ? 'f1' : i % 7 === 2 ? 'f2' : i % 6 === 3 ? 'f3' : 'unsorted',
    versions: i === 0 ? [{ id: 'main', name: 'Original' }, { id: 'v2', name: '+ Guitar, Piano' }] : [{ id: 'main', name: 'Original' }], version: 'main', ...s,
  }));
  const ids = library().map(s => s.id);
  S.setlists = [{ id: 'l1', name: 'Sunday set', songIds: ids.slice(2, 8) }, { id: 'l2', name: 'Youth night', songIds: ids.slice(8, 12) }];
  S.upNext = ids.slice(3, 6);
  const first = S.songs.find(s => /break open/i.test(s.title) && !s.trashed) || library()[0];
  S.viewId = S.playId = first.id;
  S.ui.sel = first.id;
  S.history = [first.id]; S.histAt = 0;
  S.views = [first.id]; S.viewAt = 0;
}

/** Demo scenarios let every state be reviewed without a real backend. */
export function applyScenario(name) {
  S.ui.scenario = name;
  S.songs = S.songs.filter(s => !s.id.startsWith('imp'));
  S.ui.offline = name === 'offline';
  S.ui.error = null;
  if (name === 'importing') S.songs.unshift(...IMPORT_ROWS.map(r => ({ dur: 0, bpm: 0, key: '', cover: '', folder: 'unsorted', tags: [], versions: [], added: 99, ...r })));
  if (name === 'nosong') { S.viewId = S.playId = null; S.playing = false; }
  if (name === 'viewing') { const other = library().find(s => playable(s) && s.id !== S.playId); if (!S.playId) S.playId = library().find(playable).id; S.viewId = other.id; S.playing = true; }
  if (name === 'error') S.ui.error = { message: "This track's audio could not be loaded.", detail: 'Playback is disabled for this track. Other tracks are not affected.', retry: true };
  if ((name === 'default' || name === 'offline' || name === 'error' || name === 'importing') && !S.playId) { S.viewId = S.playId = library().find(playable).id; }
}

// ── Playback ────────────────────────────────────────────────────────────────
/** The songs shown in the studio, in order, so Back and Forward work like a browser's. */
function show(id) {
  if (S.views[S.viewAt] !== id) { S.views = [...S.views.slice(0, S.viewAt + 1), id]; S.viewAt = S.views.length - 1; }
  S.viewId = id;
}
const viewStep = step => { let at = S.viewAt + step; while (S.views[at] && !playable(song(S.views[at]))) at += step; return S.views[at] ? at : -1; };
export const canViewBack = () => viewStep(-1) >= 0;
export const canViewForward = () => viewStep(1) >= 0;
/** Loads a song into the player. Songs opened by the user join the history that Previous and Next walk. */
function loadInto(id, playing, walking = false) {
  if (!walking && S.history[S.histAt] !== id) { S.history = [...S.history.slice(0, S.histAt + 1), id]; S.histAt = S.history.length - 1; }
  S.playId = id; show(id);
  S.t = 0; S.loop = null; S.loopOn = false; S.speed = 1; S.secIdx = -1; S.lyIdx = -2;
  S.playing = playing;
}
function advance() {
  const nextId = S.upNext.shift();
  if (nextId) return loadInto(nextId, true);
  if (viewingOther()) return loadInto(S.viewId, false);
  S.playing = false; S.t = 0;
}
/** What plays after the queue runs out: the songs that follow the playing one in the list it was started from. */
export const contextNext = () => { const at = S.context.ids.indexOf(S.playId); return at < 0 ? [] : S.context.ids.slice(at + 1).filter(id => playable(song(id)) && !S.upNext.includes(id)); };
const contextPrev = () => { const at = S.context.ids.indexOf(S.playId); return at > 0 ? S.context.ids.slice(0, at).reverse().find(id => playable(song(id))) : null; };
export const canGoBack = () => S.history.slice(0, S.histAt).some(id => playable(song(id))) || !!contextPrev();
export const canGoForward = () => S.history.slice(S.histAt + 1).some(id => playable(song(id))) || S.upNext.length > 0 || contextNext().length > 0;
function setContext(el) {
  const rows = el && el.closest ? el.closest('[data-rows]') : null;
  if (!rows) return;
  S.context = { label: rows.dataset.context || 'Library', ids: [...rows.querySelectorAll('[data-songrow]')].map(r => r.dataset.songrow) };
}
export const recentlyPlayed = () => [...new Set([...S.history].reverse())].map(song).filter(playable);
function walk(step) {
  let at = S.histAt + step;
  while (S.history[at] && !playable(song(S.history[at]))) at += step;
  if (!S.history[at]) return false;
  S.histAt = at;
  loadInto(S.history[at], S.playing, true);
  return true;
}
/** A short message with an Undo, shown after an action that removes something. */
export function toast(text, undo) {
  const t = { text, undo };
  S.ui.toast = t;
  setTimeout(() => { if (S.ui.toast === t) { S.ui.toast = null; update('overlays'); } }, TOAST_MS);
}
let last = 0;
export function startEngine(onTick) {
  const frame = ts => {
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    if (S.playing && S.playId) {
      S.t += dt * S.speed;
      if (S.loopOn && S.loop && S.t >= S.loop.b) S.t = S.loop.a;
      if (S.t >= playSong().dur) { advance(); update(); }
      onTick();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Two-click confirm: the first click arms the control for a few seconds, the second acts. */
export function arm(key, run) {
  if (S.ui.armed === key) { S.ui.armed = null; run(); return; }
  S.ui.armed = key;
  setTimeout(() => { if (S.ui.armed === key) { S.ui.armed = null; update(); } }, ARM_MS);
}
const uniqueName = (base, taken) => { let n = 1; let name = base; while (taken.some(t => t.toLowerCase() === name.toLowerCase())) name = base + ' (' + ++n + ')'; return name; };
const nextSetlistName = () => 'Setlist ' + (S.setlists.length + 1);
const closeMenus = () => { S.ui.menu = null; S.ui.pop = null; };

// Library: select shows, open plays.
act('noop', () => false);
act('select', (ctx, id) => {
  const s = song(id);
  S.ui.sel = id;
  if (!playable(s)) return ['sidebar', 'browse'];
  if (!S.playId) loadInto(id, false); else show(id);
});
act('open', (ctx, id) => { if (!playable(song(id))) return false; setContext(ctx && ctx.el); S.ui.sel = id; S.ui.browse = null; loadInto(id, true); });
act('playContext', (ctx, id) => { loadInto(id, true); });
act('showPlaying', () => { show(S.playId); S.ui.sel = S.playId; });
act('viewBack', () => { const at = viewStep(-1); if (at < 0) return false; S.viewAt = at; S.viewId = S.ui.sel = S.views[at]; });
act('viewForward', () => { const at = viewStep(1); if (at < 0) return false; S.viewAt = at; S.viewId = S.ui.sel = S.views[at]; });
act('play', () => {
  if (!S.playId) return false;
  if (S.playing) { S.playing = false; return; }
  if (viewingOther()) return loadInto(S.viewId, true);
  if (S.loopOn && S.loop) S.t = S.loop.a;
  S.playing = true;
});
act('stop', () => { S.playing = false; S.t = S.loopOn && S.loop ? S.loop.a : 0; });
act('next', () => {
  if (S.t >= 0 && walk(1)) return;
  if (S.upNext.length) return advance();
  const id = contextNext()[0];
  if (id) loadInto(id, S.playing);
});
act('prev', () => {
  if (!S.playId) return false;
  if (S.t <= RESTART_AFTER_S && walk(-1)) return;
  const before = S.t <= RESTART_AFTER_S && contextPrev();
  if (before) return loadInto(before, S.playing);
  S.t = S.loopOn && S.loop ? S.loop.a : 0;
});
act('undo', () => { const t = S.ui.toast; S.ui.toast = null; if (t && t.undo) t.undo(); });
act('dismissToast', () => { S.ui.toast = null; return ['overlays']; });
act('seekTo', (ctx, t) => { S.t = clamp(Number(t), 0, playSong().dur - 0.05); return ['footer', 'main', 'panel']; });
act('seek', ctx => { const r = ctx.el.getBoundingClientRect(); S.t = clamp((ctx.event.clientX - r.left) / r.width, 0, 0.999) * playSong().dur; return false; });
act('sec', (ctx, i) => { S.t = dataOf(S.playId).sections[i].a + 0.01; return false; });
act('loopsec', (ctx, i) => { const sec = dataOf(S.playId).sections[i]; const same = S.loopOn && S.loop && S.loop.i === Number(i); S.loop = { i: Number(i), a: sec.a, b: sec.b }; S.loopOn = !same; });
act('loop', () => { if (!S.loop) return actions.loopsec(null, Math.max(0, S.secIdx)); S.loopOn = !S.loopOn; });
act('speed', (ctx, d) => { S.speed = clamp(Math.round((S.speed + d * SPEED_STEP) * 100) / 100, 0.5, 1); if (S.speed < 1) S.slowSpeed = S.speed; return ['footer', 'stage']; });
act('speedToggle', () => { S.speed = S.speed < 1 ? 1 : S.slowSpeed; return ['footer', 'stage']; });
act('key', (ctx, d) => { S.key = clamp(S.key + Number(d), -6, 6); });
act('keyReset', () => { S.key = 0; STEMS.forEach(s => { S.stems[s.id].key = 0; }); });
act('toggle', (ctx, k) => { S[k] = !S[k]; });
act('flip', (ctx, k) => { S.ui[k] = !S.ui[k]; });
act('set', (ctx, k, v) => { S.ui[k] = v; });
act('tab', (ctx, id, arg) => { S.ui.tab = id; S.ui.tabArg = arg || S.ui.tabArg; S.ui.panel = true; closeMenus(); });
act('mute', (ctx, id) => { S.stems[id].mute = !S.stems[id].mute; });
act('solo', (ctx, id) => { S.stems[id].solo = !S.stems[id].solo; });
act('mine', (ctx, id) => { S.mine = id; closeMenus(); });
act('preset', (ctx, name) => { const muted = PRESETS[name](); STEMS.forEach(s => { S.stems[s.id].mute = muted.includes(s.id); S.stems[s.id].solo = false; }); });
act('lanekey', (ctx, id, d) => { S.stems[id].key = clamp(S.stems[id].key + Number(d), -6, 6); return ['main']; });

// Quick options on a song.
act('fav', (ctx, id) => { const s = song(id); s.fav = !s.fav; closeMenus(); });
act('upnext', (ctx, id) => { if (!S.upNext.includes(id) && id !== S.playId) S.upNext.push(id); closeMenus(); });
act('unqueue', (ctx, i) => { S.upNext.splice(Number(i), 1); });
act('clearQueue', () => { const was = S.upNext; S.upNext = []; toast('Up Next cleared', () => { S.upNext = was; }); });
act('playQueued', (ctx, i) => { const id = S.upNext[Number(i)]; S.upNext.splice(0, Number(i) + 1); loadInto(id, true); });
act('moveQueued', (ctx, i, d) => { const a = Number(i); const b = a + Number(d); if (b < 0 || b >= S.upNext.length) return false; [S.upNext[a], S.upNext[b]] = [S.upNext[b], S.upNext[a]]; });
act('saveQueue', () => { S.setlists.push({ id: 'l' + Date.now(), name: nextSetlistName(), songIds: [S.playId, ...S.upNext].filter(Boolean) }); S.ui.browse = { view: 'setlist:' + S.setlists.at(-1).id, q: '' }; });
act('trash', (ctx, id) => {
  const s = song(id); const was = { folder: s.folder, upNext: S.upNext };
  s.trashed = true; S.upNext = S.upNext.filter(x => x !== id); closeMenus();
  toast('Moved “' + s.title + '” to the Trash', () => { s.trashed = false; s.folder = was.folder; S.upNext = was.upNext; });
  if (S.viewId === id) S.viewId = S.playId === id ? null : S.playId;
  if (S.playId === id) { S.playId = null; S.playing = false; }
});
act('restore', (ctx, id) => { const s = song(id); s.trashed = false; s.folder = 'unsorted'; });
act('emptyTrash', () => arm('emptyTrash', () => { S.songs = S.songs.filter(s => !s.trashed); S.setlists.forEach(l => { l.songIds = l.songIds.filter(song); }); update(); }));
act('moveTo', (ctx, id, folderId) => { song(id).folder = folderId; closeMenus(); });
act('addToSet', (ctx, id, setId) => { const l = setlist(setId); if (!l.songIds.includes(id)) l.songIds.push(id); closeMenus(); });
act('newSetWith', (ctx, id) => { S.setlists.push({ id: 'l' + Date.now(), name: nextSetlistName(), songIds: [id] }); closeMenus(); S.ui.browse = { view: 'setlist:' + S.setlists.at(-1).id, q: '' }; });
act('newFolderWith', (ctx, id) => { const f = { id: 'f' + Date.now(), name: uniqueName('New folder', S.folders.map(x => x.name)), color: 'blue', parent: null }; S.folders.push(f); song(id).folder = f.id; closeMenus(); S.ui.dialog = { id: 'folder', folderId: f.id, title: 'New folder' }; });

// Folders and setlists.
act('newFolder', (ctx, parent) => { const f = { id: 'f' + Date.now(), name: uniqueName('New folder', S.folders.map(x => x.name)), color: 'blue', parent: parent || null }; S.folders.push(f); closeMenus(); S.ui.dialog = { id: 'folder', folderId: f.id, title: parent ? 'New subfolder' : 'New folder' }; });
act('folderColor', (ctx, id, color) => { folder(id).color = color; });
act('deleteFolder', (ctx, id) => arm('folder:' + id, () => {
  const ids = [id, ...folderTree(id).map(f => f.id)];
  S.songs.forEach(s => { if (ids.includes(s.folder)) s.trashed = true; });
  S.folders = S.folders.filter(f => !ids.includes(f.id));
  S.ui.browse = { view: 'all', q: '' }; closeMenus(); update();
}));
act('folderToSet', (ctx, id) => { const ids = [id, ...folderTree(id).map(f => f.id)]; S.setlists.push({ id: 'l' + Date.now(), name: uniqueName(folder(id).name, S.setlists.map(l => l.name)), songIds: library().filter(s => ids.includes(s.folder)).map(s => s.id) }); closeMenus(); S.ui.browse = { view: 'setlist:' + S.setlists.at(-1).id, q: '' }; });
act('newSetlist', () => { S.setlists.push({ id: 'l' + Date.now(), name: nextSetlistName(), songIds: [] }); S.ui.browse = { view: 'setlist:' + S.setlists.at(-1).id, q: '' }; });
act('deleteSetlist', (ctx, id) => arm('setlist:' + id, () => { S.setlists = S.setlists.filter(l => l.id !== id); S.ui.browse = { view: 'all', q: '' }; update(); }));
act('setToFolder', (ctx, id) => { const l = setlist(id); const f = { id: 'f' + Date.now(), name: uniqueName(l.name, S.folders.map(x => x.name)), color: 'violet', parent: null }; S.folders.push(f); l.songIds.forEach(sid => { const s = song(sid); if (s && !s.trashed) s.folder = f.id; }); S.ui.browse = { view: 'folder:' + f.id, q: '' }; });
act('playSetlist', (ctx, id) => { const ids = setlist(id).songIds.filter(sid => playable(song(sid))); if (!ids.length) return false; S.context = { label: setlist(id).name, ids }; S.ui.browse = null; loadInto(ids[0], true); });
act('setMove', (ctx, id, i, d) => { const ids = setlist(id).songIds; const a = Number(i); const b = a + Number(d); if (b < 0 || b >= ids.length) return false; [ids[a], ids[b]] = [ids[b], ids[a]]; });
act('setRemove', (ctx, id, i) => { const l = setlist(id); const was = [...l.songIds]; l.songIds.splice(Number(i), 1); toast('Removed from ' + l.name, () => { l.songIds = was; }); });

// Overlays.
act('browse', (ctx, ...view) => { S.ui.browse = { view: view.join(':') || 'all', q: '', layout: S.ui.browse?.layout || 'grid' }; closeMenus(); });
act('browseLayout', (ctx, layout) => { S.ui.browse.layout = layout; return ['browse']; });
act('closeBrowse', () => { S.ui.browse = null; });
act('dialog', (ctx, id, arg) => { S.ui.dialog = { id, arg }; closeMenus(); S.ui.alerts = false; });
act('closeDialog', () => { S.ui.dialog = null; });
act('pop', (ctx, id) => { const r = ctx.el.getBoundingClientRect(); S.ui.menu = null; S.ui.pop = S.ui.pop && S.ui.pop.id === id ? null : { id, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }; return ['overlays']; });
act('closePop', () => { closeMenus(); return ['overlays']; });
act('scenario', (ctx, name) => { applyScenario(name); closeMenus(); });
act('dismissError', () => { S.ui.error = null; });
