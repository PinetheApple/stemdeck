// PROTOTYPE - throwaway layout mockup.
import { boot, mockbar, logo, addPop, minePop, songRow, sectionsBar, footerB, wave, icon, lyricsList, queueList, S, STEMS } from './mock.js';
document.getElementById('bar').outerHTML = mockbar('b');

const lane = s => `<div class="lane" data-stem="${s.id}" style="--c:var(--${s.id})">
  <div class="lane__h">
    <button class="lane__name" data-act="mute:${s.id}" title="Mute or unmute ${s.name}">${s.name}<small>My part</small></button>
    <button class="ms ms--m" data-act="mute:${s.id}" title="Mute">M</button><button class="ms ms--s" data-act="solo:${s.id}" title="Solo">S</button>
    <input class="vol" type="range" min="0" max="1" step="0.01" data-vol="${s.id}"><div class="meter"><i></i></div></div>
  <div class="lane__w">${wave(s.id, { playhead: false })}</div>
</div>`;

const tools = () => `
  <div class="card"><h4>${icon('metronome')} Tempo</h4><div class="big" data-b="bpm"></div>
    <div class="seg" style="margin-top:10px"><button class="is-on">Constant tempo</button><button>Follow the band</button></div>
    <div class="grid3"><button class="btn">Tap</button><button class="btn">÷ 2</button><button class="btn">× 2</button><button class="btn">← 10 ms</button><button class="btn">Beat 1 here</button><button class="btn">10 ms →</button></div></div>
  <div class="card"><h4>${icon('volume-2')} Click track</h4><div class="kv"><span>Sound</span><b>Classic</b><span>Accent</span><b>Auto · 2</b><span>Count-in</span><b>1 bar</b></div></div>
  <div class="card"><h4>${icon('sliders-horizontal')} EQ and mastering</h4><div class="hint">Per stem and master. Opens as a wide sheet over the lanes.</div></div>
  <div class="card"><h4>${icon('info')} Details</h4><div class="kv"><span>Key</span><b data-b="keyname"></b><span>Loudness</span><b>-11.9 LUFS</b><span>Tempo stability</span><b>96%</b><span>Stems</span><b>6</b></div></div>
  <div class="card"><h4>${icon('download')} Export and stems</h4><div class="grid3" style="grid-template-columns:1fr 1fr;margin-top:0"><button class="btn">Export mix…</button><button class="btn">Extract more…</button></div></div>`;

const PINNED = 5;
const RECENT = 4;
const setRow = (name, count) => `<button class="row"><div class="cover settile">${icon('list-music', 18)}</div><div class="row__txt"><div class="row__t ell">${name}</div><div class="row__s ell">Setlist · ${count} songs</div></div></button>`;
const group = (ic, label) => `<div class="group">${icon(ic, 13)} <span>${label}</span></div>`;

const sidebar = () => `<aside class="lib">
  <div class="lib__top"><button class="btn browsebtn" data-act="pop:library">${icon('library')} <span>Browse library</span><kbd class="mono">Ctrl K</kbd></button></div>
  <div class="lib__list">
    ${group('heart', 'Favorites')}${S.songs.slice(0, PINNED).concat(S.songs.indexOf(S.song) >= PINNED ? [S.song] : []).map(s => songRow(s)).join('')}
    ${group('list-music', 'Setlists')}${setRow('Sunday set', 6)}${setRow('Youth night', 4)}
    ${group('timer', 'Recent')}${S.songs.slice(PINNED, PINNED + RECENT).map(s => songRow(s)).join('')}
  </div>
</aside>`;

const card = (s, i) => `<button class="card2 ${s === S.song ? 'is-current' : ''}" data-act="song:${s.id}">
  <div class="cover" ${s.cover ? `style="background-image:url('${s.cover.replace('maxresdefault', 'mqdefault')}')"` : ''}><span class="pin ${i < PINNED ? 'is-on' : ''}" title="Add to Favorites">${icon('heart', 14, i < PINNED ? 'ic--fill' : '')}</span></div>
  <div class="row__t ell">${s.title}</div><div class="row__s ell">${s.artist}</div></button>`;

const browse = () => `<div class="pop libover" data-pop="library" hidden>
  <nav><button class="is-on">${icon('music')} All songs</button><button>${icon('heart')} Favorites</button><button>${icon('timer')} Recently added</button>
    <div class="group">Setlists</div><button>${icon('list-music')} Sunday set</button><button>${icon('list-music')} Youth night</button><button>${icon('plus')} New setlist</button>
    <div class="group">Folders</div><button>${icon('folder')} Unsorted</button><button>${icon('plus')} New folder</button>
    <div class="sp"></div><button>${icon('trash-2')} Trash</button></nav>
  <div class="libmain"><div class="search">${icon('search')} Search songs, artists, setlists</div><div class="libgrid">${S.songs.map(card).join('')}</div></div>
</div>`;

const tab = (id, label, ic) => `<button data-act="tab:panel:${id}" data-tabbtn="panel:${id}" data-default="lyrics">${icon(ic, 14)} ${label}</button>`;

boot(() => `<div class="app app--b">
  <header class="topbar">
    <button class="iconbtn" data-act="flip:lib" title="Show or hide the library">${icon('panel-left', 18)}</button>
    <div class="brand">${logo} StemDeck</div>
    <div class="sp"></div>
    <div class="anchor"><button class="btn" data-act="pop:add">${icon('plus')} Add song</button>${addPop()}</div>
    <button class="iconbtn" title="Alerts">${icon('bell', 18)}</button>
    <button class="iconbtn" title="Guide">${icon('help', 18)}</button>
    <button class="iconbtn" title="Settings">${icon('settings', 18)}</button>
    <button class="iconbtn" data-act="flip:side" title="Show or hide the side panel">${icon('panel-right', 18)}</button>
  </header>
  ${sidebar()}
  <main class="main-b"><div class="wash"></div>
    <div class="head">
      <div class="cover cover--now" style="width:56px;height:56px;border-radius:12px"></div>
      <div class="head__txt"><div class="head__title ell" data-b="title"></div>
        <div class="head__meta"><span class="ell" data-b="artist"></span><span class="tag" data-b="keyname"></span><span class="tag" data-b="bpm"></span><span class="tag" data-b="dur"></span></div></div>
      <button class="iconbtn" title="Favorite">${icon('heart', 18)}</button>
      <button class="iconbtn" title="Add to Up Next">${icon('list-plus', 18)}</button>
      <button class="iconbtn" title="More">${icon('ellipsis', 18)}</button>
      <a class="btn" href="stage.html">${icon('maximize-2')} Stage mode</a>
    </div>
    <div class="top">
      <div class="gut">
        <div class="anchor"><button class="pill" data-act="pop:mine">${icon('user', 14)} My part: <b data-b="minename"></b> ${icon('chevron-down', 13)}</button>${minePop()}</div>
        <div class="seg"><button data-preset="full" data-act="preset:full">Full band</button><button data-preset="minus" data-act="preset:minus">Without me</button><button data-preset="only" data-act="preset:only">Only me</button></div>
      </div>
      <div class="tl">${sectionsBar()}<div class="ticker"><b data-b="ly-cur"></b><span data-b="ly-next"></span></div></div>
    </div>
    <div class="lanebox">
      <div class="cols">${S.sections.map((sec, i) => `<div class="col" data-sec="${i}" style="--w:${sec.share * 100}"></div>`).join('')}</div>
      ${STEMS.map(lane).join('')}
      <div class="lanes__ph"></div>
    </div>
  </main>
  <aside class="side">
    <div class="tabs">${tab('lyrics', 'Lyrics', 'text')}${tab('queue', 'Up Next', 'list-music')}${tab('tools', 'Tools', 'sliders-horizontal')}</div>
    <div class="panel" data-tabpanel="panel:lyrics" data-default="lyrics">${lyricsList()}</div>
    <div class="panel" data-tabpanel="panel:queue" data-default="lyrics" hidden>${queueList()}</div>
    <div class="panel" data-tabpanel="panel:tools" data-default="lyrics" hidden>${tools()}</div>
  </aside>
  ${footerB()}
  ${browse()}
</div>`);

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'k') { e.preventDefault(); document.querySelector('[data-act="pop:library"]').click(); }
});
