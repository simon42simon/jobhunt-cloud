// Global single-letter shortcut policy (UI consistency pack t-1783183576693 +
// bug t-1783163892019). Every global single-key handler (App's b/t/d/i/p/n/?,
// TopBar's "/", ChatCapture's "c", TriageInbox's j/k/s/m/p) consults the SAME
// three-part guard before acting, so the rules can never drift per-surface
// again:
//
//   typing   - the key is going into an INPUT / TEXTAREA / SELECT
//   modifier - a Ctrl/Cmd/Alt chord (Ctrl+P must print, not navigate;
//              Ctrl+C must copy, not open the capture panel)
//   modal    - a [role="dialog"][aria-modal="true"] overlay is open, so the
//              page behind it must be keyboard-inert (previously d/i/p
//              switched the view BEHIND an open StatusChangeModal)
//
// Shift is deliberately NOT a blocking modifier: "?" is Shift+/ on most
// layouts.

export type ShortcutBlockReason = "typing" | "modifier" | "modal";

// The pure decision, unit-testable without a DOM (same posture as
// dialogFocus.nextTrapTarget).
export function shortcutBlockReasonFor(input: {
  targetTag: string | undefined;
  hasModifier: boolean;
  modalOpen: boolean;
}): ShortcutBlockReason | null {
  const tag = (input.targetTag || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "typing";
  if (input.hasModifier) return "modifier";
  if (input.modalOpen) return "modal";
  return null;
}

// The one definition of "a modal overlay is open". Matches every dialog in the
// app (all aria-modal elements also carry role="dialog"); the docked, non-modal
// Run/Batch panels deliberately do NOT match, so shortcuts keep working while a
// run streams in the corner.
export const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

// Browser-side wrapper: derive the guard's inputs from a real KeyboardEvent.
// Only ever called at runtime in the browser (never at import time), so its
// DOM references are safe in the node test env - same rule as dialogFocus.
export function shortcutBlockReason(e: KeyboardEvent): ShortcutBlockReason | null {
  const target = e.target as HTMLElement | null;
  return shortcutBlockReasonFor({
    targetTag: target?.tagName,
    hasModifier: e.metaKey || e.ctrlKey || e.altKey,
    modalOpen: !!document.querySelector(MODAL_DIALOG_SELECTOR),
  });
}

// --- '?' cheat-sheet data ----------------------------------------------------
// Data-driven so the overlay can never disagree with itself and the list is
// assertable in tests. Keep this in sync when a handler gains or loses a key.

export type ShortcutItem = { keys: string[]; label: string };
export type ShortcutSection = { title: string; items: ShortcutItem[] };

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Navigate",
    items: [
      { keys: ["b"], label: "Jobs - board view" },
      { keys: ["t"], label: "Jobs - table view" },
      { keys: ["d"], label: "Discovery" },
      { keys: ["i"], label: "Insights" },
      { keys: ["p"], label: "Product hub" },
    ],
  },
  {
    title: "Act",
    items: [
      { keys: ["n"], label: "Add a lead" },
      { keys: ["c"], label: "Report a bug or request" },
      { keys: ["/"], label: "Focus search (Jobs page)" },
      { keys: ["?"], label: "Show this cheat sheet" },
      { keys: ["Esc"], label: "Close dialogs, drawers, and toasts; minimize an open run panel" },
    ],
  },
  {
    title: "Discovery - triage finds",
    items: [
      { keys: ["j", "k"], label: "Next / previous find" },
      { keys: ["s"], label: "Skip the selected find" },
      { keys: ["m"], label: "Maybe the selected find" },
      { keys: ["p"], label: "Pursue the selected find (wins over Product hub here)" },
    ],
  },
];
