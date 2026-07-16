import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MODAL_DIALOG_SELECTOR,
  SHORTCUT_SECTIONS,
  shortcutBlockReasonFor,
} from "../src/lib/shortcuts";

// UI consistency pack t-1783183576693 (d) + bug t-1783163892019: every global
// single-key handler consults ONE shared guard (typing / modifier chord / open
// modal dialog), and a '?' cheat-sheet overlay documents the keys. The guard
// DECISION is pure and unit-tested here; the wiring (which handlers consult it,
// and the overlay's dialog contract) is asserted as a source contract, same
// posture as the D3 dialog tests.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("shortcutBlockReasonFor (the shared global-shortcut guard decision)", () => {
  const free = { targetTag: "BODY", hasModifier: false, modalOpen: false };

  it("allows a plain key in a neutral context", () => {
    expect(shortcutBlockReasonFor(free)).toBeNull();
  });

  it.each(["INPUT", "TEXTAREA", "SELECT", "input", "select"])(
    "blocks while typing in a %s",
    (tag) => {
      expect(shortcutBlockReasonFor({ ...free, targetTag: tag })).toBe("typing");
    },
  );

  it("does not treat a button or div target as typing", () => {
    expect(shortcutBlockReasonFor({ ...free, targetTag: "BUTTON" })).toBeNull();
    expect(shortcutBlockReasonFor({ ...free, targetTag: "DIV" })).toBeNull();
  });

  it("tolerates a missing target tag (window-level key event)", () => {
    expect(shortcutBlockReasonFor({ ...free, targetTag: undefined })).toBeNull();
  });

  it("blocks Ctrl/Cmd/Alt chords (Ctrl+P must print, not navigate - t-1783183576693 d)", () => {
    expect(shortcutBlockReasonFor({ ...free, hasModifier: true })).toBe("modifier");
  });

  it("blocks while a modal dialog is open (d/i/p fired behind StatusChangeModal - t-1783163892019)", () => {
    expect(shortcutBlockReasonFor({ ...free, modalOpen: true })).toBe("modal");
  });

  it("reports typing ahead of modifier/modal (most specific reason wins)", () => {
    expect(
      shortcutBlockReasonFor({ targetTag: "INPUT", hasModifier: true, modalOpen: true }),
    ).toBe("typing");
  });

  it("the modal selector requires BOTH role=dialog and aria-modal (docked Run/Batch panels stay exempt)", () => {
    expect(MODAL_DIALOG_SELECTOR).toBe('[role="dialog"][aria-modal="true"]');
  });
});

describe("SHORTCUT_SECTIONS (the '?' cheat-sheet data)", () => {
  const allItems = SHORTCUT_SECTIONS.flatMap((s) => s.items);

  it("documents every global key the handlers own", () => {
    const keys = new Set(allItems.flatMap((i) => i.keys));
    for (const k of ["b", "t", "d", "i", "p", "n", "c", "/", "?", "Esc", "j", "k", "s", "m"]) {
      expect(keys.has(k), `missing key: ${k}`).toBe(true);
    }
  });

  it("every item has at least one key and a label", () => {
    for (const item of allItems) {
      expect(item.keys.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe("guard wiring (source contract): one guard, consulted everywhere", () => {
  const consumers = [
    ["App", "../src/App.tsx"],
    ["TopBar", "../src/components/TopBar.tsx"],
    ["ChatCapture", "../src/components/ChatCapture.tsx"],
    ["TriageInbox", "../src/components/TriageInbox.tsx"],
  ] as const;

  it.each(consumers)("%s imports and calls the shared guard", (_name, rel) => {
    const src = read(rel);
    // App sits at src root (./lib/...), components one level down (../lib/...).
    expect(src).toMatch(/from "\.{1,2}\/lib\/shortcuts"/);
    expect(src).toContain("shortcutBlockReason(e)");
  });

  it.each(consumers)("%s no longer hand-rolls the typing guard", (_name, rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/tag === ["']INPUT["']/);
  });

  it("App opens the '?' overlay and closes it on Escape first", () => {
    const src = read("../src/App.tsx");
    expect(src).toContain('e.key === "?"');
    expect(src).toContain("setShortcutHelp(true)");
    expect(src.indexOf("if (shortcutHelp) setShortcutHelp(false);")).toBeGreaterThan(-1);
  });
});

describe("ShortcutHelp overlay satisfies the dialog contract (source contract)", () => {
  const src = read("../src/components/ShortcutHelp.tsx");

  it('declares role="dialog" and aria-modal="true"', () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
  });

  it("has an accessible name via aria-labelledby pointing at its title", () => {
    expect(src).toContain("aria-labelledby=");
  });

  it("uses the shared focus trap + focusable finder", () => {
    expect(src).toContain('from "./dialogFocus"');
    expect(src).toContain("nextTrapTarget");
    expect(src).toContain("getFocusableElements");
  });

  it("restores focus to the opener on close", () => {
    expect(src).toContain("document.activeElement");
    expect(src).toContain("opener?.focus()");
  });

  it("does NOT add its own Escape KEY handler (global handler owns Esc; avoids double-close)", () => {
    expect(src).not.toMatch(/["']Escape["']/);
  });

  it("renders from the shared SHORTCUT_SECTIONS data (never a second hand-typed list)", () => {
    expect(src).toContain("SHORTCUT_SECTIONS");
  });
});
