// PROTOTYPE - throwaway. First-pass tabs and dialogs; fuller files register over these by id.
import { S, act, song, folder, setlist, playSong, dataOf, playable, FOLDER_COLOR_NAMES, folderColor } from './store.js';
import { registerTab, registerDialog } from './slots.js';
import { icon, esc, fmt, cover, emptyState } from './ui.js';

registerTab('lyrics', 'Lyrics', () => {
  if (!S.playId) return emptyState('text', 'Open a track to find its lyrics.');
  const lines = dataOf(S.playId).lyrics;
  return lines.length ? `<div class="ly">${lines.map((l, i) => `<p data-li="${i}" data-act="seekTo:${l.t}">${esc(l.text)}</p>`).join('')}</div>` : '<div class="empty">Loading lyrics…</div>';
});

const queueRow = (id, i) => { const s = song(id); return `<div class="srow" tabindex="-1" data-act="playQueued:${i}" title="Play now"><i class="num mono">${i + 1}</i>${cover(s, 40)}
  <div class="row__txt"><div class="row__t ell">${esc(s.title)}</div><div class="row__s ell">${fmt(s.dur)}</div></div>
  <div class="srow__acts"><button class="iconbtn" data-act="moveQueued:${i}:-1" title="Move up">${icon('arrow-up', 15)}</button><button class="iconbtn" data-act="moveQueued:${i}:1" title="Move down">${icon('arrow-down', 15)}</button><button class="iconbtn" data-act="unqueue:${i}" title="Remove from Up Next">${icon('x', 15)}</button></div></div>`; };
registerTab('upnext', () => 'Up Next' + (S.upNext.length ? ` <i class="count">${S.upNext.length}</i>` : ''), () => {
  const s = playSong();
  return `<div class="group">Now playing</div>${s ? `<div class="srow is-playing">${cover(s, 44)}<div class="row__txt"><div class="row__t ell">${esc(s.title)}</div><div class="row__s ell">${fmt(s.dur)}</div></div></div>` : '<div class="empty">Nothing is open</div>'}
  <div class="group">Up next<div class="sp"></div>${s || S.upNext.length ? '<button class="linkbtn" data-act="saveQueue">Save as setlist</button>' : ''}${S.upNext.length ? '<button class="linkbtn" data-act="clearQueue">Clear</button>' : ''}</div>
  ${S.upNext.length ? S.upNext.map(queueRow).join('') : emptyState('list-music', 'Up Next is empty', 'Press + on a song in the library to play it after this one.')}`;
});
['tempo:Tempo', 'eq:EQ', 'details:Details'].forEach(pair => { const [id, label] = pair.split(':'); registerTab(id, label, () => emptyState('sliders-horizontal', label, 'This tab is built in the next pass.')); });

const dlgHead = title => `<div class="dlg__head"><h3>${esc(title)}</h3><button class="iconbtn" data-act="closeDialog" title="Close (Esc)">${icon('x', 18)}</button></div>`;
const input = (name, value, placeholder = '') => `<input class="input" data-input="dlgField:${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`;
const dlgFoot = (saveAct, label = 'Save') => `<div class="dlg__foot"><button class="btn" data-act="closeDialog">Cancel</button><button class="btn btn--accent" data-act="${saveAct}">${label}</button></div>`;
act('dlgField', (ctx, name, value) => { S.ui.dialog.values = { ...S.ui.dialog.values, [name]: value }; return false; });
const value = (name, fallback) => S.ui.dialog.values?.[name] ?? fallback;

registerDialog('folder', d => {
  const f = folder(d.folderId || d.arg);
  return dlgHead(d.title || (f.system ? 'Edit folder' : 'Rename folder')) + `<div class="dlg__body">
    ${f.system ? '' : '<label class="lbl">Name</label>' + input('name', f.name)}
    <label class="lbl">Color</label><div class="swatches">${FOLDER_COLOR_NAMES.map(c => `<button class="swatch ${f.color === c ? 'is-on' : ''}" style="background:${folderColor(c)}" data-act="folderColor:${f.id}:${c}" title="${c}"></button>`).join('')}</div>
  </div>` + dlgFoot('saveFolder:' + f.id);
});
act('saveFolder', (ctx, id) => { const name = value('name', folder(id).name).trim(); if (name) folder(id).name = name.slice(0, 100); S.ui.dialog = null; });

registerDialog('rename', d => {
  const s = song(d.arg);
  return dlgHead('Rename this song') + `<div class="dlg__body"><label class="lbl">Song title</label>${input('title', s.title, s.title)}<label class="lbl">Artist</label>${input('artist', s.artist)}
    <div class="hint">Enter saves · Esc cancels. Emptying a field goes back to the detected name.</div></div>` + dlgFoot('saveRename:' + s.id);
});
act('saveRename', (ctx, id) => { const s = song(id); s.title = value('title', s.title).trim() || s.title; s.artist = value('artist', s.artist).trim(); S.ui.dialog = null; });

registerDialog('renameSetlist', d => { const l = setlist(d.arg); return dlgHead('Rename setlist') + `<div class="dlg__body"><label class="lbl">Name</label>${input('name', l.name)}</div>` + dlgFoot('saveSetlist:' + l.id); });
act('saveSetlist', (ctx, id) => { const name = value('name', setlist(id).name).trim(); if (name) setlist(id).name = name.slice(0, 100); S.ui.dialog = null; });

act('retryImport', (ctx, id) => { const s = song(id); s.status = 'queued'; s.stage = 'Queued - #3 in line'; s.progress = 0; });
act('cancelImport', (ctx, id) => { S.songs = S.songs.filter(s => s.id !== id); });
act('download', () => false);
act('renameSection', () => false);
