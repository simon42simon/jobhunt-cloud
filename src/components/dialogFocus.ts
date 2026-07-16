// Focus helpers for ALL of the app's dialogs and drawers (the D3 dialog
// contract: role=dialog + aria-modal + a Tab focus trap + focus restore).
// Extracted for AddJobModal/StatusChangeModal first, then adopted app-wide by
// the UI consistency pack (t-1783183576693): JobDetail, ChatCapture (panel +
// lightbox), NotificationPanel, and the TeamView / HubSidebar drawers all
// dropped their local getFocusableElements copies for this one, so the trap
// selector can never drift per-dialog again. The Tab-wrap DECISION
// (nextTrapTarget) stays pure so it is unit-testable in the node env without
// a DOM.

// Visible, enabled, focusable descendants in DOM order. `summary` is included
// because a <details>/<summary> disclosure is keyboard-focusable (JobDetail's
// "Full job note" - its local selector had already drifted to add this). Only
// ever called at runtime in the browser (never in tests), so its DOM
// references are safe: importing this module does not touch the DOM.
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null,
  );
}

// Pure Tab-trap boundary decision: given a dialog's focusable elements, the element
// that currently has focus, and whether Shift is held, return the element that should
// receive focus to KEEP focus inside the dialog - or null to let the browser move
// focus natively. Focus only wraps at the edges (Tab past the last -> first;
// Shift+Tab before the first -> last), and focus that has somehow escaped the dialog
// is pulled back to an edge.
export function nextTrapTarget<T>(
  focusables: readonly T[],
  active: unknown,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const within = focusables.some((el) => el === active);
  if (shiftKey) {
    return !within || active === first ? last : null;
  }
  return !within || active === last ? first : null;
}
