// The chat-capture panel's keyboard priority decision (bug t-1783145481696).
//
// ChatCapture's Esc handler and App's global Esc handler are BOTH window
// keydown listeners, and preventDefault does NOT stop sibling listeners - so
// one Esc used to close the chat panel AND pop App's topmost overlay (minimize
// a live run panel, drop the undo toast, close the job drawer). The fix has
// two halves:
//
//   1. ChatCapture registers its listener in the CAPTURE phase (real keydown
//      targets are focused elements/body, never window itself, so a capture
//      listener on window always runs before App's bubble listener).
//   2. When the panel CONSUMES a key (`exclusive` below), it calls
//      preventDefault AND stopImmediatePropagation, so no sibling window
//      listener acts on the same press. A second Esc then reaches App
//      normally and minimizes the newest run panel, as v0.22 intends.
//
// The decision is pure and unit-tested here (tests/chatcapture-esc.test.ts);
// the DOM wiring (focus trap targets, listener registration) stays in
// ChatCapture - same split as lib/shortcuts.shortcutBlockReasonFor.

export type ChatCaptureKeyAction =
  | "open-panel" // "c" from anywhere (behind the shared shortcut guard)
  | "close-lightbox" // Esc while the nested image viewer is stacked on top
  | "close-panel" // Esc while the panel itself is the top overlay
  | "trap-tab" // Tab/Shift+Tab cycles inside the open dialog (lightbox first)
  | "none";

export interface ChatCaptureKeyDecision {
  action: ChatCaptureKeyAction;
  // true => the panel consumes the key EXCLUSIVELY: preventDefault +
  // stopImmediatePropagation, so App's global Esc handler never sees it.
  // trap-tab stays non-exclusive: the handler preventDefaults only when a
  // trap target actually exists (a DOM question, decided at the call site).
  exclusive: boolean;
}

export function chatCaptureKeyDecision(input: {
  key: string;
  panelOpen: boolean;
  lightboxOpen: boolean;
  // shortcutBlockReason(e) != null - typing in a field, a Ctrl/Cmd/Alt chord
  // (Ctrl+C must copy, never open this), or another modal dialog open.
  blocked: boolean;
}): ChatCaptureKeyDecision {
  const { key, panelOpen, lightboxOpen, blocked } = input;
  if (!panelOpen) {
    if (key === "c" && !blocked) return { action: "open-panel", exclusive: true };
    return { action: "none", exclusive: false };
  }
  // The lightbox is a nested dialog stacked over the panel: while it is open
  // it owns Esc (close the viewer, NOT the whole panel) and traps Tab within
  // itself; every other key is left alone.
  if (lightboxOpen) {
    if (key === "Escape") return { action: "close-lightbox", exclusive: true };
    if (key === "Tab") return { action: "trap-tab", exclusive: false };
    return { action: "none", exclusive: false };
  }
  if (key === "Escape") return { action: "close-panel", exclusive: true };
  if (key === "Tab") return { action: "trap-tab", exclusive: false };
  return { action: "none", exclusive: false };
}
