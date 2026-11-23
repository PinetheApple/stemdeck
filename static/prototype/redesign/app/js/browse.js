// PROTOTYPE - throwaway. The Browse library overlay: every song, folders, setlists, favorites and Trash.
import { S, act, actions, library, favorites, trashed, importing, folder, setlist, song, folderTree, folderColor, armed, playable } from './store.js';
import { registerRegion, browseViews } from './slots.js';
import { icon, esc, emptyState, fmt } from './ui.js';
import { registerMenu } from './slots.js';
import { songRow, songCard } from './songs.js';

const matches = (s, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (needle.startsWith('#')) return (s.tags || []).some(t => t.toLowerCase().includes(needle.slice(1)));
  return [s.title, s.artist, s.source, ...(s.tags || [])].some(v => (v || '').toLowerCase().includes(needle));
};
const navBtn = (view, ic, label, count, extra = '') => `<button class="${S.ui.browse.view === view ? 'is-on' : ''}" data-act="browse:${view}" ${extra}>${ic}<span class="ell">${esc(label)}</span>${count === undefined ? '' : `<i class="count">${count}</i>`}</button>`;
const folderDot = f => `<span class="dot" style="background:${folderColor(f.color)}"></span>`;

const nav = () => `<nav data-scroll="browse-nav">
  ${navBtn('all', icon('music'), 'All songs', library().length)}
  ${navBtn('fav', icon('heart'), 'Favorites', favorites().length)}
  ${navBtn('recent', icon('clock'), 'Recently added')}
  ${importing().length ? navBtn('queue', icon('download'), 'Import queue', importing().length) : ''}
  <div class="group">Setlists<div class="sp"></div><button class="iconbtn iconbtn--sm" data-act="newSetlist" title="New setlist">${icon('plus', 14)}</button></div>
  ${S.setlists.map(l => navBtn('setlist:' + l.id, icon('list-music'), l.name, l.songIds.length, `data-drop="addToSet:{id}:${l.id}"`)).join('')}
  <div class="group">Folders<div class="sp"></div><button class="iconbtn iconbtn--sm" data-act="newFolder" title="New folder">${icon('plus', 14)}</button></div>
  ${folderTree().map(f => navBtn('folder:' + f.id, `<span style="width:${f.depth * 14}px"></span>` + folderDot(f), f.name, library().filter(s => s.folder === f.id).length, `data-drop="moveTo:{id}:${f.id}" data-ctx="menu:folder:${f.id}"`)).join('')}
  <div class="sp"></div>
  ${navBtn('trash', icon('trash-2'), 'Trash', trashed().length, 'data-drop="trash:{id}"')}
</nav>`;

const SORTS = { added: 'Recently added', title: 'Title', artist: 'Artist', dur: 'Length', bpm: 'Tempo', key: 'Key', custom: 'My order' };
const TEMPOS = { '': 'Any tempo', slow: 'Slow (under 90 BPM)', mid: 'Medium (90 to 130 BPM)', fast: 'Fast (over 130 BPM)' };
const MODES = { '': 'Any key', maj: 'Major keys', min: 'Minor keys' };
const SLOW_BPM = 90;
const FAST_BPM = 130;
const inTempo = (s, t) => !t || (t === 'slow' ? s.bpm < SLOW_BPM : t === 'fast' ? s.bpm > FAST_BPM : s.bpm >= SLOW_BPM && s.bpm <= FAST_BPM);
const filterCount = () => [S.ui.lib.favOnly, S.ui.lib.tempo, S.ui.lib.mode].filter(Boolean).length;

/** Applies the library's filters and sort; 'custom' keeps the order the user dragged songs into. */
function arrange(songs) {
  const { sort, dir, favOnly, tempo, mode } = S.ui.lib;
  const kept = songs.filter(s => (!favOnly || s.fav) && inTempo(s, tempo) && (!mode || (s.key || '').includes(mode)));
  if (sort === 'custom') return kept;
  const value = s => (sort === 'added' ? s.added : sort === 'dur' ? s.dur : sort === 'bpm' ? s.bpm : (s[sort] || '').toLowerCase());
  const sorted = [...kept].sort((a, b) => (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

registerMenu('sort', () => [
  { heading: 'Sort by' },
  ...Object.entries(SORTS).map(([id, label]) => ({ label, act: 'libSort:' + id, checked: S.ui.lib.sort === id })),
  'sep',
  { label: 'Ascending', icon: 'arrow-up', act: 'libDir:asc', checked: S.ui.lib.dir === 'asc', disabled: S.ui.lib.sort === 'custom' },
  { label: 'Descending', icon: 'arrow-down', act: 'libDir:desc', checked: S.ui.lib.dir === 'desc', disabled: S.ui.lib.sort === 'custom' },
]);
registerMenu('filter', () => [
  { label: 'Favorites only', icon: 'heart', act: 'libFav', checked: S.ui.lib.favOnly, keep: true },
  { heading: 'Tempo' },
  ...Object.entries(TEMPOS).map(([id, label]) => ({ label, act: 'libTempo:' + id, checked: S.ui.lib.tempo === id, keep: true })),
  { heading: 'Key' },
  ...Object.entries(MODES).map(([id, label]) => ({ label, act: 'libMode:' + id, checked: S.ui.lib.mode === id, keep: true })),
  'sep',
  { label: 'Clear filters', icon: 'x', act: 'libClear', disabled: !filterCount() },
]);
const bulk = name => S.ui.lib.picked.map(id => name + ':' + id);
registerMenu('bulkSet', () => S.setlists.map(l => ({ label: l.name, icon: 'list-music', act: 'bulk:addToSet:' + l.id })));
registerMenu('bulkFolder', () => folderTree().map(f => ({ label: f.name, color: folderColor(f.color), indent: f.depth, act: 'bulk:moveTo:' + f.id })));

const bulkBar = () => (S.ui.lib.picking ? `<div class="bulkbar"><b>${S.ui.lib.picked.length} selected</b>
  <button class="btn btn--quiet" data-act="pickAll">Select all</button><div class="sp"></div>
  <button class="btn" data-act="bulk:upnext">${icon('list-plus')} Up Next</button>
  <button class="btn" data-act="menu:bulkSet">${icon('list-music')} Add to setlist</button>
  <button class="btn" data-act="menu:bulkFolder">${icon('folder')} Move to folder</button>
  <button class="btn" data-act="bulk:fav">${icon('heart')} Favorite</button>
  <button class="btn is-danger" data-act="bulk:trash">${icon('trash-2')} Trash</button>
  <button class="btn btn--accent" data-act="pickMode">Done</button></div>` : '');

const reorderHint = () => (S.ui.lib.sort === 'custom' ? '<div class="hint" style="padding:0 4px 8px">My order: drag a song onto another to place it before that song.</div>' : '');
const dropAttr = s => (S.ui.lib.sort === 'custom' ? `data-drop="reorder:{id}:${s.id}"` : '');

const DAY = 86400000;
function addedLabel(at) {
  const days = Math.floor((Date.now() - at) / DAY);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 30) return days + ' days ago';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const COLS = [['key', 'Key', 'c-key'], ['bpm', 'Tempo', 'c-bpm'], ['dur', 'Length', 'c-dur'], ['folder', 'Folder', 'c-folder'], ['added', 'Added', 'c-added']];
const cells = s => (s.status === 'done' ? `<span class="cell c-key">${esc(s.key || '—')}</span><span class="cell c-bpm mono">${s.bpm || '—'}</span><span class="cell c-dur mono">${fmt(s.dur)}</span>
  <span class="cell c-folder ell"><span class="dot" style="background:${folderColor(folder(s.folder)?.color)}"></span> ${esc(folder(s.folder)?.name || '')}</span><span class="cell c-added">${addedLabel(s.added)}</span>` : COLS.map(c => `<span class="cell ${c[2]}"></span>`).join(''));
const sortMark = id => (S.ui.lib.sort === id ? icon(S.ui.lib.dir === 'asc' ? 'arrow-up' : 'arrow-down', 11) : '');
const colHead = ([id, label, cls]) => (id === 'folder' ? `<span class="cell ${cls}">${label}</span>` : `<button class="cell ${cls} ${S.ui.lib.sort === id ? 'is-on' : ''}" data-act="libSortBy:${id}" title="Sort by ${label.toLowerCase()}">${label} ${sortMark(id)}</button>`);
const tableHead = () => `<div class="thead"><button class="cell c-title ${S.ui.lib.sort === 'title' ? 'is-on' : ''}" data-act="libSortBy:title" title="Sort by title">Title ${sortMark('title')}</button>
  <button class="cell c-artist ${S.ui.lib.sort === 'artist' ? 'is-on' : ''}" data-act="libSortBy:artist" title="Sort by artist">Artist ${sortMark('artist')}</button><div class="sp"></div>${COLS.map(colHead).join('')}<span class="cell c-acts"></span></div>`;

const VIEW_NAMES = { all: 'All songs', fav: 'Favorites', recent: 'Recently added' };
const contextLabel = () => { const [kind, id] = S.ui.browse.view.split(':'); return kind === 'folder' ? folder(id).name : VIEW_NAMES[kind] || 'Library'; };
const list = (songs, layout) => reorderHint() + (layout === 'list'
  ? `${tableHead()}<div class="blist blist--table" data-rows data-context="${esc(contextLabel())}">${songs.map(s => `<div class="dropwrap" ${dropAttr(s)}>${songRow(s, { cols: cells(s) })}</div>`).join('')}</div>`
  : `<div class="bgrid" data-rows data-context="${esc(contextLabel())}">${songs.map(s => `<div class="dropwrap" ${dropAttr(s)}>${songCard(s)}</div>`).join('')}</div>`);
const noMatch = q => emptyState('search', 'No tracks match your search', 'Try another word, or start with # to search by tag.');

function folderView(id, q, layout) {
  const f = folder(id);
  const songs = arrange(library().filter(s => s.folder === id && matches(s, q)));
  const subs = S.folders.filter(x => x.parent === id);
  return `<div class="bhead">${folderDot(f)}<h2 class="ell">${esc(f.name)}</h2><span class="dim">${songs.length} songs</span><div class="sp"></div>
    ${f.system ? '' : `<button class="btn" data-act="folderToSet:${id}">${icon('list-music')} Make a setlist</button><button class="iconbtn" data-act="menu:folder:${id}" title="More">${icon('ellipsis', 18)}</button>`}</div>
    ${subs.length ? `<div class="chips">${subs.map(x => `<button class="pill" data-act="browse:folder:${x.id}">${folderDot(x)} ${esc(x.name)}</button>`).join('')}</div>` : ''}
    ${songs.length ? list(songs, layout) : q ? noMatch(q) : emptyState('folder', 'Nothing in this folder yet.', 'Drag songs here, or use a song’s ⋯ menu.')}`;
}

function setlistView(id) {
  const l = setlist(id);
  const canPlay = l.songIds.some(sid => playable(song(sid)));
  const row = (sid, i) => {
    const s = song(sid);
    const acts = `<button class="iconbtn" tabindex="-1" ${i === 0 ? 'disabled' : ''} data-act="setMove:${id}:${i}:-1" title="Move up">${icon('arrow-up', 15)}</button>
      <button class="iconbtn" tabindex="-1" ${i === l.songIds.length - 1 ? 'disabled' : ''} data-act="setMove:${id}:${i}:1" title="Move down">${icon('arrow-down', 15)}</button>
      <button class="iconbtn" tabindex="-1" data-act="setRemove:${id}:${i}" title="Remove from this setlist">${icon('x', 15)}</button>`;
    return songRow(s, { lead: `<i class="num mono">${i + 1}</i>`, acts, sub: s.trashed ? 'In the Trash' : undefined });
  };
  return `<div class="bhead"><div class="cover settile" style="width:44px;height:44px">${icon('list-music', 20)}</div><h2 class="ell">${esc(l.name)}</h2><span class="dim">${l.songIds.length} songs</span><div class="sp"></div>
    <button class="btn btn--accent" ${canPlay ? '' : 'disabled'} data-act="playSetlist:${id}">${icon('play', 14, 'ic--fill')} Play from the top</button>
    <button class="iconbtn" data-act="dialog:renameSetlist:${id}" title="Rename ${esc(l.name)}">${icon('pencil', 16)}</button>
    <button class="iconbtn" ${l.songIds.length ? '' : 'disabled'} data-act="setToFolder:${id}" title="Make a folder from ${esc(l.name)}">${icon('folder', 16)}</button>
    <button class="btn btn--quiet ${armed('setlist:' + id) ? 'is-danger' : ''}" data-act="deleteSetlist:${id}" title="Delete ${esc(l.name)}">${icon('trash-2', 16)}${armed('setlist:' + id) ? ' Delete?' : ''}</button></div>
    ${l.songIds.length ? `<div class="blist" data-rows data-context="${esc(l.name)}">${l.songIds.map(row).join('')}</div>` : emptyState('list-music', 'No songs yet.', 'Add them from a song’s ⋯ menu, or drag songs onto this setlist.')}`;
}

function trashView(q) {
  const songs = trashed().filter(s => matches(s, q));
  return `<div class="bhead"><h2>Trash</h2><span class="dim">${songs.length} songs</span><div class="sp"></div>
    <button class="btn ${armed('emptyTrash') ? 'is-danger' : ''}" ${songs.length ? '' : 'disabled'} data-act="emptyTrash">${icon('trash-2')} ${armed('emptyTrash') ? 'Delete permanently?' : 'Empty trash'}</button></div>
    ${songs.length ? `<div class="blist" data-rows>${songs.map(s => songRow(s)).join('')}</div>` : emptyState('trash-2', 'Trash is empty', 'Songs you delete wait here, so you can restore them.')}`;
}

const titled = (title, songs, q, layout, empty) => `<div class="bhead"><h2>${title}</h2><span class="dim">${songs.length} songs</span></div>${songs.length ? list(songs, layout) : q ? noMatch(q) : empty}`;

function results() {
  const { view, q, layout } = S.ui.browse;
  const [kind, id] = view.split(':');
  if (browseViews[kind]) return browseViews[kind](id, q);
  if (kind === 'folder') return folderView(id, q, layout);
  if (kind === 'setlist') return setlistView(id);
  if (kind === 'trash') return trashView(q);
  if (kind === 'fav') return titled('Favorites', arrange(favorites().filter(s => matches(s, q))), q, layout, emptyState('heart', 'No favorites yet', 'Click ♥ on a song to keep it here.'));
  if (kind === 'recent') return titled('Recently added', library().filter(s => matches(s, q)).sort((a, b) => b.added - a.added).slice(0, 12), q, layout, '');
  return titled('All songs', arrange(library().filter(s => matches(s, q))), q, layout, emptyState('music', 'Start with a song', 'Use Add song to paste links, or drop files or a folder.'));
}
registerRegion('browse-results', () => results() + bulkBar());

const layoutBtn = (id, ic, title) => `<button class="iconbtn ${S.ui.browse.layout === id ? 'is-on' : ''}" aria-pressed="${S.ui.browse.layout === id}" data-act="browseLayout:${id}" title="${title}">${icon(ic, 16)}</button>`;

export function browse() {
  if (!S.ui.browse) return '';
  const tags = [...new Set(library().flatMap(s => s.tags || []))].slice(0, 8);
  return `<div class="scrim" data-act="closeBrowse"></div>
  <div class="libover" role="dialog" aria-label="Library">${nav()}
    <div class="libmain">
      <div class="btools"><label class="search">${icon('search')}<input data-input="browseQuery" value="${esc(S.ui.browse.q)}" placeholder="Search songs, artists, or #tag" autocomplete="off"></label>
        <button class="btn" data-act="menu:sort" title="Sort the library">${icon(S.ui.lib.dir === 'asc' ? 'arrow-up' : 'arrow-down', 14)} ${SORTS[S.ui.lib.sort]}</button>
        <button class="btn ${filterCount() ? 'is-on' : ''}" data-act="menu:filter" title="Filter the library">${icon('sliders-horizontal', 14)} Filter${filterCount() ? ' · ' + filterCount() : ''}</button>
        <button class="btn ${S.ui.lib.picking ? 'is-on' : ''}" aria-pressed="${S.ui.lib.picking}" data-act="pickMode" title="Select several songs to change them together">${icon('check', 14)} Select</button>
        ${layoutBtn('grid', 'grid', 'Show as a grid')}${layoutBtn('list', 'list', 'Show as a list')}
        <button class="iconbtn" data-act="closeBrowse" title="Close (Esc)">${icon('x', 18)}</button></div>
      <div class="chips tagrow">${tags.map(t => `<button class="tag" data-act="browseTag:${esc(t)}">#${esc(t)}</button>`).join('')}</div>
      <div class="bresults" data-region="browse-results" data-scroll="browse">${results()}${bulkBar()}</div>
    </div>
  </div>`;
}

act('browseQuery', (ctx, value) => { S.ui.browse.q = value; return ['browse-results']; });
act('browseTag', (ctx, tag) => { S.ui.browse.q = S.ui.browse.q === '#' + tag ? '' : '#' + tag; return ['browse']; });

// Sort, filter, manual order and multi-select.
act('libSort', (ctx, id) => { S.ui.lib.sort = id; return ['browse']; });
act('libSortBy', (ctx, id) => { const lib = S.ui.lib; if (lib.sort === id) lib.dir = lib.dir === 'asc' ? 'desc' : 'asc'; else { lib.sort = id; lib.dir = id === 'added' ? 'desc' : 'asc'; } return ['browse']; });
act('libDir', (ctx, dir) => { S.ui.lib.dir = dir; return ['browse']; });
act('libFav', () => { S.ui.lib.favOnly = !S.ui.lib.favOnly; return ['browse', 'overlays']; });
act('libTempo', (ctx, id) => { S.ui.lib.tempo = id || ''; return ['browse', 'overlays']; });
act('libMode', (ctx, id) => { S.ui.lib.mode = id || ''; return ['browse', 'overlays']; });
act('libClear', () => { Object.assign(S.ui.lib, { favOnly: false, tempo: '', mode: '' }); return ['browse', 'overlays']; });
act('reorder', (ctx, id, beforeId) => {
  if (id === beforeId) return false;
  const moved = S.songs.splice(S.songs.findIndex(s => s.id === id), 1)[0];
  S.songs.splice(S.songs.findIndex(s => s.id === beforeId), 0, moved);
  return ['browse', 'sidebar'];
});
act('pickMode', () => { S.ui.lib.picking = !S.ui.lib.picking; S.ui.lib.picked = []; return ['browse']; });
act('pickAll', () => { S.ui.lib.picked = [...document.querySelectorAll('.bresults [data-songrow]')].map(el => el.dataset.songrow); return ['browse']; });
act('bulk', (ctx, name, arg) => {
  S.ui.lib.picked.forEach(id => actions[name](ctx, id, arg));
  S.ui.lib.picked = []; S.ui.menu = null;
});
const selectOne = actions.select;
act('select', (ctx, id) => {
  if (!S.ui.lib.picking || !S.ui.browse) return selectOne(ctx, id);
  const at = S.ui.lib.picked.indexOf(id);
  if (at >= 0) S.ui.lib.picked.splice(at, 1); else S.ui.lib.picked.push(id);
  return ['browse'];
});
const openOne = actions.open;
act('open', (ctx, id) => (S.ui.lib.picking && S.ui.browse ? false : openOne(ctx, id)));
