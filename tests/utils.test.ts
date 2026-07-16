import { describe, it, expect } from "vitest";
import {
  attentionLabel,
  computeNeedsAttention,
  daysSinceApplied,
  daysUntil,
  deadlineLabel,
  deriveNextAction,
  fmtDate,
  followUpLabel,
  isFollowUpDue,
  isUndraftedDueSoon,
  jobCompletedDate,
  jobRecency,
  undraftedDeadlineText,
} from "../src/lib/utils";
import type { Job, Status } from "../src/types";

// Minimal Job factory: only the fields the tracker's derivations read
// (status/applied/mtime) are interesting; the rest are filled to satisfy the type.
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
    mtime: 0,
    ...over,
  };
}

// Build a YYYY-MM-DD string for today +/- offset days, in LOCAL time (matching how
// daysUntil compares calendar days). Lets the boundary tests stay deterministic.
function ymdLocal(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// An mtime (epoch ms) `days` ago, for the age-based needs-attention fallbacks
// that key off a deadline-less job's folder mtime instead of a deadline date.
function mtimeDaysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

describe("daysUntil", () => {
  it("returns null for empty or invalid input", () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil("not-a-date")).toBeNull();
  });
  it("is negative for a past date", () => {
    expect(daysUntil("2020-01-01")!).toBeLessThan(0);
  });
  it("is large and positive for a far-future date", () => {
    expect(daysUntil("2999-01-01")!).toBeGreaterThan(1000);
  });
  // Boundary: guards the off-by-one where a passed deadline read as "due today".
  it("is 0 today, -1 yesterday, +1 tomorrow (calendar-day accurate)", () => {
    expect(daysUntil(ymdLocal(0))).toBe(0);
    expect(daysUntil(ymdLocal(-1))).toBe(-1);
    expect(daysUntil(ymdLocal(1))).toBe(1);
  });
});

describe("deadlineLabel", () => {
  it("returns null when there is no date", () => {
    expect(deadlineLabel(null)).toBeNull();
  });
  it("marks a past date as muted with 'ago'", () => {
    const info = deadlineLabel("2020-01-01")!;
    expect(info.tone).toBe("muted");
    expect(info.text).toContain("ago");
  });
  it("marks a far-future date as calm with 'left'", () => {
    const info = deadlineLabel("2999-01-01")!;
    expect(info.tone).toBe("calm");
    expect(info.text).toContain("left");
  });
});

describe("fmtDate", () => {
  it("formats a valid date", () => {
    expect(fmtDate("2026-06-23")).toMatch(/2026/);
  });
  it("passes non-dates through", () => {
    expect(fmtDate("1-yr contract")).toBe("1-yr contract");
    expect(fmtDate(null)).toBe("");
  });
});

describe("jobCompletedDate", () => {
  it("returns the applied date for every submitted+ status", () => {
    for (const status of ["submitted", "interview", "offer", "rejected", "closed"] as Status[]) {
      expect(jobCompletedDate(job({ status, applied: "2026-07-01" }))).toBe("2026-07-01");
    }
  });

  it("returns null for a pre-application status even if applied is somehow set", () => {
    for (const status of ["lead", "queued", "drafted"] as Status[]) {
      expect(jobCompletedDate(job({ status, applied: "2026-07-01" }))).toBeNull();
    }
  });

  it("returns null when there is no applied date, whatever the status", () => {
    expect(jobCompletedDate(job({ status: "submitted", applied: null }))).toBeNull();
    expect(jobCompletedDate(job({ status: "offer", applied: null }))).toBeNull();
  });
});

describe("jobRecency", () => {
  it("keys off the applied date (ms epoch) when present", () => {
    expect(jobRecency(job({ status: "submitted", applied: "2026-07-01", mtime: 0 }))).toBe(
      Date.parse("2026-07-01T00:00:00")
    );
  });

  it("falls back to mtime when there is no applied date", () => {
    expect(jobRecency(job({ status: "lead", applied: null, mtime: 12345 }))).toBe(12345);
  });

  it("falls back to mtime when the applied date is unparseable", () => {
    expect(jobRecency(job({ status: "submitted", applied: "not-a-date", mtime: 999 }))).toBe(999);
  });

  it("orders a later application above an earlier one (larger key = more recent)", () => {
    const newer = jobRecency(job({ status: "submitted", applied: "2026-07-03" }));
    const older = jobRecency(job({ status: "submitted", applied: "2026-06-01" }));
    expect(newer).toBeGreaterThan(older);
  });
});

describe("computeNeedsAttention", () => {
  it("puts an active job with a past deadline in overdue only", () => {
    const na = computeNeedsAttention([job({ status: "queued", deadline: ymdLocal(-2) })]);
    expect(na.overdue).toHaveLength(1);
    expect(na.dueSoon).toHaveLength(0);
    expect(na.staleDrafts).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  it("puts an active job due within 3 days in dueSoon", () => {
    const na = computeNeedsAttention([job({ status: "queued", deadline: ymdLocal(2) })]);
    expect(na.dueSoon).toHaveLength(1);
    expect(na.overdue).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  it("puts a drafted job with a 4-7 day deadline in staleDrafts only", () => {
    const na = computeNeedsAttention([job({ status: "drafted", deadline: ymdLocal(5) })]);
    expect(na.staleDrafts).toHaveLength(1);
    expect(na.dueSoon).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  // The bug: a drafted job (drafted is an active status) due within 3 days
  // matched BOTH dueSoon and staleDrafts, so total counted it twice.
  it("counts a drafted, due-soon job exactly ONCE (dueSoon wins over staleDrafts)", () => {
    const na = computeNeedsAttention([job({ id: "dup", status: "drafted", deadline: ymdLocal(1) })]);
    expect(na.dueSoon.map((j) => j.id)).toEqual(["dup"]);
    expect(na.staleDrafts).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  it("keeps the buckets disjoint and total = distinct job count", () => {
    const jobs = [
      job({ id: "a", status: "queued", deadline: ymdLocal(-1) }), // overdue (pre-submission)
      // Was `submitted` w/ a near deadline expecting dueSoon; under the
      // pre-submission refinement a submitted job's deadline is moot, so this
      // now exercises the follow-up clock instead (applied 8d ago -> followUps).
      job({ id: "b", status: "submitted", applied: ymdLocal(-8) }), // followUp
      job({ id: "c", status: "drafted", deadline: ymdLocal(1) }), // drafted + due-soon -> dueSoon only
      job({ id: "d", status: "drafted", deadline: ymdLocal(6) }), // staleDraft
      job({ id: "e", status: "lead", deadline: ymdLocal(30) }), // nothing urgent
    ];
    const na = computeNeedsAttention(jobs);
    const ids = [...na.overdue, ...na.dueSoon, ...na.followUps, ...na.staleDrafts].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // no job in two buckets
    expect(na.total).toBe(ids.length);
    expect(na.total).toBe(4);
  });

  it("ignores archived (rejected/closed) jobs even with a past deadline", () => {
    const jobs = [
      job({ status: "rejected", deadline: ymdLocal(-3) }),
      job({ status: "closed", deadline: ymdLocal(1) }),
    ];
    expect(computeNeedsAttention(jobs).total).toBe(0);
  });

  // --- Deadline-less age fallbacks (t-1783183576517) -----------------------
  // A job with no deadline could never land in any bucket before this fix
  // (every check gated on daysUntil !== null), so it could sit forever without
  // ever surfacing as needing attention. These fallbacks key off folder mtime.

  it("leaves a deadline-less drafted job under the stale-age threshold out of every bucket", () => {
    const na = computeNeedsAttention([job({ status: "drafted", deadline: null, mtime: mtimeDaysAgo(3) })]);
    expect(na.staleDrafts).toHaveLength(0);
    expect(na.total).toBe(0);
  });

  it("puts a deadline-less drafted job past the stale-age threshold in staleDrafts exactly once", () => {
    const na = computeNeedsAttention([job({ id: "d1", status: "drafted", deadline: null, mtime: mtimeDaysAgo(10) })]);
    expect(na.staleDrafts.map((j) => j.id)).toEqual(["d1"]);
    expect(na.staleLeads).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  it("puts deadline-less lead/queued jobs past the stale-age threshold in staleLeads exactly once, but not a younger one", () => {
    const jobs = [
      job({ id: "q1", status: "queued", deadline: null, mtime: mtimeDaysAgo(10) }),
      job({ id: "l1", status: "lead", deadline: null, mtime: mtimeDaysAgo(10) }),
      job({ id: "q2", status: "queued", deadline: null, mtime: mtimeDaysAgo(3) }), // too young: excluded
    ];
    const na = computeNeedsAttention(jobs);
    expect(na.staleLeads.map((j) => j.id).sort()).toEqual(["l1", "q1"]);
    expect(na.staleDrafts).toHaveLength(0);
    expect(na.total).toBe(2);
  });

  it("keeps all five buckets disjoint when dated and age-based jobs are mixed, total = distinct count", () => {
    const jobs = [
      job({ id: "a", status: "queued", deadline: ymdLocal(-1) }), // overdue (dated, pre-submission)
      // Was `submitted` w/ a near deadline expecting dueSoon; a submitted job's
      // deadline is now moot, so it exercises the follow-up bucket instead.
      job({ id: "b", status: "submitted", applied: ymdLocal(-8) }), // followUp (applied 8d ago)
      job({ id: "c", status: "drafted", deadline: ymdLocal(1) }), // drafted + due-soon -> dueSoon only
      job({ id: "d", status: "drafted", deadline: ymdLocal(6) }), // staleDraft (dated)
      job({ id: "e", status: "lead", deadline: ymdLocal(30) }), // nothing urgent
      job({ id: "f", status: "drafted", deadline: null, mtime: mtimeDaysAgo(10) }), // staleDraft (age)
      job({ id: "g", status: "queued", deadline: null, mtime: mtimeDaysAgo(10) }), // staleLead (age)
      job({ id: "h", status: "lead", deadline: null, mtime: mtimeDaysAgo(2) }), // too young: nothing
    ];
    const na = computeNeedsAttention(jobs);
    const ids = [...na.overdue, ...na.dueSoon, ...na.followUps, ...na.staleDrafts, ...na.staleLeads].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // no job in two buckets
    expect(na.total).toBe(ids.length);
    expect(na.total).toBe(6);
  });

  // --- Follow-up bucket + pre-submission deadline refinement ----------------
  // The submitted-job "applied N days ago, heard nothing, follow up" signal, and
  // the paired refinement that a submitted job's application deadline no longer
  // counts as Overdue (you already applied - the follow-up clock takes over).

  it("(a) puts a submitted job applied 7d+ ago in followUps, NOT overdue, even with a past deadline", () => {
    const na = computeNeedsAttention([
      job({ id: "s", status: "submitted", applied: ymdLocal(-8), deadline: ymdLocal(-3) }),
    ]);
    expect(na.followUps.map((j) => j.id)).toEqual(["s"]);
    expect(na.overdue).toHaveLength(0);
    expect(na.dueSoon).toHaveLength(0);
    expect(na.total).toBe(1);
  });

  it("(a-boundary) is due exactly at FOLLOWUP_DUE_DAYS (applied 7d ago), not at 6d", () => {
    expect(computeNeedsAttention([job({ status: "submitted", applied: ymdLocal(-7) })]).followUps).toHaveLength(1);
    expect(computeNeedsAttention([job({ status: "submitted", applied: ymdLocal(-6) })]).followUps).toHaveLength(0);
  });

  it("(b) leaves a submitted job applied <7d ago in NO bucket", () => {
    const na = computeNeedsAttention([job({ status: "submitted", applied: ymdLocal(-3) })]);
    expect(na.followUps).toHaveLength(0);
    expect(na.overdue).toHaveLength(0);
    expect(na.dueSoon).toHaveLength(0);
    expect(na.total).toBe(0);
  });

  it("(b-no-date) leaves a submitted job with no applied date in NO bucket", () => {
    const na = computeNeedsAttention([job({ status: "submitted", applied: null, deadline: ymdLocal(-5) })]);
    expect(na.total).toBe(0);
  });

  it("(c) no longer puts a submitted job with a past deadline in overdue (pre-submission refinement)", () => {
    // Same job that pre-refinement WOULD have been overdue (active + past
    // deadline). No applied date, so it does not fall into followUps either -
    // it correctly surfaces in nothing, because its deadline is moot once sent.
    const na = computeNeedsAttention([job({ status: "submitted", deadline: ymdLocal(-2), applied: null })]);
    expect(na.overdue).toHaveLength(0);
    expect(na.total).toBe(0);
  });

  it("(d) still puts a lead / queued / drafted job with a past deadline in overdue", () => {
    for (const status of ["lead", "queued", "drafted"] as Status[]) {
      const na = computeNeedsAttention([job({ id: status, status, deadline: ymdLocal(-2) })]);
      expect(na.overdue.map((j) => j.id), status).toEqual([status]);
      expect(na.total).toBe(1);
    }
  });

  it("(e) followUps counts toward total, disjoint from every other bucket", () => {
    const jobs = [
      job({ id: "over", status: "drafted", deadline: ymdLocal(-1) }), // overdue (pre-submission)
      job({ id: "soon", status: "queued", deadline: ymdLocal(2) }), // dueSoon
      job({ id: "fu1", status: "submitted", applied: ymdLocal(-9) }), // followUp
      job({ id: "fu2", status: "submitted", applied: ymdLocal(-30), deadline: ymdLocal(-20) }), // followUp (past deadline ignored)
      job({ id: "sd", status: "drafted", deadline: null, mtime: mtimeDaysAgo(10) }), // staleDraft (age)
      job({ id: "sl", status: "lead", deadline: null, mtime: mtimeDaysAgo(10) }), // staleLead (age)
    ];
    const na = computeNeedsAttention(jobs);
    expect(na.followUps.map((j) => j.id).sort()).toEqual(["fu1", "fu2"]);
    const ids = [...na.overdue, ...na.dueSoon, ...na.followUps, ...na.staleDrafts, ...na.staleLeads].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // exactly one bucket per job
    expect(na.total).toBe(ids.length);
    expect(na.total).toBe(6);
  });

  it("stops the follow-up clock once the job advances past submitted (interview/offer)", () => {
    for (const status of ["interview", "offer"] as Status[]) {
      const na = computeNeedsAttention([job({ status, applied: ymdLocal(-30) })]);
      expect(na.followUps).toHaveLength(0);
      expect(na.total).toBe(0);
    }
  });
});

// --- "Due, not drafted" marker (t-1783183576640, ops audit F6) --------------
// A queued job with no CV is on a collision course with the deadline
// auto-close sweep (server/lib.js shouldAutoClose / tests/auto-close.test.js):
// once its deadline passes while still queued, the sweep silently closes it
// un-drafted. isUndraftedDueSoon/undraftedDeadlineText/attentionLabel are the
// pure logic behind the needs-attention marker + inline batch-draft CTA that
// flag that window while it is still open.
describe("isUndraftedDueSoon", () => {
  it("flags a queued job with no CV due within the 0-3 day horizon", () => {
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: ymdLocal(0) }))).toBe(true);
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: ymdLocal(2) }))).toBe(true);
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: ymdLocal(3) }))).toBe(true);
  });

  it("is false once the job already has a CV on disk", () => {
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: true, deadline: ymdLocal(1) }))).toBe(false);
  });

  it("is false for any status other than queued", () => {
    for (const status of ["lead", "drafted", "submitted", "interview"] as Status[]) {
      expect(isUndraftedDueSoon(job({ status, hasCV: false, deadline: ymdLocal(1) }))).toBe(false);
    }
  });

  it("is false outside the due-soon horizon (already overdue, or further out)", () => {
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: ymdLocal(-1) }))).toBe(false);
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: ymdLocal(4) }))).toBe(false);
  });

  it("is false when the job carries no deadline at all", () => {
    expect(isUndraftedDueSoon(job({ status: "queued", hasCV: false, deadline: null }))).toBe(false);
  });
});

describe("undraftedDeadlineText", () => {
  it("renders due-today / due-tomorrow / due-Nd, always tagged 'not drafted'", () => {
    expect(undraftedDeadlineText(ymdLocal(0))).toEqual({ text: "due today - not drafted", tone: "urgent" });
    expect(undraftedDeadlineText(ymdLocal(1))).toEqual({ text: "due tomorrow - not drafted", tone: "urgent" });
    expect(undraftedDeadlineText(ymdLocal(2))).toEqual({ text: "due 2d - not drafted", tone: "urgent" });
  });
});

describe("attentionLabel", () => {
  it("prefers the undrafted marker over the plain deadline countdown", () => {
    const j = job({ status: "queued", hasCV: false, deadline: ymdLocal(2) });
    expect(attentionLabel(j)).toEqual({ text: "due 2d - not drafted", tone: "urgent" });
  });

  it("falls back to the plain deadline countdown once the job has a CV", () => {
    const j = job({ status: "queued", hasCV: true, deadline: ymdLocal(2) });
    expect(attentionLabel(j)).toEqual(deadlineLabel(ymdLocal(2)));
  });

  it("falls back to the age label for a deadline-less stale lead/queued job", () => {
    const j = job({ status: "queued", hasCV: false, deadline: null, mtime: mtimeDaysAgo(10) });
    expect(attentionLabel(j).text).toContain("no deadline");
  });

  it("prefers the follow-up label for a submitted, applied-7d+ job over its (moot) deadline", () => {
    const j = job({ status: "submitted", applied: ymdLocal(-8), deadline: ymdLocal(-3) });
    expect(attentionLabel(j)).toEqual({ text: "applied 8d ago - follow up", tone: "urgent" });
  });
});

// --- Follow-up clock helpers (submitted, awaiting reply) --------------------
describe("daysSinceApplied", () => {
  it("returns null when there is no applied date or it is unparseable", () => {
    expect(daysSinceApplied(job({ status: "submitted", applied: null }))).toBeNull();
    expect(daysSinceApplied(job({ status: "submitted", applied: "not-a-date" }))).toBeNull();
  });

  it("is 0 today, 1 yesterday, 8 for eight days ago (calendar-day accurate at local midnight)", () => {
    expect(daysSinceApplied(job({ status: "submitted", applied: ymdLocal(0) }))).toBe(0);
    expect(daysSinceApplied(job({ status: "submitted", applied: ymdLocal(-1) }))).toBe(1);
    expect(daysSinceApplied(job({ status: "submitted", applied: ymdLocal(-8) }))).toBe(8);
  });

  it("tolerates a datetime-suffixed applied value (slices to the date)", () => {
    expect(daysSinceApplied(job({ status: "submitted", applied: ymdLocal(-3) + "T12:34:00" }))).toBe(3);
  });
});

describe("isFollowUpDue", () => {
  it("is true for a submitted job applied FOLLOWUP_DUE_DAYS (7) or more days ago", () => {
    expect(isFollowUpDue(job({ status: "submitted", applied: ymdLocal(-7) }))).toBe(true);
    expect(isFollowUpDue(job({ status: "submitted", applied: ymdLocal(-30) }))).toBe(true);
  });

  it("is false for a submitted job applied fewer than 7 days ago", () => {
    expect(isFollowUpDue(job({ status: "submitted", applied: ymdLocal(-6) }))).toBe(false);
    expect(isFollowUpDue(job({ status: "submitted", applied: ymdLocal(0) }))).toBe(false);
  });

  it("is false for a submitted job with no applied date", () => {
    expect(isFollowUpDue(job({ status: "submitted", applied: null }))).toBe(false);
  });

  it("is false for any status other than submitted, however old the applied date", () => {
    for (const status of ["lead", "queued", "drafted", "interview", "offer", "rejected", "closed"] as Status[]) {
      expect(isFollowUpDue(job({ status, applied: ymdLocal(-30) })), status).toBe(false);
    }
  });
});

describe("followUpLabel", () => {
  it("reads 'applied Nd ago - follow up' with an urgent tone", () => {
    expect(followUpLabel(job({ status: "submitted", applied: ymdLocal(-8) }))).toEqual({
      text: "applied 8d ago - follow up",
      tone: "urgent",
    });
  });
});

// --- Derived next-action suggestion (US-3, t-1783318991874) ------------------
// The DISPLAY-ONLY "what do I do next" hint used only when a job carries no
// user-authored next_action. Pure, writes nothing. One assertion per status
// branch, plus the drafted gaps split and the submitted follow-up boundary, plus
// terminal -> null.
describe("deriveNextAction", () => {
  it("suggests Triage for a lead", () => {
    expect(deriveNextAction(job({ status: "lead" }))).toBe("Triage");
  });

  it("suggests Draft CV + cover for a queued job", () => {
    expect(deriveNextAction(job({ status: "queued" }))).toBe("Draft CV + cover");
  });

  it("suggests Finalize for a drafted job whose gaps are answered (finalizeReady)", () => {
    expect(deriveNextAction(job({ status: "drafted", finalizeReady: true }))).toBe("Finalize");
  });

  it("suggests Answer gaps for a drafted job that is not finalize-ready (gaps open, or no CV yet)", () => {
    expect(deriveNextAction(job({ status: "drafted", finalizeReady: false }))).toBe("Answer gaps");
    // A drafted job with a CV but gaps still open is likewise not finalizeReady.
    expect(deriveNextAction(job({ status: "drafted", hasCV: true, finalizeReady: false }))).toBe("Answer gaps");
  });

  it("suggests Submit application for a finalized (ready) job", () => {
    expect(deriveNextAction(job({ status: "ready" }))).toBe("Submit application");
  });

  it("suggests Follow up for a submitted job past the follow-up clock (applied 7d+ ago)", () => {
    expect(deriveNextAction(job({ status: "submitted", applied: ymdLocal(-7) }))).toBe("Follow up");
    expect(deriveNextAction(job({ status: "submitted", applied: ymdLocal(-30) }))).toBe("Follow up");
  });

  it("suggests Await response for a submitted job not yet follow-up-due (boundary: 6d, 0d, no date)", () => {
    expect(deriveNextAction(job({ status: "submitted", applied: ymdLocal(-6) }))).toBe("Await response");
    expect(deriveNextAction(job({ status: "submitted", applied: ymdLocal(0) }))).toBe("Await response");
    expect(deriveNextAction(job({ status: "submitted", applied: null }))).toBe("Await response");
  });

  // The submitted branch must agree with the Follow-up needs-attention bucket:
  // the SAME job that isFollowUpDue flags true is exactly the one that suggests
  // "Follow up", and vice-versa, right across the 7-day boundary.
  it("agrees with isFollowUpDue across the follow-up boundary", () => {
    const due = job({ status: "submitted", applied: ymdLocal(-7) });
    const notDue = job({ status: "submitted", applied: ymdLocal(-6) });
    expect(isFollowUpDue(due)).toBe(true);
    expect(deriveNextAction(due)).toBe("Follow up");
    expect(isFollowUpDue(notDue)).toBe(false);
    expect(deriveNextAction(notDue)).toBe("Await response");
  });

  it("suggests Prep (STAR) for an interview", () => {
    expect(deriveNextAction(job({ status: "interview" }))).toBe("Prep (STAR)");
  });

  it("suggests Evaluate / negotiate for an offer", () => {
    expect(deriveNextAction(job({ status: "offer" }))).toBe("Evaluate / negotiate");
  });

  it("returns null for terminal statuses (rejected / closed) - no suggestion", () => {
    expect(deriveNextAction(job({ status: "rejected" }))).toBeNull();
    expect(deriveNextAction(job({ status: "closed" }))).toBeNull();
  });

  // Every status resolves to either a non-empty string or null - never "" or
  // undefined - so the caller's `suggestion ? ... : "-"` branch is well-defined.
  it("returns a non-empty string or null for every status, never undefined/empty", () => {
    const statuses: Status[] = [
      "lead",
      "queued",
      "drafted",
      "submitted",
      "interview",
      "offer",
      "rejected",
      "closed",
    ];
    for (const status of statuses) {
      const out = deriveNextAction(job({ status }));
      expect(out === null || (typeof out === "string" && out.length > 0), status).toBe(true);
    }
  });
});
