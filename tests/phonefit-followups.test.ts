import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// R3 phone-fit follow-ups (next-window bundle) + the UI consistency pack's
// 44px sweep remainder. Like taskboard-a11y.test.ts, whether a control is
// >= 44px rendered is a live-browser concern; these are static source
// contracts that each enumerated control carries the app's 44px-on-touch
// idiom (min-h-[44px] ... sm:min-h-*), so the fixes cannot silently regress.
//
//   t-1783201082838 - JobFilterBar tap targets (selects/inputs, enum chips,
//                     combinator toggle, chip-remove, remove-condition)
//   t-1783201090278 - TriageInbox bulk-select checkboxes (44px hit area via
//                     the wrapping label, not a giant visual checkbox)
//   t-1783201097671 - Insights/Usage bar labels stack above the bar at narrow
//                     widths instead of a fixed-width squeezing column
//   t-1783183576693 - JobTable sort headers, TriageInbox source-filter-chip x

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TOUCH = "min-h-[44px]";

describe("JobFilterBar tap targets (t-1783201082838)", () => {
  const src = read("../src/components/JobFilterBar.tsx");

  it("the shared select/input classes are 44px on touch, 36px at >= sm", () => {
    expect(src).toMatch(/const selectCls =\s*\n?\s*"min-h-\[44px\][^"]*sm:min-h-\[36px\]/);
    expect(src).toMatch(/const inputCls =\s*\n?\s*"min-h-\[44px\][^"]*sm:min-h-\[36px\]/);
  });

  it("the enum value chips are 44px on touch (were 30px)", () => {
    expect(src).toContain(`${TOUCH} rounded-full border px-2.5 py-1 text-[12px] font-medium transition sm:min-h-[30px]`);
  });

  it("the All/Any combinator toggle is the shared 44px-on-touch SegmentedControl", () => {
    expect(src).toContain("<SegmentedControl<Combinator>");
    expect(src).not.toContain("min-h-[30px] rounded px-2.5");
  });

  it("the chip-remove and remove-condition buttons get 44px hit areas on touch (were 16px / 32px)", () => {
    expect(src).toContain("h-11 w-11 shrink-0 items-center justify-center rounded-full");
    expect(src).toContain("sm:h-4 sm:w-4");
    expect(src).toContain("h-11 w-11 shrink-0 items-center justify-center rounded-md");
    expect(src).toContain("sm:h-8 sm:w-8");
  });

  it("the Filter trigger and Add-condition/Clear-all buttons are 44px on touch", () => {
    expect(src).toContain(`inline-flex ${TOUCH} shrink-0 items-center gap-1.5 rounded-md border px-2.5`);
    expect(src).toContain(`${TOUCH} items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[34px]`);
  });
});

describe("TriageInbox bulk-select hit areas (t-1783201090278)", () => {
  const src = read("../src/components/TriageInbox.tsx");

  it("the row checkbox is wrapped in a 44px label hit area; the box itself stays 16px", () => {
    expect(src).toContain(`-my-2.5 -ml-2.5 flex ${TOUCH} min-w-[44px] shrink-0 cursor-pointer`);
    expect(src).toMatch(/min-w-\[44px\][\s\S]{0,400}className="h-4 w-4 shrink-0 cursor-pointer"/);
  });

  it("the select-all label is the 44px tap target for its checkbox + count", () => {
    expect(src).toContain(`inline-flex ${TOUCH} cursor-pointer items-center gap-2 text-[12px]`);
  });

  it("the source-filter chip's clear button gets a 44px hit area on touch", () => {
    // shrink-0 (t-1783422377158) keeps the clear control from being collapsed
    // away by a long source name; the 44px touch target is unchanged.
    expect(src).toContain("h-11 w-11 shrink-0 items-center justify-center rounded-full");
    expect(src).toContain("sm:h-5 sm:w-5");
  });
});

describe("JobTable sort headers (44px sweep, t-1783183576693)", () => {
  it("the sortable header buttons are 44px on touch", () => {
    const src = read("../src/components/JobTable.tsx");
    expect(src).toContain(`inline-flex ${TOUCH} items-center gap-1 uppercase tracking-wide`);
  });
});

describe("Insights bar labels stack at narrow widths (t-1783201097671)", () => {
  // UsagePanel (the other adopter) was deleted with the in-app hub's
  // retirement (SIM-59); the contract holds for InsightsView.
  it.each([
    ["InsightsView", "../src/components/InsightsView.tsx", "sm:w-[120px]"],
  ])("%s stacks label above bar below sm and restores the column at >= sm", (_name, rel, col) => {
    const src = read(rel);
    // Stacked by default...
    expect(src).toContain("flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2");
    // ...label width becomes an sm-only concern (no unconditional fixed column)...
    expect(src).toContain(col);
    expect(src).not.toMatch(/className="w-\[1[24]0px\] shrink-0/);
    // ...bar keeps full width when stacked, flexes back in the row.
    expect(src).toContain("h-5 w-full overflow-hidden rounded bg-[var(--color-panel-2)] sm:w-auto sm:flex-1");
    // truncate + title stays for long labels.
    expect(src).toContain("truncate text-[12px]");
    expect(src).toContain("title={r.label}");
  });
});
