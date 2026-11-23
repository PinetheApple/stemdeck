// PROTOTYPE - throwaway. Up Next tab: now playing, the queue with drag and Alt+Up/Down reordering.
import { S, act, actions, update, song, playSong, contextNext } from './store.js';
import { registerTab } from './slots.js';
import { icon, esc, fmt, cover, emptyState, kbd } from './ui.js';

const ROW_SEL = '[data-qrow]';

function queueRow(id, i) {
  const s = song(id);
  return '<div class="qrow" data-qrow="' + i + '" data-drag="' + id + '" draggable="true" data-drop="queueDrop:{id}:' + i + '">' +
    '<span class="qrow__grip" title="Drag to reorder">' + icon('grip-vertical', 14) + '</span>' +
    '<button class="qrow__main" tabindex="' + (i === 0 ? 0 : -1) + '" data-act="playQueued:' + i + '" title="Play now"><i class="num mono">' + (i + 1) + '</i>' + cover(s, 40) +
    '<span class="row__txt"><span class="row__t ell">' + esc(s.title) + '</span><span class="row__s ell">' + fmt(s.dur) + '</span></span></button>' +
    '<button class="iconbtn iconbtn--sm qrow__x" tabindex="-1" data-act="unqueue:' + i + '" title="Remove from Up Next">' + icon('x', 14) + '</button></div>';
}
function nowPlaying() {
  const s = playSong();
  if (!s) return '<div class="empty">Nothing is open</div>';
  return '<div class="srow is-playing">' + cover(s, 44) + '<div class="row__txt"><div class="row__t ell">' + esc(s.title) + '</div><div class="row__s ell">' + fmt(s.dur) + '</div></div></div>';
}
function queueHead() {
  const save = playSong() || S.upNext.length ? '<button class="linkbtn" data-act="saveQueue" title="Save Up Next as a setlist">Save as setlist</button>' : '';
  const clear = S.upNext.length ? '<button class="linkbtn" data-act="clearQueue" title="Remove every song from Up Next">Clear</button>' : '';
  return '<div class="group">Up next<div class="sp"></div>' + save + clear + '</div>';
}
const hint = () => '<p class="hint qhint">Drag to reorder · ' + kbd('Alt') + kbd('↑') + kbd('↓') + ' moves the focused row</p>';

const CONTEXT_PEEK = 8;
const contextRow = id => {
  const s = song(id);
  return '<div class="qrow"><button class="qrow__main qrow__main--ctx" tabindex="-1" data-act="playContext:' + id + '" title="Play now">' + cover(s, 40) +
    '<span class="row__txt"><span class="row__t ell">' + esc(s.title) + '</span><span class="row__s ell">' + fmt(s.dur) + '</span></span></button>' +
    '<button class="iconbtn iconbtn--sm qrow__x" tabindex="-1" data-act="upnext:' + id + '" title="Add to Up Next">' + icon('list-plus', 14) + '</button></div>';
};
/** Like Spotify's "Next from": what follows in the list the playing song was started from, after the queue runs out. */
function nextFrom() {
  const ids = contextNext();
  if (!ids.length) return '';
  const more = ids.length > CONTEXT_PEEK ? '<p class="hint qhint">and ' + (ids.length - CONTEXT_PEEK) + ' more</p>' : '';
  return '<div class="group">Next from: ' + esc(S.context.label) + '</div><div class="qlist">' + ids.slice(0, CONTEXT_PEEK).map(contextRow).join('') + '</div>' + more;
}

registerTab('upnext', () => 'Up Next' + (S.upNext.length ? ' <i class="count">' + S.upNext.length + '</i>' : ''), () => {
  const list = S.upNext.length
    ? '<div class="qlist" data-drop="queueDrop:{id}:' + S.upNext.length + '">' + S.upNext.map(queueRow).join('') + '</div>' + hint()
    : contextNext().length ? '<p class="hint qhint">Nothing queued. Press + on a song to play it next.</p>' : emptyState('list-music', 'Up Next is empty', 'Press + on a song in the library to play it after this one.');
  return '<div class="group">Now playing</div>' + nowPlaying() + queueHead() + list + nextFrom();
});

/** A drop moves a queued song to the row it lands on; a library song dropped here joins the queue there. */
act('queueDrop', (ctx, id, at) => {
  if (id === S.playId) return false;
  const from = S.upNext.indexOf(id);
  if (from >= 0) S.upNext.splice(from, 1);
  S.upNext.splice(Math.min(Number(at), S.upNext.length), 0, id);
  return ['panel', 'footer'];
});

const focusRow = i => document.querySelector(ROW_SEL + '[data-qrow="' + i + '"] .qrow__main')?.focus();
const ROVE = { ArrowDown: 1, ArrowUp: -1 };
function onQueueKey(e) {
  const row = e.target.closest?.(ROW_SEL);
  const step = ROVE[e.key];
  if (!row || S.ui.dialog) return;
  const i = Number(row.dataset.qrow);
  if (e.key === 'ArrowRight') { row.querySelector('.qrow__x').focus(); e.preventDefault(); return; }
  if (e.key === 'ArrowLeft') { row.querySelector('.qrow__main').focus(); e.preventDefault(); return; }
  if (!step) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!e.altKey) return focusRow(i + step);
  if (actions.moveQueued({}, i, step) === false) return;
  update('panel');
  focusRow(i + step);
}
document.addEventListener('keydown', onQueueKey);
