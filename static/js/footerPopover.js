// Popovers that open above a footer control: one at a time, fixed in place so the
// footer's own clipping cannot cut them, and kept inside the window.

const EDGE_PX = 8;
const GAP_PX = 8;
const HIDDEN_CLASS = "hidden";

let closeShown = null;

/** Put `panel` directly above `trigger`, measured while shown: a hidden panel has no height. */
export function placeAbove(trigger, panel) {
  const r = trigger.getBoundingClientRect();
  const maxLeft = window.innerWidth - panel.offsetWidth - EDGE_PX;
  panel.style.left = `${Math.max(EDGE_PX, Math.min(Math.round(r.left), maxLeft))}px`;
  panel.style.top = `${Math.max(EDGE_PX, Math.round(r.top - panel.offsetHeight - GAP_PX))}px`;
}

/**
 * Wire one trigger and its panel. `shownClass` is the class the panel's CSS keys off:
 * "hidden" for a panel that ships hidden, "open" for one that opts in to showing.
 */
export function wirePopover(trigger, panel, { shownClass = HIDDEN_CLASS, onOpen } = {}) {
  const isOpen = () => trigger.getAttribute("aria-expanded") === "true";
  const place = () => placeAbove(trigger, panel);
  const show = (on) => panel.classList.toggle(shownClass, shownClass === HIDDEN_CLASS ? !on : on);

  function close() {
    if (!isOpen()) return;
    show(false);
    trigger.setAttribute("aria-expanded", "false");
    if (closeShown === close) closeShown = null;
  }

  function open() {
    if (closeShown !== close) closeShown?.();
    onOpen?.();
    show(true);
    trigger.setAttribute("aria-expanded", "true");
    closeShown = close;
    place();
  }

  function onTriggerClick() {
    if (isOpen()) close();
    else open();
  }

  // A press that starts inside, such as a fader drag released outside, is not a click away.
  let pressedInside = false;
  function onPanelPress() {
    pressedInside = true;
  }

  // Capture phase, so menus that stop their own clicks still close this one.
  function onClickAway(e) {
    const inside = pressedInside || panel.contains(e.target) || trigger.contains(e.target);
    pressedInside = false;
    if (!inside) close();
  }

  function onEscape(e) {
    if (e.key !== "Escape" || !isOpen()) return;
    close();
    trigger.focus();
  }

  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", onTriggerClick);
  panel.addEventListener("pointerdown", onPanelPress);
  document.addEventListener("click", onClickAway, true);
  document.addEventListener("keydown", onEscape);
  window.addEventListener("resize", close);
  return { open, close, isOpen, place };
}
