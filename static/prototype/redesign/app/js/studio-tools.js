// PROTOTYPE - throwaway. Studio tools: footer and header popovers, section editing, beat grid editor, lyric sync lane, drag-out grips.
import { S, STEMS, act, actions, arm, armed, update, dataOf, playSong, viewSong, song, audible } from './store.js';
import { registerPop, registerDialog, registerHook } from './slots.js';
import { icon, esc, fmt, clamp, toggle, check, kbd, registerIcons } from './ui.js';

registerIcons({
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  'move-h': '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  'bar-line': '<path d="M12 3v18"/><path d="M5 8v8"/><path d="M19 8v8"/>',
});

const NOTICE_MS = 2600;
const SAVING_MS = 600;
const SAVED_MS = 1800;
const MIN_SECTION_S = 0.5;
const MIN_LOOP_S = 0.2;
const MIN_BEAT_S = 0.05;
const NEW_SECTION_SHARE = 0.12;
const DEFAULT_LOOP = [0.25, 0.5];
const DRAG_PX = 6;
const EDGE_PX = 8;
const HIT_PX = 8;
const MIN_LINE_PX = 6;
const FALLBACK_WAVE_PX = 1000;
const SNAP_S = 0.06;
const ONSET_JITTER_S = 0.012;
const BEATS_PER_BAR = 4;
const MAX_BAR = 32;
const WHEEL_COARSE_S = 0.1;
const WHEEL_FINE_S = 0.01;
const EXPORT_TICK_MS = 120;
const EXPORT_STEP = 0.07;
const EXTRACT_TICK_MS = 200;
export const PERCENT = 100;

export const T = (S.ui.tools = {
  clickVol: 60, accent: 'auto', custom: 4, groups: '', sound: 'Classic', groupWarn: '',
  format: 'WAV', withClick: false, withCount: false, master: true, exporting: null, exportError: '',
  notice: null, saved: '', extract: null, tool: 'move', ripple: true, snap: true, bar: BEATS_PER_BAR, barFrom: 0, grid: null,
});

// ── Shared bits ──
let noticeTimer;
export function notice(text, action = null) {
  T.notice = { text, action };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { T.notice = null; update('main'); }, NOTICE_MS);
  update('main');
}
function markSaved() {
  T.saved = 'Saving';
  setTimeout(() => { T.saved = 'Saved'; update('main'); }, SAVING_MS);
  setTimeout(() => { T.saved = ''; update('main'); }, SAVING_MS + SAVED_MS);
}
export const runAct = (name, ...args) => { const res = actions[name]({}, ...args); if (res !== false) update(...(res || [])); };
export const typing = el => !!el.matches && el.matches('input:not([type="range"]), textarea, select, [contenteditable="true"]');
export const dlgHead = title => `<div class="dlg__head"><h3>${esc(title)}</h3><button class="iconbtn" data-act="closeDialog" title="Close (Esc)">${icon('x', 18)}</button></div>`;
export const dlgFoot = (saveAct, extra = '') => `<div class="dlg__foot">${extra}<div class="sp"></div><button class="btn" data-act="closeDialog">Cancel</button><button class="btn btn--accent" data-act="${saveAct}">Save</button></div>`;
export const dlgInput = (name, value, label, disabled = false) => `<label class="lbl">${label}</label><input class="input" data-input="toolField:${name}" value="${esc(value)}" ${disabled ? 'disabled' : ''} autocomplete="off">`;
export const dlgValue = (name, fallback) => S.ui.dialog?.values?.[name] ?? fallback;
act('toolField', (ctx, name, value) => { S.ui.dialog.values = { ...S.ui.dialog.values, [name]: value }; return false; });
const nativeSelect = (inputAct, value, options, title) => `<select class="select" data-input="${inputAct}" title="${title}">${options.map(([v, label, off]) => `<option value="${v}" ${v === value ? 'selected' : ''} ${off ? 'disabled' : ''}>${label}</option>`).join('')}</select>`;
const parseTime = text => { const m = String(text).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
const fmtMs = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
let suppressClick = false;

// ── Loop ──
const loopBounds = s => S.loop || { a: s.dur * DEFAULT_LOOP[0], b: s.dur * DEFAULT_LOOP[1] };
const loopField = (edge, label, s) => `<label class="stl__f"><span class="lbl">${label}</span><input class="input mono" data-commit data-loopf="${edge}" ${s ? '' : 'disabled'} value="${s ? fmtMs(loopBounds(s)[edge]) : ''}" placeholder="0:00.000" aria-label="${label}" autocomplete="off"></label>`;
registerPop('loop', () => {
  const s = playSong();
  return `<div class="stl stl--loop"><div class="stl__h"><h3>Loop</h3>${s ? toggle(S.loopOn, 'loop', 'Loop on or off') : ''}</div>
    <div class="stl__pair" title="Exact loop start / end (mm:ss.mmm or seconds)">${loopField('a', 'Loop start', s)}${loopField('b', 'Loop end', s)}</div>
    <div class="hint">Loop start/end · scroll. Type a time, then Enter.</div>
    <div class="stl__btns"><button class="btn" ${s ? '' : 'disabled'} data-act="loopEdge:a">Set start here ${kbd('I')}</button><button class="btn" ${s ? '' : 'disabled'} data-act="loopEdge:b">Set end here ${kbd('O')}</button></div>
    <button class="btn btn--quiet stl__wide" ${S.loop ? '' : 'disabled'} data-act="loopClear">${icon('x', 14)} Clear loop</button></div>`;
});
function setLoop(a, b) { S.loop = { a, b }; S.loopOn = true; }
function setEdge(edge) {
  const s = playSong();
  if (!s) return;
  const { a, b } = loopBounds(s);
  if (edge === 'a') setLoop(clamp(S.t, 0, b - MIN_SECTION_S), b);
  else setLoop(a, clamp(S.t, a + MIN_SECTION_S, s.dur));
}
act('loopEdge', (ctx, edge) => { setEdge(edge); return ['footer', 'main', 'stage', 'overlays']; });
act('loopClear', () => { S.loop = null; S.loopOn = false; });
function commitLoopField(el) {
  const s = playSong();
  const next = { ...loopBounds(s), [el.dataset.loopf]: parseTime(el.value) };
  if (Number.isNaN(next[el.dataset.loopf]) || next.a < 0 || next.b > s.dur || next.b - next.a < MIN_LOOP_S) { el.value = fmtMs(loopBounds(s)[el.dataset.loopf]); return; }
  setLoop(next.a, next.b);
  update('footer', 'main', 'stage', 'overlays');
}
function nudgeLoopField(el, e) {
  const s = playSong();
  const charW = parseFloat(getComputedStyle(el).fontSize) * 0.6;
  const at = (e.offsetX - parseFloat(getComputedStyle(el).paddingLeft)) / charW;
  const step = (at > el.value.indexOf('.') ? WHEEL_FINE_S : WHEEL_COARSE_S) * (e.deltaY < 0 ? 1 : -1);
  const next = { ...loopBounds(s) };
  next[el.dataset.loopf] = Math.round((next[el.dataset.loopf] + step) * 1000) / 1000;
  if (next.a < 0 || next.b > s.dur || next.b - next.a < MIN_LOOP_S) return;
  setLoop(next.a, next.b);
  el.value = fmtMs(next[el.dataset.loopf]);
  update('footer', 'main', 'stage');
}
document.addEventListener('wheel', e => { const el = e.target.closest?.('[data-loopf]'); if (el && !el.disabled) { e.preventDefault(); nudgeLoopField(el, e); } }, { passive: false });

// ── Export ──
const FORMATS = ['WAV', 'MP3', 'FLAC', 'OGG', 'MP4'];
const LOSSY = ['MP3', 'OGG'];
const hasVideo = s => !!s.source;
const videoFailed = s => [...s.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 3 === 0;
const xrow = (act, title, sub, disabled = false) => `<button class="xrow" ${disabled ? 'disabled aria-disabled="true"' : ''} data-act="${act}"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</button>`;
export const titled = (title, html) => `<div title="${title}">${html}</div>`;
function exportOptions(s) {
  const lossy = LOSSY.includes(T.format);
  return `${titled('Mix the click track into the exported file', check(T.withClick, 'exportOpt:withClick', 'Include click track'))}
    ${titled('Prepend one bar of count-in click before the audio', check(T.withCount, 'exportOpt:withCount', 'Add count-in (1 bar)'))}
    ${titled('Master the exported mix to this loudness', check(T.master, 'exportOpt:master', `Master <span class="mono dim">−14 LUFS · ${lossy ? '−1.5' : '−1'} dBTP</span>`))}`;
}
registerPop('export', () => {
  const s = viewSong();
  if (!s) return '<div class="empty">Open a song to export it.</div>';
  if (T.exporting) return `<div class="stl stl--export"><h3>Exporting…</h3><div class="hint">${esc(T.exporting.label)}</div><div class="bar stl__bar"><i style="width:${T.exporting.p * PERCENT}%"></i></div></div>`;
  const mp4 = T.format === 'MP4' && hasVideo(s);
  const region = S.loopOn && S.loop;
  return `<div class="stl stl--export" aria-label="Export options"><h3>Export</h3>
    <div class="seg" role="radiogroup" aria-label="Format">${FORMATS.filter(f => f !== 'MP4' || hasVideo(s)).map(f => `<button role="radio" aria-checked="${T.format === f}" class="${T.format === f ? 'is-on' : ''}" data-act="exportFormat:${f}">${f}</button>`).join('')}</div>
    ${mp4 && videoFailed(s) ? '<div class="stl__warn">MP4 export is unavailable: the video could not be fetched for this track. The audio stems are unaffected.</div>' : ''}
    ${mp4 ? '' : exportOptions(s)}
    ${T.exportError ? `<div class="stl__warn">${T.exportError}</div>` : ''}
    <div class="stl__rows">${xrow('export:mix', 'Export Mix', mp4 ? 'With the original video' : 'The stems you hear, as one file', mp4 && videoFailed(s))}
    ${mp4 ? '' : xrow('export:stems', 'Export All Stems', 'All stems as a .zip') + xrow('export:player', 'Export for Another Player', 'Stems, beats, lyrics and mix in one file')
      + xrow('export:region', 'Export Current Region', region ? fmt(S.loop.a) + ' – ' + fmt(S.loop.b) : 'Turn Loop on to export a region', !region)}</div></div>`;
});
act('exportFormat', (ctx, f) => { T.format = f; T.exportError = ''; return ['overlays']; });
act('exportOpt', (ctx, key) => { T[key] = !T[key]; return ['overlays']; });
const EXPORTS = {
  mix: s => ['Export Mix', s.title + '.' + T.format.toLowerCase()], stems: s => ['Export All Stems', s.title + ' stems.zip'],
  player: s => ['Export for Another Player', s.title + '.stemdeck.zip'], region: s => ['Export Current Region', `${s.title} ${fmt(S.loop.a)}-${fmt(S.loop.b)}.${T.format.toLowerCase()}`],
};
act('export', (ctx, kind) => {
  if (kind === 'mix' && !STEMS.some(st => audible(st.id))) { T.exportError = 'All stems are muted - nothing to export.'; return ['overlays']; }
  const [label, file] = EXPORTS[kind](viewSong());
  T.exportError = '';
  T.exporting = { label, p: 0 };
  const timer = setInterval(() => {
    T.exporting.p = Math.min(1, T.exporting.p + EXPORT_STEP);
    if (T.exporting.p >= 1) { clearInterval(timer); T.exporting = null; S.ui.pop = null; notice('Exported ' + file); }
    update('overlays');
  }, EXPORT_TICK_MS);
  return ['overlays'];
});

// ── Click and count-in ──
const ACCENTS = ['off', '2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'];
const SOUNDS = ['Classic', 'Woodblock', 'Rimshot', 'Soft', 'Cowbell'];
const GROUP_HINTS = { 5: '3+2', 6: '3+3', 7: '3+2+2', 9: '3+3+3', 12: '3+3+3+3' };
const accentBeats = () => ({ auto: T.bar, off: 0, custom: T.custom })[T.accent] ?? Number(T.accent.split('/')[0]);
function clickNote(s) {
  const bpm = Math.round(s.bpm * S.speed);
  const n = accentBeats();
  if (!n) return `Clicking ${bpm} BPM.`;
  return T.groups ? `Clicking ${bpm} BPM, counting ${n} in ${T.groups}.` : `Clicking ${bpm} BPM, accenting every ${n} beats.`;
}
registerPop('click', () => {
  const s = playSong();
  if (!s) return '<div class="stl"><h3>Click track</h3><div class="hint">Load a track to use the click</div></div>';
  const n = accentBeats();
  const accents = [['auto', 'Auto · ' + T.bar], ...ACCENTS.map(a => [a, a === 'off' ? 'Off' : a]), ['custom', 'Custom...']];
  return `<div class="stl stl--click"><div class="stl__h"><h3>Click track</h3>${toggle(S.click, 'toggle:click', 'Click track (K)')}</div>
    <label class="stl__f"><span class="lbl" data-clickvol>Click volume: ${T.clickVol}%</span><input class="vol" type="range" min="0" max="100" step="5" value="${T.clickVol}" data-input="clickVol" style="--c:var(--text-2);--vol:${T.clickVol / PERCENT}" title="Click volume: ${T.clickVol}%"></label>
    <div class="stl__pair"><label class="stl__f"><span class="lbl">Accent</span>${nativeSelect('clickAccent', T.accent, accents, 'Accent')}</label>
      ${T.accent === 'custom' ? `<label class="stl__f"><span class="lbl">Custom</span><input class="input mono" type="number" min="1" max="${MAX_BAR}" value="${T.custom}" data-input="clickCustom" title="Beats between accents" aria-label="Beats between accents"></label>` : ''}</div>
    ${n >= 5 ? `<label class="stl__f"><span class="lbl">Groups</span><input class="input mono" data-commit data-groups value="${esc(T.groups)}" placeholder="${GROUP_HINTS[n] || '3+2+2'}" title="How the bar divides, e.g. 3+2+2. Blank uses the usual grouping for the meter." autocomplete="off"></label>` : ''}
    ${T.groupWarn ? `<div class="stl__warn">${T.groupWarn}</div>` : ''}
    <label class="stl__f"><span class="lbl">Sound</span>${nativeSelect('clickSound', T.sound, SOUNDS.map(x => [x, 'Sound: ' + x]), 'Click sound')}</label>
    <div class="hint" title="Use ÷2 or ×2 in the Tempo tab if the click feels half or double speed.">${clickNote(s)}</div>
    <button class="linkbtn" data-act="tab:tempo">Tempo and grid… ${icon('chevron-right', 13)}</button></div>`;
});
act('clickVol', (ctx, v) => {
  T.clickVol = Number(v);
  ctx.el.style.setProperty('--vol', T.clickVol / PERCENT);
  ctx.el.closest('.stl').querySelector('[data-clickvol]').textContent = `Click volume: ${T.clickVol}%`;
  return false;
});
act('clickAccent', (ctx, v) => { T.accent = v; T.groups = ''; return ['overlays']; });
act('clickCustom', (ctx, v) => { const n = Number(v); if (v !== '') T.custom = Number.isInteger(n) && n >= 1 && n <= MAX_BAR ? n : BEATS_PER_BAR; return ['overlays']; });
act('clickSound', (ctx, v) => { T.sound = v; return false; });
function commitGroups(el) {
  const parts = el.value.split('+').map(Number);
  const ok = !el.value.trim() || parts.every(p => p > 0) && parts.reduce((a, b) => a + b, 0) === accentBeats();
  if (ok) { T.groups = el.value.trim(); update('overlays'); return; }
  T.groupWarn = `A grouping has to add up to ${accentBeats()}.`;
  setTimeout(() => { T.groupWarn = ''; update('overlays'); }, NOTICE_MS);
  update('overlays');
}
const countLabel = n => (n ? `Count-in: ${n} bar${n > 1 ? 's' : ''}` : 'Count-in: off');
registerPop('countin', () => `<div class="menu stl-menu" role="menu" title="Bars of click before the song starts when you press play. Plays even with the click track off."><div class="menu__h">Count-in</div>
  ${[0, 1, 2, 3, 4].map(n => `<button role="menuitemradio" aria-checked="${S.countIn === n}" data-act="countIn:${n}">${icon(S.countIn === n ? 'check' : '', 15)}<span class="ell">${countLabel(n)}</span></button>`).join('')}
  <div class="hint stl__cap">Plays even with the click track off</div></div>`);
act('countIn', (ctx, n) => { S.countIn = Number(n); S.ui.pop = null; });

// ── Versions ──
registerPop('versions', () => {
  const s = viewSong();
  return `<div class="menu stl-menu" role="menu"><div class="menu__h">Versions</div>${s.versions.map(v => `<button role="menuitemradio" aria-checked="${s.version === v.id}" data-act="pickVersion:${s.id}:${v.id}">${icon(s.version === v.id ? 'check' : '', 15)}<span class="ell">${esc(v.name)}</span></button>`).join('')}
    <hr><button data-act="saveVersion:${s.id}">${icon('plus', 15)}<span class="ell">Save as new version</span></button></div>`;
});
act('pickVersion', (ctx, id, v) => { song(id).version = v; S.ui.pop = null; });
act('saveVersion', (ctx, id) => {
  const s = song(id);
  s.versions.push({ id: 'v' + Date.now(), name: 'Version ' + (s.versions.length + 1) });
  s.version = s.versions.at(-1).id;
  Object.assign(S.ui, { pop: null, dialog: { id: 'versionName', arg: id } });
});
registerDialog('versionName', d => {
  const v = song(d.arg).versions.find(x => x.id === song(d.arg).version);
  return dlgHead('Name this version') + `<div class="dlg__body">${dlgInput('name', v.name, 'Version name')}<div class="hint">The new version starts with the current mix.</div></div>` + dlgFoot('saveVersionName:' + d.arg);
});
act('saveVersionName', (ctx, id) => { const s = song(id); const v = s.versions.find(x => x.id === s.version); v.name = dlgValue('name', v.name).trim() || v.name; S.ui.dialog = null; });

// ── Sections ──
const PLACEHOLDER = '';
const secData = () => dataOf(S.playId);
const hasSections = d => !(d.sections.length === 1 && d.sections[0].placeholder);
registerPop('sections', () => {
  const d = S.playId && secData();
  return `<div class="stl stl--sections"><h3>Sections</h3>
    <div class="stl__btns"><button class="btn" ${d ? '' : 'disabled'} data-act="addSection" aria-label="Add section">${icon('plus', 14)} Add section</button>
      ${d && hasSections(d) ? `<button class="btn ${armed('clearSections') ? 'is-danger' : ''}" data-act="clearSections" aria-label="Clear all sections">${armed('clearSections') ? 'Confirm?' : 'Clear'}</button>` : ''}</div>
    <div class="hint">Add uses the loop when Loop is on; otherwise it starts at the playhead.</div>
    <div class="hint">Double-click a section to rename it, lock its position or delete it. Drag a section to move it, or its edge to resize it.</div>
    <button class="btn btn--quiet stl__wide" data-act="flip:sectionsShown" title="Hide the sections bar. Collapse > Sections brings it back.">${icon(S.ui.sectionsShown ? 'minimize-2' : 'maximize-2', 14)} ${S.ui.sectionsShown ? 'Hide the sections bar' : 'Show the sections bar'}</button>
    <div class="stl__note" title="Experimental. Labels intro, verse and chorus while a track is imported…"><b>Detect structure</b><span>Lives in Add song. Tick it there to label intro, verse and chorus on the next import; it does not show or hide this bar.</span></div></div>`;
});
function reshare(d, s) { d.sections.forEach(sec => { sec.share = (sec.b - sec.a) / s.dur; }); if (S.loop) delete S.loop.i; markSaved(); }
function carve(d, k, a, b) {
  const sec = d.sections[k];
  const fresh = { name: 'Section', a, b, energy: sec.energy, locked: false };
  const pieces = [{ ...sec, b: a }, fresh, { ...sec, a: b }].filter(p => p === fresh || p.b - p.a >= MIN_SECTION_S);
  fresh.a = pieces[0] === fresh ? sec.a : a;
  fresh.b = pieces.at(-1) === fresh ? sec.b : b;
  d.sections.splice(k, 1, ...pieces);
  return d.sections.indexOf(fresh);
}
function sectionSpan(d, s) {
  if (S.loopOn && S.loop) {
    if (S.loop.b - S.loop.a < MIN_SECTION_S) return 'Loop too short for a section';
    const k = d.sections.findIndex(sec => sec.a <= S.loop.a && S.loop.b <= sec.b);
    return k >= 0 && (d.sections[k].placeholder || !d.sections[k].locked) ? [k, S.loop.a, S.loop.b] : 'Loop overlaps a section';
  }
  const k = d.sections.findIndex(sec => S.t < sec.b);
  const sec = d.sections[k];
  const b = Math.min(sec.b, S.t + s.dur * NEW_SECTION_SHARE);
  return sec.locked || b - S.t < MIN_SECTION_S ? 'No room left. Shorten or delete a section.' : [k, S.t, b];
}
act('addSection', () => {
  const d = secData();
  const span = sectionSpan(d, playSong());
  if (typeof span === 'string') { notice(span); return false; }
  const i = carve(d, ...span);
  reshare(d, playSong());
  S.ui.pop = null;
  S.ui.dialog = { id: 'section', arg: i };
});
function emptySections() {
  secData().sections = [{ name: PLACEHOLDER, a: 0, b: playSong().dur, share: 1, energy: 0, locked: false, placeholder: true }];
  if (S.loop) delete S.loop.i;
  markSaved();
}
act('clearSections', () => arm('clearSections', () => { emptySections(); update(); }));
act('renameSection', (ctx, i) => { S.ui.dialog = { id: 'section', arg: Number(i) }; S.ui.pop = null; S.ui.menu = null; });
registerDialog('section', dlg => {
  const sec = secData().sections[dlg.arg];
  if (!sec) return dlgHead('Section') + '<div class="dlg__body"><div class="empty">This section is gone.</div></div>';
  return dlgHead('Edit section') + `<div class="dlg__body">${dlgInput('name', sec.name, 'Name', sec.locked)}
    <div class="hint">${sec.locked ? 'Unlock the position to rename, move or resize this section.' : 'Enter saves · Esc cancels. An empty name keeps the old one.'}</div>
    <div class="frow"><div class="frow__l"><b>Lock position</b><span>A locked section can still be clicked, looped and deleted.</span></div><div class="frow__c">${toggle(sec.locked, 'lockSection:' + dlg.arg, sec.locked ? 'Unlock position' : 'Lock position')}</div></div></div>`
    + dlgFoot('saveSection:' + dlg.arg, `<button class="btn is-danger" data-act="deleteSection:${dlg.arg}" aria-label="Delete section">${icon('trash-2', 14)} Delete section</button>`);
});
act('lockSection', (ctx, i) => { const sec = secData().sections[i]; sec.locked = !sec.locked; markSaved(); });
act('saveSection', (ctx, i) => {
  const sec = secData().sections[i];
  const name = dlgValue('name', sec.name).trim();
  if (name && name !== sec.name && !sec.locked) { sec.name = name.slice(0, PERCENT); sec.placeholder = false; markSaved(); }
  S.ui.dialog = null;
});
act('deleteSection', (ctx, i) => {
  const d = secData();
  const k = Number(i);
  S.ui.dialog = null;
  if (d.sections.length === 1) return emptySections();
  const into = d.sections[k - 1] || d.sections[k + 1];
  if (k > 0) into.b = d.sections[k].b; else into.a = d.sections[k].a;
  d.sections.splice(k, 1);
  reshare(d, playSong());
});

// Contiguous sections: moving or resizing one moves the shared edge with its neighbour.
let secDrag = null;
function dragSection(sec, prev, next, dt) {
  const { mode, a, b } = secDrag;
  if (mode === 'a' && prev) sec.a = clamp(a + dt, prev.a + MIN_SECTION_S, sec.b - MIN_SECTION_S);
  if (mode === 'b' && next) sec.b = clamp(b + dt, sec.a + MIN_SECTION_S, next.b - MIN_SECTION_S);
  if (mode === 'move' && prev && next) { sec.a = clamp(a + dt, prev.a + MIN_SECTION_S, next.b - MIN_SECTION_S - (b - a)); sec.b = sec.a + b - a; }
  if (prev) prev.b = sec.a;
  if (next) next.a = sec.b;
}
document.addEventListener('pointerdown', e => {
  const el = e.target.closest?.('[data-region="main"] .secs .sec[data-act]');
  if (!el || e.button !== 0 || S.ui.guide || e.target.closest('button')) return;
  const sec = secData().sections[el.dataset.sec];
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  secDrag = { i: Number(el.dataset.sec), mode: x < EDGE_PX ? 'a' : x > r.width - EDGE_PX ? 'b' : 'move', x0: e.clientX, perS: el.parentElement.clientWidth / playSong().dur, a: sec.a, b: sec.b, moved: false };
});
document.addEventListener('pointermove', e => {
  if (!secDrag || (!secDrag.moved && Math.abs(e.clientX - secDrag.x0) < DRAG_PX)) return;
  secDrag.moved = true;
  const d = secData();
  const sec = d.sections[secDrag.i];
  if (sec.locked || sec.placeholder) return;
  dragSection(sec, d.sections[secDrag.i - 1], d.sections[secDrag.i + 1], (e.clientX - secDrag.x0) / secDrag.perS);
  d.sections.forEach(x => { x.share = (x.b - x.a) / playSong().dur; });
  update('main');
});
document.addEventListener('pointerup', () => {
  if (secDrag?.moved) { suppressClick = true; reshare(secData(), playSong()); }
  secDrag = null;
});
document.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);

// ── Beat grid editor ──
const TOOLS = {
  move: { label: 'Move', icon: 'move-h', title: 'Drag beats', hint: 'Drag a beat to retime the region. Alt-drag moves one beat.' },
  add: { label: 'Add', icon: 'plus', title: 'Click to add a beat', hint: 'Click where a beat is missing to add one. Right-click works in any tool.' },
  delete: { label: 'Delete', icon: 'eraser', title: 'Click a beat to remove it', hint: 'Click a beat to remove it. Right-click works in any tool.' },
  bar: { label: 'Bar line', icon: 'bar-line', title: 'Click a beat to mark it as a downbeat', hint: 'Click a beat to start a bar there. The bars after it follow the Bar number.' },
};
const detectedBeats = s => Array.from({ length: Math.floor((s.dur * s.bpm) / 60) }, (_, i) => ({ t: (i * 60) / s.bpm, down: i % BEATS_PER_BAR === 0 }));
const onsets = s => detectedBeats(s).map((b, i) => b.t + (((i * 7) % 5) - 2) * ONSET_JITTER_S);
function grid() {
  const s = playSong();
  if (T.grid?.id !== s.id) T.grid = { id: s.id, beats: detectedBeats(s), undo: [], redo: [] };
  return T.grid;
}
function editGrid(fn) { const g = grid(); g.undo.push(JSON.stringify(g.beats)); g.redo = []; fn(g.beats); }
function snapT(t) {
  if (!T.snap) return t;
  const near = onsets(playSong()).reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);
  return Math.abs(near - t) <= SNAP_S ? near : t;
}
function nearestBeat(t, widthPx) {
  const s = playSong();
  let best = -1;
  grid().beats.forEach((b, i) => { if (best < 0 || Math.abs(b.t - t) < Math.abs(grid().beats[best].t - t)) best = i; });
  return best >= 0 && (Math.abs(grid().beats[best].t - t) * widthPx) / s.dur <= HIT_PX ? best : -1;
}
const findDown = (beats, i, dir) => { for (let j = i + dir; j >= 0 && j < beats.length; j += dir) if (beats[j].down) return j; return -1; };
function moveBeat(beats, i, t, ripple) {
  const p = ripple ? findDown(beats, i, -1) : -1;
  const q = ripple ? findDown(beats, i, 1) : -1;
  const lo = (p >= 0 ? beats[p] : beats[i - 1])?.t ?? 0;
  const hi = (q >= 0 ? beats[q] : beats[i + 1])?.t ?? playSong().dur;
  const shift = clamp(t, lo + MIN_BEAT_S, hi - MIN_BEAT_S) - beats[i].t;
  beats.forEach((b, j) => {
    if (j === i) b.t += shift;
    else if (p >= 0 && j > p && j < i) b.t += (shift * (j - p)) / (i - p);
    else if (q >= 0 && j > i && j < q) b.t += (shift * (q - j)) / (q - i);
  });
}
const barsFrom = (beats, from) => beats.forEach((b, j) => { if (j >= from) b.down = (j - from) % T.bar === 0; });
function gridBar() {
  const g = grid();
  const tool = ([id, t]) => `<button role="radio" aria-checked="${T.tool === id}" class="${T.tool === id ? 'is-on' : ''}" data-act="gridTool:${id}" title="${t.title}">${icon(t.icon, 14)}${t.label}</button>`;
  return `<div class="gridbar"><div class="gridbar__row" role="toolbar" aria-label="Beat grid editor"><span class="lbl">Grid</span><div class="seg" role="radiogroup" aria-label="Tool">${Object.entries(TOOLS).map(tool).join('')}</div>
    ${titled('A drag re-spaces the beats up to the bar lines on either side. Alt-drag inverts it for one drag.', check(T.ripple, 'gridOpt:ripple', 'Ripple'))}
    ${titled('Snap to detected onsets', check(T.snap, 'gridOpt:snap', 'Snap'))}
    <label class="gridbar__bar">Bar<input class="input mono" type="number" min="1" max="${MAX_BAR}" value="${T.bar}" data-input="gridBarLen" aria-label="Beats per bar in this region"></label>
    <button class="iconbtn iconbtn--sm" ${g.undo.length ? '' : 'disabled'} data-act="gridUndo" title="Undo (Cmd/Ctrl+Z)">${icon('undo', 15)}</button><button class="iconbtn iconbtn--sm" ${g.redo.length ? '' : 'disabled'} data-act="gridRedo" title="Redo (Cmd/Ctrl+Shift+Z)">${icon('redo', 15)}</button>
    <div class="sp"></div><button class="btn btn--quiet" data-act="gridReset" title="Discard all edits and restore the detected grid">Reset</button><button class="btn" data-act="gridDone">Done</button></div>
    <div class="hint">${TOOLS[T.tool].hint}</div></div>`;
}
function beatLines(s) {
  const beats = S.ui.gridEdit || T.grid?.id === s.id ? grid().beats : detectedBeats(s);
  const beatPx = ((document.querySelector('.wavearea')?.clientWidth || FALLBACK_WAVE_PX) * 60) / s.bpm / s.dur;
  const barEvery = Math.max(1, Math.ceil(MIN_LINE_PX / (beatPx * BEATS_PER_BAR)));
  const path = list => list.map(b => `M${b.t.toFixed(3)} 0V100`).join('');
  const beatPath = S.ui.gridEdit || beatPx >= MIN_LINE_PX ? `<path class="bgrid__beat" vector-effect="non-scaling-stroke" d="${path(beats.filter(b => !b.down))}"/>` : '';
  return `<svg class="bgrid" viewBox="0 0 ${s.dur} 100" preserveAspectRatio="none" aria-hidden="true">${beatPath}<path class="bgrid__bar" vector-effect="non-scaling-stroke" d="${path(beats.filter(b => b.down).filter((_, i) => i % barEvery === 0))}"/></svg>`;
}
const onsetTicks = s => `<svg class="bgrid__onsets" viewBox="0 0 ${s.dur} 100" preserveAspectRatio="none" aria-hidden="true"><path vector-effect="non-scaling-stroke" d="${onsets(s).map(t => `M${t.toFixed(3)} 0V100`).join('')}"/></svg>`;
const hitLayer = s => `<div class="bgrid__hit bgrid__hit--${T.tool}" data-gridhit data-act="gridClick" data-ctx="gridDel" data-help="${TOOLS[T.tool].hint}">${T.snap ? onsetTicks(s) : ''}</div>`;
const pointerT = ctx => { const r = ctx.el.getBoundingClientRect(); return [clamp((ctx.event.clientX - r.left) / r.width, 0, 1) * playSong().dur, r.width]; };
act('gridTool', (ctx, id) => { T.tool = id; return ['main']; });
act('gridOpt', (ctx, key) => { T[key] = !T[key]; return ['main']; });
act('gridClick', ctx => {
  const [t, w] = pointerT(ctx);
  const i = nearestBeat(t, w);
  if (T.tool === 'add' && i < 0) editGrid(b => { b.push({ t: snapT(t), down: false }); b.sort((x, y) => x.t - y.t); });
  else if (T.tool === 'delete' && i >= 0) editGrid(b => b.splice(i, 1));
  else if (T.tool === 'bar' && i >= 0) { T.barFrom = i; editGrid(b => barsFrom(b, i)); } else return false;
  return ['main'];
});
act('gridDel', ctx => { const i = nearestBeat(...pointerT(ctx)); if (i < 0) return false; editGrid(b => b.splice(i, 1)); return ['main']; });
act('gridBarLen', (ctx, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > MAX_BAR) return false; T.bar = n; editGrid(b => barsFrom(b, T.barFrom)); return ['main']; });
const history = (from, to) => { const g = grid(); if (!g[from].length) return false; g[to].push(JSON.stringify(g.beats)); g.beats = JSON.parse(g[from].pop()); return ['main']; };
act('gridUndo', () => history('undo', 'redo'));
act('gridRedo', () => history('redo', 'undo'));
act('gridReset', () => { editGrid(b => b.splice(0, b.length, ...detectedBeats(playSong()))); T.bar = BEATS_PER_BAR; T.barFrom = 0; return ['main']; });
act('gridDone', () => { S.ui.gridEdit = false; });
act('gridEdit', () => { S.ui.gridEdit = !S.ui.gridEdit; gridOpened(); });
function gridOpened() { if (S.ui.gridEdit && playSong()) { S.click = true; grid(); } }
let beatDrag = null;
document.addEventListener('pointerdown', e => {
  const hit = e.target.closest?.('[data-gridhit]');
  if (!hit || T.tool !== 'move' || e.button !== 0) return;
  const r = hit.getBoundingClientRect();
  const i = nearestBeat(((e.clientX - r.left) / r.width) * playSong().dur, r.width);
  if (i >= 0) beatDrag = { i, r, x0: e.clientX, moved: false, ripple: T.ripple !== e.altKey, before: JSON.stringify(grid().beats) };
});
document.addEventListener('pointermove', e => {
  if (!beatDrag || (!beatDrag.moved && Math.abs(e.clientX - beatDrag.x0) < DRAG_PX)) return;
  beatDrag.moved = true;
  moveBeat(grid().beats, beatDrag.i, snapT(((e.clientX - beatDrag.r.left) / beatDrag.r.width) * playSong().dur), beatDrag.ripple);
  update('main');
});
document.addEventListener('pointerup', () => {
  if (beatDrag?.moved) { grid().undo.push(beatDrag.before); grid().redo = []; suppressClick = true; update('main'); }
  beatDrag = null;
});

// The click and the grid editor go together: opening turns the click on, the click off closes the editor.
const [baseToggle, baseFlip, baseSet] = [actions.toggle, actions.flip, actions.set];
act('toggle', (ctx, key) => { const res = baseToggle(ctx, key); if (key === 'click' && !S.click) S.ui.gridEdit = false; return res; });
act('flip', (ctx, key) => {
  const res = baseFlip(ctx, key);
  if (key === 'gridEdit') gridOpened();
  if (key === 'sectionsShown' && armed('clearSections')) S.ui.armed = null;
  return res;
});
act('set', (ctx, key, value) => { const res = baseSet(ctx, key, value); if (key === 'gridEdit') { S.ui.gridEdit = value === 'true' || value === true; gridOpened(); } return res; });

// ── Extract more stems: the label the header shows while it runs ──
const NEXT_PHASE = { wait: 'extract', extract: 'download', download: 'finish' };
const PHASE_STEP = { wait: 20, extract: 4, download: 12, finish: 25 };
const extractLabel = x => ({ wait: 'Waiting to extract', extract: `Extracting ${x.pct}%`, download: `Downloading ${x.pct}%`, finish: 'Finishing…' })[x.phase];
function stepExtract(x) {
  x.pct = Math.min(PERCENT, x.pct + PHASE_STEP[x.phase]);
  if (x.pct < PERCENT) return false;
  if (x.phase === 'finish') return true;
  Object.assign(x, { phase: NEXT_PHASE[x.phase], pct: 0 });
  return false;
}
act('extractMore', (ctx, id) => {
  if (T.extract) return false;
  T.extract = { id: id || S.viewId, phase: 'wait', pct: 0 };
  const timer = setInterval(() => { if (!T.extract || stepExtract(T.extract)) { clearInterval(timer); T.extract = null; } update('main'); }, EXTRACT_TICK_MS);
  S.ui.dialog = null;
});
act('stopExtract', () => { T.extract = null; });

// ── Hooks ──
registerHook('mainTop', () => {
  const extracting = T.extract && T.extract.id === S.viewId ? `<span class="tag" title="Extracting more stems for this song">${extractLabel(T.extract)}</span>` : '';
  const note = T.notice ? `<span>${esc(T.notice.text)}</span>${T.notice.action ? `<button class="linkbtn" data-act="${T.notice.action.act}">${esc(T.notice.action.label)}</button>` : ''}` : '';
  const bits = extracting + (T.saved ? `<span class="tnote__saved">${T.saved}</span>` : '') + note;
  return bits ? `<div class="tnote" role="status">${bits}</div>` : '';
});
registerHook('mainTop', () => (S.ui.gridEdit && playSong() && S.viewId === S.playId ? gridBar() : ''));
registerHook('laneOverlay', () => {
  const s = playSong();
  if (!s || !(S.ui.gridEdit || S.click)) return '';
  return `<div class="stl-ov">${beatLines(s)}${S.ui.gridEdit ? hitLayer(s) : ''}</div>`;
});

// ── Keys: I / O set the loop edges, grid undo and redo, Esc leaves the grid editor ──
function onToolKey(e) {
  if (typing(e.target) || S.ui.dialog || S.ui.browse) return;
  const k = e.key.toLowerCase();
  const own = fn => { e.preventDefault(); e.stopImmediatePropagation(); fn(); };
  if (S.ui.gridEdit && (e.ctrlKey || e.metaKey) && k === 'z') return own(() => runAct(e.shiftKey ? 'gridRedo' : 'gridUndo'));
  if (S.ui.gridEdit && (e.ctrlKey || e.metaKey) && k === 'y') return own(() => runAct('gridRedo'));
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape' && S.ui.gridEdit && !S.ui.menu && !S.ui.pop && !S.ui.error) return own(() => runAct('gridDone'));
  if ((k === 'i' || k === 'o') && S.loopOn && S.loop) own(() => runAct('loopEdge', k === 'i' ? 'a' : 'b'));
}
document.addEventListener('keydown', onToolKey);
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-commit]')) e.target.blur(); });
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.loopf) commitLoopField(el);
  else if (el.dataset.groups !== undefined) commitGroups(el);
});
