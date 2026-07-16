import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SAVED_VIEWS, matchesView } from "../src/components/TriageInbox";
import type { Discovery } from "../src/types";

// t-1783422377158: "text overflow and cannot clear the filter. Also what is
// Hidden status?" Two fixes, both guarded here in the repo's node-env +
// source-wiring idiom (no jsdom render harness in this project):
//   (a) the source-filter chip must keep its clear (X) control visible even when
//       the source name is long enough to overflow the 208px rail.
//   (b) every saved view - "Hidden" above all - must carry an explanation.

function find(over: Partial<Discovery> & { Title: string }): Discovery {
  return {
    "Date Found": "2026-07-01",
    Employer: "Some Co",
    Sector: "private",
    Track: "b2b_gtm_focused",
    Fit: "moderate",
    Tailoring: "light",
    Deadline: "",
    Location: "",
    Source: "",
    Link: "",
    Decision: "",
    Notes: "",
    tracked: false,
    ...over,
  };
}

describe("saved-view explanations (Hidden help)", () => {
  it("every saved view carries a non-empty hint (the tooltip + explainer source)", () => {
    for (const v of SAVED_VIEWS) {
      expect(v.hint, v.id).toBeTypeOf("string");
      expect(v.hint.trim().length, v.id).toBeGreaterThan(0);
    }
  });

  it("the Hidden hint actually explains it is the already-tracked finds", () => {
    const hidden = SAVED_VIEWS.find((v) => v.id === "hidden");
    expect(hidden).toBeDefined();
    expect(hidden!.hint.toLowerCase()).toContain("tracked");
  });

  it("the hint matches the behaviour: Hidden = tracked finds", () => {
    // The explainer must not lie about what the view shows.
    expect(matchesView(find({ Title: "t", tracked: true }), "hidden", "")).toBe(true);
    expect(matchesView(find({ Title: "n", tracked: false }), "hidden", "")).toBe(false);
  });
});

// Wiring contracts - the parts that fail without the fix, checked at source
// level (tests/triage-counts.test.ts idiom).
describe("TriageInbox filter-chip + Hidden wiring", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/TriageInbox.tsx", import.meta.url)),
    "utf8",
  );

  it("the source-filter chip fills its container and only the name truncates", () => {
    // `flex w-full min-w-0` on the chip + `min-w-0 flex-1 truncate` on the name
    // is what guarantees the row fits the rail instead of overflowing it.
    expect(src).toMatch(/flex w-full min-w-0 items-center gap-1\.5 rounded-full/);
    expect(src).toMatch(/className="min-w-0 flex-1 truncate font-medium" title=\{activeSourceName\}/);
  });

  it("the clear control stays visible (shrink-0) and keeps its accessible label", () => {
    expect(src).toMatch(/aria-label=\{`Clear source filter \$\{activeSourceName\}`\}/);
    // The old fixed 140px name cap that pushed the X off the rail is gone.
    expect(src).not.toContain("max-w-[140px] truncate font-medium");
    // The clear button carries shrink-0 so flex can never collapse it away.
    expect(src).toMatch(/inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full/);
  });

  it("the Hidden view renders an in-place explainer (not just a tooltip)", () => {
    expect(src).toMatch(/view === "hidden" &&/);
    expect(src).toMatch(/SAVED_VIEWS\.find\(\(v\) => v\.id === "hidden"\)\?\.hint/);
  });

  it("each view chip exposes its hint as a tooltip", () => {
    expect(src).toMatch(/title=\{v\.hint\}/);
  });
});
