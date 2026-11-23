// PROTOTYPE - throwaway. Footer: what is playing, the transport over a seek bar, and the practice group.
import { S, playSong, viewingOther, dataOf, canGoBack, canGoForward } from './store.js';
import { icon, esc, fmt, coverStyle } from './ui.js';

const seg = (on, act, ic, label, pop, title) => `<div class="pseg ${on ? 'is-on' : ''}"><button class="pseg__main" aria-pressed="${!!on}" data-act="${act}" title="${title}">${icon(ic, 18)}<span>${label}</span></button>
  ${pop ? `<button class="pseg__more" data-act="pop:${pop}" title="${title}: options">${icon('chevron-up', 12)}</button>` : ''}</div>`;
const stepper = (label, key, value, extra = '') => `<div class="pstep"><button data-act="${key}:-1" title="${label} down">${icon('minus', 14)}</button>
  <button class="pstep__v" ${extra}><span>${label}</span><b class="mono">${value}</b></button><button data-act="${key}:1" title="${label} up">${icon('plus', 14)}</button></div>`;

export function footer() {
  const s = playSong();
  const other = viewingOther();
  const loopName = S.loopOn && S.loop ? (S.loop.i === undefined ? 'Region' : dataOf(S.playId).sections[S.loop.i].name) : 'Loop';
  const now = s ? `<div class="cover" style="width:52px;height:52px;${coverStyle(s, 'md')}"></div>
    <div class="row__txt"><div class="row__t ell">${other ? '<span class="lbl">Playing</span> ' : ''}${esc(s.title)}</div><div class="row__s ell"><span data-b="secname"></span> · next <span data-b="nextsec"></span></div></div>`
    : '<div class="row__txt"><div class="row__t dim">Nothing is open</div></div>';
  return `${other ? `<button class="tp-now tp-now--btn" data-act="showPlaying" title="Show the playing song">${now}</button>` : `<div class="tp-now">${now}</div>`}
  <div class="tpc">
    <div class="tpc__btns">
      <button class="iconbtn" ${s ? '' : 'disabled'} data-act="stop" title="Stop and go back to the start">${icon('square', 16, 'ic--fill')}</button>
      <button class="iconbtn" ${s ? '' : 'disabled'} data-act="prev" title="${canGoBack() ? 'Previous song. Restarts this one when it has played for a few seconds (Alt ←)' : 'Back to the start'}">${icon('skip-back', 18, 'ic--fill')}</button>
      <button class="playbtn" ${s ? '' : 'disabled'} data-act="play" title="${S.playing ? 'Pause' : other ? 'Play the song you are looking at' : 'Play'} (Space)">${icon(S.playing ? 'pause' : 'play', 20, 'ic--fill')}</button>
      <button class="iconbtn" ${canGoForward() ? '' : 'disabled'} data-act="next" title="Next song: forward again after going back, otherwise the next in Up Next (Alt →)">${icon('skip-forward', 18, 'ic--fill')}</button>
      <button class="iconbtn ${S.ui.panel && S.ui.tab === 'upnext' ? 'is-on' : ''}" data-act="tab:upnext" title="Show Up Next">${icon('list-music', 16)}</button>
    </div>
    <div class="tpc__seek mono"><span data-b="time">0:00</span><div class="seekbar" data-act="seek" role="slider" aria-label="Seek"><i></i></div><span>${s ? fmt(s.dur) : '0:00'}</span></div>
  </div>
  <div class="tpr"><button class="recbtn" data-act="pop:record" title="Add a recording track"><i></i> Record</button>
    <div class="prac">
      ${seg(S.loopOn, 'loop', 'repeat', esc(loopName), 'loop', 'Loop the selected position (L)')}
      ${stepper('Speed', 'speed', S.speed.toFixed(2) + '×', 'data-act="pop:speed" data-dbl="speedToggle" title="Click to type an exact speed. Double-click to switch between 1x and your slow speed"')}
      ${stepper('Key', 'key', (S.key > 0 ? '+' : '') + S.key, 'data-act="pop:key" data-dbl="keyReset" title="Click for key options. Double-click to put every lane back in the original key"')}
      ${seg(S.click, 'toggle:click', 'metronome', 'Click', 'click', 'Click track (K)')}
      ${seg(S.countIn > 0, 'pop:countin', 'timer', S.countIn ? S.countIn + ' bar' + (S.countIn > 1 ? 's' : '') : 'Count-in', '', 'Bars of click before the song starts')}
    </div></div>`;
}
