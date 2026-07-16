import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// UI consistency pack t-1783183576693 (a)+(b), source contracts:
//   (a) the dialogs that hand-rolled focus traps now share ./dialogFocus,
//       whose selector includes `summary` (JobDetail's drift, folded back in);
//   (b) the segmented-control dialects share SegmentedControl (canonical
//       accent-fill pill) and the two undo toasts share UndoToast.
// SIM-59 note: the legacy in-app Product Hub surfaces (HubSidebar, TeamView,
// TaskBoard, IntakeView) were deleted with the hub's retirement; their rows
// dropped out of the tables below - the contracts hold for what remains.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("dialogFocus sweep (a): one trap, shared by every dialog", () => {
  const dialogs = [
    ["ChatCapture", "../src/components/ChatCapture.tsx"],
    ["NotificationPanel", "../src/components/NotificationPanel.tsx"],
    ["JobDetail", "../src/components/JobDetail.tsx"],
    ["ShortcutHelp", "../src/components/ShortcutHelp.tsx"],
    ["AddJobModal", "../src/components/AddJobModal.tsx"],
    ["StatusChangeModal", "../src/components/StatusChangeModal.tsx"],
  ] as const;

  it.each(dialogs)("%s imports the shared trap helpers", (_name, rel) => {
    const src = read(rel);
    expect(src).toContain('from "./dialogFocus"');
    expect(src).toContain("nextTrapTarget");
  });

  it.each(dialogs)("%s keeps no local getFocusableElements copy", (_name, rel) => {
    expect(read(rel)).not.toMatch(/function getFocusableElements\(/);
  });

  it("the shared selector includes `summary` (JobDetail's Full-job-note disclosure)", () => {
    const src = read("../src/components/dialogFocus.ts");
    expect(src).toMatch(/textarea:not\(\[disabled\]\), summary,/);
  });

  it("no component keeps a private focusable-elements selector", () => {
    // The trap selector's most distinctive fragment must exist ONLY in dialogFocus.
    for (const [, rel] of dialogs) {
      expect(read(rel)).not.toContain("a[href], button:not([disabled])");
    }
  });
});

describe("SegmentedControl (b): the one segmented dialect", () => {
  const adopters = [
    ["TopBar (Board/Table)", "../src/components/TopBar.tsx"],
    ["JobFilterBar (All/Any)", "../src/components/JobFilterBar.tsx"],
  ] as const;

  it.each(adopters)("%s renders the shared control", (_name, rel) => {
    const src = read(rel);
    expect(src).toContain('from "./SegmentedControl"');
    expect(src).toContain("<SegmentedControl");
  });

  it("the shared control is the canonical accent-fill pill with aria-pressed buttons and 44px touch targets", () => {
    const src = read("../src/components/SegmentedControl.tsx");
    expect(src).toContain('role="group"');
    expect(src).toContain("aria-pressed={on}");
    expect(src).toContain("bg-[var(--color-accent)] text-white");
    expect(src).toContain("min-h-[44px]");
    expect(src).toContain("sm:min-h-0");
  });

});

describe("UndoToast (b): the one undo toast", () => {
  const adopters = [
    ["App", "../src/App.tsx"],
    ["TriageInbox", "../src/components/TriageInbox.tsx"],
  ] as const;

  it.each(adopters)("%s renders the shared toast", (_name, rel) => {
    const src = read(rel);
    expect(src).toContain("<UndoToast");
    // The toast markup itself (role=status shell) lives only in UndoToast.tsx.
    expect(src).not.toMatch(/role="status"[\s\S]{0,200}Undo/);
  });

  it("the shared toast is a polite status region with a 44px-on-touch Undo button, clamped to the viewport", () => {
    const src = read("../src/components/UndoToast.tsx");
    expect(src).toContain('role="status"');
    expect(src).toContain("min-h-[44px]");
    expect(src).toContain("max-w-[calc(100vw-2rem)]");
  });

  it("both owners keep the ~6s auto-dismiss convention", () => {
    for (const [, rel] of adopters) {
      expect(read(rel)).toContain("setUndo(null), 6000");
    }
  });
});
