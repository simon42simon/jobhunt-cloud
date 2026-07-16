import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FIND_SORTS,
  filterFindsByFacets,
  refreshWithBusy,
  sortFinds,
  type FindsSort,
} from "../src/components/TriageInbox";
import type { Discovery } from "../src/types";

// Discovery finds view controls (t-1783163892053): #4 user-controllable
// sort/filter (pure helpers) and #3 the Refresh busy wrapper. Node-env unit
// tests over the exported helpers (the repo's component-test posture,
// triage-pursue.test.ts / triage-counts.test.ts), plus source-level wiring
// contracts in the ui-consistency idiom.

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

const titles = (arr: Discovery[]) => arr.map((f) => f.Title);

describe("sortFinds", () => {
  const fixture = [
    find({ Title: "old stretch, near deadline", "Date Found": "2026-06-01", Fit: "stretch", Deadline: "2026-07-10" }),
    find({ Title: "new strong, no deadline", "Date Found": "2026-07-04", Fit: "strong" }),
    find({ Title: "mid moderate, far deadline", "Date Found": "2026-06-20", Fit: "moderate", Deadline: "2026-09-01" }),
    find({ Title: "new weird fit, rolling", "Date Found": "2026-07-03", Fit: "???", Deadline: "rolling" }),
  ];

  it("newest (the default) is Date Found desc, title as tiebreak", () => {
    expect(titles(sortFinds(fixture, "newest"))).toEqual([
      "new strong, no deadline",
      "new weird fit, rolling",
      "mid moderate, far deadline",
      "old stretch, near deadline",
    ]);
  });

  it("fit ranks strong > moderate > stretch, unknown fits last", () => {
    expect(titles(sortFinds(fixture, "fit"))).toEqual([
      "new strong, no deadline",
      "mid moderate, far deadline",
      "old stretch, near deadline",
      "new weird fit, rolling",
    ]);
  });

  it("fit is case/whitespace tolerant (' Strong ' ranks first)", () => {
    const arr = [find({ Title: "b", Fit: "moderate" }), find({ Title: "a", Fit: " Strong " })];
    expect(titles(sortFinds(arr, "fit"))).toEqual(["a", "b"]);
  });

  it("deadline puts the soonest REAL date first; free-text and blank sink to the end", () => {
    expect(titles(sortFinds(fixture, "deadline"))).toEqual([
      "old stretch, near deadline",
      "mid moderate, far deadline",
      // no real date -> both sink, newest-first among themselves:
      "new strong, no deadline",
      "new weird fit, rolling",
    ]);
  });

  it("never mutates its input", () => {
    const arr = [find({ Title: "b" }), find({ Title: "a" })];
    const before = titles(arr);
    sortFinds(arr, "newest");
    expect(titles(arr)).toEqual(before);
  });

  it("every declared sort id is handled (no silent fall-through to newest)", () => {
    const ids: FindsSort[] = FIND_SORTS.map((s) => s.id);
    expect(ids).toEqual(["newest", "fit", "deadline"]);
  });
});

describe("filterFindsByFacets", () => {
  const fixture = [
    find({ Title: "s-gtm", Fit: "Strong", Track: "b2b_gtm_focused" }),
    find({ Title: "m-gtm", Fit: "moderate", Track: "b2b_gtm_focused" }),
    find({ Title: "s-out", Fit: "strong", Track: "industry_outreach_focused" }),
  ];

  it("no facets = the same array back (referential, so memos stay cheap)", () => {
    expect(filterFindsByFacets(fixture, {})).toBe(fixture);
    expect(filterFindsByFacets(fixture, { fit: "", track: "" })).toBe(fixture);
  });

  it("fit matches case-insensitively", () => {
    expect(titles(filterFindsByFacets(fixture, { fit: "strong" }))).toEqual(["s-gtm", "s-out"]);
  });

  it("track matches the raw key exactly", () => {
    expect(titles(filterFindsByFacets(fixture, { track: "b2b_gtm_focused" }))).toEqual(["s-gtm", "m-gtm"]);
  });

  it("facets combine (AND)", () => {
    expect(titles(filterFindsByFacets(fixture, { fit: "strong", track: "b2b_gtm_focused" }))).toEqual(["s-gtm"]);
  });
});

describe("refreshWithBusy (#3)", () => {
  it("holds busy true while an async reload is in flight, clears it after", async () => {
    const states: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = refreshWithBusy(() => gate, (b) => states.push(b));
    expect(states).toEqual([true]); // busy immediately, before the reload settles
    release();
    await p;
    expect(states).toEqual([true, false]);
  });

  it("clears busy even when the reload rejects (never strands a disabled button)", async () => {
    const setBusy = vi.fn();
    await expect(
      refreshWithBusy(() => Promise.reject(new Error("boom")), setBusy),
    ).rejects.toThrow("boom");
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("tolerates a void (non-promise) reload", async () => {
    const setBusy = vi.fn();
    await refreshWithBusy(() => undefined, setBusy);
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
  });
});

// Wiring contracts (the ui-consistency idiom): the controls are actually
// attached to the rendered view the way the tickets specified.
describe("TriageInbox control wiring", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/TriageInbox.tsx", import.meta.url)),
    "utf8",
  );

  it("#3: the Refresh button disables while refreshing and goes through refreshWithBusy", () => {
    expect(src).toMatch(/refreshWithBusy\(reload, setRefreshing\)/);
    expect(src).toMatch(/disabled=\{refreshing\}/);
    expect(src).toContain('{refreshing ? "Refreshing…" : "Refresh"}');
  });

  it("#4: the visible list is ordered by the user's sort and facets feed the SHARED scoped array", () => {
    expect(src).toMatch(/return sortFinds\(arr, sort\)/);
    expect(src).toMatch(/filterFindsByFacets\(scopeFindsToSource\(finds, sourceFilter, aliasIdx\)/);
    expect(src).toContain('ariaLabel="Sort finds"');
    expect(src).toContain('aria-label="Filter by fit"');
    expect(src).toContain('aria-label="Filter by track"');
  });

  it("#4: the sort control is the shared SegmentedControl, not a new dialect", () => {
    expect(src).toContain('from "./SegmentedControl"');
    expect(src).toContain("<SegmentedControl");
  });

  it("#2: rows carry one primary Pursue plus the overflow menu (no inline row Skip/Maybe buttons)", () => {
    expect(src).toMatch(/<RowActionMenu/);
    // The row's Skip/Maybe go through the menu callbacks; the only aria-labelled
    // standalone Skip button left is the detail pane's full-size one.
    expect(src.match(/aria-label=\{`Skip \$\{find\.Title\}`\}/g)).toBeNull();
  });

  it("#5: the empty state offers the inline Run affordance", () => {
    expect(src).toMatch(/runFromEmptyState/);
    expect(src).toContain('"Run due sources"');
  });

  it("#1: the finds view stays a stacked card/list layout - no table to horizontally scroll", () => {
    expect(src).not.toContain("<table");
  });
});
