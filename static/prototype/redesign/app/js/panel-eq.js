// PROTOTYPE - throwaway. EQ tab: a lane's graph or pedal knobs, and the Master view.
import { S, STEMS, act, update } from './store.js';
import { registerTab, registerMenu } from './slots.js';
import { icon, clamp } from './ui.js';

const F_MIN = 20;
const DECADES = 3;
const G_MAX = 15;
const KNOB_MAX = 12;
const KNOB_DEG = 135;
const KNOB_PX_DB = 0.1;
const SAMPLES = 120;
const F_STEP = 1.06;
const G_STEP = 0.5;
const Q_STEP = 0.1;
const MEASURE_MS = 1200;
const CEIL_STEP = 0.1;
const CEIL = [-3, -0.1];
const GRAPH_LANES = ['vocals', 'drums', 'other'];
const TITLES = { bass: 'Bass EQ', guitar: 'Guitar EQ', piano: 'Keys EQ' };
const KNOBS = [['low', 'Low'], ['mid', 'Mid'], ['high', 'High'], ['presence', 'Presence']];
const TYPES = ['Bell', 'Low shelf', 'High shelf', 'Low cut', 'High cut', 'Notch', 'Band pass', 'Tilt'];
const PRESETS = { streaming: { label: 'Streaming', lufs: -14 }, loud: { label: 'Loud', lufs: -9, glue: 0.5 }, off: { label: 'Off' } };
const OUTCOMES = { ok: 'Works', quiet: 'Not enough sound', failed: 'Fails', lane: 'Not for this lane' };
const ERRORS = { quiet: 'Not enough sound here to suggest an EQ.', failed: "Suggest didn't work. Try again.", lane: "Couldn't suggest for this lane." };
const band = (type, f, g, q) => ({ type, f, g, q });
const defaultBands = () => [band('Low cut', 80, 0, 0.7), band('Bell', 280, -2, 1.2), band('Bell', 3000, 2.5, 1), band('High shelf', 10000, 1.5, 0.7)];
const SUGGESTED = () => [band('Low cut', 110, 0, 0.7), band('Bell', 400, -3.5, 1.6), band('Bell', 2600, 3, 0.9), band('High shelf', 9000, 2, 0.7)];
const flatKnobs = () => ({ low: 0, mid: 0, high: 0, presence: 0 });

const E = (S.ui.eq ??= {
  scope: 'lane', sel: 0, outcome: 'ok', error: '', pending: null,
  lanes: Object.fromEntries(STEMS.map(s => [s.id, { on: true, bands: defaultBands(), knobs: flatKnobs() }])),
  master: { on: true, bands: [band('Low shelf', 60, 1, 0.7), band('Bell', 2500, -1, 0.8)], glue: 0.35, preset: 'streaming', lufs: -14, ceiling: -1, measuring: false },
});

const laneId = () => (STEMS.some(s => s.id === S.ui.tabArg) ? S.ui.tabArg : 'vocals');
const target = () => (E.scope === 'master' ? E.master : E.lanes[laneId()]);
const scopeKey = () => (E.scope === 'master' ? 'master' : laneId()) + '|' + S.playId;
const locked = () => !!E.pending;
const fmtF = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz');
const fmtG = g => (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g).toFixed(1) + ' dB';

// ── Graph ──
const xOf = f => Math.log10(f / F_MIN) / DECADES;
const fOf = x => F_MIN * 10 ** (clamp(x, 0, 1) * DECADES);
const yOf = g => 0.5 - g / (2 * G_MAX);
const gOf = y => clamp((0.5 - y) * 2 * G_MAX, -G_MAX, G_MAX);
const sig = v => 1 / (1 + Math.exp(-v));
const SHAPES = {
  Bell: (o, b) => b.g * Math.exp(-(o * o) * b.q * b.q),
  'Low shelf': (o, b) => b.g * sig(-o * 4),
  'High shelf': (o, b) => b.g * sig(o * 4),
  'Low cut': o => -G_MAX * sig(-o * 6),
  'High cut': o => -G_MAX * sig(o * 6),
  Notch: (o, b) => -G_MAX * Math.exp(-(o * o) * b.q * b.q * 16),
  'Band pass': (o, b) => -G_MAX * (1 - Math.exp(-(o * o) * b.q * b.q)),
  Tilt: (o, b) => b.g * Math.tanh(o),
};
const response = (bands, f) => bands.reduce((sum, b) => sum + SHAPES[b.type](Math.log2(f / b.f), b), 0);
function curvePath(bands) {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const x = i / SAMPLES;
    return (i ? 'L' : 'M') + (x * 100).toFixed(2) + ',' + (clamp(yOf(response(bands, fOf(x))), 0, 1) * 100).toFixed(2);
  }).join('');
}
const GRID_F = [100, 1000, 10000];
const GRID_G = [-12, -6, 6, 12];
function graphGrid() {
  const v = GRID_F.map(f => '<line x1="' + xOf(f) * 100 + '" x2="' + xOf(f) * 100 + '" y1="0" y2="100"/>').join('');
  const h = GRID_G.map(g => '<line x1="0" x2="100" y1="' + yOf(g) * 100 + '" y2="' + yOf(g) * 100 + '"/>').join('');
  return '<g class="eqg__grid">' + v + h + '</g><line class="eqg__zero" x1="0" x2="100" y1="50" y2="50"/>';
}
const point = (b, i, on) => '<button class="eqpt' + (E.sel === i ? ' is-sel' : '') + '" style="left:' + (xOf(b.f) * 100).toFixed(2) + '%;top:' + (yOf(/Bell|shelf|Tilt/.test(b.type) ? b.g : 0) * 100).toFixed(2) + '%" data-eqpt="' + i + '" data-act="eqSel:' + i + '" data-dbl="eqDel:' + i + '" title="Band ' + (i + 1) + ': drag to set frequency and gain, wheel sets the width, double-click removes"' + (on ? '' : ' disabled') + '>' + (i + 1) + '</button>';
function graph(t, color) {
  const before = E.pending?.key === scopeKey() ? '<path class="eqg__before" d="' + curvePath(E.pending.before) + '"/><path class="eqg__target" d="' + curvePath(SUGGESTED().map(b => ({ ...b, g: b.g * 1.3 }))) + '"/>' : '';
  const path = curvePath(t.bands);
  const labels = GRID_F.map(f => '<span style="left:' + xOf(f) * 100 + '%">' + fmtF(f).replace(' ', '') + '</span>').join('');
  return '<div class="eqg' + (t.on ? '' : ' is-off') + '" style="--c:' + color + '" data-eqgraph data-dbl="eqAdd" title="Double-click empty space to add a band">' +
    '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' + graphGrid() + before + '<path class="eqg__fill" d="' + path + 'L100,50L0,50Z"/><path class="eqg__line" d="' + path + '"/></svg>' +
    t.bands.map((b, i) => point(b, i, !locked())).join('') + '<div class="eqg__f">' + labels + '</div></div>';
}
function readout(t) {
  const b = t.bands[E.sel];
  if (!b) return '<p class="hint">Double-click the graph to add a band.</p>';
  return '<div class="eqread"><b>Band ' + (E.sel + 1) + '</b><button class="select pselect--sm" data-act="menu:eqType" title="Band type"' + (locked() ? ' disabled' : '') + '><span>' + b.type + '</span>' + icon('chevron-down', 12) + '</button>' +
    '<span class="mono">' + fmtF(b.f) + '</span><span class="mono">' + fmtG(b.g) + '</span><span class="mono">Q ' + b.q.toFixed(1) + '</span></div>';
}
registerMenu('eqType', () => TYPES.map(type => ({ label: type, checked: target().bands[E.sel]?.type === type, act: 'eqType:' + type })));

// ── Pedal knobs ──
function knob([k, label], lane) {
  const v = lane.knobs[k];
  return '<div class="knob"><button class="knob__dial" style="--a:' + (v / KNOB_MAX) * KNOB_DEG + 'deg" data-knob="' + k + '" data-dbl="eqKnob0:' + k + '" title="' + label + ': drag up or down, Shift is finer, double-click returns to 0 dB" aria-label="' + label + '"' + (locked() ? ' disabled' : '') + '><i></i></button><span class="lbl">' + label + '</span><b class="mono">' + fmtG(v) + '</b></div>';
}
const knobs = lane => '<div class="knobs">' + KNOBS.map(k => knob(k, lane)).join('') + '</div>';

// ── Suggest bar and buttons ──
function suggestRow(flatAct) {
  if (E.pending?.key === scopeKey()) {
    return '<div class="eqsug"><div class="prow"><b>Suggested</b><span class="sp"></span><button class="btn pbtn" data-act="eqUndo">Undo</button><button class="btn pbtn btn--lead" data-act="eqApply">Apply</button></div><span class="eqlegend"><i class="is-target"></i>Target<i class="is-before"></i>Before</span></div>';
  }
  return '<div class="prow"><button class="btn pbtn" data-act="eqSuggest" title="Play a fitted EQ now">' + icon('zap', 14) + 'Suggest</button><button class="btn pbtn" data-act="' + flatAct + '" title="Reset to flat">Flat</button></div>' + (E.error ? '<p class="perr">' + E.error + '</p>' : '');
}
const power = (on, act) => '<button class="iconbtn iconbtn--sm' + (on ? ' is-on' : '') + '" data-act="' + act + '" title="' + (on ? 'EQ on' : 'EQ off') + '" aria-pressed="' + on + '"' + (locked() ? ' disabled' : '') + '>' + icon('power', 14) + '</button>';

function laneView() {
  const id = laneId();
  const lane = E.lanes[id];
  const hasGraph = GRAPH_LANES.includes(id);
  const body = hasGraph ? graph(lane, 'var(--' + id + ')') + readout(lane) : knobs(lane);
  return '<div class="pcard"><div class="pcard__h"><b>' + (TITLES[id] || 'Parametric EQ') + '</b><span class="sp"></span>' + power(lane.on, 'eqPower') + '</div>' + body + suggestRow('eqFlat') + '</div>' +
    '<p class="hint">Pick a lane with its EQ mark in the mixer.</p>';
}

// ── Master ──
function masterMeters(m) {
  const now = m.measuring || !S.playing ? '…' : (m.lufs + 0.6).toFixed(1);
  const gain = m.measuring ? '…' : fmtG(m.preset === 'off' ? 0 : 2.1);
  const gr = m.preset === 'off' ? 0 : m.glue * 4;
  return '<div class="prow"><span class="plabel">GR</span><span class="pmeter"><i style="width:' + (gr / 6) * 100 + '%"></i></span><span class="mono dim">' + fmtG(-gr) + '</span></div>' +
    '<div class="mfigs"><div><span class="lbl">Now, LUFS</span><b class="mono">' + now + '</b></div><div><span class="lbl">Gain at export</span><b class="mono">' + gain + '</b></div></div>';
}
function masterView() {
  const m = E.master;
  const off = m.preset === 'off';
  const seg = Object.entries(PRESETS).map(([id, p]) => '<button role="radio" aria-checked="' + (m.preset === id) + '" class="' + (m.preset === id ? 'is-on' : '') + '" data-act="eqPreset:' + id + '" title="' + p.label + (p.lufs ? ' (' + String(p.lufs).replace('-', '−') + ' LUFS' + (p.glue ? ', glue at 50%' : '') + ')' : '') + '">' + p.label + '</button>').join('');
  return '<div class="pcard"><div class="pcard__h"><b>Master EQ</b><span class="sp"></span>' + power(m.on, 'eqPower') + '</div>' + graph(m, 'var(--text-2)') + readout(m) + '</div>' +
    '<div class="pcard"><div class="pcard__h"><span class="lbl">Export loudness</span>' + (m.preset === 'custom' ? '<span class="chip pchip">Custom</span>' : '') + '</div><div class="seg" role="radiogroup" aria-label="Export loudness">' + seg + '</div>' +
    '<div class="prow"><span class="plabel">Target</span><b class="mono">' + (off ? '—' : String(m.lufs).replace('-', '−') + ' LUFS') + '</b></div>' +
    '<div class="prow"><span class="plabel">Ceiling</span><button class="iconbtn iconbtn--sm" data-act="eqCeil:-1" title="Lower ceiling"' + (off || m.ceiling <= CEIL[0] ? ' disabled' : '') + '>' + icon('minus', 14) + '</button><b class="mono preadout">' + m.ceiling.toFixed(1).replace('-', '−') + ' dBTP</b><button class="iconbtn iconbtn--sm" data-act="eqCeil:1" title="Raise ceiling"' + (off || m.ceiling >= CEIL[1] ? ' disabled' : '') + '>' + icon('plus', 14) + '</button></div>' +
    '<div class="prow"><span class="plabel">Glue</span><input type="range" class="prange" min="0" max="1" step="0.05" value="' + m.glue + '" data-input="eqGlue" aria-label="Glue"' + (off ? ' disabled' : '') + '><b class="mono pval">' + Math.round(m.glue * 100) + '%</b></div>' +
    masterMeters(m) + (off ? '' : '<p class="hint">Live preview is approximate</p>') + suggestRow('eqFlat') + '</div>';
}

function scopeSeg() {
  const stem = STEMS.find(s => s.id === laneId());
  const btn = (id, label) => '<button role="radio" aria-checked="' + (E.scope === id) + '" class="' + (E.scope === id ? 'is-on' : '') + '" data-act="eqScope:' + id + '">' + label + '</button>';
  return '<div class="seg eqscope" role="radiogroup" aria-label="EQ scope">' + btn('lane', '<span class="dot" style="background:var(--' + stem.id + ')"></span>' + stem.name) + btn('master', 'Master') + '</div>';
}
const switcher = () => '<div class="proto"><span class="lbl">Prototype: Suggest result</span><div class="proto__chips">' + Object.entries(OUTCOMES).map(([id, label]) => '<button class="chip pchip ' + (E.outcome === id ? 'is-on' : '') + '" data-act="eqOutcome:' + id + '" aria-pressed="' + (E.outcome === id) + '">' + label + '</button>').join('') + '</div></div>';

registerTab('eq', 'EQ', () => {
  if (E.pending && E.pending.key !== scopeKey()) dropPending();
  return scopeSeg() + (E.scope === 'master' ? masterView() : laneView()) + switcher();
});

// ── Actions ──
function dropPending() { const t = E.pending.target; t.bands = E.pending.before; if (E.pending.preset) Object.assign(E.master, E.pending.preset); E.pending = null; }
const clampBand = b => { b.f = clamp(b.f, F_MIN, F_MIN * 10 ** DECADES); b.g = clamp(b.g, -G_MAX, G_MAX); b.q = clamp(b.q, Q_STEP, 10); };
act('eqScope', (ctx, s) => { E.scope = s; E.sel = 0; E.error = ''; return ['panel']; });
act('eqOutcome', (ctx, o) => { E.outcome = o; E.error = ''; return ['panel']; });
act('eqSel', (ctx, i) => { E.sel = Number(i); return ['panel']; });
act('eqDel', (ctx, i) => { if (locked()) return false; target().bands.splice(Number(i), 1); E.sel = 0; return ['panel']; });
act('eqType', (ctx, type) => { target().bands[E.sel].type = type; S.ui.menu = null; });
act('eqAdd', ctx => {
  if (locked() || ctx.event.target.closest('.eqpt')) return false;
  const r = ctx.el.getBoundingClientRect();
  const b = band('Bell', fOf((ctx.event.clientX - r.left) / r.width), gOf((ctx.event.clientY - r.top) / r.height), 1);
  target().bands.push(b); E.sel = target().bands.length - 1;
  return ['panel'];
});
act('eqPower', () => { target().on = !target().on; return ['panel']; });
act('eqFlat', () => { const t = target(); if (t.knobs) t.knobs = flatKnobs(); t.bands = []; E.error = ''; return ['panel']; });
act('eqKnob0', (ctx, k) => { if (locked()) return false; E.lanes[laneId()].knobs[k] = 0; return ['panel']; });
act('eqSuggest', () => {
  const failure = E.outcome === 'ok' ? '' : E.scope === 'master' ? "Couldn't suggest for this mix." : ERRORS[E.outcome];
  if (failure) { E.error = failure; return ['panel']; }
  const t = target();
  E.pending = { key: scopeKey(), target: t, before: t.bands.map(b => ({ ...b })), preset: E.scope === 'master' ? { preset: E.master.preset, lufs: E.master.lufs, glue: E.master.glue } : null };
  t.bands = SUGGESTED();
  if (E.scope === 'master') Object.assign(E.master, { preset: 'streaming', lufs: PRESETS.streaming.lufs, glue: 0.4 });
  E.error = '';
  return ['panel'];
});
act('eqUndo', () => { dropPending(); return ['panel']; });
act('eqApply', () => { E.pending = null; return ['panel']; });
function measure() { E.master.measuring = true; setTimeout(() => { E.master.measuring = false; update('panel'); }, MEASURE_MS); }
act('eqPreset', (ctx, id) => { const p = PRESETS[id]; Object.assign(E.master, { preset: id }, p.lufs ? { lufs: p.lufs } : {}, p.glue ? { glue: p.glue } : {}); measure(); return ['panel']; });
act('eqCeil', (ctx, d) => { const m = E.master; m.ceiling = clamp(Math.round((m.ceiling + d * CEIL_STEP) * 10) / 10, ...CEIL); m.preset = 'custom'; measure(); return ['panel']; });
act('eqGlue', (ctx, v) => { E.master.glue = Number(v); ctx.el.nextElementSibling.textContent = Math.round(v * 100) + '%'; return false; });

// ── Pointer, wheel and key gestures on bands and knobs ──
let drag = null;
function onDown(e) {
  if (S.ui.guide || locked()) return;
  const pt = e.target.closest('.eqpt');
  const dial = e.target.closest('[data-knob]');
  if (pt) drag = { kind: 'pt', i: Number(pt.dataset.eqpt), rect: pt.closest('[data-eqgraph]').getBoundingClientRect() };
  else if (dial) drag = { kind: 'knob', k: dial.dataset.knob, y: e.clientY, v: E.lanes[laneId()].knobs[dial.dataset.knob] };
}
function onMove(e) {
  if (!drag) return;
  if (drag.kind === 'pt') {
    const b = target().bands[drag.i];
    b.f = fOf((e.clientX - drag.rect.left) / drag.rect.width);
    b.g = gOf((e.clientY - drag.rect.top) / drag.rect.height);
    E.sel = drag.i;
  } else {
    const per = KNOB_PX_DB * (e.shiftKey ? 0.25 : 1);
    E.lanes[laneId()].knobs[drag.k] = clamp(Math.round((drag.v + (drag.y - e.clientY) * per) * 10) / 10, -KNOB_MAX, KNOB_MAX);
  }
  update('panel');
}
function onWheel(e) {
  const pt = e.target.closest?.('.eqpt');
  if (!pt || locked()) return;
  e.preventDefault();
  const b = target().bands[pt.dataset.eqpt];
  b.q = clamp(Math.round((b.q - Math.sign(e.deltaY) * Q_STEP * (e.shiftKey ? 0.25 : 1)) * 100) / 100, Q_STEP, 10);
  update('panel');
}
const KEY_STEP = { ArrowLeft: ['f', 1 / F_STEP], ArrowRight: ['f', F_STEP], ArrowUp: ['g', G_STEP], ArrowDown: ['g', -G_STEP] };
function onKey(e) {
  const pt = e.target.closest?.('.eqpt');
  const dial = e.target.closest?.('[data-knob]');
  const scope = e.target.closest?.('.eqscope');
  if (scope && KEY_STEP[e.key]) { e.preventDefault(); E.scope = E.scope === 'lane' ? 'master' : 'lane'; update('panel'); return document.querySelector('.eqscope .is-on')?.focus(); }
  if (dial && KEY_STEP[e.key]?.[0] === 'g') { e.preventDefault(); const kn = E.lanes[laneId()].knobs; kn[dial.dataset.knob] = clamp(kn[dial.dataset.knob] + Math.sign(KEY_STEP[e.key][1]) * G_STEP, -KNOB_MAX, KNOB_MAX); update('panel'); return document.querySelector('[data-knob="' + dial.dataset.knob + '"]')?.focus(); }
  if (!pt) return;
  const i = Number(pt.dataset.eqpt);
  const b = target().bands[i];
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); target().bands.splice(i, 1); E.sel = 0; update('panel'); return; }
  const step = KEY_STEP[e.key];
  if (!step) return;
  e.preventDefault();
  if (step[0] === 'f') b.f *= step[1]; else b.g += step[1];
  clampBand(b); E.sel = i; update('panel');
  document.querySelector('[data-eqpt="' + i + '"]')?.focus();
}
document.addEventListener('pointerdown', onDown);
document.addEventListener('pointermove', onMove);
document.addEventListener('pointerup', () => { drag = null; });
document.addEventListener('wheel', onWheel, { passive: false });
document.addEventListener('keydown', onKey);
