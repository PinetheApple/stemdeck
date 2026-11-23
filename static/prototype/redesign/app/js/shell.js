// PROTOTYPE - throwaway. The mockup strip, the top bar and the collapsed/expanded sidebar.
import { S, favorites, library, importing, trashed, song, playable, recentlyPlayed } from './store.js';
import { icon, logo, esc } from './ui.js';
import { songRow } from './songs.js';

const SCENARIOS = [['default', 'Song open'], ['viewing', 'Viewing another song'], ['importing', 'Imports running'], ['nosong', 'No song open'], ['error', 'Playback error'], ['offline', 'Offline']];
const RECENT = 4;

export const mockbar = () => `<a href="../index.html">Overview</a><a href="../b.html">B mockup</a><a class="is-on">Full prototype</a>
  <span>state</span>${SCENARIOS.map(([id, label]) => `<button class="${S.ui.scenario === id ? 'is-on' : ''}" data-act="scenario:${id}">${label}</button>`).join('')}
  <div class="sp"></div><span class="dim">Theme and font: Settings › Appearance</span>`;

const toggleBtn = (key, ic, title) => `<button class="iconbtn ${S.ui[key] ? 'is-on' : ''}" aria-pressed="${S.ui[key]}" data-act="flip:${key}" title="${title}">${icon(ic, 18)}</button>`;
const hasAlerts = () => { const n = S.ui.notices; return !n || n.cards.length > 0 || !n.releaseHidden; };
const badge = n => (n ? `<i class="badge">${n > 99 ? '99+' : n}</i>` : '');

export const topbar = () => `
  ${toggleBtn('sidebar', 'panel-left', 'Show or hide the sidebar')}
  <a class="brand" href="https://stemdeck.app" target="_blank" rel="noopener" title="Open stemdeck.app">${logo} StemDeck</a>
  <div class="sp"></div>
  ${S.ui.offline ? `<span class="offline" title="Can't reach StemDeck">${icon('alert', 14)} Offline</span>` : ''}
  ${importing().length ? `<button class="btn btn--quiet" data-act="browse:queue" title="Import queue">${icon('download')} Importing ${importing().length}</button>` : ''}
  <button class="btn" data-act="pop:add" title="Add songs from a link, a search or your files">${icon('plus')} Add song</button>
  <button class="iconbtn ${S.ui.pop?.id === 'alerts' ? 'is-on' : ''}" data-act="pop:alerts" title="Alerts: failures and new releases">${icon('bell', 18)}${hasAlerts() ? '<i class="dotbadge"></i>' : ''}</button>
  <button class="iconbtn ${S.ui.guide ? 'is-on' : ''}" aria-pressed="${S.ui.guide}" data-act="flip:guide" title="Explain the screen">${icon('help', 18)}</button>
  <button class="iconbtn" data-act="dialog:settings" title="Settings">${icon('settings', 18)}</button>
  ${toggleBtn('panel', 'panel-right', 'Show or hide song tools')}`;

const group = (ic, label, extra = '') => `<div class="group">${icon(ic, 13)} <span>${label}</span><div class="sp"></div>${extra}</div>`;
const setRow = l => `<div class="srow" tabindex="-1" data-act="browse:setlist:${l.id}" data-drop="addToSet:{id}:${l.id}">
  <div class="cover settile">${icon('list-music', 18)}</div>
  <div class="row__txt"><div class="row__t ell">${esc(l.name)}</div><div class="row__s ell">Setlist · ${l.songIds.length} songs</div></div>
  <div class="srow__acts"><button class="iconbtn" tabindex="-1" data-act="playSetlist:${l.id}" title="Play ${esc(l.name)} from the top">${icon('play', 14, 'ic--fill')}</button></div>
</div>`;
const more = view => `<button class="linkbtn" data-act="browse:${view}">See all</button>`;

export function sidebar() {
  const favs = favorites();
  const playing = song(S.playId);
  const shown = favs.concat(playing && !favs.includes(playing) ? [playing] : []);
  const recent = recentlyPlayed().filter(s => !shown.includes(s)).concat(library().filter(s => playable(s) && !shown.includes(s))).filter((s, i, all) => all.indexOf(s) === i).slice(0, RECENT);
  return `<div class="lib__top"><button class="btn browsebtn" data-act="browse:all" title="Browse library (Ctrl K)">${icon('library')} <span>Browse library</span><kbd class="kbd">Ctrl K</kbd></button></div>
  <div class="lib__list" data-scroll="sidebar" data-rows>
    ${importing().length ? group('download', 'Importing', more('queue')) + importing().map(s => songRow(s)).join('') : ''}
    ${group('heart', 'Favorites', more('fav'))}${shown.length ? shown.map(s => songRow(s)).join('') : '<div class="empty">Click ♥ on a song to keep it here.</div>'}
    ${group('list-music', 'Setlists', `<button class="iconbtn iconbtn--sm" data-act="newSetlist" title="New setlist">${icon('plus', 14)}</button>`)}${S.setlists.map(setRow).join('')}
    ${group('clock', 'Recently played', more('recent'))}${recent.map(s => songRow(s)).join('')}
  </div>
  <div class="lib__foot"><button class="btn btn--quiet" data-act="browse:trash" data-drop="trash:{id}" title="Trash">${icon('trash-2')} <span>Trash</span>${badge(trashed().length)}</button></div>`;
}
