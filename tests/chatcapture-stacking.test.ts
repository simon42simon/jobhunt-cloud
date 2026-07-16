import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Stacking contract for the chat-capture drawer (t-1783742858526). QA repro:
// with a CTO-assessment run expanded, the RunPanel stack (z-[70], bottom-right,
// up to ~full viewport height) covered the drawer's "New report / My reports"
// tabs 5/5. The open drawer is MODAL (dimmed backdrop + aria-modal), so it must
// stack ABOVE every non-modal run surface (expanded RunPanel stack, run note,
// UndoToast at z-[70]; RunDock at z-[65]) while staying BELOW the interrupting
// confirm modals (z-[80]) and ShortcutHelp (z-[90]). These are source contracts
// in the ui-consistency style: they pin the z values' ORDER, not the numbers.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function zOf(src: string, pattern: RegExp, what: string): number {
  const m = pattern.exec(src);
  if (!m) throw new Error(`could not locate ${what} (pattern ${pattern})`);
  return Number(m[1]);
}

const maxZ = (src: string) => Math.max(...[...src.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1])));

const chat = read("../src/components/ChatCapture.tsx");
const backdropZ = zOf(chat, /fixed inset-0 z-\[(\d+)\] bg-black\/50/, "chat backdrop");
const panelZ = zOf(chat, /fixed right-0 top-0 z-\[(\d+)\]/, "chat panel");
const lightboxZ = zOf(
  chat,
  /fixed inset-0 z-\[(\d+)\] flex items-center justify-center bg-black\/80/,
  "chat lightbox",
);

describe("chat-capture drawer stacks above the run surfaces (t-1783742858526)", () => {
  it("panel and backdrop sit above the expanded RunPanel stack, run note, and UndoToast", () => {
    // App.tsx owns the RunPanel stack + run-note placement; its highest layer
    // must stay under the chat drawer or a tall run panel covers the tabs.
    const appTopZ = maxZ(read("../src/App.tsx"));
    expect(panelZ).toBeGreaterThan(appTopZ);
    expect(backdropZ).toBeGreaterThan(appTopZ);
    expect(panelZ).toBeGreaterThan(maxZ(read("../src/components/UndoToast.tsx")));
  });

  it("panel sits above the RunDock chips", () => {
    expect(panelZ).toBeGreaterThan(maxZ(read("../src/components/RunDock.tsx")));
  });

  it("backdrop sits under the panel; lightbox (nested dialog) sits over it", () => {
    expect(backdropZ).toBeLessThan(panelZ);
    expect(lightboxZ).toBeGreaterThan(panelZ);
  });

  it("the whole drawer stays under the interrupting modals and ShortcutHelp", () => {
    const statusModalZ = maxZ(read("../src/components/StatusChangeModal.tsx"));
    const shortcutZ = maxZ(read("../src/components/ShortcutHelp.tsx"));
    for (const z of [backdropZ, panelZ, lightboxZ]) {
      expect(z).toBeLessThan(statusModalZ);
      expect(z).toBeLessThan(shortcutZ);
    }
  });
});
