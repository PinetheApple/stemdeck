// PROTOTYPE - throwaway. Song rows, cards and the quick-options menu used everywhere a song is listed.
import { S, song, playable, folderTree, folderColor, viewingOther, armed } from './store.js';
import { registerMenu } from './slots.js';
import { icon, esc, fmt, coverStyle } from './ui.js';

const eqBars = '<span class="eqbars"><i></i><i></i><i></i></span>';

function subLine(s) {
  if (s.trashed) return 'Removed';
  if (s.status === 'processing') return `<span class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></span>${esc(s.stage)} ${Math.round(s.progress * 100)}%`;
  if (s.status === 'queued') return esc(s.stage);
  if (s.status === 'failed') return '<span class="bad">Import failed</span>';
  if (s.status === 'stopped') return 'Stopped';
  const tail = s.versions.length > 1 ? s.versions.length + ' versions' : fmt(s.dur);
  return (s.fav ? icon('heart', 10, 'ic--fill fav') + ' ' : '') + esc(s.artist) + ' · ' + tail;
}

const rowState = s => [S.ui.lib.picked.includes(s.id) ? 'is-picked' : '', s.id === S.playId ? 'is-playing' : '', s.id === S.ui.sel || (viewingOther() && s.id === S.viewId) ? 'is-sel' : '', playable(s) ? '' : 'is-busy'].join(' ');
const resumeBtn = s => `<button class="cover__play" tabindex="-1" data-act="play" title="Resume ${esc(s.title)}">${icon('play', 14, 'ic--fill')}</button>`;
const coverInner = s => (s.id === S.playId ? (S.playing ? eqBars : resumeBtn(s)) : playable(s) ? `<button class="cover__play" tabindex="-1" data-act="open:${s.id}" title="Play ${esc(s.title)}">${icon('play', 14, 'ic--fill')}</button>`
  : s.status === 'failed' ? icon(s.file ? 'file' : 'link', 16) : '');

function rowActions(s) {
  if (s.trashed) return `<button class="iconbtn" tabindex="-1" data-act="restore:${s.id}" title="Restore ${esc(s.title)}">${icon('rotate-ccw', 15)}</button>`;
  if (s.status === 'failed') return `<button class="iconbtn" tabindex="-1" data-act="retryImport:${s.id}" title="${s.file ? 'Pick the file again' : 'Retry'}">${icon('rotate-ccw', 15)}</button>`;
  if (s.status === 'stopped') return `<button class="iconbtn" tabindex="-1" data-act="retryImport:${s.id}" title="Extract ${esc(s.title)} again">${icon('zap', 15)}</button>`;
  if (!playable(s)) return `<button class="iconbtn" tabindex="-1" data-act="cancelImport:${s.id}" title="Cancel this import">${icon('x', 15)}</button>`;
  return `<button class="iconbtn" tabindex="-1" data-act="upnext:${s.id}" title="Add ${esc(s.title)} to Up Next">${icon('list-plus', 15)}</button>
    <button class="iconbtn" tabindex="-1" data-act="menu:song:${s.id}" title="More for ${esc(s.title)}">${icon('ellipsis', 15)}</button>`;
}

/** opts.lead: HTML shown before the cover (a setlist position); opts.acts: replaces the hover buttons. */
export const songRow = (s, opts = {}) => `<div class="srow ${rowState(s)}" tabindex="${s.id === S.ui.sel ? 0 : -1}" data-songrow="${s.id}" data-act="select:${s.id}" data-dbl="open:${s.id}" data-ctx="menu:song:${s.id}" draggable="true" data-drag="${s.id}">
  ${opts.lead || ''}<div class="cover" style="${coverStyle(s, 'md')}">${coverInner(s)}</div>
  <div class="row__txt"><div class="row__t ell">${esc(s.title)}</div><div class="row__s ell">${opts.sub || subLine(s)}</div></div>
  ${opts.cols || ''}<div class="srow__acts">${opts.acts || rowActions(s)}</div>
</div>`;

export const songCard = s => `<div class="scard ${rowState(s)}" tabindex="${s.id === S.ui.sel ? 0 : -1}" data-songrow="${s.id}" data-act="select:${s.id}" data-dbl="open:${s.id}" data-ctx="menu:song:${s.id}" draggable="true" data-drag="${s.id}">
  <div class="cover" style="${coverStyle(s, 'md')}">${coverInner(s)}
    ${playable(s) ? `<button class="scard__fav ${s.fav ? 'is-on' : ''}" tabindex="-1" data-act="fav:${s.id}" title="${s.fav ? 'Remove from Favorites' : 'Add to Favorites'}">${icon('heart', 14, s.fav ? 'ic--fill' : '')}</button>
    <button class="scard__more" tabindex="-1" data-act="menu:song:${s.id}" title="More for ${esc(s.title)}">${icon('ellipsis', 15)}</button>` : ''}</div>
  <div class="row__t ell">${esc(s.title)}</div><div class="row__s ell">${subLine(s)}</div>
</div>`;

/** Every quick option for a song. where = 'head' leaves Rename to the header's own title click. */
registerMenu('song', (id, where) => {
  const s = song(id);
  if (s.trashed) return [{ label: 'Restore', icon: 'rotate-ccw', act: 'restore:' + id }];
  return [
    { label: 'Play now', icon: 'play', act: 'open:' + id },
    { label: 'Add to Up Next', icon: 'list-plus', act: 'upnext:' + id, disabled: S.upNext.includes(id) || id === S.playId },
    { label: s.fav ? 'Remove from Favorites' : 'Add to Favorites', icon: 'heart', act: 'fav:' + id },
    'sep',
    ...(where === 'head' ? [] : [{ label: 'Rename…', icon: 'pencil', act: 'dialog:rename:' + id }]),
    { label: 'Extract more stems…', icon: 'audio-waveform', act: 'dialog:extract:' + id },
    { label: 'About this song', icon: 'info', act: 'dialog:aboutSong:' + id },
    { heading: 'Add to setlist' },
    ...S.setlists.map(l => ({ label: l.name, icon: 'list-music', act: 'addToSet:' + id + ':' + l.id, checked: l.songIds.includes(id), disabled: l.songIds.includes(id) })),
    { label: 'New setlist with this song', icon: 'plus', act: 'newSetWith:' + id },
    { heading: 'Move to folder' },
    ...folderTree().map(f => ({ label: f.name, color: folderColor(f.color), indent: f.depth, act: 'moveTo:' + id + ':' + f.id, checked: s.folder === f.id, disabled: s.folder === f.id })),
    { label: 'New folder…', icon: 'plus', act: 'newFolderWith:' + id },
    'sep',
    { label: 'Move to Trash', icon: 'trash-2', act: 'trash:' + id, danger: true },
  ];
});

registerMenu('folder', id => [
  { label: 'Rename…', icon: 'pencil', act: 'dialog:folder:' + id },
  { label: 'New subfolder', icon: 'plus', act: 'newFolder:' + id },
  { label: 'Make a setlist', icon: 'list-music', act: 'folderToSet:' + id, disabled: !S.songs.some(s => s.folder === id && !s.trashed) },
  'sep',
  { label: armed('folder:' + id) ? 'Delete? Click again' : 'Delete folder', icon: 'trash-2', act: 'deleteFolder:' + id, danger: true, keep: true },
]);
