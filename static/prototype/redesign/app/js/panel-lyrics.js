// PROTOTYPE - throwaway. Lyrics tab: statuses, toolbar, Align, Sync lines, Edit lines and Paste or load.
import { S, act, actions, update, dataOf, playSong } from './store.js';
import { registerTab, registerMenu } from './slots.js';
import { icon, esc, fmt, clamp, emptyState, kbd, check } from './ui.js';

const STEP_MS = 120;
const SEARCH_MS = 1400;
const SAVE_MS = 600;
const ALIGN_STEP = 0.1;
const LEAD_IN_S = 2;
const MAX_PASTE = 20000;
const TRANSCRIBE_PHASES = [[0.1, 'Waiting for an import to finish…'], [0.3, 'Downloading the lyrics model…'], [0.4, 'Loading the lyrics model…'], [1, 'Transcribing lyrics…']];
const STATES = { found: 'Found', text: 'Text only', searching: 'Searching', none: 'None found', instrumental: 'Instrumental', candidates: 'Candidates', removed: 'Removed', notags: 'No tags', unreachable: 'Offline', failed: 'Lookup failed' };
const SOURCES = { file: 'From the file', transcribed: 'Transcribed', yours: 'Your lyrics' };
const CANDIDATES = [{ album: 'Live at Home', dur: 251 }, { album: 'Acoustic Sessions', dur: 198 }, { album: 'Radio Edit', dur: 214 }];

const L = (S.ui.lyrics ??= {
  state: 'found', mode: null, source: 'lrclib', original: null, versions: false, job: null, note: '', runs: 0,
  align: { offset: 0, base: null, clicked: null, msg: '' },
  sync: { next: 0, sel: null, leadIn: true, snap: true, later: false, kind: 'Their own timing', saving: '', history: [], msg: '' },
  edit: { lines: [], kept: false, saving: false }, drafts: {}, paste: { text: '', status: '', error: '' },
});

/** Advances job.pct on a timer; the effects are faked, so every job finishes the same way. */
export function runProgress(job, onDone, rate = 0.02) {
  const timer = setInterval(() => {
    if (job.cancelled) return clearInterval(timer);
    job.pct = Math.min(1, job.pct + rate);
    if (job.pct >= 1) { clearInterval(timer); onDone(); }
    update('panel');
  }, STEP_MS);
}
const later = (ms, fn) => setTimeout(() => { fn(); update('panel', 'main', 'stage'); }, ms);
const cycle = list => list[L.runs++ % list.length];
const pct = job => Math.round(job.pct * 100) + '%';
const progress = (label, job, cancelAct) => '<div class="pjob"><div class="pjob__t"><span>' + label + '</span><b class="mono">' + pct(job) + '</b></div><div class="pbar"><i style="width:' + pct(job) + '"></i></div>' + (cancelAct ? '<button class="btn btn--quiet pbtn" data-act="' + cancelAct + '">Cancel</button>' : '') + '</div>';
const lines = () => (S.playId ? dataOf(S.playId).lyrics : []);
const hasLines = () => L.state === 'found' || L.state === 'text';
const title = () => esc(playSong()?.title || '');

// ── Toolbar ──
function toolbarButtons() {
  const text = L.state === 'text';
  const noLyrics = !hasLines() && L.state !== 'searching' && L.state !== 'candidates';
  const remove = L.source === 'yours' && L.original
    ? { id: 'back', label: 'Back to original', act: 'lyRemove', tip: 'Drop your lyrics and return to the ones they replaced', quiet: true }
    : { id: 'remove', label: 'Remove lyrics', act: 'lyRemove', tip: 'Remove lyrics', quiet: true };
  return [
    hasLines() && { id: 'sync', label: 'Sync lines', act: 'lyMode:sync', on: L.mode === 'sync', disabled: text, tip: text ? 'Only lyrics with timing can be synced line by line. These are text only.' : 'Set when each line starts…' },
    hasLines() && { id: 'align', label: 'Align', act: 'lyMode:align', on: L.mode === 'align', disabled: text, tip: text ? 'Only synced lyrics can be aligned…' : 'Align lyrics to track' },
    hasLines() && { id: 'edit', label: 'Edit lines', act: 'lyMode:edit', on: L.mode === 'edit', tip: 'Correct the words: edit, add, delete or split lines' },
    noLyrics && !L.job && { id: 'transcribe', label: 'Transcribe lyrics', act: 'lyTranscribe', tip: 'Transcribe lyrics' },
    { id: 'paste', label: 'Paste or load lyrics', act: 'lyMode:paste', on: L.mode === 'paste', tip: 'Use your own lyrics for this track: paste them or load an .lrc or .txt file' },
    hasLines() && { id: 'versions', label: L.versions ? 'Hide other versions' : 'Other versions (' + CANDIDATES.length + ')', act: 'lyVersions', on: L.versions, quiet: true, tip: 'Other versions of these lyrics on LRCLIB' },
    hasLines() && remove,
  ].filter(Boolean);
}
const PRIMARY_ORDER = ['sync', 'edit', 'transcribe', 'paste'];
function toolbar() {
  const items = toolbarButtons();
  const lead = PRIMARY_ORDER.find(id => items.some(b => b.id === id && !b.disabled));
  const btn = b => '<button class="' + (b.quiet ? 'linkbtn' : 'btn pbtn') + (b.id === lead ? ' btn--lead' : '') + (b.on ? ' is-on' : '') + '" data-act="' + b.act + '" title="' + esc(b.tip) + '"' + (b.on !== undefined ? ' aria-pressed="' + !!b.on + '"' : '') + (b.disabled ? ' disabled' : '') + '>' + b.label + '</button>';
  const quiet = items.filter(b => b.quiet);
  return '<div class="lytools" role="toolbar" aria-label="Lyrics actions"><div class="ptools">' + items.filter(b => !b.quiet).map(btn).join('') + '</div>' + (quiet.length ? '<div class="ptools ptools--quiet">' + quiet.map(btn).join('') + '</div>' : '') + '</div>';
}
function matchHeader() {
  const s = playSong();
  const meta = [s.artist, s.album || 'Single', SOURCES[L.source]].filter(Boolean).map(esc).join(' · ');
  return '<div class="lyhead__m"><b class="ell">' + esc(s.title) + '</b><span class="ell">' + meta + '</span></div>';
}

// ── Statuses ──
const STATUS = {
  searching: () => '<p class="lystat">' + icon('search', 16) + 'Searching LRCLIB for “' + title() + '”…</p>',
  none: () => '<p class="lystat">No lyrics found for “' + title() + '”.</p>',
  notags: () => '<p class="lystat">This track has no artist or song tags. Save its band with the ⓘ button…</p>',
  unreachable: () => '<p class="lystat">Could not reach LRCLIB…</p><button class="btn pbtn" data-act="lyLookup">Try again</button>',
  failed: () => '<p class="lystat">Could not look up lyrics right now…</p>',
  instrumental: () => '<p class="lystat">This version is marked instrumental…</p>',
  candidates: () => '<p class="lystat">This song is on LRCLIB, but not in a version the same length… Pick the right one:</p>' + candidateList(),
  removed: () => '<p class="lystat">Lyrics removed for this track.</p><button class="btn pbtn" data-act="lyLookup">Look up again</button>',
};
const candidateList = () => '<div class="lycands">' + CANDIDATES.map((c, i) => '<button class="row" data-act="lyPick:' + i + '" title="Use these lyrics"><div class="row__txt"><div class="row__t ell">' + title() + '</div><div class="row__s ell">' + esc(playSong().artist) + ' · ' + c.album + '</div></div><span class="mono dim">' + fmt(c.dur) + '</span></button>').join('') + '</div>';

function transcribeBox() {
  if (L.job) return progress(TRANSCRIBE_PHASES.find(([end]) => L.job.pct <= end)[1], L.job, 'lyCancelJob');
  const note = L.note ? '<p class="lystat">' + L.note + '</p>' : '';
  return note + (toolbarButtons().some(b => b.id === 'transcribe') ? '<p class="hint">Transcribing on the CPU can take a few minutes.</p>' : '');
}

// ── Lines ──
function lineAct(l, i) {
  if (L.mode === 'sync') return 'lySyncLine:' + i;
  if (L.mode === 'align') return 'lyAlignPick:' + i;
  return 'seekTo:' + l.t.toFixed(2);
}
function lineHtml(l, i) {
  const untimed = L.state === 'text' || l.untimed;
  if (untimed) return '<p class="is-untimed">' + esc(l.text) + ' <span class="tag">needs timing</span></p>';
  const sel = L.mode === 'sync' && L.sync.sel === i;
  const time = L.mode === 'sync' || L.mode === 'align' ? '<span class="lytime mono">' + fmt(l.t) + '.' + String(Math.floor((l.t % 1) * 10)) + '</span>' : '';
  return '<p data-li="' + i + '" data-act="' + lineAct(l, i) + '" class="' + (sel ? 'is-sel' : '') + '">' + time + esc(l.text) + '</p>' + (sel ? lineTools(i) : '');
}
const NUDGES = [-0.25, -0.05, 0.05, 0.25];
const lineTools = i => '<div class="lyline-tools">' + NUDGES.map(d => '<button class="btn pbtn mono" data-act="lyNudge:' + i + ':' + d + '" title="Move this line ' + (d < 0 ? 'earlier' : 'later') + ' by ' + Math.abs(d) + ' s">' + (d > 0 ? '+' : '−') + Math.abs(d) + '</button>').join('') + '<button class="btn pbtn" data-act="lyAtPlayhead:' + i + '" title="Start this line at the playhead">Start at playhead</button></div>';
function untimedNote() {
  if (L.state === 'text') return '<p class="hint lynote">These lyrics have no timing yet.</p>';
  const n = lines().filter(l => l.untimed).length;
  return n ? '<p class="hint lynote">Lines needing timing: ' + n + ' <button class="linkbtn" data-act="lyMode:sync">Sync line by line</button></p>' : '';
}
const linesHtml = () => untimedNote() + '<div class="lylines" data-lyscroll data-scroll="lylines"><div class="ly ly--panel">' + lines().map(lineHtml).join('') + '</div></div>';

// ── Align ──
function alignTarget() {
  const i = L.align.clicked ?? 0;
  return '“' + esc(lines()[i]?.text || '') + '”';
}
function alignPanel() {
  const a = L.align;
  const off = (a.offset >= 0 ? '+' : '') + a.offset.toFixed(2);
  const perLine = L.sync.kind === 'Timed by you' ? '<p class="hint">These lines are timed one by one, so the offset does not apply.</p>' : '';
  return '<div class="pcard lybox"><div class="pcard__h"><b>Align</b><span class="sp"></span><button class="btn pbtn" data-act="lyMode:sync">Sync line by line</button></div>' +
    '<p class="hint">Play to where the first line is sung, then press Start lyrics here. Nudge until the lines land on the words.</p>' + perLine +
    '<button class="btn pbtn" data-act="lyAlignStart" title="Move the line named below to the playhead">Start lyrics here</button>' +
    '<p class="hint ell">' + (a.clicked === null ? 'Moves the first line: ' : 'Moves the line you clicked: ') + alignTarget() + '</p>' +
    '<div class="prow"><button class="iconbtn iconbtn--sm" data-act="lyOffset:-1" title="Earlier by ' + ALIGN_STEP + ' s">' + icon('minus', 14) + '</button><b class="mono preadout">' + off + ' s</b><button class="iconbtn iconbtn--sm" data-act="lyOffset:1" title="Later by ' + ALIGN_STEP + ' s">' + icon('plus', 14) + '</button><span class="sp"></span>' +
    '<button class="btn pbtn" data-act="lyDetect" title="Auto-detect"' + (a.job ? ' disabled' : '') + '>Auto-detect</button><button class="btn pbtn btn--quiet" data-act="lyOffsetReset" title="Back to the lyrics\' own timing">Reset</button></div>' +
    (a.job ? '<p class="hint">Checking the vocals…</p>' : a.msg ? '<p class="hint">' + a.msg + '</p>' : '') +
    '<div class="pcard__f"><button class="btn pbtn" data-act="lyMode:align" title="Close the panel. Changes are already saved.">Done</button></div></div>';
}

// ── Sync lines ──
function syncStatus() {
  const s = L.sync;
  const n = lines().length;
  return s.next < n ? '<p class="lysync__next">Next to tap · line ' + (s.next + 1) + ' of ' + n + '</p>' : '<p class="lysync__next">All lines tapped <span class="dim">Undo, or click a line to go on from it.</span></p>';
}
function syncPanel() {
  const s = L.sync;
  const retime = s.job ? '<p class="hint">Listening to the vocals… ' + pct(s.job) + '</p>' : s.msg ? '<p class="hint">' + s.msg + '</p>' : '';
  return '<div class="pcard lybox"><div class="pcard__h"><b>Sync lines</b><span class="chip pchip">' + s.kind + '</span><span class="sp"></span><span class="hint">' + s.saving + '</span></div>' + syncStatus() +
    '<div class="prow"><button class="btn pbtn btn--lead" data-act="lyTap" title="Tap when the next line starts">Tap ' + kbd('T / Enter') + '</button><button class="btn pbtn" data-act="lyUndo" title="Undo the last change (Backspace)"' + (s.history.length ? '' : ' disabled') + '>' + icon('undo', 14) + 'Undo</button></div>' +
    '<div class="pchecks">' + check(s.leadIn, 'lySyncOpt:leadIn', 'Lead-in') + check(s.snap, 'lySyncOpt:snap', 'Snap to voice') + check(s.later, 'lySyncOpt:later', 'Move later lines too') + '</div>' +
    '<div class="ptools"><button class="btn pbtn" data-act="lyRetime"' + (s.job ? ' disabled' : '') + ' title="Re-time from vocals">Re-time from vocals</button><button class="btn pbtn" data-act="lyResetDetected" title="Reset to detected">Reset to detected</button><button class="btn pbtn" data-act="lyResetOriginal" title="Reset to original"' + (L.source === 'yours' && !L.original ? ' disabled' : '') + '>Reset to original</button></div>' + retime +
    '<p class="hint pkeys">T or Enter: tap · Backspace: undo · ← →: nudge (Shift: more) · ↑ ↓: line · Esc: done</p>' +
    '<div class="pcard__f"><button class="btn pbtn" data-act="lyMode:sync">Done</button></div></div>';
}

// ── Edit lines and Paste or load ──
function editPanel() {
  const e = L.edit;
  const row = (text, i) => '<div class="lyedit__row"><textarea class="input lyedit__ta" rows="1" data-input="lyEditLine:' + i + '" data-lyedit="' + i + '" aria-label="Line ' + (i + 1) + '">' + esc(text) + '</textarea>' +
    '<button class="iconbtn iconbtn--sm" data-act="lyEditSplit:' + i + '" title="Split this line at the cursor">' + icon('chevron-down', 14) + '</button><button class="iconbtn iconbtn--sm" data-act="lyEditAdd:' + (i + 1) + '" title="Add a line below">' + icon('plus', 14) + '</button><button class="iconbtn iconbtn--sm" data-act="lyEditDel:' + i + '" title="Delete this line">' + icon('trash-2', 14) + '</button></div>';
  return '<div class="pcard lybox"><div class="pcard__h"><b>Edit lines</b></div>' + (e.kept ? '<p class="hint">Your unsaved changes for this track were kept.</p>' : '') +
    '<div class="lyedit">' + e.lines.map(row).join('') + '</div>' +
    '<div class="pcard__f"><button class="btn pbtn btn--quiet" data-act="lyEditAdd:' + e.lines.length + '">' + icon('plus', 14) + 'Add line</button><span class="sp"></span><button class="btn pbtn" data-act="lyCancelEdit">Cancel</button><button class="btn pbtn btn--lead" data-act="lyEditSave"' + (e.saving ? ' disabled' : '') + '>' + (e.saving ? 'Saving…' : 'Save') + '</button></div></div>';
}
function pastePanel() {
  const p = L.paste;
  return '<div class="pcard lybox"><div class="pcard__h"><b>Your own lyrics</b></div><p class="hint">Paste the words, or load an .lrc or .txt file.</p>' +
    '<textarea class="input lypaste" data-input="lyPasteText" placeholder="Paste lyrics here">' + esc(p.text) + '</textarea>' +
    (p.error ? '<p class="perr">' + p.error + '</p>' : p.status ? '<p class="hint">' + p.status + '</p>' : '') +
    '<div class="pcard__f"><button class="btn pbtn" data-act="menu:lyFile" title="Load an .lrc or .txt file">' + icon('upload', 14) + 'Load file</button><span class="sp"></span><button class="btn pbtn" data-act="lyCancelEdit">Cancel</button><button class="btn pbtn btn--lead" data-act="lyPasteSave"' + (p.text.trim() ? '' : ' disabled') + '>Save</button></div></div>';
}

// ── The tab ──
const switcher = () => '<div class="proto"><span class="lbl">Prototype: lyric state</span><div class="proto__chips">' + Object.entries(STATES).map(([id, label]) => '<button class="chip pchip ' + (L.state === id ? 'is-on' : '') + '" data-act="lyState:' + id + '" aria-pressed="' + (L.state === id) + '">' + label + '</button>').join('') + '</div></div>';
function body() {
  if (L.mode === 'edit') return editPanel();
  if (L.mode === 'paste') return pastePanel();
  if (!hasLines()) return (STATUS[L.state]?.() || '') + transcribeBox();
  const box = L.mode === 'align' ? alignPanel() : L.mode === 'sync' ? syncPanel() : '';
  const loading = dataOf(S.playId).lyricsState === 'loading' ? STATUS.searching() : '';
  return box + (L.versions ? '<div class="pcard lybox"><div class="pcard__h"><b>Other versions</b></div>' + candidateList() + '</div>' : '') + (loading || linesHtml());
}
registerTab('lyrics', 'Lyrics', () => {
  if (!S.playId) return emptyState('text', 'Open a track to find its lyrics.');
  return '<div class="lytab"><div class="lyhead">' + matchHeader() + toolbar() + '</div>' + body() + switcher() + '</div>';
});

// ── Actions ──
const closeModes = () => { L.mode = null; L.versions = false; };
const snapshot = () => { if (!L.original) L.original = lines().map(l => ({ ...l })); };
const setLines = list => { dataOf(S.playId).lyrics = list; S.lyIdx = -2; };
const saveFlash = () => { L.sync.saving = 'Saving…'; later(SAVE_MS, () => { L.sync.saving = 'Saved'; }); };
act('lyState', (ctx, id) => { L.state = id; L.job = null; L.note = ''; closeModes(); return ['panel']; });
act('lyVersions', () => { L.versions = !L.versions; return ['panel']; });
act('lyPick', () => { L.state = 'found'; L.source = 'lrclib'; L.versions = false; return ['panel']; });
act('lyLookup', () => { L.state = 'searching'; later(SEARCH_MS, () => { L.state = 'found'; L.source = 'lrclib'; }); return ['panel']; });
act('lyMode', (ctx, mode) => {
  if (L.mode === mode) { L.mode = null; return ['panel']; }
  L.mode = mode; L.versions = false;
  if (mode === 'align') Object.assign(L.align, { base: lines().map(l => l.t), offset: 0, clicked: null, msg: '' });
  if (mode === 'edit') { const draft = L.drafts[S.playId]; L.edit = { lines: draft || lines().map(l => l.text), kept: !!draft, saving: false }; }
  if (mode === 'paste') L.paste = { text: '', status: '', error: '' };
  return ['panel'];
});
act('lyCancelEdit', () => { delete L.drafts[S.playId]; L.mode = null; return ['panel']; });
act('lyRemove', () => {
  if (L.source === 'yours' && L.original) { setLines(L.original); L.original = null; L.source = 'lrclib'; L.state = 'found'; }
  else { L.state = 'removed'; L.source = 'lrclib'; }
  closeModes();
});
act('lyTranscribe', () => {
  L.note = ''; L.job = { pct: 0 };
  const failure = { instrumental: 'There is too little singing in this track to transcribe.', failed: 'The lyrics could not be transcribed.' }[L.state];
  runProgress(L.job, () => { L.job = null; if (failure) { L.note = failure; return; } L.state = 'found'; L.source = 'transcribed'; });
  return ['panel'];
});
act('lyCancelJob', () => { L.job.cancelled = true; L.job = null; return ['panel']; });

// Align
const shiftAll = () => { const { base, offset } = L.align; setLines(lines().map((l, i) => ({ ...l, t: Math.max(0, base[i] + offset) }))); };
act('lyAlignPick', (ctx, i) => { L.align.clicked = Number(i); S.t = lines()[i].t; return ['panel', 'footer']; });
act('lyAlignStart', () => { const { base, clicked } = L.align; L.align.offset = S.t - base[clicked ?? 0]; shiftAll(); return ['panel', 'main']; });
act('lyOffset', (ctx, d) => { L.align.offset = Math.round((L.align.offset + d * ALIGN_STEP) * 100) / 100; shiftAll(); return ['panel', 'main']; });
act('lyOffsetReset', () => { L.align.offset = 0; L.align.msg = ''; shiftAll(); return ['panel', 'main']; });
act('lyDetect', () => {
  const job = L.align.job = { pct: 0 };
  runProgress(job, () => {
    L.align.job = null;
    const found = 0.42;
    L.align.msg = cycle(['Moved to fit the vocals: +' + found + ' s.', 'Could not tell from the vocals…', 'Auto-detect is not available…']);
    if (L.align.msg.startsWith('Moved')) { L.align.offset = found; shiftAll(); }
  }, 0.08);
  return ['panel'];
});

// Sync lines
const nudgeLine = (i, d) => {
  const list = lines().map(l => ({ ...l }));
  const end = L.sync.later ? list.length : i + 1;
  for (let k = i; k < end; k++) list[k].t = Math.max(0, list[k].t + d);
  list[i].untimed = false;
  setLines(list);
};
const timeLine = (i, t) => { L.sync.history.push({ i, t: lines()[i].t, next: L.sync.next }); nudgeLine(i, t - lines()[i].t); L.sync.kind = 'Timed by you'; saveFlash(); };
act('lyTap', () => { const s = L.sync; if (s.next >= lines().length) return false; timeLine(s.next, S.t); s.sel = s.next; s.next += 1; return ['panel', 'main']; });
act('lyUndo', () => { const h = L.sync.history.pop(); if (!h) return false; nudgeLine(h.i, h.t - lines()[h.i].t); L.sync.next = h.next; L.sync.sel = h.i; saveFlash(); return ['panel', 'main']; });
act('lySyncLine', (ctx, i) => { const s = L.sync; s.sel = s.next = Number(i); S.t = Math.max(0, lines()[i].t - (s.leadIn ? LEAD_IN_S : 0)); return ['panel', 'footer']; });
act('lyNudge', (ctx, i, d) => { L.sync.history.push({ i: Number(i), t: lines()[i].t, next: L.sync.next }); nudgeLine(Number(i), Number(d)); L.sync.kind = 'Timed by you'; saveFlash(); return ['panel', 'main']; });
act('lyAtPlayhead', (ctx, i) => { timeLine(Number(i), S.t); return ['panel', 'main']; });
act('lySyncOpt', (ctx, key) => { L.sync[key] = !L.sync[key]; return ['panel']; });
act('lyRetime', () => {
  const job = L.sync.job = { pct: 0 };
  const n = lines().length;
  runProgress(job, () => {
    L.sync.job = null; L.sync.kind = 'Timed from the vocals';
    L.sync.msg = cycle(['Timed from the vocals: ' + (n - 2) + ' of ' + n + ' lines matched.', 'Timed from the vocals, but unsure about ' + Math.ceil(n / 4) + ' lines. Check them by ear.', 'Could not time the lines from the vocals.']);
  }, 0.05);
  return ['panel'];
});
act('lyResetDetected', () => {
  if (L.source === 'yours') { L.sync.msg = 'There is no detected timing to go back to. Try Re-time from vocals.'; return ['panel']; }
  L.sync.kind = 'Their own timing'; L.sync.msg = ''; L.sync.history = []; return ['panel'];
});
act('lyResetOriginal', () => { if (L.original) setLines(L.original.map(l => ({ ...l }))); L.sync.kind = 'Their own timing'; L.sync.history = []; return ['panel', 'main']; });

// Edit lines
const editLines = () => L.edit.lines;
const keepDraft = () => { L.drafts[S.playId] = editLines(); };
const caretOf = i => document.querySelector('[data-lyedit="' + i + '"]')?.selectionStart ?? editLines()[i].length;
act('lyEditLine', (ctx, i, value) => { editLines()[i] = value; keepDraft(); return false; });
act('lyEditAdd', (ctx, i) => { editLines().splice(Number(i), 0, ''); keepDraft(); return ['panel']; });
act('lyEditDel', (ctx, i) => { editLines().splice(Number(i), 1); keepDraft(); return ['panel']; });
act('lyEditSplit', (ctx, i) => { splitAt(Number(i), caretOf(i)); return ['panel']; });
function splitAt(i, at) { const text = editLines()[i]; editLines().splice(i, 1, text.slice(0, at).trimEnd(), text.slice(at).trimStart()); keepDraft(); }
act('lyEditSave', () => {
  L.edit.saving = true;
  later(SAVE_MS, () => {
    const old = lines();
    snapshot();
    setLines(editLines().filter(t => t.trim()).map((text, i) => (old[i] ? { ...old[i], text } : { t: old.at(-1)?.t || 0, text, untimed: true })));
    delete L.drafts[S.playId]; L.mode = null; L.source = 'yours';
  });
  return ['panel'];
});

// Paste or load
const FILES = {
  'sunday-set.lrc': { text: '[00:12.40]First line of the song\n[00:16.80]Second line of the song\n[00:21.10]Third line of the song' },
  'words.txt': { text: 'First line of the song\nSecond line of the song\nThird line of the song' },
  'chart.pdf': { error: 'Only .lrc and .txt files can be loaded.' },
  'old-encoding.txt': { error: 'This file is not UTF-8 text…' },
  'blank.txt': { error: 'This file is empty…' },
  'locked.lrc': { error: 'Could not read this file.' },
};
registerMenu('lyFile', () => [{ heading: 'Prototype: pick a file' }, ...Object.keys(FILES).map(name => ({ label: name, icon: 'file', act: 'lyLoad:' + name }))]);
act('lyLoad', (ctx, name) => { const f = FILES[name]; L.paste.error = f.error || ''; if (f.text) { L.paste.text = f.text; L.paste.status = 'Loaded “' + name + '”. Save to use it.'; } S.ui.menu = null; });
act('lyPasteText', (ctx, value) => { L.paste.text = value; L.paste.error = ''; return false; });
const LRC_LINE = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;
function parsePaste(text) {
  const rows = text.split('\n').map(r => r.trim()).filter(Boolean);
  const timed = rows.every(r => LRC_LINE.test(r));
  const list = rows.map((r, i) => { const m = r.match(LRC_LINE); return m ? { t: m[1] * 60 + Number(m[2]), text: m[3].trim() } : { t: i, text: r }; });
  return { timed, list };
}
act('lyPasteSave', () => {
  if (L.paste.text.length > MAX_PASTE) { L.paste.error = 'Too long…'; return ['panel']; }
  const { timed, list } = parsePaste(L.paste.text);
  if (hasLines()) snapshot();
  setLines(list); L.state = timed ? 'found' : 'text'; L.source = 'yours'; L.mode = null;
});

// Keys while Sync lines or Align is open; this module loads before main.js, so its listener runs first.
const typing = el => el.matches?.('input, textarea, select, [contenteditable="true"]');
const overlayOpen = () => S.ui.menu || S.ui.pop || S.ui.dialog || S.ui.error;
const SYNC_KEYS = {
  t: 'lyTap', enter: 'lyTap', backspace: 'lyUndo',
  arrowleft: e => 'lyNudge:' + L.sync.sel + ':' + (e.shiftKey ? -0.25 : -0.05),
  arrowright: e => 'lyNudge:' + L.sync.sel + ':' + (e.shiftKey ? 0.25 : 0.05),
  arrowup: () => 'lySyncLine:' + clamp((L.sync.sel ?? 0) - 1, 0, lines().length - 1),
  arrowdown: () => 'lySyncLine:' + clamp((L.sync.sel ?? -1) + 1, 0, lines().length - 1),
};
function runAct(str) { const [name, ...args] = str.split(':'); const res = actions[name]?.({}, ...args); if (res !== false) update(...(res || [])); }
function onLyricsKey(e) {
  if (!L.mode || S.ui.tab !== 'lyrics' || !S.ui.panel || overlayOpen() || typing(e.target)) return;
  if (e.key === 'Escape' && (L.mode === 'sync' || L.mode === 'align')) { L.mode = null; update('panel'); e.stopImmediatePropagation(); return; }
  const key = e.key.toLowerCase();
  if (L.mode !== 'sync' || !SYNC_KEYS[key] || (key === 'enter' && e.target.matches('button'))) return;
  if (key.startsWith('arrow') && (key === 'arrowleft' || key === 'arrowright') && L.sync.sel === null) return;
  const entry = SYNC_KEYS[key];
  e.preventDefault(); e.stopImmediatePropagation();
  runAct(typeof entry === 'function' ? entry(e) : entry);
}
function onEditKey(e) {
  const i = e.target.dataset?.lyedit;
  if (i === undefined || e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  splitAt(Number(i), e.target.selectionStart);
  update('panel');
  document.querySelector('[data-lyedit="' + (Number(i) + 1) + '"]')?.focus();
}
document.addEventListener('keydown', onLyricsKey);
document.addEventListener('keydown', onEditKey);
