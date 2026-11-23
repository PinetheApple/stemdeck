// PROTOTYPE - throwaway layout mockup.
import { boot, mockbar, addPop, lyricsList, songHead, overview, presets, transport, icon, S, STEMS } from './mock.js';
document.getElementById('bar').outerHTML = mockbar('c');

const cov = (s, big) => (s.cover ? `background-image:url('${s.cover.replace('maxresdefault', big ? 'mqdefault' : 'default')}')` : '');
const tile = (s, i) => `<button class="tile ${s === S.song ? 'is-current' : ''}" data-act="song:${s.id}"><i>${i + 1}</i><div class="cover" style="width:32px;height:32px;${cov(s)}"></div><span class="ell">${s.title}</span></button>`;
const strip = s => `<div class="strip" data-stem="${s.id}" style="--c:var(--${s.id})">
  <button class="ms ms--s" data-act="solo:${s.id}" title="Solo ${s.name}">S</button>
  <div class="strip__fader"><div class="meter"><i></i></div><input class="vfader" type="range" min="0" max="1" step="0.01" data-vol="${s.id}"></div>
  <button class="strip__name" data-act="mute:${s.id}" title="Tap to mute or unmute">${s.name}</button>
</div>`;
const card = s => `<button class="card2 ${s === S.song ? 'is-current' : ''}" data-act="song:${s.id}"><div class="cover" style="${cov(s, true)}"></div><div class="row__t ell">${s.title}</div><div class="row__s ell">${s.artist}</div></button>`;
const setlist = () => { const i = S.songs.indexOf(S.song); const start = Math.max(0, Math.min(i - 1, S.songs.length - 6)); return S.songs.slice(start, start + 6).map((s, n) => tile(s, n)).join(''); };
boot(() => `<div class="app app--c">
  <header class="topbar">
    <button class="btn" data-act="pop:library">${icon('library')} Library <kbd class="mono dim" style="font-size:10.5px">Ctrl K</kbd></button>
    <span class="lbl" style="margin:0 4px 0 12px">Sunday set</span>
    <div class="set">${setlist()}</div>
    <div class="sp"></div>
    <div class="anchor"><button class="btn" data-act="pop:add">${icon('plus')} Add song</button>${addPop()}</div>
    <button class="iconbtn" title="Alerts">${icon('bell', 18)}</button><button class="iconbtn" title="Settings">${icon('settings', 18)}</button>
  </header>
  <main class="main-c"><div class="wash"></div>
    ${songHead()}
    ${overview()}
    <div class="panel big-ly">${lyricsList()}</div>
  </main>
  <aside class="console">
    <div class="mixrow">${presets()}</div>
    <div class="strips">${STEMS.map(strip).join('')}</div>
    <div class="hint">Tap a name to mute · drag a fader for level · S to solo</div>
  </aside>
  ${transport()}
  <div class="pop libover" data-pop="library" hidden>
    <nav><button class="is-on">${icon('music')} All songs</button><button>${icon('heart')} Favourites</button>
      <div class="group">Setlists</div><button>${icon('list-music')} Sunday set</button><button>${icon('plus')} New setlist</button>
      <div class="group">Folders</div><button>${icon('folder')} Unsorted</button><button>${icon('trash-2')} Trash</button></nav>
    <div class="libmain"><div class="search">${icon('search')} Search songs, artists, setlists</div><div class="libgrid">${S.songs.map(card).join('')}</div></div>
  </div>
</div>`);
