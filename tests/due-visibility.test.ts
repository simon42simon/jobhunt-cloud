import { describe, it, expect } from "vitest";
import type { DerivedSource } from "../src/types";
import { countDueSources, totalNewSinceVisit } from "../src/lib/sources";

// Pure-logic tests for the discovery due-visibility counts (t-1783183576588):
// the N in the TopBar's "Discover due (N)" button / due-chip and the "+N new"
// badge on the Finds toggle. Both are derived client-side from the SAME
// /api/discovery/sources payload the console renders, by these two helpers.

function mkSource(p: Partial<DerivedSource> = {}): DerivedSource {
  return {
    id: "oci",
    name: "OCI",
    type: "board",
    sector: "bps",
    active: "yes",
    urls: [],
    cadence: "weekly",
    instructions: "",
    outputFields: [],
    aliases: [],
    lastRunAt: null,
    lastVisitedAt: null,
    notes: "",
    runs: [],
    status: "healthy",
    due: false,
    nextRunAt: null,
    jobCount: 0,
    newSinceVisit: 0,
    pursuedPct: 0,
    ...p,
  };
}

const openRun = (): DerivedSource["runs"][number] => ({
  runId: "r-open",
  startedAt: "2026-07-04T00:00:00.000Z",
  durationMs: null,
  outcome: "running",
  leadsFound: null,
  leadsNew: null,
  trigger: "manual",
});

describe("countDueSources (the N on 'Discover due (N)' / the due-chip)", () => {
  it("counts due sources and ignores not-due ones", () => {
    expect(
      countDueSources([
        mkSource({ id: "a", due: true, status: "due" }),
        mkSource({ id: "b", due: true, status: "stale" }),
        mkSource({ id: "c", due: false, status: "healthy" }),
      ]),
    ).toBe(2);
  });

  it("mirrors run-all-due's selection: a source already running is not a target", () => {
    expect(countDueSources([mkSource({ due: true, status: "running" })])).toBe(0);
    // Same signal via an open run in the history, even if status lags.
    expect(countDueSources([mkSource({ due: true, status: "due", runs: [openRun()] })])).toBe(0);
  });

  it("counts a never-run scheduled source (the server marks it due)", () => {
    expect(countDueSources([mkSource({ due: true, status: "never-run" })])).toBe(1);
  });

  it("is 0 for an empty registry", () => {
    expect(countDueSources([])).toBe(0);
  });
});

describe("totalNewSinceVisit (the '+N new' badge on the Finds toggle)", () => {
  it("sums each source's newSinceVisit", () => {
    expect(
      totalNewSinceVisit([
        mkSource({ id: "a", newSinceVisit: 3 }),
        mkSource({ id: "b", newSinceVisit: 0 }),
        mkSource({ id: "c", newSinceVisit: 4 }),
      ]),
    ).toBe(7);
  });

  it("is 0 for an empty registry or all-visited sources", () => {
    expect(totalNewSinceVisit([])).toBe(0);
    expect(totalNewSinceVisit([mkSource({ newSinceVisit: 0 })])).toBe(0);
  });
});
