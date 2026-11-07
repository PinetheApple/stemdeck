// Click again to confirm: the first click says what the next one destroys.

export const ARM_MS = 4000;
/** The span inside a control that shows its armed text. */
export const ARM_TEXT_CLASS = "arm-text";
const ARMED = "1";
const armedControls = new WeakMap();

export function isArmed(control) {
  return control.dataset.armed === ARMED;
}

/** Put the control back as it was, if it is armed. */
export function disarm(control) {
  const state = armedControls.get(control);
  if (!state) return;
  armedControls.delete(control);
  clearTimeout(state.timer);
  delete control.dataset.armed;
  state.label.textContent = state.idleText;
  if (state.idleAria !== null) control.setAttribute("aria-label", state.idleAria);
}

/** `label` is the element whose text says what the next click does. */
export function arm(control, { label, armedText, armMs = ARM_MS }) {
  disarm(control);
  const state = {
    label,
    idleText: label.textContent,
    idleAria: control.getAttribute("aria-label"),
    timer: setTimeout(function onArmExpired() {
      disarm(control);
    }, armMs),
  };
  armedControls.set(control, state);
  control.dataset.armed = ARMED;
  label.textContent = armedText;
  if (state.idleAria !== null) control.setAttribute("aria-label", armedText);
}

/** Arm on the first call; run `onConfirm` on a second while armed. */
export function confirmOnSecondClick(control, { onConfirm, ...armOptions }) {
  if (!isArmed(control)) {
    arm(control, armOptions);
    return;
  }
  disarm(control);
  onConfirm();
}
