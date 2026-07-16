import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatCaptureKeyDecision } from "../src/lib/chatCaptureKeys";

// Bug t-1783145481696: Esc in the open chat-capture panel ALSO popped App's
// topmost overlay (minimized a live run panel / dropped the undo toast /
// closed the job drawer), because ChatCapture's Esc handler and App's global
// Esc handler are sibling window keydown listeners and preventDefault does not
// stop siblings. The fix: ChatCapture listens in the CAPTURE phase and calls
// stopImmediatePropagation whenever it consumes a key, so one Esc closes ONLY
// the chat panel and the NEXT Esc reaches App (which then minimizes the newest
// run panel, as v0.22 intends).
//
// The priority decision is pure (lib/chatCaptureKeys) and unit-tested here;
// the listener phase + exclusive consumption are pinned as source contracts
// (no React render layer in this project - related-chips-ui.test.ts idiom).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("chatCaptureKeyDecision (the pure priority decision)", () => {
  const closed = { panelOpen: false, lightboxOpen: false, blocked: false };
  const open = { panelOpen: true, lightboxOpen: false, blocked: false };
  const withLightbox = { panelOpen: true, lightboxOpen: true, blocked: false };

  it("Esc with the panel open closes ONLY the panel, exclusively (the acceptance case)", () => {
    expect(chatCaptureKeyDecision({ key: "Escape", ...open })).toEqual({
      action: "close-panel",
      exclusive: true,
    });
  });

  it("Esc with the nested lightbox open closes the viewer, not the panel", () => {
    expect(chatCaptureKeyDecision({ key: "Escape", ...withLightbox })).toEqual({
      action: "close-lightbox",
      exclusive: true,
    });
  });

  it("Esc with the panel closed is left for App's global handler (second-press path)", () => {
    expect(chatCaptureKeyDecision({ key: "Escape", ...closed })).toEqual({
      action: "none",
      exclusive: false,
    });
  });

  it("'c' opens the panel only when the shared shortcut guard allows it", () => {
    expect(chatCaptureKeyDecision({ key: "c", ...closed })).toEqual({
      action: "open-panel",
      exclusive: true,
    });
    // Typing / Ctrl+C chord / another modal open: never consume, never open.
    expect(chatCaptureKeyDecision({ key: "c", ...closed, blocked: true })).toEqual({
      action: "none",
      exclusive: false,
    });
    // 'c' typed INTO the open panel's textarea is just text.
    expect(chatCaptureKeyDecision({ key: "c", ...open })).toEqual({
      action: "none",
      exclusive: false,
    });
  });

  it("Tab traps inside the topmost dialog (lightbox over panel), non-exclusively", () => {
    expect(chatCaptureKeyDecision({ key: "Tab", ...open })).toEqual({
      action: "trap-tab",
      exclusive: false,
    });
    expect(chatCaptureKeyDecision({ key: "Tab", ...withLightbox })).toEqual({
      action: "trap-tab",
      exclusive: false,
    });
    expect(chatCaptureKeyDecision({ key: "Tab", ...closed })).toEqual({
      action: "none",
      exclusive: false,
    });
  });

  it("other keys pass through untouched while the lightbox or panel is open", () => {
    expect(chatCaptureKeyDecision({ key: "a", ...withLightbox }).action).toBe("none");
    expect(chatCaptureKeyDecision({ key: "Enter", ...open }).action).toBe("none");
  });
});

// --- Source contracts: listener phase + exclusive consumption ---------------

describe("ChatCapture owns its keys exclusively (source contract)", () => {
  const src = read("../src/components/ChatCapture.tsx");

  it("registers (and removes) its keydown listener in the CAPTURE phase", () => {
    // Capture phase guarantees it runs before App's bubble-phase window
    // listener, whatever the mount/registration order.
    expect(src).toMatch(/addEventListener\("keydown", onKeyDown, true\)/);
    expect(src).toMatch(/removeEventListener\("keydown", onKeyDown, true\)/);
  });

  it("stops sibling listeners when it consumes a key (preventDefault alone does not)", () => {
    expect(src).toContain("stopImmediatePropagation()");
  });

  it("routes every key through the one pure decision", () => {
    expect(src).toContain("chatCaptureKeyDecision(");
  });
});

describe("App's global Esc handler stays the bubble-phase fallback (source contract)", () => {
  const src = read("../src/App.tsx");

  it("registers WITHOUT the capture flag, so an open chat panel wins the race", () => {
    expect(src).toMatch(/window\.addEventListener\("keydown", handler\);/);
  });

  it("keeps the v0.22 Esc ladder: run panels MINIMIZE after the app overlays", () => {
    // The second Esc of the acceptance flow lands here and minimizes the
    // newest expanded run, one per press.
    expect(src).toContain("minimizeNewestExpanded(prev)");
  });
});
