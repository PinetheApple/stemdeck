// PROTOTYPE - throwaway. Tempo tab: tempo mode, BPM, tools, meter and the Click track block.
import { S, act, update, playSong } from './store.js';
import { registerTab, registerMenu, registerPop } from './slots.js';
import { icon, esc, clamp, select, check } from './ui.js';

const BPM_MIN = 30;
const BPM_MAX = 300;
const BPM_STEP = 0.1;
const BPB_MAX = 32;
const SHIFT_S = 0.01;
const TAP_GAP_MS = 2000;
const TAP_KEEP = 8;
const TAP_COMMIT_MS = 700;
const SAVE_MS = 1000;
const WARN_MS = 2600;
const VOL_STEP = 0.05;
const DETECTED_BEAT1 = 0.412;
const DETECTED_BPB = 4;
const METERS = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'];
const SOUNDS = ['Classic', 'Woodblock', 'Rimshot', 'Soft', 'Cowbell'];
const COUNT_INS = [0, 1, 2, 3, 4];
const GROUPS_FROM = 5;
const PROTO = { barsEdited: 'Bars edited in the grid', mixed: 'Mixed meters', unsure: 'Beat unsure', noGrid: 'No beat grid', saveFails: 'Saving fails' };

const T = (S.ui.tempo ??= {
  mode: 'constant', bpm: null, beat1: null, bpb: null, half: false, double: false, taps: [], tapped: null,
  accent: 'auto', custom: 4, groups: '', warn: '', sound: 'Classic', vol: 0.6, saved: '', proto: {},
});
let tapTimer;

const detected = () => playSong()?.bpm || 120;
const bpm = () => T.bpm ?? detected();
const beat1 = () => T.beat1 ?? DETECTED_BEAT1;
const bpb = () => T.bpb ?? DETECTED_BPB;
const constant = () => T.mode === 'constant';
const edited = () => T.bpm !== null || T.beat1 !== null || T.bpb !== null;
const clicked = () => (constant() ? bpm() : detected() * (T.half ? 0.5 : 1) * (T.double ? 2 : 1));
const round1 = v => Math.round(v * 10) / 10;
const accentBeats = () => ({ auto: bpb(), off: 0, custom: T.custom }[T.accent] ?? Number(T.accent.split('/')[0]));
const dis = off => (off ? ' disabled' : '');

const detectedChip = (field, label) => (T[field] === null ? '' : '<button class="chip pchip" data-act="tempoReset:' + field + '" title="Back to the detected value">' + label + icon('rotate-ccw', 12) + '</button>');

function tempoCard() {
  return '<div class="pcard"><div class="pcard__h"><span class="lbl">Tempo</span><span class="chip pchip">' + (T.bpm === null ? 'Detected' : 'Your tempo') + '</span></div>' +
    '<div class="tbig mono">' + round1(clicked()) + ' <small>BPM</small></div>' +
    '<div class="seg" role="radiogroup" aria-label="Tempo mode">' + [['constant', 'Constant tempo'], ['follow', 'Follow the band']].map(([id, label]) => '<button role="radio" aria-checked="' + (T.mode === id) + '" class="' + (T.mode === id ? 'is-on' : '') + '" data-act="tempoMode:' + id + '">' + label + '</button>').join('') + '</div>' +
    '<p class="hint">' + (constant() ? 'One tempo for the whole song…' : 'The click follows the band as it speeds up and slows down…') + '</p></div>';
}
function bpmRow() {
  const off = !constant();
  return '<div class="prow"><span class="plabel">BPM</span><button class="iconbtn iconbtn--sm" data-act="tempoBpm:-1" title="Slower by 0.1 BPM"' + dis(off) + '>' + icon('minus', 14) + '</button>' +
    '<input class="input pnum mono" type="number" min="' + BPM_MIN + '" max="' + BPM_MAX + '" step="' + BPM_STEP + '" value="' + round1(bpm()) + '" data-input="tempoBpmSet" aria-label="BPM"' + dis(off) + '>' +
    '<button class="iconbtn iconbtn--sm" data-act="tempoBpm:1" title="Faster by 0.1 BPM"' + dis(off) + '>' + icon('plus', 14) + '</button><span class="sp"></span>' + detectedChip('bpm', 'Detected ' + detected()) + '</div>';
}
function toolGrid() {
  const off = !constant();
  const halfOff = constant() && bpm() / 2 < BPM_MIN;
  const doubleOff = constant() && bpm() * 2 > BPM_MAX;
  const rate = (id, label, tip, on, dOff) => '<button class="btn pbtn' + (on ? ' is-on' : '') + '" data-act="tempoRate:' + id + '" title="' + tip + '"' + (off ? ' aria-pressed="' + on + '"' : '') + dis(dOff) + '>' + label + '</button>';
  const tapLabel = T.tapped ? 'Tap · ' + round1(T.tapped) : 'Tap';
  return '<div class="tgrid"><button class="btn pbtn' + (T.taps.length ? ' is-on' : '') + '" data-act="tempoTap" title="Tap along to set the tempo"' + dis(off) + '>' + tapLabel + '</button>' +
    rate('half', '÷2', 'Half time', off && T.half, halfOff) + rate('double', '×2', 'Double time', off && T.double, doubleOff) +
    '<button class="btn pbtn mono" data-act="tempoShift:-1" title="Move the grid 10 ms earlier"' + dis(off) + '>−10 ms</button><button class="btn pbtn mono" data-act="tempoShift:1" title="Move the grid 10 ms later"' + dis(off) + '>+10 ms</button>' +
    '<button class="btn pbtn" data-act="tempoBeat1" title="Make the playhead beat 1 of a bar">Beat 1 here</button></div>';
}
function meterRows() {
  const locked = T.proto.barsEdited;
  const value = locked && T.proto.mixed ? '' : bpb();
  return '<div class="prow"><span class="plabel">Beat 1</span><b class="mono">' + beat1().toFixed(3) + ' s</b><span class="sp"></span>' + detectedChip('beat1', 'Detected') + '</div>' +
    '<div class="prow"><span class="plabel">Beats per bar</span><input class="input pnum mono" type="number" min="1" max="' + BPB_MAX + '" value="' + value + '" data-input="tempoBpb" aria-label="Beats per bar"' + (locked ? ' readonly title="Bars were edited in the grid. Change them there, or reset the grid to use this field."' : '') + '><span class="sp"></span>' + detectedChip('bpb', 'Detected') + '</div>';
}
function accentNote() {
  if (T.accent === 'auto') return '';
  const n = accentBeats();
  const text = T.accent === 'off' ? "Click accents are off, so they don't mark the grid's bar lines."
    : n !== bpb() ? 'Click accents every ' + n + ' beats, grid has ' + bpb() + '.'
    : 'Click accents every ' + n + " beats from the first beat, which doesn't match the grid's bar lines.";
  return '<div class="pnote"><span>' + text + '</span><button class="btn pbtn" data-act="tempoAccent:auto">Use Auto</button></div>';
}
function statusRow() {
  const status = T.saved ? '<p class="hint' + (T.saved.startsWith('The') ? ' perr' : '') + '">' + T.saved + '</p>' : '';
  return status + '<button class="btn pbtn" data-act="tempoResetAll" title="Go back to the detected tempo, beat 1 and meter"' + dis(!edited()) + '>' + icon('rotate-ccw', 14) + 'Reset to detected</button>';
}

// ── Click track ──
const accentLabel = () => (T.accent === 'auto' ? (T.proto.noGrid ? 'Auto (none found)' : T.proto.mixed ? 'Auto' : 'Auto · ' + bpb()) : T.accent === 'off' ? 'Off' : T.accent === 'custom' ? 'Custom...' : T.accent);
const countInLabel = n => 'Count-in: ' + (n ? n + ' bar' + (n > 1 ? 's' : '') : 'off');
function noteLine() {
  const n = accentBeats();
  const head = 'Clicking ' + round1(clicked()) + ' BPM';
  const tail = !n ? '.' : T.groups ? ', counting ' + n + ' in ' + esc(T.groups) + ' (stress on ' + stresses().join(', ') + ').'
    : T.accent === 'auto' ? (T.proto.mixed ? ', accenting 3 detected meter regions.' : ', accenting ' + bpb() + '/4 from the detected downbeat.')
    : ', accenting every ' + n + ' beats.';
  return '<p class="hint pclicknote" title="Use ÷2 or ×2 in the Tempo tab if the click feels half or double speed.">' + head + tail + (T.proto.unsure ? ' <span class="pwarn">Beat unsure.</span>' : '') + '</p>';
}
const stresses = () => T.groups.split('+').map(Number).reduce((acc, g) => [...acc, acc.at(-1) + g], [1]).slice(0, -1);
function accentExtras() {
  const n = accentBeats();
  const custom = T.accent === 'custom' ? '<input class="input pnum mono" type="number" min="1" max="' + BPB_MAX + '" value="' + T.custom + '" data-tempo-custom title="Beats between accents" aria-label="Beats between accents">' : '';
  const groups = n >= GROUPS_FROM ? '<input class="input pgroups mono" data-input="tempoGroups" data-tempo-groups value="' + esc(T.groups) + '" placeholder="' + (n === 7 ? '3+2+2' : n === 5 ? '3+2' : '3+3') + '" title="How the bar divides, e.g. 3+2+2. Blank uses the usual grouping for the meter." aria-label="Groups" autocomplete="off">' : '';
  return custom || groups ? '<div class="prow">' + custom + groups + '</div>' + (T.warn ? '<p class="perr">' + T.warn + '</p>' : '') : '';
}
function clickBlock() {
  const vol = Math.round(T.vol * 100) + '%';
  return '<div class="pcard"><div class="pcard__h"><span class="lbl">Click track</span></div><fieldset class="pfs"' + (T.proto.noGrid ? ' disabled title="No beat grid for this track"' : '') + '>' +
    '<div class="prow"><button class="iconbtn' + (S.click ? ' is-on' : '') + '" data-act="toggle:click" title="Click track (K)" aria-label="Click track" aria-pressed="' + S.click + '">' + icon('metronome', 18) + '</button>' +
    '<button class="btn pbtn" data-act="pop:clickVol" title="Click volume: ' + vol + '">' + icon('volume-2', 14) + '<span class="mono">' + vol + '</span></button><span class="sp"></span>' +
    '<button class="btn pbtn' + (S.ui.gridEdit ? ' is-on' : '') + '" data-act="tempoGrid" title="Edit the beat grid" aria-pressed="' + !!S.ui.gridEdit + '">' + icon('grid', 14) + 'Grid</button></div>' +
    '<div class="pselect' + (S.countIn ? ' is-tint' : '') + '" title="Bars of click before the song starts when you press play. Plays even with the click track off.">' + select(countInLabel(S.countIn), 'menu:tempoCountIn') + '</div><p class="hint">Plays even with the click track off</p>' +
    '<div class="pselect' + (T.accent !== 'auto' ? ' is-tint' : '') + '" aria-label="Accent: ' + accentLabel() + '">' + select('Accent: ' + accentLabel(), 'menu:tempoAccent') + '</div>' + accentExtras() +
    '<div class="pselect" title="Click sound">' + select('Sound: ' + T.sound, 'menu:tempoSound') + '</div>' + noteLine() + '</fieldset></div>';
}
registerPop('clickVol', () => '<div class="pvol"><b class="mono">' + Math.round(T.vol * 100) + '%</b><input type="range" class="pvol__r" min="0" max="1" step="' + VOL_STEP + '" value="' + T.vol + '" data-input="tempoVol" aria-label="Click volume"><span class="lbl">Click</span></div>');
registerMenu('tempoCountIn', () => COUNT_INS.map(n => ({ label: countInLabel(n), checked: S.countIn === n, act: 'tempoCountIn:' + n })));
registerMenu('tempoSound', () => SOUNDS.map(s => ({ label: 'Sound: ' + s, checked: T.sound === s, act: 'tempoSound:' + s })));
registerMenu('tempoAccent', () => [
  { label: T.proto.noGrid ? 'Auto (none found)' : T.proto.mixed ? 'Auto' : 'Auto · ' + bpb(), checked: T.accent === 'auto', disabled: T.proto.noGrid, act: 'tempoAccent:auto' },
  { label: 'Off', checked: T.accent === 'off', act: 'tempoAccent:off' }, 'sep',
  ...METERS.map(m => ({ label: m, checked: T.accent === m, act: 'tempoAccent:' + m.replace('/', '-') })), 'sep',
  { label: 'Custom...', checked: T.accent === 'custom', act: 'tempoAccent:custom' },
]);

const switcher = () => '<div class="proto"><span class="lbl">Prototype: tempo state</span><div class="proto__chips">' + Object.entries(PROTO).map(([k, label]) => check(T.proto[k], 'tempoProto:' + k, label)).join('') + '</div></div>';
registerTab('tempo', 'Tempo', () => '<fieldset class="pfs ptab"' + (S.playId ? '' : ' disabled title="Load a track to use the click"') + '>' + tempoCard() +
  '<div class="pcard">' + bpmRow() + toolGrid() + meterRows() + accentNote() + statusRow() + '</div>' + clickBlock() + '</fieldset>' + switcher());

// ── Actions ──
function commit(fn) {
  const before = { bpm: T.bpm, beat1: T.beat1, bpb: T.bpb };
  fn();
  T.saved = 'Not saved yet';
  setTimeout(() => {
    if (T.proto.saveFails) { Object.assign(T, before); T.saved = 'The tempo could not be saved. Showing what is saved.'; } else T.saved = '';
    update('panel');
  }, SAVE_MS);
}
const barLen = () => (60 / bpm()) * bpb();
act('tempoMode', (ctx, mode) => { T.mode = mode; if (mode === 'constant') commit(() => { T.bpm ??= detected(); T.beat1 ??= DETECTED_BEAT1; }); return ['panel']; });
act('tempoBpm', (ctx, d) => { commit(() => { T.bpm = clamp(round1(bpm() + d * BPM_STEP), BPM_MIN, BPM_MAX); }); return ['panel']; });
act('tempoBpmSet', (ctx, v) => { const n = Number(v); if (n >= BPM_MIN && n <= BPM_MAX) commit(() => { T.bpm = round1(n); }); return false; });
act('tempoBpb', (ctx, v) => { const n = Number(v); if (n >= 1 && n <= BPB_MAX) commit(() => { T.bpb = n; T.accent = 'auto'; }); return false; });
act('tempoReset', (ctx, field) => { commit(() => { T[field] = null; }); return ['panel']; });
act('tempoResetAll', () => { commit(() => { T.bpm = T.beat1 = T.bpb = null; }); return ['panel']; });
act('tempoRate', (ctx, id) => {
  if (!constant()) { T[id] = !T[id]; if (T.half && T.double) T[id === 'half' ? 'double' : 'half'] = false; return ['panel']; }
  commit(() => { T.bpm = round1(id === 'half' ? bpm() / 2 : bpm() * 2); });
  return ['panel'];
});
act('tempoShift', (ctx, d) => { commit(() => { const bar = barLen(); T.beat1 = Math.round((((beat1() + d * SHIFT_S) % bar + bar) % bar) * 1000) / 1000; }); return ['panel']; });
act('tempoBeat1', () => { commit(() => { T.beat1 = Math.round((S.t % barLen()) * 1000) / 1000; }); return ['panel']; });
act('tempoTap', () => {
  const now = performance.now();
  if (now - (T.taps.at(-1) ?? -Infinity) > TAP_GAP_MS) T.taps = [];
  T.taps = [...T.taps, now].slice(-TAP_KEEP);
  if (T.taps.length >= 2) T.tapped = 60000 / ((T.taps.at(-1) - T.taps[0]) / (T.taps.length - 1));
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { if (T.tapped) commit(() => { T.bpm = clamp(round1(T.tapped), BPM_MIN, BPM_MAX); }); T.taps = []; T.tapped = null; update('panel'); }, TAP_COMMIT_MS);
  return ['panel'];
});
act('tempoGrid', () => { S.ui.gridEdit = !S.ui.gridEdit; });
act('tempoVol', (ctx, v) => { T.vol = Number(v); ctx.el.parentElement.querySelector('b').textContent = Math.round(T.vol * 100) + '%'; update('panel'); return false; });
act('tempoCountIn', (ctx, n) => { S.countIn = Number(n); S.ui.menu = null; });
act('tempoSound', (ctx, s) => { T.sound = s; S.ui.menu = null; });
act('tempoAccent', (ctx, a) => { T.accent = a.replace('-', '/'); T.groups = ''; T.warn = ''; S.ui.menu = null; });
act('tempoGroups', (ctx, v) => { T.groups = v.replace(/[^\d+]/g, ''); return false; });
act('tempoProto', (ctx, k) => { T.proto[k] = !T.proto[k]; return ['panel']; });

// Custom and Groups are checked once the field is left, as the app does.
function onTempoChange(e) {
  const el = e.target;
  if (el.matches('[data-tempo-custom]')) { const n = Number(el.value); T.custom = Number.isInteger(n) && n >= 1 && n <= BPB_MAX ? n : 4; update('panel'); }
  if (!el.matches('[data-tempo-groups]') || !T.groups) return;
  const sum = T.groups.split('+').reduce((a, g) => a + Number(g), 0);
  if (sum === accentBeats() && !/\+\+|^\+|\+$/.test(T.groups)) return update('panel');
  T.warn = 'A grouping has to add up to ' + accentBeats() + '.'; T.groups = '';
  setTimeout(() => { T.warn = ''; update('panel'); }, WARN_MS);
  update('panel');
}
document.addEventListener('change', onTempoChange);
