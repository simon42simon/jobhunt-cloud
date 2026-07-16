import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextTrapTarget } from "../src/components/dialogFocus";

// D3 - AddJobModal + StatusChangeModal become true dialogs. The runtime focus
// moves (getFocusableElements, the useEffects) need a DOM, so the pure Tab-wrap
// DECISION (nextTrapTarget) is unit-tested here, and the role/aria/trap/no-double-
// close wiring is asserted as a source contract.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("nextTrapTarget (the Tab focus-trap boundary decision)", () => {
  const items = ["first", "mid", "last"];

  it("returns null for an empty dialog", () => {
    expect(nextTrapTarget([], "first", false)).toBeNull();
    expect(nextTrapTarget([], null, true)).toBeNull();
  });

  it("wraps Tab from the last element back to the first", () => {
    expect(nextTrapTarget(items, "last", false)).toBe("first");
  });

  it("wraps Shift+Tab from the first element back to the last", () => {
    expect(nextTrapTarget(items, "first", true)).toBe("last");
  });

  it("lets Tab move natively when in the middle of the range", () => {
    expect(nextTrapTarget(items, "mid", false)).toBeNull();
    expect(nextTrapTarget(items, "mid", true)).toBeNull();
  });

  it("does not intercept Tab moving off the first element forward", () => {
    expect(nextTrapTarget(items, "first", false)).toBeNull();
  });

  it("does not intercept Shift+Tab moving off the last element backward", () => {
    expect(nextTrapTarget(items, "last", true)).toBeNull();
  });

  it("pulls focus that has escaped the dialog back to an edge", () => {
    // active is not one of the focusables (focus somehow left the dialog).
    expect(nextTrapTarget(items, "somewhere-else", false)).toBe("first");
    expect(nextTrapTarget(items, "somewhere-else", true)).toBe("last");
    expect(nextTrapTarget(items, null, false)).toBe("first");
    expect(nextTrapTarget(items, null, true)).toBe("last");
  });

  it("keeps focus pinned when the dialog has a single focusable", () => {
    expect(nextTrapTarget(["only"], "only", false)).toBe("only");
    expect(nextTrapTarget(["only"], "only", true)).toBe("only");
  });
});

describe.each([
  ["AddJobModal", "../src/components/AddJobModal.tsx"],
  ["StatusChangeModal", "../src/components/StatusChangeModal.tsx"],
])("%s satisfies the dialog contract (source contract)", (_name, rel) => {
  const src = read(rel);

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
    // A local Esc handler would compare against the "Escape" key string; assert no
    // such literal exists (the word appears only in explanatory comments here).
    expect(src).not.toMatch(/["']Escape["']/);
  });
});
