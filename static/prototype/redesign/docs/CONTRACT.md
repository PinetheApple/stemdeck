# Full-UI prototype: how to add a view

Throwaway prototype of the StemDeck desktop redesign (direction "B · Lanes"). It lives in
`static/prototype/redesign/app/`, is served at `http://localhost:8000/prototype/redesign/app/index.html`
(dev server already running; do not restart it) and fakes playback. Nothing here ships: no tests, no i18n,
no backend calls beyond what `store.js` already does. Plain ES modules, no build step, no dependencies.

The page CSP forbids inline `<script>` and inline event handlers. Inline `style=""` is fine.

## Files

- `js/store.js`: state `S`, demo data, fake playback, the action registry, selectors. Read it first.
- `js/ui.js`: `icon(name, size, cls)`, `esc`, `fmt`, `clamp`, `cover`, `coverStyle`, `toggle`, `check`,
  `emptyState`, `kbd`, `field`, `select`, `menuHtml`, `registerIcons`.
- `js/slots.js`: `registerTab`, `registerDialog`, `registerPop`, `registerMenu`, `registerRegion`,
  `registerBrowseView`, `registerHook`. Registering under an id that exists replaces it.
- `js/main.js`: boot, region rendering, event delegation, keyboard. Do not edit.
- `js/songs.js` (song rows, cards, the song menu), `shell.js`, `browse.js`, `studio.js`, `footer.js`,
  `panel.js`, `basics.js` (first-pass tabs and dialogs you replace by registering the same id).
- `css/app.css` on top of `../mock.css` (tokens come from `/css/variables.css`).

## Rendering

Views are functions returning HTML strings. After every action `main.js` re-renders regions
(`mockbar topbar sidebar main panel footer stage browse overlays`, plus any you add with `registerRegion`).
Scroll positions of elements carrying `data-scroll="unique-key"` survive a re-render; so does focus in an
`<input data-input>`. Per-frame values are written by `main.js` into elements you mark:
`data-b="time|secname|nextsec|bars|ly-prev|ly-cur|ly-next"`, `data-stem="<stemId>"` (gets `--lvl` 0..1),
`data-beat="0..3"`, `data-sec="<index>"` (gets `.is-current`), `data-li="<lyric index>"`
(gets `.is-current` / `.is-past`), and the root CSS variables `--p` (percent) and `--pn` (0..1).

## Actions

```js
import { S, act } from './store.js';
act('name', (ctx, arg1, arg2) => { /* mutate S */ return ['panel']; });
```

- Trigger from HTML: `data-act="name:arg1:arg2"` (click), `data-dbl="..."` (double click),
  `data-ctx="..."` (right click), `<input data-input="name:arg">` (called with the value appended on input).
  Arguments are split on `:`, so ids and values must not contain a colon.
- `ctx` is `{el, event}`. Return an array of region names to re-render, nothing to re-render everything,
  `false` to re-render nothing.
- Built in: `pop:<id>` toggles a popover anchored to the clicked button, `menu:<id>:<args>` opens a menu,
  `dialog:<id>:<arg>` opens a modal (`S.ui.dialog = {id, arg}`), `closeDialog`, `closePop`,
  `flip:<key>` toggles `S.ui[key]`, `set:<key>:<value>`, `toggle:<key>` toggles `S[key]`,
  `tab:<id>:<arg>` (arg lands in `S.ui.tabArg`), `pref:<palette|font|wash>:<value>`, `noop`.
  The rest are in `store.js` and `browse.js`.
- Two-click confirms: `arm(key, run)` from `store.js`; render the armed label with `armed(key)`.
- Esc closes the topmost thing in this order: error box, menu or popover, dialog, Browse library, Guide, Stage.
  Dialogs get a scrim; clicking it closes them.

## Look and behaviour rules (the owner's decisions; do not re-litigate)

- Reuse the existing classes before writing new CSS: `btn` (`btn--accent`, `btn--quiet`, `is-on`,
  `is-danger`), `iconbtn` (`iconbtn--sm`), `seg`, `pill`, `tag`, `chip`, `lbl`, `hint`, `dim`, `mono`,
  `ell`, `sp`, `group`, `srow`, `cover`, `menu`, `pop`, `dlg` / `dlg__head` / `dlg__body` /
  `dlg__foot`, `input`, `select`, `switch`, `checkrow`, `frow`, `emptystate`, `ms`, `vol`, `meter`,
  `kbd`, `count`, `badge`, `linkbtn`, `bar`. Look at `../b.html` and the running prototype for the feel.
- Coral (`--accent`) is for Play and for what is active now. Not for decoration, and no second primary
  button in a view.
- Every toggle shows its state (`is-on` plus `aria-pressed`). Every icon-only button has a `title`
  (Guide mode shows it as the explanation).
- No level-driven glow or flicker; meters are thin bars only. No bulky pads. No emoji. No gradients for
  decoration. Calm, compact, readable: body text 13 to 14px, controls 28 to 36px tall, radii from tokens.
- Dialogs dim the page and close on Esc. Menus and popovers close on Esc or an outside click.
- Words: "Favorites" (not Pinned), "Up Next", "Setlist", "Stage mode". Copy the English strings from the
  inventories word for word wherever a string exists.
- Comments: rare, at most two lines, only for a non-obvious why. Functions short, no magic numbers
  (name them), files under 500 lines: split a file rather than exceed that.
- Every existing function of the current app must be reachable. Where the redesign moves something, keep the
  function and say where it went in your report.

## The inventories

`docs/inventory-library.md`, `docs/inventory-studio.md`, `docs/inventory-chrome.md`: every control, label,
state and rule of the current app. Your brief names the sections you own.

## Checking your work

Syntax: `node --check <file>`. Render: drive headless Chromium with a small playwright script, open your
views at 1920x1080 and 1366x768, screenshot them and look at the PNGs. Check for page errors, overflow,
clipped text and unstyled elements.
