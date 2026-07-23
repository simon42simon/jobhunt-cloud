import { describe, it, expect } from "vitest";
import { isRunForJob, shouldRefetchOnVersionBump } from "../src/components/JobDetail";

// t-1783390990670: the job detail drawer used to fetch its job + activity ONCE
// on open and never again, so a finished Agent-action run left the drawer stale
// (the button never flipped to Done/Regenerate, no Last-run badge, new files
// hidden). The drawer now refetches on the shared `run-finished` SSE event - but
// ONLY when the finished run is this job's own. `isRunForJob` is that gate: a
// pure predicate, imported straight from the component (the job-file-client
// pattern), no DOM needed.

describe("isRunForJob (drawer refetch gate)", () => {
  const OPEN = "Account Manager - Northwind Supply";

  it("matches a run stamped with this job's own folder id", () => {
    expect(isRunForJob({ jobId: OPEN }, OPEN)).toBe(true);
  });

  it("ignores a run for a DIFFERENT job", () => {
    expect(isRunForJob({ jobId: "Program Officer - OCI" }, OPEN)).toBe(false);
  });

  it("ignores a ticket-scoped run (jobId is a t-* id, never a job folder)", () => {
    expect(isRunForJob({ jobId: "t-1783390990670" }, OPEN)).toBe(false);
  });

  it("ignores a run with no jobId (a non-job-scoped routine)", () => {
    expect(isRunForJob({ jobId: null }, OPEN)).toBe(false);
    expect(isRunForJob({}, OPEN)).toBe(false);
  });

  it("never matches when the drawer has no job open", () => {
    expect(isRunForJob({ jobId: "" }, "")).toBe(false);
    expect(isRunForJob({ jobId: OPEN }, "")).toBe(false);
  });
});

// SIM-441: on instances with no working SSE (sse:false, e.g. the pg-backed
// demo), the run-finished subscription above never fires, so a completing
// canned replay left the open drawer's FILES panel stale. The drawer now also
// refetches when App's jobs-reload version bumps - the same signal the board
// card rides (a poll-detected run finish via RunPanel/RunDock's
// onFinished=reload works with no live stream at all). This predicate is the
// "did it actually change" gate: undefined -> anything is the drawer's own
// first observation on mount, never a refetch trigger.
describe("shouldRefetchOnVersionBump (drawer fallback-refresh gate)", () => {
  it("does not fire on the drawer's first observation of a version", () => {
    expect(shouldRefetchOnVersionBump(undefined, 0)).toBe(false);
    expect(shouldRefetchOnVersionBump(undefined, 7)).toBe(false);
  });

  it("fires when the version changes after the first observation", () => {
    expect(shouldRefetchOnVersionBump(3, 4)).toBe(true);
  });

  it("does not fire when the version is unchanged", () => {
    expect(shouldRefetchOnVersionBump(3, 3)).toBe(false);
    expect(shouldRefetchOnVersionBump(0, 0)).toBe(false);
  });
});
