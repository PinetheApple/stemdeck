// PROTOTYPE - throwaway. Boot, region rendering, event delegation and keyboard for the full-UI prototype.
import { S, STEMS, actions, act, setUpdater, loadLibrary, applyScenario, startEngine, dataOf, playSong, viewSong, viewingOther, level, song } from './store.js';
import { fmt, clamp, menuHtml, icon, esc } from './ui.js';
import { dialogs, pops, menus, regions } from './slots.js';
import { mockbar, topbar, sidebar } from './shell.js';
import { browse } from './browse.js';
import { studio } from './studio.js';
import { footer } from './footer.js';
import { panel, fitTabs } from './panel.js';
import { stage } from './stage.js';
import './basics.js';
import './extras.js';

const MENU_W = 280;
const DRAG_PX = 6;
const MIN_LOOP_S = 0.2;
const SEEK_S = 5;
const UNITY = 0.8;
const DBL_MS = 400;
const EDGE = 8;
const $$ = sel => document.querySelectorAll(sel);
const root = document.documentElement;

function place(rect, width) {
  const left = clamp(rect.left, 8, innerWidth - width - 8);
  return rect.bottom > innerHeight * 0.62 ? `left:${left}px;bottom:${innerHeight - rect.top + 6}px` : `left:${left}px;top:${rect.bottom + 6}px`;
}
const placeRight = rect => (rect.bottom > innerHeight * 0.62 ? `right:${Math.max(8, innerWidth - rect.right)}px;bottom:${innerHeight - rect.top + 8}px` : `right:${Math.max(8, innerWidth - rect.right)}px;top:${rect.bottom + 8}px`);
const missing = id => `<div class="empty">Not built yet: ${id}</div>`;

function overlays() {
  const { dialog, pop, menu, guide } = S.ui;
  return [
    dialog ? `<div class="scrim" data-act="closeDialog"></div><div class="dlg dlg--${dialog.id}" role="dialog" aria-modal="true">${(dialogs[dialog.id] || (() => missing(dialog.id)))(dialog)}</div>` : '',
    pop ? `<div class="pop" data-pop="${pop.id}" style="${placeRight(pop.rect)}">${(pops[pop.id] || (() => missing(pop.id)))()}</div>` : '',
    menu && menus[menu.id] ? `<div class="pop menu ctx" role="menu" style="${place(menu.rect, MENU_W)}">${menuHtml(menus[menu.id](...menu.args))}</div>` : '',
    guide ? '<div class="guidepill">Help mode: point at anything to see what it does. Esc to leave.</div>' : '',
    S.ui.toast ? `<div class="toast" role="status"><span class="ell">${esc(S.ui.toast.text)}</span>${S.ui.toast.undo ? '<button class="btn btn--quiet" data-act="undo">Undo</button>' : ''}<button class="iconbtn iconbtn--sm" data-act="dismissToast" title="Dismiss">${icon('x', 14)}</button></div>` : '',
  ].join('');
}

const REGIONS = { mockbar, topbar, sidebar, main: studio, panel, footer, stage, browse, overlays };

function setRoot() {
  const d = root.dataset;
  d.sidebar = S.ui.sidebar ? 'on' : 'off';
  d.panel = S.ui.panel ? 'on' : 'off';
  d.preview = viewingOther() ? 'on' : 'off';
  d.guide = S.ui.guide ? 'on' : 'off';
  if (tip && !S.ui.guide) tip.hidden = true;
  d.stage = S.ui.stage && S.playId ? 'on' : 'off';
  const s = playSong();
  if (s && S.loopOn && S.loop) { d.loop = '1'; root.style.setProperty('--lan', S.loop.a / s.dur); root.style.setProperty('--lwn', (S.loop.b - S.loop.a) / s.dur); } else delete d.loop;
}

function render(...names) {
  const list = names.length ? names : Object.keys(REGIONS);
  setRoot();
  const scroll = [...$$('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]);
  const active = document.activeElement;
  const refocus = active && active.dataset ? { input: active.dataset.input, row: active.dataset.songrow, at: active.selectionStart } : {};
  list.forEach(name => {
    const el = document.querySelector('[data-region="' + name + '"]');
    const fn = REGIONS[name] || regions[name];
    if (el && fn) el.innerHTML = fn();
  });
  scroll.forEach(([key, top]) => { const el = document.querySelector('[data-scroll="' + key + '"]'); if (el) el.scrollTop = top; });
  if (refocus.input) { const el = document.querySelector('[data-input="' + refocus.input + '"]'); if (el && el !== document.activeElement) { el.focus(); try { el.setSelectionRange(refocus.at, refocus.at); } catch { /* not a text field */ } } }
  else if (refocus.row) document.querySelector('.libover [data-songrow="' + refocus.row + '"], [data-songrow="' + refocus.row + '"]')?.focus();
  else if (S.ui.dialog && !document.querySelector('.dlg')?.contains(document.activeElement)) document.querySelector('.dlg input, .dlg .btn--accent')?.focus();
  fitFloats();
  fitTabs();
  S.secIdx = -2; S.lyIdx = -2;
  tick();
}

/** Keeps every menu and popover inside the window: moved back in, and scrolled inside when taller than the window. */
function fitFloats() {
  $$('[data-region="overlays"] .pop').forEach(el => {
    el.style.maxHeight = innerHeight - 2 * EDGE + 'px';
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - EDGE || r.top < EDGE) { el.style.bottom = 'auto'; el.style.top = Math.max(EDGE, Math.min(r.top, innerHeight - EDGE - r.height)) + 'px'; }
    if (r.right > innerWidth - EDGE || r.left < EDGE) { el.style.right = 'auto'; el.style.left = Math.max(EDGE, Math.min(r.left, innerWidth - EDGE - r.width)) + 'px'; }
  });
}
addEventListener('resize', fitFloats);
setUpdater(render);

function tick() {
  const s = playSong();
  if (!s) { root.style.setProperty('--p', '0%'); root.style.setProperty('--pn', 0); return; }
  const data = dataOf(s.id);
  const pn = S.t / s.dur;
  root.style.setProperty('--p', (pn * 100).toFixed(3) + '%');
  root.style.setProperty('--pn', pn.toFixed(5));
  $$('[data-b="time"]').forEach(el => { el.textContent = fmt(S.t); });
  STEMS.forEach((st, si) => { const lvl = level(st.id, si).toFixed(3); $$('[data-stem="' + st.id + '"]').forEach(el => el.style.setProperty('--lvl', lvl)); });
  const beat = Math.floor((S.t * s.bpm) / 60) % 4;
  $$('[data-beat]').forEach(el => el.classList.toggle('is-on', S.playing && Number(el.dataset.beat) === beat));
  const secIdx = data.sections.findIndex(sec => S.t < sec.b);
  const cur = data.sections[Math.max(0, secIdx)];
  if (secIdx !== S.secIdx) {
    S.secIdx = secIdx;
    const live = !viewingOther();
    $$('[data-sec]').forEach(el => el.classList.toggle('is-current', (live || !el.closest('[data-region="main"]')) && Number(el.dataset.sec) === secIdx));
    const next = data.sections[secIdx + 1];
    $$('[data-b="secname"]').forEach(el => { el.textContent = cur.name; });
    $$('[data-b="nextsec"]').forEach(el => { el.textContent = S.loopOn && S.loop && S.loop.i === secIdx ? cur.name + ' again' : next ? next.name : 'End'; });
  }
  const barsLeft = Math.max(1, Math.ceil(((cur.b - S.t) * s.bpm) / 240));
  $$('[data-b="bars"]').forEach(el => { el.textContent = barsLeft; });
  $$('[data-b="barword"]').forEach(el => { el.textContent = barsLeft === 1 ? 'bar' : 'bars'; });
  let lyIdx = -1;
  data.lyrics.forEach((l, i) => { if (l.t <= S.t) lyIdx = i; });
  if (lyIdx !== S.lyIdx) {
    S.lyIdx = lyIdx;
    const text = i => (data.lyrics[i] ? data.lyrics[i].text : '');
    const live = !viewingOther();
    $$('[data-b="ly-prev"]').forEach(el => { el.textContent = text(lyIdx - 1); });
    $$('[data-b="ly-cur"]').forEach(el => { el.textContent = live || !el.closest('[data-region="main"]') ? text(lyIdx) || (data.lyrics.length ? '· · ·' : '') : ''; });
    $$('[data-b="ly-next"]').forEach(el => { el.textContent = live || !el.closest('[data-region="main"]') ? text(lyIdx + 1) : ''; });
    $$('[data-li]').forEach(el => {
      const i = Number(el.dataset.li);
      el.classList.toggle('is-current', i === lyIdx);
      el.classList.toggle('is-past', i < lyIdx);
      const box = el.closest('.panel, [data-lyscroll]');
      if (i === lyIdx && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2, behavior: 'smooth' });
    });
  }
}

function run(actStr, el, event, extra = []) {
  const [name, ...args] = actStr.split(':');
  const fn = actions[name];
  if (!fn) return console.warn('No action: ' + name);
  const res = fn({ el, event }, ...args, ...extra);
  if (res !== false) render(...(res || []));
}

act('menu', (ctx, id, ...args) => {
  const r = ctx.event.type === 'contextmenu' ? { left: ctx.event.clientX, right: ctx.event.clientX, top: ctx.event.clientY, bottom: ctx.event.clientY } : ctx.el.getBoundingClientRect();
  S.ui.pop = null;
  S.ui.menu = { id, args, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
  return ['overlays'];
});
act('pref', (ctx, key, value) => { root.dataset[key] = value; localStorage.setItem('mock-' + key, value); });

// ── Guide (help mode): presses explain instead of acting ──
let tip;
function explain(target) {
  const el = target.closest('[title], [data-help]');
  tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'guidetip' }));
  if (!el) { tip.hidden = true; return; }
  const r = el.getBoundingClientRect();
  tip.hidden = false;
  tip.textContent = el.dataset.help || el.getAttribute('title');
  tip.style.left = clamp(r.left, 8, innerWidth - 300) + 'px';
  tip.style.top = (r.bottom + 8 > innerHeight - 60 ? r.top - 44 : r.bottom + 8) + 'px';
}

function closeTop() {
  const ui = S.ui;
  if (ui.error) ui.error = null;
  else if (ui.menu || ui.pop) { ui.menu = null; ui.pop = null; }
  else if (ui.dialog) ui.dialog = null;
  else if (ui.browse && ui.lib.picking) { ui.lib.picking = false; ui.lib.picked = []; }
  else if (ui.browse) ui.browse = null;
  else if (ui.guide) { ui.guide = false; if (tip) tip.hidden = true; }
  else if (ui.stage) ui.stage = false;
  else return false;
  render();
  return true;
}

// A row is re-rendered by its first click, so the browser's own dblclick never reaches it: count the clicks here.
let lastDbl = {};
document.addEventListener('click', e => {
  if (S.ui.guide && !e.target.closest('[data-act="flip:guide"]')) { e.preventDefault(); e.stopPropagation(); explain(e.target); return; }
  const el = e.target.closest('[data-act]');
  const float = e.target.closest('.ctx, .pop');
  const dbl = e.target.closest('[data-dbl]');
  if (dbl && !e.target.closest('button:not([data-dbl]), input, a')) {
    const now = performance.now();
    if (lastDbl.key === dbl.dataset.dbl && now - lastDbl.at < DBL_MS) { lastDbl = {}; return run(dbl.dataset.dbl, dbl, e); }
    lastDbl = { key: dbl.dataset.dbl, at: now };
  }
  if (!float && (S.ui.menu || S.ui.pop) && !(el && /^(menu|pop):/.test(el.dataset.act))) { S.ui.menu = null; S.ui.pop = null; render('overlays'); }
  if (!el || el.disabled) return;
  run(el.dataset.act, el, e);
  if (float && float.classList.contains('ctx') && !el.hasAttribute('data-keep') && S.ui.menu) { S.ui.menu = null; render('overlays'); }
}, true);
document.addEventListener('mouseover', e => { if (S.ui.guide) explain(e.target); });
document.addEventListener('dblclick', e => {
  if (S.ui.guide) return;
  if (e.target.dataset.vol) { S.stems[e.target.dataset.vol].vol = UNITY; return render('main', 'stage'); }
});
document.addEventListener('contextmenu', e => { const el = e.target.closest('[data-ctx]'); if (el) { e.preventDefault(); run(el.dataset.ctx, el, e); } });
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.vol) {
    S.stems[el.dataset.vol].vol = Number(el.value);
    $$('[data-stem="' + el.dataset.vol + '"]').forEach(lane => { lane.style.setProperty('--vol', el.value / Number(el.max)); });
  } else if (el.dataset.input) run(el.dataset.input, el, e, [el.type === 'checkbox' ? el.checked : el.value]);
});

// ── Keyboard ──
const typing = el => el.matches && el.matches('input:not([type="range"]), textarea, select, [contenteditable="true"]');
const KEYS = {
  ' ': () => run('play'), '[': () => run('seekTo:' + (S.t - SEEK_S)), ']': () => run('seekTo:' + (S.t + SEEK_S)),
  l: () => run('loop'), k: () => run('toggle:click'), f: () => run('flip:stage'), r: () => run('record'),
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (closeTop()) e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!S.ui.dialog) run(S.ui.browse ? 'closeBrowse' : 'browse:all'); if (S.ui.browse) document.querySelector('.libover input')?.focus(); return; }
  if (typing(e.target)) { if (e.key === 'Enter' && e.target.closest('.dlg') && e.target.tagName !== 'TEXTAREA') document.querySelector('.dlg__foot .btn--accent')?.click(); return; }
  if (e.altKey && !S.ui.dialog && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('[data-songrow], .srow')) { e.preventDefault(); return run(e.key === 'ArrowLeft' ? 'viewBack' : 'viewForward'); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const row = e.target.closest && e.target.closest('[data-songrow]');
  if (row) {
    const rows = [...row.closest('[data-rows]').querySelectorAll('[data-songrow]')];
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step) { e.preventDefault(); rows[clamp(rows.indexOf(row) + step, 0, rows.length - 1)].focus(); return; }
    if (e.key === 'Enter' && row.dataset.dbl) { e.preventDefault(); return run(row.dataset.dbl, row, e); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !song(row.dataset.songrow).trashed && !S.ui.dialog) { e.preventDefault(); return run('trash:' + row.dataset.songrow, row, e); }
  }
  if (S.ui.dialog) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (fn && !(e.key === ' ' && e.target.matches('button, a') && e.target.matches(':focus-visible'))) { e.preventDefault(); fn(); }
});

// ── Waveform: click moves the playhead, drag loops a region ──
let dragLoop = null;
document.addEventListener('pointerdown', e => {
  const area = e.target.closest('[data-wavearea]');
  if (!area || viewingOther() || !S.playId || S.ui.guide) return;
  const r = area.getBoundingClientRect();
  dragLoop = { r, x0: e.clientX, moved: false, was: S.loop, wasOn: S.loopOn };
});
document.addEventListener('pointermove', e => {
  if (!dragLoop) return;
  if (!dragLoop.moved && Math.abs(e.clientX - dragLoop.x0) < DRAG_PX) return;
  dragLoop.moved = true;
  const dur = playSong().dur;
  const f = x => clamp((x - dragLoop.r.left) / dragLoop.r.width, 0, 1) * dur;
  S.loop = { a: Math.min(f(dragLoop.x0), f(e.clientX)), b: Math.max(f(dragLoop.x0), f(e.clientX)) };
  S.loopOn = true;
  setRoot();
});
document.addEventListener('pointerup', e => {
  if (!dragLoop) return;
  const { r, moved, was, wasOn } = dragLoop;
  dragLoop = null;
  if (moved) { if (S.loop.b - S.loop.a < MIN_LOOP_S) { S.loop = was; S.loopOn = wasOn; } return render('main', 'footer', 'stage'); }
  const t = clamp((e.clientX - r.left) / r.width, 0, 0.999) * playSong().dur;
  const inside = S.loopOn && S.loop && t >= S.loop.a && t <= S.loop.b;
  S.t = t;
  if (S.loopOn && !inside) { S.loopOn = false; render('main', 'footer', 'stage'); } else tick();
});

// ── Drag a song onto a folder, a setlist, the Trash or another song ──
let dragId = null;
document.addEventListener('dragstart', e => { const el = e.target.closest && e.target.closest('[data-drag]'); if (el) { dragId = el.dataset.drag; e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragover', e => { const el = dragId && e.target.closest('[data-drop]'); if (el) { e.preventDefault(); el.classList.add('is-drop'); } });
document.addEventListener('dragleave', e => { e.target.closest && e.target.closest('[data-drop]')?.classList.remove('is-drop'); });
document.addEventListener('drop', e => { const el = dragId && e.target.closest('[data-drop]'); if (el) { e.preventDefault(); run(el.dataset.drop.replace('{id}', dragId), el, e); } dragId = null; });

// ── Resizable columns: kept within limits and never so wide that the waveforms get squeezed out ──
const SIZES = { lw: [232, 380], hw: [328, 480], sw: [320, 520] };
const MIN_WAVE = 320;
const KEY_STEP = 16;
const app = () => document.querySelector('.app');
const sizeOf = key => parseFloat(getComputedStyle(app()).getPropertyValue('--' + key)) || { lw: 248, sw: 340 }[key];
function setSize(key, px) {
  const [lo, hi] = SIZES[key];
  const others = Object.keys(SIZES).filter(k => k !== key).reduce((sum, k) => sum + (k === 'lw' && !S.ui.sidebar ? 64 : k === 'sw' && !S.ui.panel ? 0 : sizeOf(k)), 0);
  const value = Math.round(clamp(px, lo, Math.max(lo, Math.min(hi, app().clientWidth - others - MIN_WAVE))));
  app().style.setProperty('--' + key, value + 'px');
  localStorage.setItem('proto-size-' + key, value);
  if (key === 'sw') refitPanel();
}
let panelW = 0;
/** The panel's tabs depend on its width, so it is redrawn when that changes. */
function refitPanel() { const w = document.querySelector('.side')?.clientWidth || 0; if (w && w !== panelW) { panelW = w; fitTabs(); } }
addEventListener('resize', refitPanel);
function resetSize(key) { app().style.removeProperty('--' + key); localStorage.removeItem('proto-size-' + key); refitPanel(); }
let resizing = null;
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-rz]');
  if (!el) return;
  e.preventDefault();
  resizing = el;
  el.classList.add('is-drag');
  document.body.classList.add('is-resizing');
});
document.addEventListener('pointermove', e => {
  if (!resizing) return;
  const r = app().getBoundingClientRect();
  const key = resizing.dataset.rz;
  const lib = S.ui.sidebar ? sizeOf('lw') : 64;
  setSize(key, key === 'lw' ? e.clientX - r.left : key === 'hw' ? e.clientX - r.left - lib : r.right - e.clientX);
});
document.addEventListener('pointerup', () => { if (resizing) { resizing.classList.remove('is-drag'); document.body.classList.remove('is-resizing'); resizing = null; } });
document.addEventListener('dblclick', e => { const el = e.target.closest('[data-rz]'); if (el) resetSize(el.dataset.rz); });
document.addEventListener('keydown', e => {
  const el = e.target.closest && e.target.closest('[data-rz]');
  const step = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP }[e.key];
  if (!el) return;
  if (e.key === 'Enter') return resetSize(el.dataset.rz);
  if (step) { e.preventDefault(); e.stopPropagation(); setSize(el.dataset.rz, sizeOf(el.dataset.rz) + (el.dataset.rz === 'sw' ? -step : step)); }
}, true);

async function boot() {
  Object.keys(SIZES).forEach(key => { const saved = localStorage.getItem('proto-size-' + key); if (saved) app().style.setProperty('--' + key, saved + 'px'); });
  ['palette', 'font', 'wash'].forEach(key => { root.dataset[key] = localStorage.getItem('mock-' + key) || { palette: 'coral', font: 'manrope', wash: 'on' }[key]; });
  await loadLibrary();
  applyScenario(new URLSearchParams(location.search).get('state') || 'default');
  render();
  refitPanel();
  startEngine(tick);
}
boot();
