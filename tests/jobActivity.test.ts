import { describe, it, expect } from "vitest";
import { deriveJobActivity, type JobActivityEntry } from "../src/lib/jobActivity";
import type { ActivityRecord, Job } from "../src/types";

// Unit tests for the pure per-job Activity timeline derivation (US-7,
// t-1783353402918). Node-env style (no DOM/React), matching tests/decisions.test.ts
// - the lib is the single source of truth the JobActivityTimeline component
// renders, so these assertions pin the exact filter, milestone-merge, ordering,
// and empty-state contract. The function WRITES NOTHING; it is a pure function of
// (job, activityLog).

const JOB_ID = "Business Development Manager (Aerospace & Defence) - Nefab";

// A minimal job stub - the derivation reads only id + the two dated fields.
function mkJob(over: Partial<Pick<Job, "id" | "applied" | "deadline">> = {}) {
  return { id: JOB_ID, applied: null, deadline: null, ...over };
}

// A run START record as the activity feed writes it (ts, routine, label, jobId,
// status:"running"). The CLOSE record (runId + terminal status, NO jobId) is
// modeled separately in the "ignores close records" test.
function runStart(over: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    ts: "2026-07-02T10:00:00.000Z",
    kind: "run",
    runId: "r1",
    routine: "first-draft-job",
    label: "Draft CV + cover letter",
    jobId: JOB_ID,
    status: "running",
    ...over,
  };
}

describe("deriveJobActivity - run filtering by jobId", () => {
  it("keeps only run records whose jobId matches this job", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "r1", jobId: JOB_ID }),
      runStart({ runId: "r2", jobId: "Some Other Role - Other Co" }),
      runStart({ runId: "r3", jobId: "t-1783119823228", routine: "assess-ticket" }), // a task run
      runStart({ runId: "r4", jobId: "york-university", routine: "discover-jobs-source" }), // a source run
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("run");
    expect(out[0].id).toBe("run:r1");
  });

  it("ignores close records (no jobId) and non-run kinds", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "r1" }),
      // close record: runId + terminal status, no jobId / routine
      { ts: "2026-07-02T10:05:00.000Z", kind: "run", runId: "r1", status: "done", exitCode: 0 },
      // a delegation record for good measure
      { ts: "2026-07-02T11:00:00.000Z", kind: "delegation", jobId: JOB_ID },
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("run:r1");
  });

  it("dedups repeated run records by runId", () => {
    const log: ActivityRecord[] = [runStart({ runId: "r1" }), runStart({ runId: "r1" })];
    expect(deriveJobActivity(mkJob(), log)).toHaveLength(1);
  });

  it("skips a run with an unparseable timestamp (cannot be placed)", () => {
    const log: ActivityRecord[] = [runStart({ runId: "r1", ts: "not-a-date" })];
    expect(deriveJobActivity(mkJob(), log)).toHaveLength(0);
  });
});

describe("deriveJobActivity - applied/deadline milestones", () => {
  it("includes an Applied milestone when applied is set", () => {
    const out = deriveJobActivity(mkJob({ applied: "2026-07-02" }), []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "applied", label: "Applied", ts: "2026-07-02", dateOnly: true });
  });

  it("includes a Deadline milestone when deadline is set", () => {
    const out = deriveJobActivity(mkJob({ deadline: "2026-07-10" }), []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "deadline", label: "Deadline", ts: "2026-07-10", dateOnly: true });
  });

  it("omits a milestone whose date is missing or unparseable", () => {
    expect(deriveJobActivity(mkJob({ applied: null, deadline: null }), [])).toHaveLength(0);
    expect(deriveJobActivity(mkJob({ applied: "not-a-date" }), [])).toHaveLength(0);
  });

  it("includes BOTH date milestones plus runs, merged into one list", () => {
    const log: ActivityRecord[] = [runStart({ runId: "r1" })];
    const out = deriveJobActivity(mkJob({ applied: "2026-07-02", deadline: "2026-07-10" }), log);
    expect(out.map((e) => e.kind).sort()).toEqual(["applied", "deadline", "run"]);
  });
});

describe("deriveJobActivity - newest-first ordering", () => {
  it("sorts every entry (runs + dates) by timestamp descending", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "old", ts: "2026-07-01T09:00:00.000Z" }),
      runStart({ runId: "new", ts: "2026-07-05T09:00:00.000Z", routine: "finalize-job" }),
    ];
    // applied 2026-07-03 sits between the two runs; deadline 2026-07-10 is newest.
    const out = deriveJobActivity(mkJob({ applied: "2026-07-03", deadline: "2026-07-10" }), log);
    expect(out.map((e) => e.id)).toEqual(["deadline", "run:new", "applied", "run:old"]);
  });

  it("orders a future deadline ahead of past activity", () => {
    const log: ActivityRecord[] = [runStart({ runId: "r1", ts: "2026-07-02T10:00:00.000Z" })];
    const out = deriveJobActivity(mkJob({ deadline: "2027-01-01" }), log);
    expect(out[0].kind).toBe("deadline");
  });
});

describe("deriveJobActivity - run label mapping", () => {
  it("uses a past-tense label for a known job routine", () => {
    const draft = deriveJobActivity(mkJob(), [runStart({ routine: "first-draft-job" })]);
    expect(draft[0].label).toBe("Drafted CV + cover letter");
    const fin = deriveJobActivity(mkJob(), [runStart({ routine: "finalize-job", label: "Finalize application" })]);
    expect(fin[0].label).toBe("Finalized application");
  });

  it("falls back to the feed's stamped label for an unmapped routine", () => {
    const out = deriveJobActivity(mkJob(), [runStart({ routine: "some-new-routine", label: "Did a thing" })]);
    expect(out[0].label).toBe("Did a thing");
  });

  it("falls back to the routine id when no label is stamped", () => {
    const out = deriveJobActivity(mkJob(), [runStart({ routine: "some-new-routine", label: undefined })]);
    expect(out[0].label).toBe("some-new-routine");
  });
});

describe("deriveJobActivity - consecutive same-routine collapse (US-7 QA refinement 2026-07-06)", () => {
  it("collapses N consecutive same-routine runs into one row with a run count", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "f1", routine: "finalize-job", ts: "2026-07-02T10:00:00.000Z" }),
      runStart({ runId: "f2", routine: "finalize-job", ts: "2026-07-03T10:00:00.000Z" }),
      runStart({ runId: "f3", routine: "finalize-job", ts: "2026-07-04T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out).toHaveLength(1);
    // Folded into the NEWEST run (f3), reporting all three retries in one row.
    expect(out[0]).toMatchObject({ id: "run:f3", kind: "run", routine: "finalize-job", runCount: 3 });
    expect(out[0].label).toBe("Finalized application");
    expect(out[0].ts).toBe("2026-07-04T10:00:00.000Z");
  });

  it("does not collapse runs of DIFFERENT routines", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "d1", routine: "first-draft-job", ts: "2026-07-02T10:00:00.000Z" }),
      runStart({ runId: "f1", routine: "finalize-job", ts: "2026-07-03T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out.map((e) => e.id)).toEqual(["run:f1", "run:d1"]);
    expect(out.every((e) => e.runCount === 1)).toBe(true);
  });

  it("a date milestone between two same-routine runs breaks the group", () => {
    // finalize Jul4, deadline Jul3, finalize Jul2: the deadline splits the two
    // finalizes, so they must NOT collapse - the milestone is real history.
    const log: ActivityRecord[] = [
      runStart({ runId: "f_new", routine: "finalize-job", ts: "2026-07-04T10:00:00.000Z" }),
      runStart({ runId: "f_old", routine: "finalize-job", ts: "2026-07-02T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob({ deadline: "2026-07-03" }), log);
    expect(out.map((e) => e.id)).toEqual(["run:f_new", "deadline", "run:f_old"]);
    expect(out[0].runCount).toBe(1);
    expect(out[2].runCount).toBe(1);
  });

  it("collapses only the adjacent same-routine group in an interleaved list", () => {
    // newest-first resolves to: finalize(Jul6), finalize(Jul5), draft(Jul4), finalize(Jul3)
    const log: ActivityRecord[] = [
      runStart({ runId: "f3", routine: "finalize-job", ts: "2026-07-03T10:00:00.000Z" }),
      runStart({ runId: "d1", routine: "first-draft-job", ts: "2026-07-04T10:00:00.000Z" }),
      runStart({ runId: "f5", routine: "finalize-job", ts: "2026-07-05T10:00:00.000Z" }),
      runStart({ runId: "f6", routine: "finalize-job", ts: "2026-07-06T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob(), log);
    // f6+f5 collapse (runCount 2); the draft breaks the run; the lone Jul3 finalize stays 1.
    expect(out.map((e) => e.id)).toEqual(["run:f6", "run:d1", "run:f3"]);
    expect(out.map((e) => e.runCount)).toEqual([2, 1, 1]);
  });

  it("does not fold together runs that have no routine id", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "x1", routine: undefined, label: "Thing A", ts: "2026-07-02T10:00:00.000Z" }),
      runStart({ runId: "x2", routine: undefined, label: "Thing B", ts: "2026-07-03T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.runCount === 1)).toBe(true);
  });

  it("a single run reports runCount 1; date milestones carry no runCount", () => {
    const out = deriveJobActivity(mkJob({ applied: "2026-07-02" }), [runStart({ runId: "r1" })]);
    const run = out.find((e) => e.kind === "run")!;
    const applied = out.find((e) => e.kind === "applied")!;
    expect(run.runCount).toBe(1);
    expect(applied.runCount).toBeUndefined();
  });

  it("retains the folded runs (newest-first) so the row can expand", () => {
    const log: ActivityRecord[] = [
      runStart({ runId: "f1", routine: "finalize-job", ts: "2026-07-02T10:00:00.000Z" }),
      runStart({ runId: "f2", routine: "finalize-job", ts: "2026-07-03T10:00:00.000Z" }),
      runStart({ runId: "f3", routine: "finalize-job", ts: "2026-07-04T10:00:00.000Z" }),
    ];
    const out = deriveJobActivity(mkJob(), log);
    expect(out).toHaveLength(1);
    // all three members kept, newest-first, for the expanded disclosure
    expect(out[0].runs?.map((r) => r.id)).toEqual(["run:f3", "run:f2", "run:f1"]);
    // each member is a plain run entry - no nested group state
    expect(
      out[0].runs?.every((r) => r.kind === "run" && r.runCount === undefined && r.runs === undefined),
    ).toBe(true);
  });

  it("an uncollapsed single run carries no member list", () => {
    const out = deriveJobActivity(mkJob(), [runStart({ runId: "r1" })]);
    expect(out[0].runCount).toBe(1);
    expect(out[0].runs).toBeUndefined();
  });
});

describe("deriveJobActivity - strict date-only milestones (US-7 QA refinement 2026-07-06)", () => {
  it("omits a deadline that carries anything beyond a bare YYYY-MM-DD", () => {
    expect(deriveJobActivity(mkJob({ deadline: "2026-07-10 (firm)" }), [])).toHaveLength(0);
    expect(deriveJobActivity(mkJob({ deadline: "2026-07-10T09:00:00Z" }), [])).toHaveLength(0);
  });

  it("omits an impossible calendar date rather than silently rolling it over", () => {
    expect(deriveJobActivity(mkJob({ applied: "2026-02-30" }), [])).toHaveLength(0);
    expect(deriveJobActivity(mkJob({ deadline: "2026-13-01" }), [])).toHaveLength(0);
  });

  it("accepts a clean YYYY-MM-DD (surrounding whitespace tolerated, not leaked)", () => {
    const out = deriveJobActivity(mkJob({ deadline: " 2026-07-10 " }), []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "deadline", ts: "2026-07-10", dateOnly: true });
  });

  it("still shows a future deadline as a milestone (always-shown semantics)", () => {
    const out = deriveJobActivity(mkJob({ deadline: "2099-01-01" }), [runStart({ runId: "r1" })]);
    expect(out[0]).toMatchObject({ kind: "deadline", ts: "2099-01-01" });
  });
});

describe("deriveJobActivity - empty-state signal", () => {
  it("returns [] when there is nothing derivable (component shows the empty state)", () => {
    const out: JobActivityEntry[] = deriveJobActivity(mkJob(), []);
    expect(out).toEqual([]);
  });

  it("does not mutate the input activity array", () => {
    const log: ActivityRecord[] = [runStart({ runId: "r2" }), runStart({ runId: "r1" })];
    const snapshot = log.map((r) => r.runId);
    deriveJobActivity(mkJob(), log);
    expect(log.map((r) => r.runId)).toEqual(snapshot);
  });
});
