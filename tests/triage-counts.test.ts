import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SAVED_VIEWS,
  effDecision,
  matchesView,
  scopeFindsToSource,
  triageCounts,
  type EffDecision,
} from "../src/components/TriageInbox";
import { buildAliasIndex, findKey } from "../src/lib/sources";
import type { DerivedSource, Discovery } from "../src/types";

// Saved-view rail counts respect the active source filter (t-1783255697392).
// The bug: the counts memo ran over ALL finds while the list applied the
// source chip via resolveFindSourceId - with "source: LinkedIn Jobs" active
// the rail showed the global numbers over an empty list. The fix derives ONE
// shared source-scoped array (scopeFindsToSource) and bases BOTH the counts
// and the list on it. Pure node-env tests (the repo's component-test posture,
// same as triage-pursue.test.ts) plus a source-wiring contract on the memos
// themselves, which is the part that fails without the fix.

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
    Link: `https://example.com/${encodeURIComponent(over.Title)}`,
    Decision: "",
    Notes: "",
    tracked: false,
    ...over,
  };
}

function src(over: Partial<DerivedSource> & { id: string; name: string }): DerivedSource {
  return {
    type: "board",
    sector: "private",
    active: "yes",
    urls: [],
    cadence: "manual",
    fetchMode: null,
    fetchNote: "",
    instructions: "",
    outputFields: [],
    aliases: [],
    tracks: [],
    lastRunAt: null,
    lastVisitedAt: null,
    notes: "",
    runs: [],
    status: "never-run",
    due: false,
    nextRunAt: null,
    lastRunSignal: null,
    jobCount: 0,
    newSinceVisit: 0,
    pursuedPct: 0,
    contractGaps: [],
    instructionProposals: [],
    instructionsApprovedFrom: null,
    instructionsUpdatedAt: null,
    ...over,
  } as DerivedSource;
}

const sources = [
  src({ id: "linkedin-jobs", name: "LinkedIn Jobs", aliases: ["linkedin"] }),
  src({ id: "uni-affairs", name: "University Affairs" }),
];
const aliasIdx = buildAliasIndex(sources);

// Multi-source fixture: 4 LinkedIn finds (1 new, 1 maybe, 1 pursued, 1 tracked),
// 2 University Affairs finds (1 new, 1 skipped), 1 unassigned new find.
const finds: Discovery[] = [
  find({ Title: "LI new", Source: "LinkedIn Jobs" }),
  find({ Title: "LI maybe", Source: "linkedin", Decision: "maybe" }), // via alias
  find({ Title: "LI pursued", sourceId: "linkedin-jobs", Decision: "pursue" }), // via stamped id
  find({ Title: "LI tracked", Source: "LinkedIn Jobs", tracked: true }),
  find({ Title: "UA new", Source: "University Affairs" }),
  find({ Title: "UA skipped", Source: "University Affairs", Decision: "skip" }),
  find({ Title: "Unassigned new", Source: "Some Random Label" }),
];

const none: Record<string, EffDecision> = {};

// The list length the component renders for one view (the filtered memo's
// filter, minus the sort - length is what the badge promises).
function listLen(scoped: Discovery[], view: (typeof SAVED_VIEWS)[number]["id"], overrides: Record<string, EffDecision>) {
  return scoped.filter((f) => matchesView(f, view, effDecision(f, overrides))).length;
}

describe("scopeFindsToSource", () => {
  it("returns the input untouched when no source filter is set", () => {
    expect(scopeFindsToSource(finds, null, aliasIdx)).toBe(finds);
  });

  it("keeps only the finds that resolve to the filtered source (name, alias, or stamped id)", () => {
    const scoped = scopeFindsToSource(finds, "linkedin-jobs", aliasIdx);
    expect(scoped.map((f) => f.Title)).toEqual(["LI new", "LI maybe", "LI pursued", "LI tracked"]);
  });

  it("drops unassigned finds when any filter is active", () => {
    const scoped = scopeFindsToSource(finds, "uni-affairs", aliasIdx);
    expect(scoped.map((f) => f.Title)).toEqual(["UA new", "UA skipped"]);
  });
});

describe("rail counts under a source filter (t-1783255697392)", () => {
  it("every view badge equals the list length that view renders, filter active", () => {
    for (const sourceId of ["linkedin-jobs", "uni-affairs"]) {
      const scoped = scopeFindsToSource(finds, sourceId, aliasIdx);
      const counts = triageCounts(scoped, none);
      for (const v of SAVED_VIEWS) {
        expect(counts[v.id], `${sourceId} / ${v.id}`).toBe(listLen(scoped, v.id, none));
      }
    }
  });

  it("filtered counts are the source's own numbers, not the global ones", () => {
    const li = triageCounts(scopeFindsToSource(finds, "linkedin-jobs", aliasIdx), none);
    expect(li).toEqual({ new: 1, maybe: 1, pursued: 2, all: 4, hidden: 1 });
    const ua = triageCounts(scopeFindsToSource(finds, "uni-affairs", aliasIdx), none);
    expect(ua).toEqual({ new: 1, maybe: 0, pursued: 0, all: 2, hidden: 0 });
    // Guard against a tautology: the global numbers really are different.
    expect(li).not.toEqual(triageCounts(finds, none));
  });

  it("clearing the chip reverts every badge to the global numbers", () => {
    const global = triageCounts(scopeFindsToSource(finds, null, aliasIdx), none);
    expect(global).toEqual({ new: 3, maybe: 1, pursued: 2, all: 7, hidden: 1 });
  });

  it("optimistic overrides move the scoped counts (a skip decided this session leaves New)", () => {
    const overrides: Record<string, EffDecision> = { [findKey(finds[0])]: "skip" };
    const li = triageCounts(scopeFindsToSource(finds, "linkedin-jobs", aliasIdx), overrides);
    expect(li.new).toBe(0);
    expect(li.all).toBe(4); // still that source's finds - a decision hides nothing from All
  });
});

// The wiring contract - the part that fails without the fix: both memos must
// consume the ONE shared scoped array. Source-level check, the established
// idiom for render-layer contracts (tests/ui-consistency.test.ts).
describe("TriageInbox memo wiring", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/TriageInbox.tsx", import.meta.url)),
    "utf8",
  );

  it("the counts memo derives from the shared source-scoped array", () => {
    expect(src).toMatch(/const counts = useMemo\(\(\) => triageCounts\(scopedFinds, overrides\)/);
  });

  it("the list memo derives from the same shared array", () => {
    expect(src).toMatch(/const arr = scopedFinds\.filter\(/);
  });

  it("no memo counts over the unscoped finds anymore", () => {
    // (trackOptions deliberately iterates the raw finds - facet OPTIONS must
    // not shrink when a facet is picked - so this pins only the COUNTING.)
    expect(src).not.toMatch(/triageCounts\(finds,/);
  });
});
