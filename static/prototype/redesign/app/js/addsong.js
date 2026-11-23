// PROTOTYPE - throwaway. Getting songs in: the Add song popover, online search, batch review, the import queue and failed imports.
import { S, STEMS, act, actions, update, song, library, importing, playSong, arm, armed } from './store.js';
import { registerPop, registerDialog, registerBrowseView, registerHook } from './slots.js';
import { icon, esc, fmt, menuHtml, emptyState, registerIcons } from './ui.js';

registerIcons({ loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>' });

const MIN_QUERY = 2;
const MAX_RESULTS = 8;
const SEARCH_MS = 350;
const LOOKUP_MS = 1200;
const SUBMIT_MS = 700;
const SAVE_MS = 400;
const DROP_ERROR_MS = 6000;
const TICK_MS = 500;
const PREVIEW_TICK_MS = 250;
const STEP = 0.025;
const FAIL_AT = 0.5;
const PREVIEW_S = 30;
const LIMIT_MIN = 15;
const MAX_FILE_MB = 400;
const MB = 1024 * 1024;
const QUEUE_ROOM = 12;
const MAX_LINKS = 100;
const MAX_FILES = 500;
const PLAYLIST_PEEK = 3;
const NEXT_FROM = 2;
const COPIED_MS = 1500;
const RETURN_MS = 1500;
const START_MS = 900;
const CANCEL_MS = 900;
const FG_PHRASE_TICKS = 6;
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'mp4', 'm4a', 'ogg', 'opus'];
const PLACEHOLDER = 'Search, paste links, or drop files…';
const DETECT_TIP = 'Experimental. Labels intro, verse and chorus while a track is imported. Applies to the next import, not to a track that is already open. To hide the sections bar, use Collapse > Sections.';
const FULL_QUEUE = 'The queue is full. Wait for it to drain, or cancel something first.';
const FAIL_REASON = 'The download was interrupted. Check the connection, then retry.';
const TABS = { yt: 'YouTube songs', ytpl: 'YouTube playlists', sc: 'SoundCloud songs' };
const STAGES = [[0, 'Downloading'], [0.12, 'Separating stems'], [0.8, 'Finding tempo and key'], [0.94, 'Finishing']];
const FG_PHRASES = ['Fetching the audio again', 'Separating stems', 'Lining up the sections'];
const VARIANTS = ['', ' (Live)', ' - Acoustic', ' (Official Lyric Video)', ' | Full Concert', ' - Piano Cover', ' (Rehearsal Mix)', ' - Instrumental'];
const UPLOADERS = ['Bethel Music', 'Hillsong Worship', 'Elevation Worship', 'Maverick City Music', 'Live Sessions', 'Church Online', 'Acoustic Covers', 'Worship Together'];
const LONG_AT = 4;
const NO_PREVIEW_AT = 6;
const LONG_S = 5520;
const tooLong = mins => 'Longer than your ' + mins + ' minute limit. Change it in Settings.';
const fmtSize = mb => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB');
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const DROP_ERRORS = [
  'Only MP3, WAV, FLAC, MP4, M4A, OGG, and Opus files are supported.',
  'File is too large (612.4 MB). Maximum is 400 MB.',
  'Could not read take-2.wav. It may have been moved or deleted.',
  'That folder has no files in it.',
  "That folder couldn't be read.",
];
const FLAGS = {
  inlib: { label: 'In library', tip: 'Already in your library. Tick to import it again.' },
  long: { label: 'Over ' + LIMIT_MIN + ' min', tip: tooLong(LIMIT_MIN), locked: true },
  notaudio: { label: 'Not audio', locked: true },
  notlink: { label: 'Not a link', locked: true },
  unavailable: { label: 'Unavailable', locked: true },
  toolarge: { label: 'Too large', locked: true },
  notqueued: { label: 'Not queued' },
};

const A = (S.ui.addsong = {
  text: '', tab: 'yt', search: null, hi: -1, preview: null, picked: null, staged: null, track: false, dropError: null, dropIdx: 0,
  picker: null, stems: STEMS.map(s => s.id), vocalMode: 'combined', structure: false, saving: false, submitting: false,
  batch: null, lastBatch: null, order: [], paused: false, starting: false, fg: null, copied: null, notice: null, dragging: false, autoOpen: false,
});

const isLink = t => /^(https?:\/\/|www\.)\S+$/i.test(t.trim());
const isPlaylist = t => (/[?&]list=(?!RD)/.test(t) && !/[?&]v=/.test(t)) || /soundcloud\.com\/[^/]+\/sets\//.test(t);
const hostOf = t => t.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
const on = id => A.stems.includes(id);
const allOn = () => A.stems.length === STEMS.length;
const titleCase = q => q.trim().replace(/\b\w/g, c => c.toUpperCase());

// ── Online search ───────────────────────────────────────────────────────────
function results() {
  const q = A.search.q;
  const shift = Object.keys(TABS).indexOf(A.tab) * 3;
  return VARIANTS.slice(0, MAX_RESULTS).map((v, i) => ({
    title: titleCase(q) + (A.tab === 'ytpl' ? ' - Worship Playlist' + (i ? ' ' + (i + 1) : '') : v),
    by: UPLOADERS[(i + shift) % UPLOADERS.length], dur: i === LONG_AT ? LONG_S : 188 + i * 23, count: 8 + i * 3,
    link: A.tab === 'sc' ? 'https://soundcloud.com/artist/track-' + i : A.tab === 'ytpl' ? 'https://www.youtube.com/playlist?list=PLdemo' + i : 'https://youtu.be/demo' + q.length + i,
    long: A.tab !== 'ytpl' && i === LONG_AT, noPreview: i === NO_PREVIEW_AT,
  }));
}
const searchState = q => (/offline|fail/i.test(q) ? 'failed' : /^(none|zzz)/i.test(q) ? 'none' : 'done');
let searchTimer;
function searchSoon(now) {
  clearTimeout(searchTimer);
  const q = A.text.trim();
  if (q.length < MIN_QUERY || isLink(q)) { A.search = null; stopPreview(); return; }
  const land = () => { A.search = { q, state: searchState(q) }; A.hi = -1; update('overlays'); };
  const show = () => { A.search = { q, state: 'searching' }; stopPreview(); update('overlays'); searchTimer = setTimeout(land, SEARCH_MS); };
  if (now) show(); else searchTimer = setTimeout(show, SEARCH_MS);
}
function pick(i) {
  const r = results()[i];
  if (!r || r.long) return;
  A.text = r.link; A.picked = r; A.search = null; stopPreview();
}

const stopPreview = () => { A.preview = null; };
function previewTick() {
  const p = A.preview;
  if (!p || !p.playing) return;
  if (S.ui.pop?.id !== 'add' || !A.search) { stopPreview(); return; }
  p.t = Math.min(PREVIEW_S, p.t + PREVIEW_TICK_MS / 1000);
  if (p.t >= PREVIEW_S) p.playing = false;
  const clock = document.querySelector('[data-asclock]');
  const seek = document.querySelector('[data-asseek]');
  if (clock) clock.textContent = fmt(p.t) + ' / ' + fmt(PREVIEW_S);
  if (seek) seek.value = p.t;
  if (!p.playing) update('overlays');
}
setInterval(previewTick, PREVIEW_TICK_MS);

const player = p => `<div class="as-player" data-act="noop">${p.failed ? '<span class="hint">Preview unavailable</span>' : `
  <button class="iconbtn iconbtn--sm" data-act="asPvPlay" title="${p.playing ? 'Pause' : 'Play'}">${icon(p.playing ? 'pause' : 'play', 14, 'ic--fill')}</button>
  <input type="range" class="as-seek" min="0" max="${PREVIEW_S}" step="0.1" value="${p.t}" data-asseek data-input="asSeek" aria-label="Seek">
  <span class="mono hint" data-asclock>${fmt(p.t)} / ${fmt(PREVIEW_S)}</span>`}</div>`;

function resultRow(r, i) {
  const sub = A.tab === 'ytpl' ? r.by + ' · ' + r.count + ' songs' : r.by + ' · ' + fmt(r.dur);
  const pv = A.preview?.i === i;
  return `<div class="as-res ${i === A.hi ? 'is-hi' : ''} ${r.long ? 'is-blocked' : ''}" role="option" aria-selected="${i === A.hi}" aria-disabled="${r.long}" data-act="${r.long ? 'noop' : 'asPick:' + i}">
    <div class="as-res__row"><div class="cover as-thumb">${icon(A.tab === 'ytpl' ? 'list-music' : 'music', 16)}</div>
    <div class="row__txt"><div class="row__t ell">${esc(r.title)}</div><div class="row__s ell">${esc(sub)}</div></div>
    ${r.long ? `<span class="chip as-warn" title="${esc(tooLong(LIMIT_MIN))}">Over ${LIMIT_MIN} min</span>` : ''}
    ${A.tab === 'ytpl' ? '' : `<button class="as-pv ${pv ? 'is-on' : ''}" aria-pressed="${pv}" data-act="asPreview:${i}" title="Preview without picking">${icon(pv ? 'x' : 'play', 11, pv ? '' : 'ic--fill')} Preview</button>`}</div>
    ${pv ? player(A.preview) : ''}</div>`;
}

function dropdown() {
  const { state } = A.search;
  const tabs = Object.entries(TABS).map(([id, label]) => `<button class="${A.tab === id ? 'is-on' : ''}" aria-pressed="${A.tab === id}" data-act="asTab:${id}">${label}</button>`).join('');
  const body = state === 'searching' ? `<div class="as-state">${icon('loader', 15, 'as-spin')} Searching…</div>`
    : state === 'none' ? '<div class="as-state">No results</div>'
      : state === 'failed' ? `<div class="as-state bad">${icon('alert', 15)} Search failed. Check your connection.</div>`
        : `<div class="as-results" role="listbox" data-scroll="as-results">${results().map(resultRow).join('')}</div>`;
  return `<div class="as-drop"><div class="seg as-tabs">${tabs}</div>${body}</div>`;
}

// ── The popover ─────────────────────────────────────────────────────────────
function stagedChip() {
  const b = A.batch;
  const st = A.staged || { kind: b.kind, name: b.folder };
  const items = b ? b.items : [];
  const text = st.kind === 'file' ? `<b class="ell">${esc(st.name)}</b><span>${fmtSize(st.mb)}</span>`
    : st.kind === 'links' ? `<b>${plural(b.links, 'link')}</b><span>${plural(items.length, 'song')}</span>`
      : st.kind === 'folder' ? `<b class="ell">${esc(st.name)}</b><span>${plural(items.length, 'file')}</span>`
        : `<b>${plural(items.length, 'file')}</b><span>${fmtSize(items.reduce((sum, it) => sum + (it.mb || 0), 0))}</span>`;
  return `<span class="as-chip">${icon(st.kind === 'links' ? 'link' : st.kind === 'folder' ? 'folder' : 'file', 14)}${text}
    <button class="iconbtn iconbtn--sm" data-act="asUnstage" title="Remove file">${icon('x', 13)}</button></span>`;
}
const trackChip = () => (A.track && !A.text && playSong() ? `<span class="as-chip as-chip--track">${icon('file', 14)}<b class="ell">${esc(playSong().title)}</b></span>` : '');

function box() {
  const input = `<input class="as-input" data-input="asText" value="${esc(A.text)}" placeholder="${A.dragging ? 'Drop files or a folder' : PLACEHOLDER}" aria-label="${PLACEHOLDER}" autocomplete="off" spellcheck="false">`;
  return `<div class="as-box ${A.dragging ? 'is-drag' : ''} ${A.dropError ? 'is-err' : ''}">${icon(A.search ? 'search' : 'link', 16)}
    ${A.staged || A.batch ? stagedChip() : trackChip() + input}
    ${A.dropError ? `<span class="as-err" role="alert">${icon('alert', 14)}<span>${esc(A.dropError)}</span></span>` : ''}</div>`;
}

function linkHint() {
  const t = A.text.trim();
  if (!isLink(t) || A.staged || A.batch) return '';
  const text = isPlaylist(t) ? 'Playlist link. Extract stems opens the review first.'
    : /[?&]v=/.test(t) && /[?&]list=/.test(t) ? 'A song inside a playlist. Imports this one song only, with no folder.'
      : 'Extract stems imports this link straight away.';
  return `<div class="hint as-linkhint">${icon(isPlaylist(t) ? 'list-music' : 'link', 13)} ${text}</div>`;
}

const PICKERS = {
  files: [{ heading: 'Prototype: the picker returns' }, { label: 'One file', icon: 'file', act: 'asPickOne' }, { label: 'Several files', icon: 'upload', act: 'asPickFiles' }],
  folder: [{ heading: 'Prototype: the picker returns' }, { label: 'A folder with subfolders', icon: 'folder', act: 'asPickFolder' },
    { label: 'An empty folder', icon: 'folder', act: 'asPickError:3' }, { label: 'The folder picker fails', icon: 'alert', act: 'asPickError:picker' }],
};
const pickers = () => `<div class="as-pickers">
  <button class="btn ${A.picker === 'files' ? 'is-on' : ''}" aria-expanded="${A.picker === 'files'}" data-act="asPicker:files" title="Add files">${icon('upload')} Add files</button>
  <button class="btn ${A.picker === 'folder' ? 'is-on' : ''}" aria-expanded="${A.picker === 'folder'}" data-act="asPicker:folder" title="Add a folder">${icon('folder')} Add a folder</button>
  <span class="hint ell">MP3, WAV, FLAC, MP4, M4A, OGG, Opus</span></div>
  ${A.picker ? `<div class="menu as-pickmenu">${menuHtml(PICKERS[A.picker])}</div>` : ''}`;

const stemChip = (id, label, lit) => `<button class="as-stem ${lit ? 'is-on' : ''}" aria-pressed="${lit}" data-act="asStem:${id}">${lit ? icon('check', 12) : ''}${label}</button>`;
const modeBtn = (id, label) => { const lit = on('vocals') && A.vocalMode === id; return `<button class="${lit ? 'is-on' : ''}" aria-pressed="${lit}" data-act="asMode:${id}">${label}</button>`; };
const extractRow = () => `<div class="as-extract"><span class="lbl">Extract</span><div class="as-stems">
  ${stemChip('all', 'All', allOn())}
  <span class="as-vox">${stemChip('vocals', 'Vocals', on('vocals'))}<span class="seg as-mode">${modeBtn('combined', 'Combined')}${modeBtn('split', 'Lead + Backing')}</span></span>
  ${STEMS.filter(s => s.id !== 'vocals').map(s => stemChip(s.id, s.name, on(s.id))).join('')}</div></div>`;

const canImport = () => !!A.staged || isLink(A.text) || (A.track && !A.text.trim() && !!playSong());
function submitRow() {
  const label = A.submitting ? 'Processing' : A.batch ? 'Review ' + A.batch.items.length : 'Extract stems';
  const disabled = A.submitting || !A.stems.length || (!A.batch && !canImport());
  return `<div class="as-foot"><span class="as-detect" title="${esc(DETECT_TIP)}">
    <button class="switch ${A.structure ? 'is-on' : ''}" role="switch" aria-checked="${A.structure}" aria-label="Detect structure" ${A.saving ? 'disabled' : ''} data-act="asStructure"><i></i></button>
    <b>Detect structure</b><span class="tag">Experimental</span></span><div class="sp"></div>
    <button class="btn btn--accent" ${disabled ? 'disabled' : ''} data-act="asExtract">${icon(A.submitting ? 'loader' : 'zap', 15, A.submitting ? 'as-spin' : '')} ${label}</button></div>`;
}

const protoRow = () => `<div class="as-proto"><span class="lbl">Prototype</span>
  <button class="linkbtn" data-act="asDropError">Drop error</button>
  <button class="linkbtn ${A.track ? 'is-on' : ''}" aria-pressed="${A.track}" ${S.playId ? '' : 'disabled'} data-act="asTrack">Open song is an upload</button>
  <button class="linkbtn" data-act="asPasteMany">Paste several links</button>
  <button class="linkbtn" ${S.viewId ? '' : 'disabled'} data-act="asForeground">Foreground import</button>
  <span class="hint">Search “none” or “offline” for the other result states.</span></div>`;

registerPop('add', () => `<div class="as-pop"><h3>Add songs</h3>${box()}${A.search ? dropdown() : linkHint()}${pickers()}${extractRow()}${submitRow()}${protoRow()}</div>`);

// ── Popover actions ─────────────────────────────────────────────────────────
let dropErrorTimer;
function showDropError(text) {
  A.dropError = text;
  clearTimeout(dropErrorTimer);
  dropErrorTimer = setTimeout(() => { A.dropError = null; update('overlays'); }, DROP_ERROR_MS);
}
act('asText', (ctx, value) => { A.text = value; A.dropError = null; searchSoon(/\s$/.test(value)); return ['overlays']; });
act('asTab', (ctx, id) => { A.tab = id; searchSoon(true); return ['overlays']; });
act('asPick', (ctx, i) => { pick(Number(i)); return ['overlays']; });
act('asPreview', (ctx, i) => {
  const r = results()[Number(i)];
  A.preview = A.preview?.i === Number(i) ? null : { i: Number(i), t: 0, playing: !r.noPreview, failed: r.noPreview };
  return ['overlays'];
});
act('asPvPlay', () => { A.preview.playing = !A.preview.playing; return ['overlays']; });
act('asSeek', (ctx, value) => { A.preview.t = Number(value); return false; });
act('asStem', (ctx, id) => {
  if (id === 'all') A.stems = allOn() ? [] : STEMS.map(s => s.id);
  else if (allOn()) A.stems = [id];
  else if (on(id)) A.stems = A.stems.filter(x => x !== id);
  else { A.stems = [...A.stems, id]; if (id === 'vocals') A.vocalMode = 'combined'; }
  return ['overlays'];
});
act('asMode', (ctx, mode) => {
  if (on('vocals') && A.vocalMode === mode) A.stems = A.stems.filter(x => x !== 'vocals');
  else { A.vocalMode = mode; if (!on('vocals')) A.stems = [...A.stems, 'vocals']; }
  return ['overlays'];
});
act('asStructure', () => {
  A.structure = !A.structure; A.saving = true;
  setTimeout(() => { A.saving = false; update('overlays'); }, SAVE_MS);
  return ['overlays'];
});
act('asPicker', (ctx, kind) => { A.picker = A.picker === kind ? null : kind; return ['overlays']; });
act('asPickOne', () => { Object.assign(A, { staged: { kind: 'file', name: 'rehearsal-take-4.wav', mb: 38.6 }, batch: null, picker: null, text: '', dropError: null, search: null }); return ['overlays']; });
act('asPickFiles', () => openBatch(filesBatch(SAMPLE_FILES)));
act('asPickFolder', () => openBatch(folderBatch('Sunday band')));
act('asPickError', (ctx, which) => { A.picker = null; showDropError(which === 'picker' ? 'Could not open the folder picker.' : DROP_ERRORS[Number(which)]); return ['overlays']; });
act('asUnstage', () => { A.staged = null; A.batch = null; return ['overlays']; });
act('asDropError', () => { showDropError(DROP_ERRORS[A.dropIdx++ % DROP_ERRORS.length]); return ['overlays']; });
act('asTrack', () => { A.track = !A.track; return ['overlays']; });
act('asPasteMany', () => openBatch(linksBatch(SAMPLE_LINES)));
act('asExtract', () => (A.batch ? openBatch(A.batch) : submit()));

function submit() {
  const link = A.text.trim();
  S.ui.error = null;
  if (S.ui.offline) { S.ui.pop = null; S.ui.error = { message: 'Could not reach StemDeck. Check the connection and try again.', retry: true }; return; }
  if (isLink(link) && isPlaylist(link)) return openBatch(linksBatch([link]));
  if (link && importing().some(s => s.source === link)) { S.ui.pop = null; S.ui.error = { message: 'This song is still importing. Try again when it finishes.' }; return; }
  A.submitting = true;
  setTimeout(() => { A.submitting = false; enqueue(stagedImport(link)); Object.assign(A, { text: '', staged: null, picked: null }); update(); }, SUBMIT_MS);
  return ['overlays'];
}
function stagedImport(link) {
  if (A.staged) return { title: A.staged.name, file: true };
  if (isLink(link)) return { title: hostOf(link).includes('soundcloud') ? 'SoundCloud link' : 'YouTube link', source: link, found: A.picked?.link === link ? A.picked : { title: 'Build My Life', by: 'Pat Barrett' } };
  return { title: playSong().title, file: true, resplit: true };
}

// ── Batch review ────────────────────────────────────────────────────────────
const SAMPLE_LINES = ['https://youtu.be/aa1', 'https://youtu.be/aa2', 'https://youtu.be/inlib', 'https://youtu.be/concert', 'Sunday links:', 'https://youtu.be/private', 'https://soundcloud.com/band/demo', 'https://www.youtube.com/playlist?list=PLsunday'];
const KNOWN = {
  aa1: { title: 'Goodness of God', artist: 'Bethel Music', dur: 312 }, aa2: { title: 'Way Maker', artist: 'Sinach', dur: 527, willFail: true },
  concert: { title: 'Worship Night | Full Concert', artist: 'Live Sessions', dur: LONG_S, flag: 'long' }, private: { title: 'Private video', artist: '', flag: 'unavailable' },
};
const SAMPLE_FILES = [['rehearsal-take-1.wav', 41.2], ['rehearsal-take-2.wav', 39.8], ['click-track.mp3', 4.1], ['setlist.pdf', 0.3], ['full-service.wav', 612.4]].map(([name, mb]) => ({ name, mb }));
const PLAYLIST = ['Firm Foundation', 'Holy Forever', 'Gratitude', 'Same God', 'Graves into Gardens', 'Raise a Hallelujah', 'The Blessing', 'Living Hope', 'King of Kings', 'What a Beautiful Name', 'Battle Belongs', 'This Is Amazing Grace'];
let uid = 0;
const nextId = () => 'b' + uid++;

function linkItem(line, n) {
  if (!isLink(line)) return { title: line, sub: 'Line ' + n, icon: 'alert', flag: 'notlink', ticked: false };
  const key = line.split('/').pop();
  const lib = key === 'inlib' && library().find(s => s.status === 'done');
  if (lib) return { title: lib.title, sub: lib.artist + ' · ' + fmt(lib.dur), icon: 'music', flag: 'inlib', ticked: false, link: line };
  const k = KNOWN[key] || { title: 'Song from ' + hostOf(line), artist: hostOf(line), dur: 200 + n * 11, unchecked: hostOf(line).includes('soundcloud') };
  return { title: k.title, artist: k.artist, sub: k.unchecked ? 'Not checked' : [k.artist, k.dur && fmt(k.dur)].filter(Boolean).join(' · '), icon: k.flag ? 'alert' : 'link', flag: k.flag, ticked: !FLAGS[k.flag]?.locked, link: line, willFail: k.willFail };
}
function playlistItems(line, g) {
  const songs = PLAYLIST.map((title, i) => ({ title, sub: UPLOADERS[i % UPLOADERS.length] + ' · ' + fmt(200 + i * 13), icon: 'music', ticked: true, group: g, link: line + '&i=' + i }));
  Object.assign(songs.at(-1), { flag: 'unavailable', icon: 'alert', ticked: false });
  return songs;
}
function linksBatch(lines) {
  const kept = lines.slice(0, MAX_LINKS);
  const groups = {};
  const items = kept.flatMap((line, i) => {
    if (!isLink(line) || !isPlaylist(line)) return [linkItem(line, i + 1)];
    const g = nextId();
    groups[g] = { name: 'Sunday set', total: PLAYLIST.length, unavailable: 1, cut: true, open: false, more: false };
    return playlistItems(line, g);
  }).map(it => ({ id: nextId(), ...it }));
  const notes = lines.length > MAX_LINKS ? [{ text: 'Only 100 links at a time. ' + (lines.length - MAX_LINKS) + ' more lines were left out.' }] : [];
  if (items.some(it => it.sub === 'Not checked')) notes.push({ text: "Couldn't look these up: the service did not answer in time.", retry: true });
  return { kind: 'links', links: kept.filter(isLink).length, sub: 'Pasted list', items, groups, notes, looking: true };
}
function fileItem(f, path) {
  const ext = f.name.split('.').pop().toLowerCase();
  const flag = !AUDIO_EXT.includes(ext) ? 'notaudio' : f.mb > MAX_FILE_MB ? 'toolarge' : '';
  return { id: nextId(), title: f.name, mb: f.mb, sub: fmtSize(f.mb), icon: flag ? 'alert' : 'file', flag, ticked: !flag, path, file: true };
}
function filesBatch(files) {
  const notes = files.length > MAX_FILES ? [{ text: 'Only 500 files at a time. ' + (files.length - MAX_FILES) + ' more files were left out.' }] : [];
  return { kind: 'files', sub: '', items: files.slice(0, MAX_FILES).map(f => fileItem(f)), groups: {}, notes };
}
function folderBatch(name) {
  const tree = [[[name], 'opening-song.wav', 44.1], [[name], 'closing-song.flac', 61.7], [[name, 'Vocals'], 'harmony-guide.m4a', 12.2], [[name, 'Vocals'], 'lead-guide.m4a', 11.9], [[name, 'Old'], 'notes.txt', 0.1]];
  return { kind: 'folder', folder: name, sub: 'Includes subfolders', items: tree.map(([path, file, mb]) => fileItem({ name: file, mb }, path)), groups: {}, notes: [] };
}
function openBatch(b) {
  Object.assign(A, { batch: b, staged: null, picker: null, search: null, text: '' });
  stopPreview();
  S.ui.pop = null; S.ui.menu = null;
  S.ui.dialog = { id: 'batch' };
  if (b.looking) setTimeout(() => { b.looking = false; update('overlays'); }, LOOKUP_MS);
}

function batchTitle(b) {
  const n = b.items.length;
  if (b.kind === 'links') return b.looking ? plural(b.links, 'link') : plural(n, 'song') + ' from ' + plural(b.links, 'link');
  return b.kind === 'folder' ? plural(n, 'file') + ' in ' + b.folder : plural(n, 'file');
}
const tickBox = (state, act, label, locked) => `<button class="as-tick" role="checkbox" aria-checked="${state === 'some' ? 'mixed' : state === 'all'}" aria-label="${esc(label)}" ${locked ? 'disabled' : ''} data-act="${act}">
  <span class="checkbox ${state !== 'none' ? 'is-on' : ''}">${state === 'all' ? icon('check', 12) : state === 'some' ? icon('minus', 12) : ''}</span></button>`;

function itemRow(it, looking) {
  const flag = FLAGS[it.flag];
  const busy = looking && it.link;
  return `<div class="as-item ${it.group ? 'as-item--in' : ''}">${tickBox(it.ticked ? 'all' : 'none', 'asTick:' + it.id, 'Import ' + it.title, flag?.locked || busy)}
    <span class="as-item__ic">${busy ? icon('loader', 16, 'as-spin') : icon(it.icon, 16)}</span>
    <div class="row__txt"><div class="row__t ell">${esc(it.title)}</div><div class="row__s ell" title="${esc(it.sub)}">${busy ? 'Looking up…' : esc(it.sub)}</div></div>
    ${flag && !busy ? `<span class="chip as-flag as-flag--${it.flag}" ${flag.tip ? `title="${esc(flag.tip)}"` : ''}>${flag.label}</span>` : ''}
    ${it.flag === 'notqueued' ? `<button class="btn btn--quiet" data-act="asItemRetry:${it.id}">${icon('rotate-ccw', 14)} Retry</button>` : ''}
    <button class="iconbtn iconbtn--sm" data-act="asItemRemove:${it.id}" title="Remove">${icon('x', 14)}</button></div>`;
}
function groupRows(b, gid) {
  const g = b.groups[gid];
  const members = b.items.filter(it => it.group === gid);
  const ticked = members.filter(it => it.ticked).length;
  const state = !ticked ? 'none' : ticked === members.filter(it => !FLAGS[it.flag]?.locked).length ? 'all' : 'some';
  const shown = g.more ? members : members.slice(0, PLAYLIST_PEEK);
  const meta = 'Playlist · ' + plural(g.total, 'song') + (g.unavailable ? ' · ' + g.unavailable + ' unavailable' : '') + (g.cut ? ' · rest of the list left out' : '');
  return `<div class="as-item as-group">${tickBox(state, 'asTickGroup:' + gid, 'Import ' + g.name, b.looking)}<span class="as-item__ic">${icon('list-music', 16)}</span>
    <div class="row__txt"><div class="row__t ell">${esc(g.name)}</div><div class="row__s ell">${meta}</div></div>
    <button class="btn btn--quiet" aria-expanded="${g.open}" data-act="asGroupOpen:${gid}">${g.open ? 'Hide songs' : 'Show songs'}</button>
    <button class="iconbtn iconbtn--sm" data-act="asGroupRemove:${gid}" title="Remove">${icon('x', 14)}</button></div>
    ${g.open ? shown.map(it => itemRow(it, b.looking)).join('') + (members.length > shown.length ? `<button class="linkbtn as-more" data-act="asGroupMore:${gid}">Show ${members.length - shown.length} more</button>` : '') : ''}`;
}
function batchRows(b) {
  let lastPath = '';
  const seen = new Set();
  return b.items.map(it => {
    if (it.group) { if (seen.has(it.group)) return ''; seen.add(it.group); return groupRows(b, it.group); }
    const path = (it.path || []).join(' / ');
    const sep = path && path !== lastPath ? `<div class="as-sep">${icon('folder', 13)} ${esc(path)}</div>` : '';
    lastPath = path;
    return sep + itemRow(it, b.looking);
  }).join('');
}
const room = () => Math.max(0, QUEUE_ROOM - queue().length);
registerDialog('batch', () => {
  const b = A.batch;
  if (!b) return emptyState('list-music', 'Nothing to review');
  const n = b.items.filter(it => it.ticked).length;
  const stems = b.snapshot ? b.snapshot.stems : A.stems.length;
  const detect = b.snapshot ? b.snapshot.structure : A.structure;
  const notes = b.notes.map(nt => `<div class="as-note">${icon('info', 14)}<span>${esc(nt.text)}</span>${nt.retry ? '<button class="btn btn--quiet" data-act="asLookupRetry">Try again</button>' : ''}</div>`).join('');
  return `<div class="dlg__head"><div class="as-bh"><h3>${batchTitle(b)}</h3>${b.sub ? `<span class="hint">${b.sub}</span>` : ''}</div><button class="iconbtn" data-act="closeDialog" title="Close">${icon('x', 18)}</button></div>
  <div class="dlg__body as-bbody" data-scroll="as-batch">${notes}${batchRows(b)}</div>
  <div class="dlg__foot as-bfoot"><span class="hint">For all: ${plural(stems, 'stem')} · Detect structure ${detect ? 'on' : 'off'}</span>
    ${n > room() ? `<span class="hint as-room">Only ${room()} fit in the queue now</span>` : ''}<div class="sp"></div>
    <button class="btn" data-act="closeDialog">Cancel</button>
    <button class="btn btn--accent" ${b.looking || b.sending || !n ? 'disabled' : ''} data-act="asQueue">Queue ${n}</button></div>`;
});

const batchItem = id => A.batch.items.find(it => it.id === id);
act('asTick', (ctx, id) => { const it = batchItem(id); it.ticked = !it.ticked; return ['overlays']; });
act('asTickGroup', (ctx, gid) => {
  const members = A.batch.items.filter(it => it.group === gid && !FLAGS[it.flag]?.locked);
  const fill = !members.every(it => it.ticked);
  members.forEach(it => { it.ticked = fill; });
  return ['overlays'];
});
act('asGroupOpen', (ctx, gid) => { const g = A.batch.groups[gid]; g.open = !g.open; return ['overlays']; });
act('asGroupMore', (ctx, gid) => { A.batch.groups[gid].more = true; return ['overlays']; });
act('asGroupRemove', (ctx, gid) => { A.batch.items = A.batch.items.filter(it => it.group !== gid); return closeIfEmpty(); });
act('asItemRemove', (ctx, id) => { A.batch.items = A.batch.items.filter(it => it.id !== id); return closeIfEmpty(); });
act('asLookupRetry', () => {
  const b = A.batch;
  b.notes = b.notes.filter(nt => !nt.retry); b.looking = true;
  b.items.filter(it => it.sub === 'Not checked').forEach(it => { it.sub = 'The Band · 4:05'; it.title = 'Demo (Live)'; });
  setTimeout(() => { b.looking = false; update('overlays'); }, LOOKUP_MS);
  return ['overlays'];
});
act('asItemRetry', (ctx, id) => {
  const it = batchItem(id);
  if (!room()) return false;
  A.lastBatch = { ids: [...(A.lastBatch?.ids || []), ...queueItems([it])] };
  A.batch.items = A.batch.items.filter(x => x !== it);
  return closeIfEmpty();
});
act('asQueue', () => {
  const b = A.batch;
  b.sending = true;
  setTimeout(() => { b.sending = false; finishQueue(b); update(); }, SUBMIT_MS);
  return ['overlays'];
});
function finishQueue(b) {
  b.snapshot ||= { stems: A.stems.length, structure: A.structure };
  const ticked = b.items.filter(it => it.ticked);
  const fits = ticked.slice(0, room());
  ticked.slice(fits.length).forEach(it => { Object.assign(it, { flag: 'notqueued', sub: FULL_QUEUE, group: null }); });
  A.lastBatch = { ids: queueItems(fits) };
  b.items = b.items.filter(it => it.flag === 'notqueued');
  b.notes = [];
  closeIfEmpty();
}
function queueItems(items) {
  const folders = {};
  return items.map(it => {
    const g = it.group && A.batch.groups[it.group];
    if (g && !folders[it.group]) { folders[it.group] = 'f' + Date.now() + it.group; S.folders.push({ id: folders[it.group], name: g.name, color: 'violet', parent: null }); }
    return enqueue({ title: it.title, artist: it.artist || '', file: !!it.file, source: it.link, folder: folders[it.group] || 'unsorted', willFail: it.willFail }).id;
  });
}
function closeIfEmpty() {
  if (A.batch.items.length) return ['overlays'];
  A.batch = null;
  if (S.ui.dialog?.id === 'batch') S.ui.dialog = null;
}

// ── Import queue and the fake import engine ─────────────────────────────────
let seq = 0;
function enqueue(fields) {
  const s = { id: 'imp' + Date.now().toString(36) + seq++, artist: '', dur: 0, bpm: 0, key: '', cover: '', folder: 'unsorted', tags: [], versions: [], added: Math.max(0, ...S.songs.map(x => x.added || 0)) + 1, status: 'queued', progress: 0, stage: '', ...fields };
  S.songs.unshift(s);
  A.order.push(s.id);
  if (!S.playId) A.autoOpen = true;
  labelQueue();
  return s;
}
function queue() {
  const list = importing();
  list.forEach(s => { if (!A.order.includes(s.id)) A.order.push(s.id); });
  const rank = s => (s.status === 'processing' ? -1 : A.order.indexOf(s.id));
  return list.sort((a, b) => rank(a) - rank(b));
}
const stageOf = p => STAGES.filter(([at]) => p >= at).at(-1)[1];
const labelQueue = () => queue().forEach((s, i) => { if (s.status === 'queued') s.stage = A.paused ? 'Paused' : 'Queued - #' + (i + 1) + ' in line'; });

function startNext() {
  const s = queue().find(x => x.status === 'queued');
  if (!s) return null;
  Object.assign(s, { status: 'processing', progress: 0 }, s.found ? { title: s.found.title, artist: s.found.by } : {});
  return s;
}
function finish(s) {
  if (s.resplit) { S.songs = S.songs.filter(x => x !== s); return; }
  Object.assign(s, { status: 'done', progress: 1, dur: 200 + (seq % 7) * 19, bpm: 68 + (seq % 9) * 8, key: 'G maj', versions: [{ id: 'main', name: 'Original' }], version: 'main', fav: false });
  if (A.autoOpen && !S.playId) { S.playId = S.viewId = S.ui.sel = s.id; S.playing = false; }
  A.autoOpen = false;
}
function backToLibrary() {
  if (queue().length || S.ui.browse?.view !== 'queue') return;
  setTimeout(() => { if (!queue().length && S.ui.browse?.view === 'queue') { S.ui.browse.view = 'all'; update(); } }, RETURN_MS);
}
function simTick() {
  if (A.fg) fgTick();
  const run = !A.paused && (queue().find(s => s.status === 'processing') || startNext());
  if (!run) return;
  run.progress = Math.min(1, run.progress + STEP);
  run.stage = stageOf(run.progress);
  const failing = run.willFail && run.progress >= FAIL_AT;
  if (failing) Object.assign(run, { status: 'failed', reason: FAIL_REASON });
  else if (run.progress >= 1) finish(run);
  labelQueue();
  if (!failing && run.progress < 1) return update('sidebar', 'topbar', 'browse-results');
  backToLibrary();
  update();
}
setInterval(simTick, TICK_MS);

act('retryImport', (ctx, id) => {
  const s = song(id);
  A.notice = s.trashed ? { id, text: 'Restore it from the Trash first.' } : queue().length >= QUEUE_ROOM ? { id, text: FULL_QUEUE } : null;
  if (A.notice || importing().includes(s)) return;
  Object.assign(s, { status: 'queued', progress: 0, willFail: false });
  if (S.ui.dialog?.id === 'failedImport') S.ui.dialog = null;
  labelQueue();
});
act('cancelImport', (ctx, id) => {
  const remove = () => { S.songs = S.songs.filter(s => s.id !== id); labelQueue(); backToLibrary(); };
  if (song(id).file) return arm('cancel:' + id, () => { remove(); update(); });
  remove();
});
act('asNext', (ctx, id) => { A.order = [id, ...A.order.filter(x => x !== id)]; labelQueue(); return ['browse', 'sidebar']; });
act('asReorder', (ctx, id, beforeId) => {
  if (id === beforeId || song(id).status !== 'queued') return false;
  A.order = A.order.filter(x => x !== id);
  A.order.splice(A.order.indexOf(beforeId), 0, id);
  labelQueue();
  return ['browse', 'sidebar'];
});
act('asPauseProto', () => { A.paused = !A.paused; labelQueue(); });
act('asStart', () => {
  A.starting = true;
  setTimeout(() => { Object.assign(A, { starting: false, paused: false }); labelQueue(); update(); }, START_MS);
  return ['browse'];
});
act('asRetryFailed', () => { batchSongs().filter(s => s.status === 'failed').forEach(s => actions.retryImport(null, s.id)); });
act('asRemove', (ctx, id) => { S.songs = S.songs.filter(s => s.id !== id); });

const batchSongs = () => (A.lastBatch ? A.lastBatch.ids.map(song).filter(Boolean) : []);
function batchHeader() {
  const songs = batchSongs();
  const count = test => songs.filter(test).length;
  const [done, failed, waiting] = [count(s => s.status === 'done'), count(s => s.status === 'failed'), count(s => importing().includes(s))];
  const notQueued = A.batch ? A.batch.items.filter(it => it.flag === 'notqueued').length : 0;
  const total = songs.length + notQueued || 1;
  const failedRows = songs.filter(s => s.status === 'failed').map(s => `<div class="srow as-qrow as-qrow--bad"><span class="as-grip"></span><div class="cover">${icon('alert', 16)}</div>
    <div class="row__txt"><div class="row__t ell">${esc(s.title)}</div><div class="row__s ell bad">${esc(s.reason)}</div></div>
    <div class="as-qacts"><button class="btn btn--quiet" data-act="retryImport:${s.id}">${icon('rotate-ccw', 14)} Retry</button><button class="iconbtn" data-act="asRemove:${s.id}" title="Remove">${icon('x', 15)}</button></div></div>`).join('');
  return `<div class="as-batchhead"><div class="as-batchhead__t"><b>${done} of ${total} done</b><span class="hint">${failed} failed · ${notQueued} not queued · ${waiting} waiting</span></div>
    <span class="as-two"><i class="as-two__ok" style="width:${(done / total) * 100}%"></i><i class="as-two__bad" style="width:${(failed / total) * 100}%"></i></span>
    <button class="btn" ${failed ? '' : 'disabled'} data-act="asRetryFailed">${icon('rotate-ccw', 14)} Retry failed</button></div>${failedRows}`;
}
function queueRow(s, i) {
  const waiting = s.status === 'queued';
  const pct = Math.round(s.progress * 100);
  const sure = armed('cancel:' + s.id);
  const drag = waiting ? `draggable="true" data-drag="${s.id}" data-drop="asReorder:{id}:${s.id}"` : '';
  return `<div class="srow as-qrow ${s.status === 'processing' ? 'is-running' : ''}" ${drag}>
    <span class="as-grip" ${waiting ? 'title="Drag to reorder"' : ''}>${waiting ? icon('grip-vertical', 15) : ''}</span>
    <div class="cover" style="${s.cover ? `background-image:url('${s.cover}')` : ''}">${s.cover ? '' : icon(s.file ? 'file' : 'music', 16)}</div>
    <div class="row__txt"><div class="row__t ell">${esc(s.title)}</div><div class="row__s ell">${waiting ? esc(s.stage) : esc(s.stage) + ' ' + pct + '%'}</div></div>
    ${s.status === 'processing' ? `<span class="as-qbar"><i style="width:${pct}%"></i></span>` : ''}
    <div class="as-qacts">${waiting && i >= NEXT_FROM ? `<button class="iconbtn" data-act="asNext:${s.id}" title="Extract this one next">${icon('arrow-up', 15)}</button>` : ''}
    <button class="${sure ? 'btn is-danger' : 'iconbtn'}" data-act="cancelImport:${s.id}" title="Cancel this import">${icon('x', 15)}${sure ? ' Delete upload?' : ''}</button></div></div>`;
}
registerBrowseView('queue', () => {
  const list = queue();
  const banner = A.paused ? `<div class="as-paused">${icon('pause', 15)}<span>Paused - ${plural(list.length, 'track')} from your last session.</span><div class="sp"></div>
    <button class="btn" ${A.starting ? 'disabled' : ''} data-act="asStart">${A.starting ? 'Starting…' : 'Start'}</button></div>` : '';
  return `<div class="bhead"><h2>Import Queue</h2><span class="dim">${plural(list.length, 'song')}</span><div class="sp"></div>
    <button class="linkbtn ${A.paused ? 'is-on' : ''}" aria-pressed="${A.paused}" data-act="asPauseProto">Prototype: paused after a restart</button></div>
    ${banner}${A.lastBatch ? batchHeader() : ''}
    ${list.length ? `<div class="blist as-queue">${list.map(queueRow).join('')}</div>` : emptyState('download', 'Nothing importing', 'Songs you queue for import show up here.')}`;
});

// ── Failed imports ──────────────────────────────────────────────────────────
function failedBody(s) {
  const source = s.file ? `<span class="as-src__v ell">${icon('file', 14)} ${esc(s.title)}</span>`
    : `<span class="as-src__v mono ell">${esc(s.source)}</span>
      <button class="btn btn--quiet" tabindex="-1" data-act="asCopy:${s.id}" title="${A.copied === s.id ? 'Link copied' : 'Copy link'}">${icon(A.copied === s.id ? 'check' : 'copy', 14)} Copy link</button>
      <button class="btn btn--quiet" tabindex="-1" data-act="asOpenLink:${s.id}" title="Open link">${icon('external-link', 14)} Open link</button>`;
  return `<div class="as-fail__head">${icon('alert', 18)}<div class="row__txt"><b>Import failed</b><span class="ell">${esc(s.title)}</span></div></div>
    <p class="as-fail__why">${esc(s.reason || FAIL_REASON)}</p>
    ${A.notice?.id === s.id ? `<div class="as-note">${icon('info', 14)}<span>${esc(A.notice.text)}</span></div>` : ''}
    <div class="as-src"><span class="lbl">Source</span>${source}</div>
    <div class="as-fail__acts" data-asarrows><button class="btn" tabindex="-1" data-act="retryImport:${s.id}">${icon(s.file ? 'upload' : 'rotate-ccw', 14)} ${s.file ? 'Pick the file again' : 'Retry'}</button>
      <button class="btn is-danger" tabindex="-1" data-act="trash:${s.id}">${icon('trash-2', 14)} Trash</button></div>`;
}
const failedSel = () => { const s = song(S.ui.sel); return s && s.status === 'failed' && !s.trashed ? s : null; };
registerHook('mainTop', () => { const s = failedSel(); return s ? `<div class="as-fail" role="region" aria-label="Failed import">${failedBody(s)}<button class="iconbtn as-fail__x" data-act="asCloseFail" title="Close">${icon('x', 16)}</button></div>` : ''; });
registerDialog('failedImport', d => {
  const s = song(d.arg);
  return `<div class="dlg__head"><h3>Failed import</h3><button class="iconbtn" data-act="closeDialog" title="Close (Esc)">${icon('x', 18)}</button></div><div class="dlg__body as-fail as-fail--dlg">${s ? failedBody(s) : ''}</div>`;
});
const selectBefore = actions.select;
act('select', (ctx, id) => {
  const res = selectBefore(ctx, id);
  if (song(id)?.status !== 'failed' || (S.ui.lib.picking && S.ui.browse)) return res;
  A.notice = null;
  if (S.ui.browse || !S.viewId) S.ui.dialog = { id: 'failedImport', arg: id };
});
act('asCloseFail', () => { S.ui.sel = S.viewId; });
act('asCopy', (ctx, id) => {
  navigator.clipboard?.writeText(song(id).source).catch(err => console.warn('Copy link failed', err));
  A.copied = id;
  setTimeout(() => { A.copied = null; update(); }, COPIED_MS);
});
act('asOpenLink', (ctx, id) => { window.open(song(id).source, '_blank', 'noopener'); return false; });

// ── Foreground import (Sync again holds the studio) ─────────────────────────
function fgTick() {
  const f = A.fg;
  if (f.cancelling) return;
  f.progress = Math.min(1, f.progress + STEP);
  f.ticks++;
  if (f.progress >= 1) A.fg = null;
  update('main');
}
registerHook('mainTop', () => {
  const f = A.fg;
  if (!f) return '';
  const pct = Math.round(f.progress * 100);
  return `<div class="as-fg"><div class="row__txt"><b class="ell">${esc(f.title)}</b><span class="hint">${FG_PHRASES[Math.floor(f.ticks / FG_PHRASE_TICKS) % FG_PHRASES.length]}…</span></div>
    <span class="as-qbar as-qbar--wide"><i style="width:${pct}%"></i></span><span class="hint mono">${pct}%</span>
    <button class="btn" ${f.cancelling ? 'disabled' : ''} data-act="asFgCancel">${f.cancelling ? 'Cancelling…' : 'Cancel'}</button></div>`;
});
act('asForeground', () => { A.fg = { title: song(S.viewId).title, progress: 0, ticks: 0, cancelling: false }; S.ui.pop = null; });
act('asFgCancel', () => { A.fg.cancelling = true; setTimeout(() => { A.fg = null; update(); }, CANCEL_MS); return ['main']; });

// ── Keyboard, paste and dropping files anywhere in the window ───────────────
function onSearchKeys(e) {
  if (e.target.closest?.('[data-asarrows]') && /^Arrow(Left|Right)$/.test(e.key)) return moveFocus(e);
  if (!e.target.matches?.('.as-input')) return;
  const n = A.search?.state === 'done' ? MAX_RESULTS : 0;
  if (e.key === 'Escape' && A.search) { A.search = null; stopPreview(); }
  else if (n && /^Arrow(Up|Down)$/.test(e.key)) A.hi = (A.hi + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  else if (e.key === 'Enter' && n && A.hi >= 0) pick(A.hi);
  else if (e.key === 'Enter' && !A.search) return document.querySelector('.as-foot .btn--accent:not([disabled])')?.click();
  else return;
  e.preventDefault(); e.stopPropagation();
  update('overlays');
}
function moveFocus(e) {
  const btns = [...e.target.closest('[data-asarrows]').querySelectorAll('button')];
  btns[(btns.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
  e.preventDefault();
}
window.addEventListener('keydown', onSearchKeys, true);

function onPasteLinks(e) {
  if (!e.target.matches?.('.as-input')) return;
  const lines = (e.clipboardData?.getData('text') || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines.some(isLink)) return;
  e.preventDefault();
  openBatch(linksBatch(lines));
  update();
}
document.addEventListener('paste', onPasteLinks, true);

function openAddPop() {
  const btn = document.querySelector('.topbar [data-act="pop:add"]');
  const r = btn ? btn.getBoundingClientRect() : { left: innerWidth - 8, right: innerWidth - 8, top: 8, bottom: 8 };
  S.ui.menu = null;
  S.ui.pop = { id: 'add', rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
}
function takeDrop(dt) {
  const dir = [...dt.items].map(it => it.webkitGetAsEntry?.()).find(en => en?.isDirectory);
  if (dir) return openBatch(folderBatch(dir.name));
  const files = [...dt.files].map(f => ({ name: f.name, mb: f.size / MB }));
  if (files.length > 1) return openBatch(filesBatch(files));
  openAddPop();
  const f = files[0];
  if (!f) return showDropError("That folder couldn't be read.");
  if (!AUDIO_EXT.includes(f.name.split('.').pop().toLowerCase())) return showDropError(DROP_ERRORS[0]);
  if (f.mb > MAX_FILE_MB) return showDropError('File is too large (' + fmtSize(f.mb) + '). Maximum is ' + MAX_FILE_MB + ' MB.');
  Object.assign(A, { staged: { kind: 'file', ...f }, batch: null, text: '', dropError: null });
}
let dragDepth = 0;
let dropzone;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
function setDragging(onNow) {
  A.dragging = onNow;
  dropzone ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'as-dropzone', innerHTML: `<div>${icon('upload', 28)}<b>Drop files or a folder</b></div>` }));
  dropzone.hidden = !onNow;
  if (S.ui.pop?.id === 'add') update('overlays');
}
window.addEventListener('dragenter', function onFileDragEnter(e) { if (hasFiles(e)) { dragDepth++; if (dragDepth === 1) setDragging(true); } });
window.addEventListener('dragleave', function onFileDragLeave(e) { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
window.addEventListener('dragover', function onFileDragOver(e) { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', function onFileDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  takeDrop(e.dataTransfer);
  update();
});
