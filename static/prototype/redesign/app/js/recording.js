// PROTOTYPE - throwaway. Lanes below and over the stems: recording tracks and takes, the lyric sync lane, drag-out grips;
// plus the Record button and its popover and the speed and key popovers of the footer.
import { S, STEMS, act, update, playSong, dataOf, song, keyName } from './store.js';
import { registerPop, registerDialog, registerHook, registerMenu } from './slots.js';
import { icon, esc, fmt, clamp, kbd } from './ui.js';
import { notice, runAct, typing, dlgHead, dlgFoot, dlgInput, dlgValue, PERCENT } from './studio-tools.js';

const SAVE_MS = 1200;
const SLOW_SAVE_MS = 5000; // the app waits 10 s; shortened so the state can be reviewed
const BEATS_PER_BAR = 4;
const UNITY = 0.8;
const VOL_MAX = 1.6;
const CLIP_BARS = 90;
const METER_RATE = 0.004;
const MS_PER_MIN = 60000;
const MAX_KEY = 6;
const MAX_SPEED_FRACTION = 10;
const TAP_PX = 3;
const NUDGE_S = 0.05;
const NUDGE_BIG_S = 0.25;
const LYRIC_WORDS = 3;
const MIN_LINE_GAP_S = 0.05;
const LABEL_MIN_PX = 56;
const FALLBACK_WAVE_PX = 1000;

const INPUTS = [{ name: 'Default input' }, { name: 'Built-in microphone', silent: true }, { name: 'USB Audio Interface', stereo: true }];
const STEREO = ['Input 1', 'Input 2', 'Inputs 1+2'];
const PROBLEMS = [
  ['No microphone or audio input found…', 'Try again'], ["StemDeck isn't allowed to use the microphone…", 'Try again'], ["This window can't use a microphone…", 'Try again'],
  ['No sound from the input…', 'Choose input'], ["Couldn't start recording. Try again.", ''], ["This take couldn't be saved. Record it again.", 'OK'],
];
const NO_DEVICE = 0;
const SILENT = 3;

const R = (S.ui.rec = {
  tracks: [{
    id: 't1', name: 'Track 1', input: 'Default input', vol: UNITY, mute: false, solo: false, open: true, problem: -1, pick: 'k1',
    takes: [{ id: 'k1', n: 1, at: 18, len: 42, state: 'done' }, { id: 'k2', n: 2, at: 66, len: 17, state: 'unfinished' }],
  }],
  armed: 't1', state: 'idle', at: 0, started: 0, len: 0, countLeft: 0, saveStarted: 0, slowSave: false, songId: null, nextId: 2, pendingDelete: null, latencyInput: '', lySel: -1,
});
const track = id => R.tracks.find(t => t.id === id);
const armedTrack = () => track(R.armed);
const live = () => R.state === 'rec' || R.state === 'countin';
const pct = t => (t / playSong().dur) * PERCENT;
const clock = () => fmt((Date.now() - R.started) / 1000);
const slowSaving = () => R.state === 'saving' && R.slowSave && Date.now() - R.saveStarted > SLOW_SAVE_MS;

function recTitle() {
  if (live()) return 'Stop recording';
  if (R.state === 'saving') return slowSaving() ? 'Still saving. Click to stop; what arrived stays as unfinished.' : 'Saving…';
  if (!R.tracks.length) return 'Add a recording track';
  if (!armedTrack()) return 'Arm a track to record into';
  if (armedTrack().problem >= 0) return "The armed track's input isn't ready";
  if (!S.playId) return 'Recording needs the song loaded';
  return S.speed === 1 ? 'Record' : 'Recording needs 1.00x speed';
}

// ── Taking a take ──
let countTimer;
function startTake() { Object.assign(R, { state: 'rec', at: S.t, started: Date.now(), songId: S.playId }); }
function startCountIn() {
  R.state = 'countin';
  R.countLeft = Math.max(1, S.countIn) * BEATS_PER_BAR;
  countTimer = setInterval(() => {
    R.countLeft -= 1;
    if (R.countLeft <= 0) { clearInterval(countTimer); S.playing = true; startTake(); }
    update('main', 'footer');
  }, MS_PER_MIN / playSong().bpm);
}
function finishSave(state) {
  const t = armedTrack() || R.tracks[0];
  R.state = 'idle';
  if (!t) return null;
  const take = { id: 'k' + Date.now(), n: Math.max(0, ...t.takes.map(k => k.n)) + 1, at: R.at, len: R.len, state };
  t.takes.push(take);
  Object.assign(t, { pick: take.id, open: true });
  update();
  return take;
}
function stopTake() {
  R.len = (Date.now() - R.started) / 1000;
  R.state = 'saving';
  R.saveStarted = Date.now();
  if (!R.slowSave) setTimeout(() => { if (R.state === 'saving') finishSave('new'); }, SAVE_MS);
}
function addTrack() {
  const n = R.nextId++;
  R.tracks.push({ id: 't' + n, name: 'Track ' + n, input: 'Default input', vol: UNITY, mute: false, solo: false, open: true, problem: -1, pick: null, takes: [] });
}
act('record', () => {
  if (R.state === 'countin') { clearInterval(countTimer); R.state = 'idle'; return; }
  if (R.state === 'rec') return stopTake();
  if (R.state === 'saving') return slowSaving() ? void finishSave('unfinished') : false;
  if (!R.tracks.length) return addTrack();
  const why = recTitle();
  if (why !== 'Record') { notice(why); return false; }
  S.ui.pop = null;
  if (S.playing) startTake(); else startCountIn();
});
function switchedSong() {
  const from = song(R.songId);
  stopTake();
  const take = finishSave('new');
  notice(`Recording stopped when you changed songs. Take ${take.n} is saved in ${from.title}.`, { label: 'Open ' + from.title, act: 'open:' + from.id });
}

// ── Record popover and the footer's Record button ──
const goLabel = () => (live() ? 'Stop recording' : R.state === 'saving' ? 'Saving…' : 'Record');
registerPop('record', () => {
  const t = armedTrack();
  const why = recTitle();
  const can = why === 'Record' || live() || slowSaving();
  const status = live() ? (R.state === 'rec' ? `Recording into ${esc(t.name)}` : 'Counting in…') : t ? `${esc(t.name)} · ${esc(t.input)}` : 'No track armed';
  return `<div class="stl stl--rec"><h3>Record</h3><div class="recpop__state ${live() ? 'is-rec' : ''}">${icon('mic', 15)}<span class="ell">${status}</span></div>
    <button class="btn recpop__go ${live() ? 'is-rec' : ''}" ${can ? '' : 'disabled'} data-act="record" title="${why}">${icon(live() ? 'square' : 'circle', 13, 'ic--fill')}${goLabel()}<span class="sp"></span>${kbd('R')}</button>
    <div class="hint">${can && !live() && R.state !== 'saving' ? `From a stop it counts in ${Math.max(1, S.countIn)} bar${S.countIn > 1 ? 's' : ''} first.` : why}</div>
    <button class="btn btn--quiet stl__wide" data-act="recAddTrack">${icon('plus', 14)} Add a recording track</button>
    <div class="recpop__demo"><span class="lbl">Review states</span><button class="linkbtn" data-act="recDemo:problem">Arm problem</button><button class="linkbtn ${R.slowSave ? 'is-on' : ''}" aria-pressed="${R.slowSave}" data-act="recDemo:slow">Slow save</button></div></div>`;
});
act('recDemo', (ctx, what) => {
  const t = armedTrack() || R.tracks[0];
  if (what === 'slow') R.slowSave = !R.slowSave;
  else if (t) { R.armed = t.id; t.problem = t.problem + 1 >= PROBLEMS.length ? -1 : t.problem + 1; }
  return ['overlays', 'main'];
});
function patchRecButton() {
  const btn = document.querySelector('.recbtn');
  if (!btn) return;
  const label = R.state === 'rec' ? clock() : R.state === 'idle' ? 'Record' : goLabel();
  if (btn.dataset.lbl !== label) { btn.dataset.lbl = label; btn.innerHTML = '<i></i> ' + label; }
  btn.classList.toggle('is-rec', live());
  btn.title = recTitle();
}
document.addEventListener('click', e => {
  if (R.state === 'idle' || S.ui.guide || !e.target.closest?.('.recbtn')) return;
  e.stopImmediatePropagation();
  runAct('record');
}, true);
document.addEventListener('keydown', e => { if (e.repeat && e.key.toLowerCase() === 'r' && !typing(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); } });
addEventListener('beforeunload', e => { if (R.state === 'rec') e.preventDefault(); });

function frame() {
  if (R.state === 'rec' && S.playId !== R.songId) switchedSong();
  patchRecButton();
  document.querySelectorAll('[data-recclock]').forEach(el => { el.textContent = 'REC ' + clock(); });
  const clip = document.querySelector('[data-recclip]');
  if (clip && playSong()) clip.style.width = pct((Date.now() - R.started) / 1000) + '%';
  const t = armedTrack();
  const meter = t && document.querySelector(`[data-recmeter="${t.id}"]`);
  if (meter) meter.style.setProperty('--lvl', t.problem < 0 && !t.mute ? (0.35 + 0.15 * Math.sin(Date.now() * METER_RATE)).toFixed(3) : 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Track rows ──
const noise = (seed, i) => Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
function clip(take, cls = '') {
  const seed = take.n + take.at;
  const bars = Array.from({ length: CLIP_BARS }, (_, i) => { const h = 12 + 70 * noise(seed, i); return `<rect x="${i + 0.2}" y="${(50 - h / 2).toFixed(1)}" width="0.6" height="${h.toFixed(1)}"/>`; }).join('');
  return `<div class="rclip rclip--${take.state} ${cls}" style="left:${pct(take.at)}%;width:${pct(take.len)}%"><svg viewBox="0 0 ${CLIP_BARS} 100" preserveAspectRatio="none" fill="currentColor">${bars}</svg></div>`;
}
function problemBox(t) {
  const [text, action] = PROBLEMS[t.problem];
  const btn = action === 'Choose input' ? `<button class="btn" data-act="menu:recInput:${t.id}">${action}</button>`
    : action ? `<button class="btn" data-act="recClearProblem:${t.id}">${action}</button>` : `<button class="iconbtn iconbtn--sm" data-act="recClearProblem:${t.id}" title="Dismiss">${icon('x', 14)}</button>`;
  return `<div class="rprob" role="alert">${icon('alert', 15)}<span>${text}</span>${btn}</div>`;
}
function trackWave(t, armed) {
  const take = t.takes.find(k => k.id === t.pick);
  const recording = armed && R.state === 'rec' ? `<div class="rclip rclip--live" data-recclip style="left:${pct(R.at)}%"></div>` : '';
  const body = take ? clip(take) : recording ? '' : '<span class="rtrack__empty">Press Record to start</span>';
  const latency = '<div class="rlat"><span>Timing is estimated.</span><button class="linkbtn" data-act="recSettings:' + t.id + '">Test latency</button></div>';
  return body + recording + (armed && t.problem >= 0 ? problemBox(t) : armed && R.state === 'idle' ? latency : '');
}
function trackHead(t, armed) {
  const name = esc(t.name);
  const fold = t.takes.length ? `<button class="rtrack__fold" aria-expanded="${t.open}" aria-label="Takes of ${name}" title="Takes of ${name}" data-act="recFold:${t.id}">${icon(t.open ? 'chevron-down' : 'chevron-right', 14)}</button>` : '<span class="rtrack__fold"></span>';
  return `<div class="rhead"><div class="rtrack__nm">${fold}<button class="rtrack__name ell" data-act="recRename:${t.id}" title="Rename ${name}">${name}</button></div>
    <button class="xbtn rtrack__in" data-act="menu:recInput:${t.id}" aria-label="Input for ${name}" title="Input for ${name}: ${esc(t.input)}">${icon('mic', 12)}<span class="ell">${esc(t.input || 'Default input')}</span>${icon('chevron-down', 11)}</button>
    <button class="ms ms--m" aria-pressed="${t.mute}" data-act="recMute:${t.id}" title="Mute ${name}">M</button><button class="ms ms--s" aria-pressed="${t.solo}" data-act="recSolo:${t.id}" title="Solo ${name}">S</button>
    <input class="vol" type="range" min="0" max="${VOL_MAX}" step="0.01" value="${t.vol}" data-input="recVol:${t.id}" data-dbl="recVolReset:${t.id}" aria-label="${name} volume" title="Drag to set. Double-click to reset.">
    <button class="ms rtrack__arm ${armed ? 'is-on' : ''}" aria-pressed="${armed}" data-act="recArm:${t.id}" aria-label="Arm ${name} for recording" title="Arm ${name} for recording">${icon('circle', 12, 'ic--fill')}</button>
    <button class="iconbtn iconbtn--sm" data-act="menu:recTrack:${t.id}" aria-label="Options for ${name}" title="Options for ${name}">${icon('ellipsis', 14)}</button>
    <div class="rmeter" data-recmeter="${t.id}" title="Input level"><i></i></div></div>`;
}
function takeRow(t, k) {
  const on = t.pick === k.id;
  const flag = k.state === 'unfinished' ? '<span class="tag rtake__flag" title="Recording was cut off. Keep what arrived, or delete it.">Unfinished</span>' : '';
  const ids = t.id + ':' + k.id;
  const acts = k.state === 'done' ? `<button class="iconbtn iconbtn--sm" data-act="recDropTake:${ids}" aria-label="Delete Take ${k.n}" title="Delete Take ${k.n}">${icon('trash-2', 14)}</button>`
    : `<button class="chip rtake__keep" data-act="recKeep:${ids}">Keep</button><button class="chip" data-act="recDropTake:${ids}">Delete</button>`;
  return `<div class="lane rtake ${on ? 'is-pick' : ''}"><div class="rhead"><button class="rtake__pick" role="radio" aria-checked="${on}" data-act="recPick:${ids}" title="Play this take"><span class="rtake__dot"></span>Take ${k.n}<span class="mono dim">${fmt(k.len)}</span></button>${flag}<div class="sp"></div>${acts}</div>
    <div class="lane__w">${clip(k, on ? '' : 'is-dim')}</div></div>`;
}
const trackRows = t => {
  const armed = R.armed === t.id;
  return `<div class="lane rtrack ${armed ? 'is-armed' : ''} ${t.mute ? 'is-m' : ''} ${t.solo ? 'is-solo' : ''}" style="--vol:${t.vol / VOL_MAX}">${trackHead(t, armed)}<div class="lane__w rtrack__w">${trackWave(t, armed)}</div></div>${t.open ? t.takes.map(k => takeRow(t, k)).join('') : ''}`;
};
const addRow = () => `<div class="lane radd"><div class="rhead"><button class="btn btn--quiet" data-act="menu:recAdd" title="Add a recording track">${icon('plus', 14)} Track</button></div><div class="lane__w"></div></div>`;

registerMenu('recInput', id => {
  const t = track(id);
  if (t.problem === NO_DEVICE) return [{ label: 'No microphone or audio input found…', icon: 'mic', disabled: true }];
  return inputOptions(t).map((label, i) => ({ label, icon: 'mic', checked: t.input === label, act: `recInput:${id}:${i}` }));
});
const inputOptions = t => INPUTS.flatMap(d => (d.stereo && R.armed === t.id ? STEREO.map(x => `${d.name} · ${x}`) : [d.name]));
const silent = label => INPUTS.some(d => d.silent && label.startsWith(d.name));
registerMenu('recTrack', id => [
  { label: 'Rename…', icon: 'pencil', act: 'recRename:' + id }, { label: 'Recording settings…', icon: 'settings', act: 'recSettings:' + id },
  'sep', { label: 'Delete track', icon: 'trash-2', danger: true, act: 'recAskDelete:' + id },
]);
registerMenu('recAdd', () => [{ label: 'Audio track', icon: 'audio-waveform', act: 'recAddTrack' }]);
registerDialog('recRename', d => dlgHead('Rename track') + `<div class="dlg__body">${dlgInput('name', track(d.arg).name, 'Track name')}</div>` + dlgFoot('recSaveName:' + d.arg));

const flipTrack = key => (ctx, id) => { track(id)[key] = !track(id)[key]; };
act('recMute', flipTrack('mute'));
act('recSolo', flipTrack('solo'));
act('recFold', flipTrack('open'));
act('recArm', (ctx, id) => {
  if (live()) return false;
  R.armed = R.armed === id ? null : id;
  track(id).problem = R.armed && silent(track(id).input) ? SILENT : -1;
});
act('recInput', (ctx, id, i) => { const t = track(id); t.input = inputOptions(t)[i]; t.problem = R.armed === id && silent(t.input) ? SILENT : -1; });
act('recClearProblem', (ctx, id) => { track(id).problem = -1; });
act('recVol', (ctx, id, v) => { track(id).vol = Number(v); ctx.el.closest('.lane').style.setProperty('--vol', v / VOL_MAX); return false; });
act('recVolReset', (ctx, id) => { track(id).vol = UNITY; return ['main']; });
act('recAddTrack', () => { addTrack(); S.ui.pop = null; });
act('recRename', (ctx, id) => { S.ui.dialog = { id: 'recRename', arg: id }; S.ui.menu = null; });
act('recSaveName', (ctx, id) => { const t = track(id); t.name = dlgValue('name', t.name).trim().slice(0, PERCENT) || t.name; S.ui.dialog = null; });
act('recSettings', (ctx, id) => { R.latencyInput = track(id).input; S.ui.dialog = { id: 'settings', arg: 'recording' }; S.ui.menu = null; });
act('recAskDelete', (ctx, id) => { R.pendingDelete = id; S.ui.dialog = { id: 'confirm', arg: 'deleteTrack', then: 'deleteTrack', name: track(id).name }; S.ui.menu = null; });
act('deleteTrack', () => {
  R.tracks = R.tracks.filter(t => t.id !== R.pendingDelete);
  if (R.armed === R.pendingDelete) R.armed = null;
  R.pendingDelete = null;
  S.ui.dialog = null;
});
const takeOf = (id, kid) => track(id).takes.find(k => k.id === kid);
act('recPick', (ctx, id, kid) => { track(id).pick = kid; S.t = takeOf(id, kid).at; S.playing = true; });
act('recKeep', (ctx, id, kid) => { takeOf(id, kid).state = 'done'; });
act('recDropTake', (ctx, id, kid) => {
  const t = track(id);
  t.takes = t.takes.filter(k => k.id !== kid);
  if (t.pick === kid) t.pick = t.takes.at(-1)?.id || null;
});


// ── Lyric sync lane, shown while Sync lines is on in the Lyrics tab (S.ui.lyricSync) ──
const firstWords = text => (text.trim() ? text.trim().split(/\s+/).slice(0, LYRIC_WORDS).join(' ') : '♪');
function lyricLane() {
  if (!S.ui.lyricSync || !S.playId) return '';
  const lines = dataOf(S.playId).lyrics;
  const pxPerS = (document.querySelector('.wavearea')?.clientWidth || FALLBACK_WAVE_PX) / playSong().dur;
  const roomy = i => ((lines[i + 1]?.t ?? playSong().dur) - lines[i].t) * pxPerS >= LABEL_MIN_PX;
  return `<div class="lane lylane"><div class="rhead"><div class="lylane__id"><b>Lyrics</b><span class="hint">Drag a line · ← → nudge</span></div><div class="sp"></div>
    <button class="btn btn--quiet" data-act="lySyncDone" title="Leave Sync lines. Changes are saved as you make them.">Done</button></div>
    <div class="lane__w lylane__w">${lines.map((l, i) => `<button class="lymark ${R.lySel === i ? 'is-sel' : ''}" data-li="${i}" data-lymark="${i}" style="left:${pct(l.t)}%" title="${esc(l.text)}">${roomy(i) ? esc(firstWords(l.text)) : ''}</button>`).join('')}</div></div>`;
}
act('lySyncDone', () => { S.ui.lyricSync = false; R.lySel = -1; });
function retime(i, t) {
  const lines = dataOf(S.playId).lyrics;
  lines[i].t = clamp(t, (lines[i - 1]?.t ?? 0) + MIN_LINE_GAP_S, (lines[i + 1]?.t ?? playSong().dur) - MIN_LINE_GAP_S);
  S.lyIdx = -2;
}
let lyDrag = null;
document.addEventListener('pointerdown', e => {
  const el = e.target.closest?.('[data-lymark]');
  if (el && e.button === 0) lyDrag = { i: Number(el.dataset.lymark), r: el.parentElement.getBoundingClientRect(), x0: e.clientX, moved: false };
});
document.addEventListener('pointermove', e => {
  if (!lyDrag || (!lyDrag.moved && Math.abs(e.clientX - lyDrag.x0) < TAP_PX)) return;
  lyDrag.moved = true;
  R.lySel = lyDrag.i;
  retime(lyDrag.i, ((e.clientX - lyDrag.r.left) / lyDrag.r.width) * playSong().dur);
  update('main', 'panel');
});
document.addEventListener('pointerup', () => { if (lyDrag && !lyDrag.moved) { R.lySel = lyDrag.i; update('main'); } lyDrag = null; });
function onSyncKey(e) {
  if (!S.ui.lyricSync || typing(e.target) || S.ui.dialog || S.ui.menu || S.ui.pop || e.ctrlKey || e.metaKey || e.altKey) return;
  const lines = dataOf(S.playId).lyrics;
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const move = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (step && R.lySel >= 0) retime(R.lySel, lines[R.lySel].t + step * (e.shiftKey ? NUDGE_BIG_S : NUDGE_S));
  else if (move) R.lySel = clamp(R.lySel + move, 0, lines.length - 1);
  else if (e.key === 'Escape') runAct('lySyncDone');
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
  update('main', 'panel');
}
document.addEventListener('keydown', onSyncKey);

// ── Drag-out grips on the loop region (desktop app) ──
function grips() {
  if (!S.loopOn || !S.loop || !playSong()) return '';
  requestAnimationFrame(placeNuggets);
  return `<div class="dregion"><button class="dgrip" draggable="true" data-dragout="mix" title="Drag this region into a DAW or folder">${icon('grip-vertical', 14)}</button>
    ${STEMS.map(st => `<button class="dnug" draggable="true" data-dragout="${st.id}" style="--c:var(--${st.id})" title="Drag ${st.name} for this region into a DAW or folder"></button>`).join('')}</div>`;
}
function placeNuggets() {
  document.querySelectorAll('.dnug').forEach(el => { const lane = document.querySelector(`.lane[data-stem="${el.dataset.dragout}"]`); if (lane) el.style.top = lane.offsetTop + lane.offsetHeight / 2 + 'px'; });
}
document.addEventListener('dragstart', e => {
  const el = e.target.closest?.('[data-dragout]');
  if (!el) return;
  const part = el.dataset.dragout === 'mix' ? '' : ' ' + el.dataset.dragout;
  e.dataTransfer.setData('text/plain', `${playSong().title}${part} ${fmt(S.loop.a)}-${fmt(S.loop.b)}.wav`);
});

// ── Footer speed and key popovers ('speed', 'key') ──
registerPop('speed', () => `<div class="stl"><h3>Speed</h3><label class="stl__f"><span class="lbl">Exact speed</span><input class="input mono" data-commit data-speedbox value="${S.speed.toFixed(2)}" aria-label="Exact playback speed" title="Type a speed from 0.50 to 1.00" autocomplete="off"></label>
  <div class="hint">Drag, scroll or use the arrow keys. Double-click to switch between 1x and your slow speed (${S.slowSpeed.toFixed(2)}×).</div></div>`);
function commitSpeed(el) {
  let n = Number(el.value.trim().replace(',', '.').replace(/[x%]$/i, ''));
  if (Number.isNaN(n) || !el.value.trim()) { el.value = S.speed.toFixed(2); return; }
  if (n >= MAX_SPEED_FRACTION) n /= PERCENT;
  S.speed = Math.round(clamp(n, 0.5, 1) * PERCENT) / PERCENT;
  if (S.speed < 1) S.slowSpeed = S.speed;
  update('footer', 'main', 'stage', 'overlays');
}
document.addEventListener('change', e => { if (e.target.dataset?.speedbox !== undefined) commitSpeed(e.target); });
registerPop('key', () => {
  const s = playSong();
  return `<div class="stl"><h3>Key</h3><div class="stl__row"><button class="iconbtn" ${S.key <= -MAX_KEY ? 'disabled' : ''} data-act="key:-1" title="Transpose down a semitone">${icon('minus')}</button>
    <b class="stl__keyv mono ${S.key ? 'is-on' : ''}">${(S.key > 0 ? '+' : '') + S.key}</b><button class="iconbtn" ${S.key >= MAX_KEY ? 'disabled' : ''} data-act="key:1" title="Transpose up a semitone">${icon('plus')}</button>
    <span class="dim">${s ? esc(keyName(s)) : ''}</span></div>
    <button class="btn stl__wide" data-act="keyReset" title="Put every lane back in the original key">${icon('rotate-ccw', 14)} Reset</button></div>`;
});

registerHook('lanes', lyricLane);
registerHook('lanes', () => (S.playId ? R.tracks.map(trackRows).join('') + addRow() : ''));
registerHook('laneOverlay', grips);
registerHook('laneOverlay', () => {
  if (R.state === 'countin') return `<div class="rcount" aria-live="polite"><b>${R.countLeft}</b><span>Count-in</span></div>`;
  return R.state === 'rec' ? `<div class="recmark ${S.ui.stage ? 'recmark--stage' : ''}"><i></i><span data-recclock>REC ${clock()}</span></div>` : '';
});
