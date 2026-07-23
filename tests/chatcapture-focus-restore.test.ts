import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// SIM-601 (a11y): open ChatCapture via the FAB (keyboard), press Esc - the
// dialog closes but focus was dropped to <body> instead of returning to the
// FAB (the standard modal focus-restore contract).
//
// Root cause: the FAB only exists in the DOM while `!open`
// ({!open && <button>} in ChatCapture.tsx), so it UNMOUNTS the instant the
// panel opens. The focus-restore effect captured `document.activeElement`
// (the FAB DOM node) into previouslyFocusedRef on open, but by the time
// close ran that captured node had already been removed from the document -
// calling .focus() on a detached element is a silent no-op per the DOM spec,
// so focus fell through to body. This reproduces for EVERY close path (Esc,
// the X button, backdrop click), not only Esc.
//
// Fix: previouslyFocusedRef.current is only used if still document.contains()-
// attached; otherwise focus falls back to fabRef, a stable ref that always
// points at whichever FAB DOM node is CURRENTLY mounted (re-mounted by the
// very same commit that closes the panel).
//
// No React render layer in this project (see tests/chatcapture-esc.test.ts's
// header) - pinned as source contracts, matching that file's own idiom.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const src = read("../src/components/ChatCapture.tsx");

describe("SIM-601 ChatCapture focus-restore survives the FAB's mount/unmount cycle (source contract)", () => {
  it("declares a stable fabRef and attaches it to the FAB button", () => {
    expect(src).toMatch(/const fabRef = useRef<HTMLButtonElement \| null>\(null\)/);
    // Attached inside the {!open && (<button ref={fabRef} ...>)} branch.
    expect(src).toMatch(/!open &&[\s\S]{0,40}<button\s+ref=\{fabRef\}/);
  });

  it("only restores to the captured element if it is still attached to the document", () => {
    expect(src).toMatch(/previouslyFocusedRef\.current && document\.contains\(previouslyFocusedRef\.current\)/);
  });

  it("falls back to focusing the current FAB node when the captured element is gone", () => {
    // The else-if branch must call focus() on fabRef.current, not merely
    // reference it - a stale capture must not just be silently dropped.
    const idx = src.indexOf("else if (fabRef.current)");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 400)).toContain("fabRef.current.focus()");
  });
});
