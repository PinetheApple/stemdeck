// PROTOTYPE - throwaway layout mockup.
import { boot, mockbar } from './mock.js';
document.getElementById('bar').outerHTML = mockbar('index');

boot(() => `<div class="wrap">
  <h1>StemDeck layout mockups</h1>
  <p>Three layouts for the desktop studio and one Stage mode, all built around practising one song. Playback is faked: press Space or Play, tap stems, tap a section, try the loop icon, speed and key. The top strip switches mockup, palette and the cover-colour wash.</p>
  <h2>Changed in every mockup</h2>
  <ul>
    <li>Import is one "Add song" button with a popover. The permanent import bar and its coral button are gone.</li>
    <li>The icon rail is gone. Favourites, setlists and Trash are library filters; Alerts, Guide and Settings sit top right.</li>
    <li>Sections are tappable blocks over one song waveform: tap to jump, loop icon to loop. No loop start and end number fields.</li>
    <li>Practice controls live beside the transport as large labelled buttons: Loop, Speed, Key, Click, Count-in.</li>
    <li>"My part" is picked once; "Without my part" and "Only my part" are one tap.</li>
    <li>Lyrics are in the main view. Tempo tools, EQ, Details, Extract more stems and Export move under "Song tools".</li>
    <li>Coral is kept for Play and for what is active now.</li>
  </ul>
  <h2>Mockups</h2>
  <div class="cards">
    <a class="c" href="a.html"><h3>A · Pads</h3><p>Six large stem pads with live level glow. Tap a pad to mute. Library left, lyrics or Up Next right.</p><ul><li>Most playful and most touch friendly</li><li>No per-stem full-song waveform</li></ul></a>
    <a class="c" href="b.html"><h3>B · Lanes</h3><p>Keeps the waveform lanes, with larger mute, solo and fader controls, lanes that fill the height, and a lyric line above them.</p><ul><li>Closest to today, least to relearn</li><li>Tools get a tab on the right</li></ul></a>
    <a class="c" href="c.html"><h3>C · Focus</h3><p>No permanent library. The setlist is a strip of tiles on top, lyrics are large, and the mixer is a console of tall faders. The library opens over the player.</p><ul><li>Most room for the song itself</li><li>Browsing takes one extra click</li></ul></a>
    <a class="c" href="stage.html"><h3>Stage mode</h3><p>Play along shows the current section, bars to the next one and the beat. Sing along shows three lyric lines. Stems stay one tap away.</p><ul><li>Works with any of the three layouts</li></ul></a>
  </div>
</div>`);
