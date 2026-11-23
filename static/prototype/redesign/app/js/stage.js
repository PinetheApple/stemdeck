// PROTOTYPE - throwaway. Stage mode: the full-screen play-along view of the playing song.
import { S, STEMS, BARS, act, actions, update, playSong, song, dataOf, keyName, activePreset, audible } from './store.js';
import { icon, esc, fmt, clamp, coverStyle, emptyState, kbd } from './ui.js';

const WAVE_BARS = 180;
const VOL_MAX = 1.6;
const UNITY = 0.8;
const HANDOFF_MS = 5000;
const RING_R = 26;
const RING_LEN = 2 * Math.PI * RING_R;
const END_GAP_S = 0.1;
const TRANSCRIBE_TICK_MS = 150;
const TRANSCRIBE_STEP = 0.05;
const LYRIC_DEMOS = [['timed', 'Timed'], ['none', 'None'], ['untimed', 'Not timed']];
const MS_PER_S = 1000;

/** Stage-only state; voice is remembered per song id. */
const st = () => (S.ui.stg ||= { voice: {}, backing: true, split: false, queue: false, handoff: null, lyrics: 'timed', transcribing: null });
const sing = () => S.ui.stageMode === 'sing';
const db = vol => (vol <= 0 ? '-∞' : (20 * Math.log10(vol / UNITY)).toFixed(1));
const pressed = on => (on ? 'is-on' : '') + '" aria-pressed="' + !!on;

// ── Top bar ──
const modeBtn = (id, label, ic) => '<button class="' + (S.ui.stageMode === id ? 'is-on' : '') + '" role="radio" aria-checked="' + (S.ui.stageMode === id) + '" data-stgmode="' + id + '" data-act="stgMode:' + id + '">' + icon(ic, 14) + ' ' + label + '</button>';

function recMark() {
  if (!st().recAt) return '';
  return '<span class="stg__rec" title="Recording"><i></i>REC <span class="mono" data-stg="rec">0:00</span></span>';
}

function sw(on, act, label, title, disabled = false) {
  return '<span class="stg__swwrap" title="' + title + '"><button class="stg__sw" role="switch" aria-checked="' + (!disabled && on) + '" data-act="' + act + '" ' + (disabled ? 'disabled' : '') + '>'
    + '<span class="switch ' + (!disabled && on ? 'is-on' : '') + '"><i></i></span>' + label + '</button></span>';
}

function voices(s) {
  const o = st();
  return '<div class="stg__voices" role="group" aria-label="Voices"><span class="lbl">Voices</span>'
    + sw(!!o.voice[s.id], 'stgVoice', 'Voice', 'Hear the lead vocal. Off silences it for this song without changing the saved mix.')
    + sw(o.backing, 'stgBacking', 'Backing', o.split ? 'Backing vocals' : 'Split the vocals in the studio first', !o.split) + '</div>';
}

function queueChip() {
  const next = song(S.upNext[0]);
  const open = st().queue;
  return '<button class="btn btn--quiet stg__chip ' + pressed(open) + '" data-act="stgQueue" title="Up Next: show or hide the list">' + icon('list-music') + ' Up Next <i class="count">' + S.upNext.length + '</i>'
    + (next ? '<span class="ell stg__chipnext">' + esc(next.title) + '</span>' : '') + '</button>';
}

function top(s) {
  const queued = S.upNext.includes(s.id);
  return '<div class="stg__top">'
    + '<div class="cover" style="width:40px;height:40px;' + coverStyle(s, 'md') + '"></div>'
    + '<div class="stg__id"><div class="stg__title ell">' + esc(s.title) + '</div><div class="row__s ell">' + esc(s.artist || 'Unknown artist') + ' · ' + esc(keyName(s)) + ' · ' + Math.round(s.bpm * S.speed) + ' BPM</div></div>'
    + recMark()
    + '<button class="iconbtn iconbtn--sm" ' + (queued ? 'disabled' : '') + ' data-act="stgAddUpNext" title="' + (queued ? 'Already in Up Next' : 'Add to Up Next') + '">' + icon('list-plus', 16) + '</button>'
    + '<button class="iconbtn iconbtn--sm" data-act="menu:song:' + s.id + ':head" title="More">' + icon('ellipsis', 16) + '</button>'
    + '<div class="seg stg__modes" role="radiogroup" aria-label="Stage view">' + modeBtn('play', 'Play along', 'music') + modeBtn('sing', 'Sing along', 'mic') + '</div>'
    + '<div class="sp"></div>'
    + (sing() ? voices(s) : '<button class="btn ' + pressed(S.ui.stageMix) + '" data-act="flip:stageMix" title="Show or hide the mixer">' + icon('sliders-horizontal') + ' Mix</button>')
    + queueChip()
    + '<button class="btn" data-act="flip:stage" title="Back to the studio (Esc)">' + icon('minimize-2') + ' Exit stage</button></div>';
}

// ── Lyrics states ──
function lyricState(d) {
  if (d.lyricsState !== 'ready') return 'loading';
  return st().lyrics === 'timed' && !d.lyrics.length ? 'none' : st().lyrics;
}

function transcribeBtn() {
  const p = st().transcribing;
  if (p === null) return '<button class="btn" data-act="stgTranscribe" title="Make timed lyrics from the vocals">' + icon('mic') + ' Transcribe lyrics</button>';
  return '<div class="stg__prog" role="progressbar" aria-valuenow="' + Math.round(p * 100) + '"><span>Transcribing… ' + Math.round(p * 100) + '%</span><i style="width:' + p * 100 + '%"></i></div>';
}

function noLyrics(state, compact) {
  if (state === 'loading') return '<div class="stg__nolyr"><span class="dim">Loading lyrics…</span></div>';
  const none = state === 'none';
  const btns = (none ? transcribeBtn() : '') + '<button class="btn" data-act="stgOpenLyrics" title="Leave Stage for the Lyrics view">' + icon('text') + ' Open lyrics</button>';
  return '<div class="stg__nolyr ' + (compact ? 'is-compact' : '') + '">' + emptyState('text', none ? 'No lyrics for this song' : "These lyrics aren't timed", '', '<div class="stg__nolyrbtns">' + btns + '</div>') + '</div>';
}

// ── Centre ──
function playCenter(s, d) {
  const state = lyricState(d);
  const lines = state === 'timed' ? '<div class="stg__lines"><span data-b="ly-prev"></span><b data-b="ly-cur"></b><span data-b="ly-next"></span><span data-stg="ly-next2"></span></div>' : noLyrics(state, true);
  return '<div class="stg__center stg__play"><div class="stg__cue"><span class="lbl">Now</span><div class="stg__now" data-b="secname"></div>'
    + '<div class="stg__then">then <b data-b="nextsec"></b> in <b data-b="bars"></b> <span data-b="barword">bars</span></div>'
    + '<div class="stg__beats" title="Beats of the bar; the first is the downbeat">' + [0, 1, 2, 3].map(n => '<i data-beat="' + n + '"></i>').join('') + '</div>'
    + '<div class="stg__facts"><div><span class="lbl">Tempo</span><b class="mono">' + Math.round(s.bpm * S.speed) + ' BPM</b></div><div><span class="lbl">Next</span><b data-stg="nextin">—</b></div></div></div>'
    + lines + '</div>';
}

const words = text => esc(text).split(' ').map(w => '<span>' + w + '</span>').join(' ');

function singCenter(d) {
  const state = lyricState(d);
  if (state !== 'timed') return '<div class="stg__center stg__singbox">' + noLyrics(state, false) + '</div>';
  return '<div class="stg__center stg__singbox"><div class="stg__sing" data-lyscroll data-scroll="stg-sing"><div class="ly">'
    + d.lyrics.map((l, i) => '<p data-li="' + i + '" data-act="seekTo:' + l.t + '" title="Jump to this line">' + words(l.text) + '</p>').join('') + '</div></div>'
    + '<div class="stg__vin" data-stg="vin" hidden><span class="lbl">Vocals in</span><b class="mono" data-stg="vin-t"></b></div></div>';
}

// ── Sections row and mini waveform ──
function waveSvg(env) {
  const rects = Array.from({ length: WAVE_BARS }, (_, i) => {
    const h = Math.max(2, env[Math.floor((i / WAVE_BARS) * BARS)] * 96);
    return '<rect x="' + (i + 0.2) + '" y="' + (50 - h / 2).toFixed(1) + '" width="0.6" height="' + h.toFixed(1) + '" rx="0.3"/>';
  }).join('');
  const svg = cls => '<svg class="' + cls + '" viewBox="0 0 ' + WAVE_BARS + ' 100" preserveAspectRatio="none" fill="currentColor">' + rects + '</svg>';
  return '<div class="wave" data-act="seek" title="Click to move the playhead">' + svg('wave__base') + svg('wave__played') + '<div class="stg__loopreg"></div><div class="playhead"></div></div>';
}

const secBlock = (sec, i) => {
  const looped = S.loopOn && S.loop && S.loop.i === i;
  return '<div class="sec ' + (i === S.secIdx ? 'is-current' : '') + ' ' + (looped ? 'is-looped' : '') + '" role="button" data-sec="' + i + '" data-act="sec:' + i + '" style="--w:' + sec.share * 100 + '" title="Jump to ' + esc(sec.name) + '">'
    + '<span class="ell">' + esc(sec.name) + '</span><span class="sec__t mono">' + fmt(sec.a) + '</span><button class="sec__loop" data-act="loopsec:' + i + '" title="Loop ' + esc(sec.name) + '">' + icon('repeat', 13) + '</button></div>';
};

const overview = (s, d) => '<div class="stg__nav" aria-label="Song overview"><div class="secs">' + d.sections.map(secBlock).join('') + '</div>'
  + '<div class="stg__wrow"><span class="mono" data-b="time">0:00</span><div class="ov__wave">' + waveSvg(d.env.mix) + '</div><span class="mono">' + fmt(s.dur) + '</span></div></div>';

// ── Mix panel ──
function mrow(stem) {
  const v = S.stems[stem.id];
  const mine = S.mine === stem.id;
  return '<div class="mrow ' + (audible(stem.id) ? '' : 'is-off') + ' ' + (v.mute ? 'is-m' : '') + ' ' + (v.solo ? 'is-solo' : '') + '" data-stem="' + stem.id + '" style="--c:var(--' + stem.id + ');--vol:' + v.vol / VOL_MAX + '">'
    + '<button class="mrow__name" data-act="mute:' + stem.id + '" title="Mute or unmute ' + stem.name + '">' + stem.name + (mine ? '<small>My part</small>' : '') + '</button>'
    + '<button class="ms ms--m" data-act="mute:' + stem.id + '" aria-pressed="' + v.mute + '" title="Mute ' + stem.name + '">M</button>'
    + '<button class="ms ms--s" data-act="solo:' + stem.id + '" aria-pressed="' + v.solo + '" title="Solo ' + stem.name + '">S</button>'
    + '<input class="vol" type="range" min="0" max="' + VOL_MAX + '" step="0.01" value="' + v.vol + '" data-vol="' + stem.id + '" aria-label="' + stem.name + ' volume" title="Drag to set. Double-click to reset.">'
    + '<span class="mrow__db mono" data-stgdb="' + stem.id + '">' + db(v.vol) + '</span><div class="meter"><i></i></div></div>';
}

const presetBtn = (id, label) => '<button class="' + pressed(activePreset() === id) + '" data-act="preset:' + id + '">' + label + '</button>';

const mix = () => '<aside class="stg__side stg__mix" aria-label="Mix"><div class="stg__sidehead"><span class="lbl">Mix</span><div class="sp"></div>'
  + '<button class="pill" data-act="menu:mine" title="Pick the part you play">' + icon('user', 14) + ' My part: <b>' + STEMS.find(x => x.id === S.mine).name + '</b> ' + icon('chevron-down', 13) + '</button></div>'
  + '<div class="seg">' + presetBtn('full', 'Full band') + presetBtn('minus', 'Without me') + presetBtn('only', 'Only me') + '</div>'
  + STEMS.map(mrow).join('') + '</aside>';

// ── Up Next side panel ──
const qrow = (id, i) => {
  const q = song(id);
  return '<div class="stg__qrow" draggable="true" data-drag="' + i + '" data-drop="stgMoveTo:{id}:' + i + '"><span class="stg__qi mono">' + (i + 1) + '</span>'
    + '<button class="stg__qplay" data-qrow="' + i + '" data-act="playQueued:' + i + '" title="Play now"><div class="cover" style="width:36px;height:36px;' + coverStyle(q, 'sm') + '"></div>'
    + '<div class="row__txt"><div class="row__t ell">' + esc(q.title) + '</div><div class="row__s ell">' + esc(q.artist) + ' · ' + fmt(q.dur) + '</div></div></button>'
    + '<button class="iconbtn iconbtn--sm" data-act="unqueue:' + i + '" title="Remove from Up Next">' + icon('x', 14) + '</button></div>';
};

function queuePanel(s) {
  const n = S.upNext.length;
  const acts = n ? '<button class="btn btn--quiet stg__qbtn" data-act="saveQueue" title="Save the playing song and Up Next as a setlist">Save as setlist</button><button class="btn btn--quiet stg__qbtn" data-act="clearQueue" title="Remove every song from Up Next">Clear</button>' : '';
  const list = n ? S.upNext.map(qrow).join('') : emptyState('list-music', 'Up Next is empty', 'Press + on a song in the library to play it after this one.');
  return '<aside class="stg__side stg__queue" aria-label="Up Next"><div class="stg__sidehead"><b>Up Next</b><i class="count">' + n + '</i><div class="sp"></div>' + acts
    + '<button class="iconbtn iconbtn--sm" data-act="stgQueue" title="Close Up Next">' + icon('x', 16) + '</button></div>'
    + '<div class="group">Now playing</div><div class="stg__qnow"><div class="cover" style="width:36px;height:36px;' + coverStyle(s, 'sm') + '"></div><div class="row__txt"><div class="row__t ell">' + esc(s.title) + '</div><div class="row__s ell">' + fmt(s.dur) + '</div></div></div>'
    + '<div class="group">Up next</div><div class="stg__qlist" data-scroll="stg-queue">' + list + '</div>'
    + '<div class="stg__qfoot hint">' + kbd('Alt') + ' ' + kbd('↑') + ' ' + kbd('↓') + ' Move</div></aside>';
}

// ── Song-end handoff ──
function handoff() {
  const h = st().handoff;
  const q = h && song(h.id);
  if (!q) return '';
  return '<div class="stg__hscrim"></div><div class="stg__handoff" role="alertdialog" aria-label="Up next"><span class="lbl">Up next</span>'
    + '<div class="stg__hsong"><div class="cover" style="width:64px;height:64px;' + coverStyle(q, 'md') + '"></div><div class="row__txt"><div class="stg__htitle ell">' + esc(q.title) + '</div><div class="row__s ell">' + esc(q.artist) + '</div></div></div>'
    + '<div class="stg__hring"><svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + RING_R + '" class="stg__ringbg"/><circle cx="32" cy="32" r="' + RING_R + '" class="stg__ringfg" data-stg="ring" stroke-dasharray="' + RING_LEN.toFixed(2) + '"/></svg>'
    + '<span data-stg="hleft">Starts in ' + fmt(HANDOFF_MS / MS_PER_S) + '</span></div>'
    + '<div class="stg__hbtns"><button class="btn" data-act="stgStay" title="Keep this song open (Esc)">Stay here</button><button class="btn btn--accent" data-act="stgPlayNow">' + icon('play', 13, 'ic--fill') + ' Play now</button></div></div>';
}

const proto = () => '<div class="stg__proto"><span class="lbl">Prototype</span>'
  + '<button class="btn btn--quiet" ' + (S.upNext.length ? '' : 'disabled') + ' data-act="stgHandoff" title="Jump to the end of the song to show the handoff to Up Next">Show handoff</button>'
  + '<span class="dim">Lyrics</span><div class="seg">' + LYRIC_DEMOS.map(([id, label]) => '<button class="' + pressed(st().lyrics === id) + '" data-act="stgLyrics:' + id + '">' + label + '</button>').join('') + '</div>'
  + '<button class="btn btn--quiet ' + pressed(st().split) + '" data-act="stgSplit" title="Pretend the vocals are split into lead and backing">Vocal split</button>'
  + '<button class="btn btn--quiet ' + pressed(st().recAt) + '" data-act="stgRec" title="Pretend a recording is running, to show the REC mark">Recording</button></div>';

let wasOn = false;
function moveFocus(on) {
  if (on === wasOn) return;
  wasOn = on;
  queueMicrotask(() => document.querySelector(on ? '.transport .playbtn' : '[data-region="main"] [data-act="flip:stage"]')?.focus());
}

export function stage() {
  const s = playSong();
  const on = !!(S.ui.stage && s);
  moveFocus(on);
  if (!on) return '';
  const d = dataOf(s.id);
  const side = st().queue ? queuePanel(s) : !sing() && S.ui.stageMix ? mix() : '';
  const cls = (sing() ? 'stg--sing' : 'stg--play') + (st().queue ? ' stg--queue' : side ? ' stg--mix' : '');
  return '<div class="stg ' + cls + '" role="region" aria-label="Stage mode"><div class="wash" style="' + coverStyle(s, 'md') + '"></div>' + top(s)
    + (sing() ? singCenter(d) : playCenter(s, d)) + (sing() ? '' : overview(s, d)) + side + proto() + handoff() + '</div>';
}

// ── Actions ──
function startNext() {
  st().handoff = null;
  actions.next();
}
act('stgMode', (ctx, mode) => { S.ui.stageMode = mode; if (mode === 'play' && st().handoff) startNext(); });
act('stgQueue', () => { st().queue = !st().queue; });
act('stgAddUpNext', () => { if (!S.upNext.includes(S.playId)) S.upNext.push(S.playId); });
act('stgVoice', () => { const v = st().voice; v[S.playId] = !v[S.playId]; return ['stage']; });
act('stgBacking', () => { st().backing = !st().backing; return ['stage']; });
act('stgRec', () => { st().recAt = st().recAt ? 0 : performance.now(); return ['stage']; });
act('stgSplit', () => { st().split = !st().split; return ['stage']; });
act('stgLyrics', (ctx, id) => { st().lyrics = id; st().transcribing = null; S.lyIdx = -2; return ['stage']; });
act('stgOpenLyrics', () => { S.ui.stage = false; S.ui.tab = 'lyrics'; S.ui.panel = true; });
act('stgStay', () => { st().handoff = null; return ['stage']; });
act('stgPlayNow', () => startNext());
act('stgMoveTo', (ctx, from, to) => {
  const a = Number(from); const b = Number(to);
  if (!Number.isInteger(a) || a === b) return false;
  S.upNext.splice(b, 0, ...S.upNext.splice(a, 1));
});
act('stgHandoff', () => {
  const id = S.upNext[0];
  if (!id) return false;
  S.t = playSong().dur - END_GAP_S;
  S.playing = false;
  st().handoff = { id, until: performance.now() + HANDOFF_MS, t: S.t };
});
act('stgTranscribe', () => {
  st().transcribing = 0;
  const timer = setInterval(() => {
    const o = st();
    if (o.transcribing === null) return clearInterval(timer);
    o.transcribing = Math.min(1, o.transcribing + TRANSCRIBE_STEP);
    if (o.transcribing >= 1) { clearInterval(timer); o.transcribing = null; o.lyrics = 'timed'; S.lyIdx = -2; }
    update('stage');
  }, TRANSCRIBE_TICK_MS);
  return ['stage'];
});

// ── Per-frame: handoff ring, Vocals in, word fill ──
function tickHandoff() {
  const h = st().handoff;
  if (!h) return;
  if (S.t !== h.t) { st().handoff = null; return update('stage'); }
  const left = Math.max(0, h.until - performance.now());
  if (!left) { startNext(); return update(); }
  const ring = document.querySelector('[data-stg="ring"]');
  if (ring) ring.style.strokeDashoffset = (RING_LEN * (1 - left / HANDOFF_MS)).toFixed(2);
  const label = document.querySelector('[data-stg="hleft"]');
  if (label) label.textContent = 'Starts in ' + fmt(Math.ceil(left / MS_PER_S));
}

function tickVocalsIn(lyrics) {
  const box = document.querySelector('[data-stg="vin"]');
  if (!box || !lyrics.length) return;
  const wait = lyrics[0].t - S.t;
  box.hidden = wait <= 0;
  if (wait > 0) box.querySelector('[data-stg="vin-t"]').textContent = fmt(Math.ceil(wait));
}

function tickWords(lyrics) {
  const line = document.querySelector('.stg__sing p.is-current');
  const cur = lyrics[S.lyIdx];
  if (!line || !cur) return;
  const end = lyrics[S.lyIdx + 1] ? lyrics[S.lyIdx + 1].t : playSong().dur;
  const sung = Math.ceil(clamp((S.t - cur.t) / (end - cur.t), 0, 1) * line.children.length);
  [...line.children].forEach((w, i) => w.classList.toggle('is-sung', i < sung));
}

function tickPlayAlong(d) {
  const nextIn = document.querySelector('[data-stg="nextin"]');
  if (nextIn) {
    const next = d.sections[S.secIdx + 1];
    nextIn.textContent = S.secIdx < 0 ? '—' : next ? next.name + ' in ' + fmt(Math.max(0, next.a - S.t) / S.speed) : 'Last section';
  }
  const far = document.querySelector('[data-stg="ly-next2"]');
  if (far) far.textContent = d.lyrics[S.lyIdx + 2] ? d.lyrics[S.lyIdx + 2].text : '';
}

function tickRec() {
  const el = document.querySelector('[data-stg="rec"]');
  if (el) el.textContent = fmt((performance.now() - st().recAt) / MS_PER_S);
}

function frame() {
  if (S.ui.stage && S.playId) {
    const d = dataOf(S.playId);
    tickHandoff();
    tickRec();
    tickPlayAlong(d);
    tickVocalsIn(d.lyrics);
    tickWords(d.lyrics);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Keys: Esc closes the handoff, then Up Next; arrows switch the view; Alt+arrows reorder ──
const blocked = () => !S.ui.stage || !S.playId || S.ui.dialog || S.ui.menu || S.ui.pop || S.ui.error || S.ui.browse || S.ui.guide;
const ARROW_STEP = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 };

function closeLayer() {
  const o = st();
  if (o.handoff) o.handoff = null;
  else if (o.queue) o.queue = false;
  else return false;
  update('stage');
  return true;
}

function moveRow(row, step) {
  const to = Number(row.dataset.qrow) + step;
  if (actions.moveQueued(null, row.dataset.qrow, step) === false) return;
  update('stage');
  document.querySelector('[data-qrow="' + to + '"]')?.focus();
}

function onStageKey(e) {
  if (blocked()) return;
  const step = ARROW_STEP[e.key];
  const row = e.target.closest && e.target.closest('[data-qrow]');
  const mode = e.target.closest && e.target.closest('[data-stgmode]');
  let handled = true;
  if (e.key === 'Escape') handled = closeLayer();
  else if (row && e.altKey && step && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) moveRow(row, step);
  else if (mode && step && !e.altKey) { actions.stgMode(null, S.ui.stageMode === 'play' ? 'sing' : 'play'); update(); document.querySelector('[data-stgmode="' + S.ui.stageMode + '"]')?.focus(); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
}
window.addEventListener('keydown', onStageKey, true);

function onStageVolume(e) {
  const id = e.target.dataset && e.target.dataset.vol;
  const label = id && document.querySelector('[data-stgdb="' + id + '"]');
  if (label) label.textContent = db(Number(e.target.value));
}
document.addEventListener('input', onStageVolume);
