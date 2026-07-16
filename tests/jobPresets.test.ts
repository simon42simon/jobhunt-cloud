import { describe, it, expect } from "vitest";
import { PRESETS, filterByPreset, presetCounts } from "../src/lib/jobPresets";
import { computeNeedsAttention } from "../src/lib/utils";
import type { Job, Status } from "../src/types";

// Minimal Job factory (same shape as tests/utils.test.ts + tests/jobFilter.test.ts):
// only the fields the presets read (status / deadline / applied / finalizeReady /
// mtime) are interesting; the rest are filled to satisfy the type. Override per case.
function job(over: Partial<Job> & { status: Status }): Job {
  return {
    id: "j",
    folder: "j",
    folderPath: "/j",
    jobFile: "/j/j.md",
    jobFileName: "j.md",
    role: "Role",
    employer: "Employer",
    track: "t",
    trackLabel: "T",
    fit: "strong",
    rawStatus: over.status,
    sector: "",
    tailoring: "",
    deadline: null,
    applied: null,
    link: "",
    nextAction: "",
    nextActionDate: null,
    tags: [],
    leadWith: "",
    files: [],
    hasCV: false,
    hasCoverLetter: false,
    gapsAnswered: false,
    finalizeReady: false,
    draftDone: false,
    finalizeDone: false,
    interviewPrepDone: false,
    offerPrepDone: false,
    followUpDone: false,
    mtime: 0,
    ...over,
  };
}

// Build a YYYY-MM-DD string for today +/- offset days, in LOCAL time (matching how
// daysUntil / daysSinceApplied compare calendar days). Relative-to-today so the
// deadline/follow-up boundary tests never drift as the calendar advances.
function ymdLocal(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ids = (jobs: Job[]) => jobs.map((j) => j.id).sort();

describe("PRESETS", () => {
  it("lists the seven quick views in the documented order", () => {
    expect(PRESETS.map((p) => p.key)).toEqual([
      "all",
      "attention",
      "overdue",
      "due-soon",
      "ready",
      "follow-up",
      "interview",
    ]);
  });
});

describe("filterByPreset", () => {
  it("'all' returns every job unchanged", () => {
    const jobs = [
      job({ id: "a", status: "lead" }),
      job({ id: "b", status: "submitted" }),
      job({ id: "c", status: "closed" }),
    ];
    expect(ids(filterByPreset("all", jobs))).toEqual(["a", "b", "c"]);
  });

  it("puts a pre-submission job with a past deadline in 'overdue' (and 'attention')", () => {
    const overdue = job({ id: "od", status: "queued", deadline: ymdLocal(-2) });
    const calm = job({ id: "calm", status: "lead", deadline: ymdLocal(30) });
    const jobs = [overdue, calm];
    expect(ids(filterByPreset("overdue", jobs))).toEqual(["od"]);
    // The same job is part of the attention union.
    expect(filterByPreset("attention", jobs).map((j) => j.id)).toContain("od");
    expect(filterByPreset("attention", jobs).map((j) => j.id)).not.toContain("calm");
  });

  it("puts a pre-submission job due within 3 days in 'due-soon'", () => {
    const soon = job({ id: "soon", status: "queued", deadline: ymdLocal(2) });
    const later = job({ id: "later", status: "queued", deadline: ymdLocal(10) });
    const jobs = [soon, later];
    expect(ids(filterByPreset("due-soon", jobs))).toEqual(["soon"]);
    expect(filterByPreset("attention", jobs).map((j) => j.id)).toContain("soon");
  });

  it("puts a `ready` (finalized) job in 'ready', not a drafted-but-finalizeReady one", () => {
    const ready = job({ id: "r", status: "ready" });
    // A drafted job whose gaps are answered is "ready to FINALIZE", not "ready to
    // submit" - it belongs to the finalize batch, not this preset.
    const finalizeReady = job({ id: "fr", status: "drafted", finalizeReady: true });
    const draft = job({ id: "d", status: "drafted", finalizeReady: false });
    const jobs = [ready, finalizeReady, draft];
    expect(ids(filterByPreset("ready", jobs))).toEqual(["r"]);
  });

  it("puts a submitted job past the follow-up window in 'follow-up' (not a fresh one)", () => {
    const due = job({ id: "due", status: "submitted", applied: ymdLocal(-8) });
    const fresh = job({ id: "fresh", status: "submitted", applied: ymdLocal(-2) });
    const jobs = [due, fresh];
    expect(ids(filterByPreset("follow-up", jobs))).toEqual(["due"]);
    // Reconciles with the NeedsAttentionStrip's Follow up bucket.
    expect(ids(filterByPreset("follow-up", jobs))).toEqual(ids(computeNeedsAttention(jobs).followUps));
  });

  it("puts a status==='interview' job in 'interview'", () => {
    const iv = job({ id: "iv", status: "interview" });
    const jobs = [iv, job({ id: "x", status: "offer" })];
    expect(ids(filterByPreset("interview", jobs))).toEqual(["iv"]);
  });

  it("returns all jobs for an unknown key (safe default)", () => {
    const jobs = [job({ id: "a", status: "lead" }), job({ id: "b", status: "offer" })];
    expect(ids(filterByPreset("does-not-exist", jobs))).toEqual(["a", "b"]);
    expect(ids(filterByPreset("", jobs))).toEqual(["a", "b"]);
  });

  it("'attention' is the deduped union of the attention buckets, disjoint from calm jobs", () => {
    const jobs = [
      job({ id: "over", status: "queued", deadline: ymdLocal(-1) }), // overdue
      job({ id: "soon", status: "drafted", deadline: ymdLocal(1) }), // dueSoon
      job({ id: "fu", status: "submitted", applied: ymdLocal(-9) }), // followUp
      job({ id: "sd", status: "drafted", deadline: null, mtime: Date.now() - 10 * 86_400_000 }), // staleDraft (age)
      job({ id: "sl", status: "lead", deadline: null, mtime: Date.now() - 10 * 86_400_000 }), // staleLead (age)
      job({ id: "calm", status: "lead", deadline: ymdLocal(30) }), // nothing urgent
    ];
    const union = filterByPreset("attention", jobs);
    expect(ids(union)).toEqual(["fu", "over", "sd", "sl", "soon"]);
    // Deduped: no job appears twice.
    expect(new Set(union.map((j) => j.id)).size).toBe(union.length);
    // Equals the strip's total (buckets are disjoint, so union size === total).
    expect(union.length).toBe(computeNeedsAttention(jobs).total);
  });
});

describe("presetCounts", () => {
  it("'all' equals the total job count", () => {
    const jobs = [
      job({ id: "a", status: "lead" }),
      job({ id: "b", status: "submitted", applied: ymdLocal(-9) }),
      job({ id: "c", status: "interview" }),
    ];
    expect(presetCounts(jobs).all).toBe(jobs.length);
  });

  it("counts each preset, reconciling with the NeedsAttentionStrip buckets", () => {
    const jobs = [
      job({ id: "over", status: "queued", deadline: ymdLocal(-1) }), // overdue
      job({ id: "soon", status: "queued", deadline: ymdLocal(2) }), // dueSoon
      job({ id: "ready", status: "ready" }), // ready (finalized, awaiting submit)
      job({ id: "fu", status: "submitted", applied: ymdLocal(-9) }), // followUp
      job({ id: "iv", status: "interview" }), // interview
      job({ id: "calm", status: "lead", deadline: ymdLocal(40) }), // nothing
    ];
    const counts = presetCounts(jobs);
    const na = computeNeedsAttention(jobs);
    expect(counts.all).toBe(6);
    expect(counts.overdue).toBe(na.overdue.length);
    expect(counts["due-soon"]).toBe(na.dueSoon.length);
    expect(counts["follow-up"]).toBe(na.followUps.length);
    expect(counts.overdue).toBe(1);
    expect(counts["due-soon"]).toBe(1);
    expect(counts.ready).toBe(1);
    expect(counts["follow-up"]).toBe(1);
    expect(counts.interview).toBe(1);
    expect(counts.attention).toBe(na.total);
  });

  it("agrees with filterByPreset for every preset key", () => {
    const jobs = [
      job({ id: "over", status: "drafted", deadline: ymdLocal(-3) }),
      job({ id: "soon", status: "lead", deadline: ymdLocal(1) }),
      job({ id: "ready", status: "ready" }),
      job({ id: "fu", status: "submitted", applied: ymdLocal(-14) }),
      job({ id: "iv", status: "interview" }),
      job({ id: "closed", status: "closed" }),
    ];
    const counts = presetCounts(jobs);
    for (const preset of PRESETS) {
      expect(counts[preset.key], preset.key).toBe(filterByPreset(preset.key, jobs).length);
    }
  });

  it("returns zeroed counts (all === 0) for an empty job list", () => {
    const counts = presetCounts([]);
    for (const preset of PRESETS) {
      expect(counts[preset.key], preset.key).toBe(0);
    }
  });
});
