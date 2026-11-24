// Popovers that open above a footer control: one at a time, fixed in place so the
// footer's own clipping cannot cut them, and kept inside the window.

import { HIDDEN_CLASS } from "./footerClasses.js";

const EDGE_PX = 8;
const GAP_PX = 8;
// GTK's default double-click time, so a desktop double-click lands before the panel opens.
const DOUBLE_CLICK_WAIT_MS = 400;
const POINTER_CLICK = 1;

let closeShown = null;

/** Put `panel` directly above `trigger`, measured while shown: a hidden panel has no height. */
export function placeAbove(trigger, panel) {
  const r = trigger.getBoundingClientRect();
  const maxLeft = window.innerWidth - panel.offsetWidth - EDGE_PX;
  panel.style.left = `${Math.max(EDGE_PX, Math.min(Math.round(r.left), maxLeft))}px`;
  panel.style.top = `${Math.max(EDGE_PX, Math.round(r.top - panel.offsetHeight - GAP_PX))}px`;
}

function popoverState(trigger, panel, { shownClass, onOpen }) {
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

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  return { open, close, toggle, isOpen, place };
}

// Keyboard presses (detail 0) open at once; a pointer press waits to see whether it starts a double-click.
function triggerClickHandler(toggle, waitForDoubleClick) {
  let pending = 0;
  return function onPopoverTriggerClick(e) {
    clearTimeout(pending);
    if (!waitForDoubleClick || e.detail < POINTER_CLICK) toggle();
    else if (e.detail === POINTER_CLICK) pending = setTimeout(toggle, DOUBLE_CLICK_WAIT_MS);
  };
}

function wireDismissal(trigger, panel, { close, isOpen }) {
  // A press that starts inside, such as a fader drag released outside, is not a click away.
  let pressedInside = false;
  panel.addEventListener("pointerdown", function onPanelPress() {
    pressedInside = true;
  });
  // Capture phase, so menus that stop their own clicks still close this one.
  document.addEventListener("click", function onClickAway(e) {
    const inside = pressedInside || panel.contains(e.target) || trigger.contains(e.target);
    pressedInside = false;
    if (!inside) close();
  }, true);
  document.addEventListener("keydown", function onPopoverEscape(e) {
    if (e.key !== "Escape" || !isOpen()) return;
    close();
    trigger.focus();
  });
  window.addEventListener("resize", close);
}

/**
 * Wire one trigger and its panel. `shownClass` is the class the panel's CSS keys off:
 * "hidden" for a panel that ships hidden, "open" for one that opts in to showing.
 * `waitForDoubleClick` is for a trigger whose double-click does something else.
 */
export function wirePopover(trigger, panel, { shownClass = HIDDEN_CLASS, onOpen, waitForDoubleClick = false } = {}) {
  const popover = popoverState(trigger, panel, { shownClass, onOpen });
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", triggerClickHandler(popover.toggle, waitForDoubleClick));
  wireDismissal(trigger, panel, popover);
  return popover;
}
