// PROTOTYPE - throwaway layout mockup.
import { boot, mockbar, overview, minePop, lyricsList, footerB, icon, S, STEMS } from './mock.js';
document.getElementById('bar').outerHTML = mockbar('stage');

const mrow = s => `<div class="mrow" data-stem="${s.id}" style="--c:var(--${s.id})">
  <button class="mrow__name" data-act="mute:${s.id}" title="Mute or unmute ${s.name}">${s.name}</button>
  <button class="ms ms--m" data-act="mute:${s.id}" title="Mute">M</button><button class="ms ms--s" data-act="solo:${s.id}" title="Solo">S</button>
  <input class="vol" type="range" min="0" max="1" step="0.01" data-vol="${s.id}"><div class="meter"><i></i></div></div>`;
const modeBtn = (id, label, ic) => `<button data-act="tab:mode:${id}" data-tabbtn="mode:${id}" data-default="play">${icon(ic, 14)} ${label}</button>`;
const nextSong = () => S.songs[(S.songs.indexOf(S.song) + 1) % S.songs.length];

boot(() => `<div class="stg"><div class="wash"></div>
  <div class="stg__top">
    <div class="cover cover--now" style="width:40px;height:40px"></div>
    <div class="row__txt" style="flex:0 1 auto"><div class="row__t ell" style="font-size:16px;font-weight:800" data-b="title"></div><div class="row__s ell"><span data-b="artist"></span> · <span data-b="keyname"></span> · <span data-b="bpm"></span></div></div>
    <div class="seg">${modeBtn('play', 'Play along', 'music')}${modeBtn('sing', 'Sing along', 'mic')}</div>
    <div class="sp"></div>
    <button class="btn btn--quiet upnext" data-act="next" title="Up Next">${icon('list-music')} <span class="dim">Next</span> <span class="ell">${nextSong().title}</span></button>
    <button class="btn" data-act="flip:mix" title="Show or hide the mix panel">${icon('sliders-horizontal')} Mix</button>
    <a class="btn" href="b.html">${icon('minimize-2')} Exit stage</a>
  </div>
  <div class="center play" data-tabpanel="mode:play" data-default="play">
    <div class="cue"><span class="lbl">Now</span><div class="now" data-b="secname"></div>
      <div class="then">then <b data-b="nextsec"></b> in <b data-b="bars"></b> bars</div>
      <div class="beats">${[0, 1, 2, 3].map(n => `<i data-beat="${n}"></i>`).join('')}<span class="mono" data-b="bpm"></span></div></div>
    <div class="lines"><span data-b="ly-prev"></span><b data-b="ly-cur"></b><span data-b="ly-next"></span></div>
  </div>
  <div class="center sing" data-tabpanel="mode:sing" data-default="play" hidden><div class="panel">${lyricsList()}</div></div>
  <div class="nav">${overview()}</div>
  <aside class="mix">
    <div class="anchor"><button class="pill" data-act="pop:mine">${icon('user', 14)} My part: <b data-b="minename"></b> ${icon('chevron-down', 13)}</button>${minePop()}</div>
    <div class="seg"><button data-preset="full" data-act="preset:full">Full band</button><button data-preset="minus" data-act="preset:minus">Without me</button><button data-preset="only" data-act="preset:only">Only me</button></div>
    ${STEMS.map(mrow).join('')}
  </aside>
  ${footerB()}
</div>`);
