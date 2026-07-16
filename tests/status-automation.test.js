import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextStatusAfterRun, DRAFT_ROUTINE, FINALIZE_ROUTINE } from "../server/lib.js";

// t-1783390854845 (ADR-022), extended by t-1783481509014: the run-completion status
// automation. TWO safe, automatic advances, each gated on a SUCCESSFUL run of its
// routine on a job whose materials exist (draftDone):
//   - lead|queued -> drafted  after first-draft-job (the draft now exists)
//   - drafted     -> ready    after finalize-job    (finalized, ready to submit)
// Pure rule, so the "automation status trigger point" is provable without spawning
// a real claude agent.

const job = (over = {}) => ({ status: "queued", draftDone: true, ...over });

describe("nextStatusAfterRun (run-completion status automation)", () => {
  it("advances a queued job to drafted after a SUCCESSFUL first draft with real artifacts", () => {
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, job())).toBe("drafted");
    expect(DRAFT_ROUTINE).toBe("first-draft-job");
  });

  it("advances a LEAD job to drafted too (first-draft is a supported action on a lead job)", () => {
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, job({ status: "lead" }))).toBe("drafted");
  });

  it("does NOT advance on a failed run (exit != 0) - a run exiting is not the work succeeding", () => {
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 1, job())).toBeNull();
    expect(nextStatusAfterRun(DRAFT_ROUTINE, null, job())).toBeNull();
  });

  it("does NOT advance without real draft artifacts (draftDone false) - evidence-backed only", () => {
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, job({ draftDone: false }))).toBeNull();
  });

  it("first-draft fires ONLY from `lead`/`queued` (idempotent, never fights a Regenerate or the agent)", () => {
    // The post-draft statuses must NOT re-advance - a Regenerate on an already-drafted
    // (or later) job leaves its status exactly where it is.
    for (const status of ["drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"]) {
      expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, job({ status })), status).toBeNull();
    }
  });

  it("advances a drafted job to ready after a SUCCESSFUL finalize with materials present", () => {
    expect(nextStatusAfterRun(FINALIZE_ROUTINE, 0, job({ status: "drafted", draftDone: true }))).toBe("ready");
    expect(FINALIZE_ROUTINE).toBe("finalize-job");
  });

  it("does NOT advance finalize on a failed run, or without draft materials", () => {
    expect(nextStatusAfterRun(FINALIZE_ROUTINE, 1, job({ status: "drafted" }))).toBeNull();
    expect(nextStatusAfterRun(FINALIZE_ROUTINE, null, job({ status: "drafted" }))).toBeNull();
    expect(nextStatusAfterRun(FINALIZE_ROUTINE, 0, job({ status: "drafted", draftDone: false }))).toBeNull();
  });

  it("finalize only fires from `drafted` (idempotent - never re-fires on a ready/submitted Regenerate)", () => {
    for (const status of ["lead", "queued", "ready", "submitted", "interview", "offer", "rejected", "closed"]) {
      expect(nextStatusAfterRun(FINALIZE_ROUTINE, 0, job({ status, draftDone: true })), status).toBeNull();
    }
  });

  it("ignores unrelated routines and a missing job", () => {
    expect(nextStatusAfterRun("interview-prep", 0, job())).toBeNull();
    expect(nextStatusAfterRun("draft-follow-up", 0, job())).toBeNull();
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, null)).toBeNull();
    expect(nextStatusAfterRun(DRAFT_ROUTINE, 0, undefined)).toBeNull();
  });

  it("never crosses the submit boundary (every returned status is pre-submission)", () => {
    // The only values this can ever return are "drafted" and "ready" - both proven
    // exhaustively above - and both are strictly before "submitted" in the
    // lifecycle. This pins the never-auto-submit contract at the automation seam.
    const results = [
      nextStatusAfterRun(DRAFT_ROUTINE, 0, job()),
      nextStatusAfterRun(FINALIZE_ROUTINE, 0, job({ status: "drafted", draftDone: true })),
    ];
    expect(results.filter(Boolean)).toEqual(["drafted", "ready"]);
  });
});

// Wiring contract: the pure rule is actually applied on run close, and only for
// scope:"job" runs, via a surgical updateFrontmatter write (the same write the
// deadline auto-close uses). The part that fails if the trigger is disconnected.
describe("run-close applies the automation (source contract)", () => {
  const src = readFileSync(fileURLToPath(new URL("../server/index.js", import.meta.url)), "utf8");

  it("the close handler advances a scope:\"job\" run through maybeAutoAdvanceJob", () => {
    expect(src).toMatch(/if \(def\.scope === "job" && run\.jobId\) maybeAutoAdvanceJob\(routine, code, run\.jobId\)/);
  });

  it("maybeAutoAdvanceJob re-derives the job and writes the pure rule's result surgically", () => {
    const fn = src.slice(src.indexOf("function maybeAutoAdvanceJob"), src.indexOf("function startRun"));
    // Post storage-seam (ADR-025): the job is re-derived and the surgical write
    // both go through the store (FileStore -> the same updateFrontmatter path).
    expect(fn).toContain("const job = store.getJobSummary(folder)");
    expect(fn).toContain("nextStatusAfterRun(routine, exitCode, job)");
    expect(fn).toContain("store.updateJobFields(folder, { status: next })");
    // Best-effort: a failure must never destabilize run close.
    expect(fn).toMatch(/try \{[\s\S]*\} catch \{[\s\S]*\}/);
  });
});
