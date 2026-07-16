import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// t-1783183576609 - Jobs hierarchy pack (audit F12/F15). App.tsx wires live
// browser rendering + localStorage side effects this suite cannot exercise
// headless (no jsdom/testing-library in this project - see kanban-a11y.test.ts
// for the same posture), so these are static SOURCE-CONTRACT checks: they pin
// the shape of the fix in the raw file text so it cannot silently regress. A
// live click-through (board -> table -> reload) is still the MAIN session's
// job before merge. The F14 block (ProductHub hub-tab persistence) retired
// with the in-app hub (SIM-59) - the SSC Product Hub owns that behavior now.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("F12 - NeedsAttentionStrip renders on BOTH Jobs views (source contract)", () => {
  const src = read("../src/App.tsx");

  it("renders NeedsAttentionStrip exactly once - not duplicated per view", () => {
    const count = (src.match(/<NeedsAttentionStrip/g) || []).length;
    expect(count).toBe(1);
  });

  it("the single render sits ABOVE the board/table switch (before both KanbanBoard and JobTable)", () => {
    const stripIdx = src.indexOf("<NeedsAttentionStrip");
    const boardIdx = src.indexOf("<KanbanBoard");
    const tableIdx = src.indexOf("<JobTable");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(boardIdx).toBeGreaterThan(stripIdx);
    expect(tableIdx).toBeGreaterThan(stripIdx);
  });

  it("stays scoped to the Jobs page - after the product/discovery/insights branches, not before them", () => {
    const stripIdx = src.indexOf("<NeedsAttentionStrip");
    const insightsIdx = src.indexOf('view === "insights"');
    expect(insightsIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeGreaterThan(insightsIdx);
  });

  it("keeps KanbanBoard and JobTable mutually exclusive on jobsView (no double-render of the list itself)", () => {
    expect(src).toMatch(/jobsView === "board" \? \(\s*<KanbanBoard/);
  });
});
