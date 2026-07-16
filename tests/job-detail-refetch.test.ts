import { describe, it, expect } from "vitest";
import { isRunForJob } from "../src/components/JobDetail";

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
