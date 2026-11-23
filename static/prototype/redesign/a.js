// PROTOTYPE - throwaway layout mockup.
import { boot, mockbar, topbar, library, songHead, overview, presets, sidePanel, transport, wave, icon, STEMS } from './mock.js';
document.getElementById('bar').outerHTML = mockbar('a');

const pad = s => `<div class="pad" role="button" data-stem="${s.id}" data-act="mute:${s.id}" style="--c:var(--${s.id})" title="Tap to mute or unmute ${s.name}">
  <div class="pad__lvl"></div>
  <div class="pad__top"><span class="pad__name">${s.name}</span>
    <span class="pad__badge pad__badge--mine">${icon('user', 11)} My part</span>
    <span class="pad__badge pad__badge--off">${icon('volume-x', 11)} Muted</span>
    <button class="pad__solo" data-act="solo:${s.id}">Solo</button></div>
  <div class="pad__wave">${wave(s.id, { bars: 90, playhead: false })}</div>
  <div class="pad__bottom" data-act="noop">${icon('volume-2')}<input class="vol" type="range" min="0" max="1" step="0.01" data-vol="${s.id}"></div>
</div>`;
boot(() => `<div class="app app--a">
  ${topbar()}
  ${library()}
  <main class="main-a"><div class="wash"></div>
    ${songHead()}
    ${overview()}
    <div class="mixrow">${presets()}<div class="sp"></div><span class="hint">Tap a pad to mute · Solo to hear it alone</span></div>
    <div class="pads">${STEMS.map(pad).join('')}</div>
  </main>
  ${sidePanel()}
  ${transport()}
</div>`);
