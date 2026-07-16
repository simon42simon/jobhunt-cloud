// Small date helpers. Deadlines/applied dates are plain YYYY-MM-DD strings.

import type { Job, Status } from "../types";
import { PRE_SUBMISSION_ACTIVE } from "./constants";

// Statuses at/after application submission - the point a job counts as
// "completed" for the Job Tracker's Completed column. Pre-application states
// (lead/queued/drafted) are deliberately excluded: they have no completion.
const COMPLETED_STATUSES: Status[] = ["submitted", "interview", "offer", "rejected", "closed"];

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  // Deadlines are date-only. Compare CALENDAR days at local midnight so that a
  // deadline reads as overdue on the very next day (a June 29 deadline is "closed
  // 1d ago" on June 30, not "due today"). The old end-of-day-minus-now + ceil was
  // off by one and reported every deadline a day late.
  const parts = dateStr.slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, mo, day] = parts;
  const deadline = new Date(y, mo - 1, day);
  if (isNaN(deadline.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((deadline.getTime() - today.getTime()) / 86_400_000);
}

export function deadlineLabel(dateStr: string | null): { text: string; tone: string } | null {
  const days = daysUntil(dateStr);
  if (days === null) return null;
  if (days < 0) return { text: `closed ${Math.abs(days)}d ago`, tone: "muted" };
  if (days === 0) return { text: "due today", tone: "urgent" };
  if (days === 1) return { text: "due tomorrow", tone: "urgent" };
  if (days <= 3) return { text: `${days}d left`, tone: "urgent" };
  if (days <= 7) return { text: `${days}d left`, tone: "soon" };
  return { text: `${days}d left`, tone: "calm" };
}

export function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// A job's completion date for the tracker (DERIVED, no stored field): its applied
// date, but ONLY once it has actually been submitted (a submitted+ status). A
// pre-application job, or one that carries no applied date, has no completion -
// returns null so the UI shows a blank rather than inventing a date.
export function jobCompletedDate(job: Job): string | null {
  return job.applied && COMPLETED_STATUSES.includes(job.status) ? job.applied : null;
}

// Newest-first sort key for the tracker's default "Recent" view: the applied date
// (parsed to a ms epoch) when present, else the folder mtime. Sorting DESCENDING
// on this value floats the most recently applied / touched jobs to the top.
export function jobRecency(job: Job): number {
  if (job.applied) {
    const t = Date.parse(job.applied + "T00:00:00");
    if (!Number.isNaN(t)) return t;
  }
  return job.mtime;
}

// --- Needs-attention signal --------------------------------------------------
// The highest-value "what do I act on today" computation, shared between the
// Insights panel and the strip at the top of the Board so the two can never
// diverge. Active jobs with a past deadline are overdue; active jobs due within
// 3 days are due-soon; drafted jobs with a deadline within a week are stale
// drafts that still need finalizing.
//
// A job with NO deadline could never land in any bucket (every check gated on
// `daysUntil(j.deadline) !== null`), so a drafted or lead/queued job could sit
// untouched forever and never surface here. Two age-based fallbacks close that
// gap, keyed off the folder's mtime rather than a deadline: a deadline-less
// drafted job stales out after a week (staleDrafts, same bucket as the dated
// case), and a deadline-less lead/queued job gets its own staleLeads bucket.

const STALE_AGE_DAYS = 7;

// Whole days since a job's folder was last touched (its mtime). Used as the
// staleness clock for jobs that carry no deadline to count down from.
export function jobAgeDays(job: Job): number {
  return Math.floor((Date.now() - job.mtime) / 86_400_000);
}

// The deadline-less counterpart to deadlineLabel: always returns a label (never
// null) so a caller can do `deadlineLabel(job.deadline) ?? ageAttentionLabel(job)`
// and always have something to render for a needs-attention job.
export function ageAttentionLabel(job: Job): { text: string; tone: string } {
  return { text: `${job.status} ${jobAgeDays(job)}d - no deadline`, tone: "muted" };
}

// --- Follow-up clock (submitted, awaiting a reply) ---------------------------
// The gap the deadline/mtime buckets miss entirely: a job you SUBMITTED and
// have heard nothing back on. Its application deadline is moot (you applied),
// and its folder mtime moved when you submitted, so neither the dated buckets
// nor the staleness fallbacks ever resurface it. This is a purely DERIVED
// signal off the `applied` date + submitted status - no new frontmatter, no
// server change. A submitted job crosses into "follow up" once it has sat
// FOLLOWUP_DUE_DAYS whole calendar days since application with no status move.
export const FOLLOWUP_DUE_DAYS = 7;

// Whole calendar days since a job's `applied` date, at LOCAL midnight (the same
// midnight discipline as daysUntil, so "applied yesterday" reads as 1, not 0).
// Returns null when there is no applied date or it is unparseable - the caller
// then treats the job as not-yet-on-the-follow-up-clock rather than day 0.
export function daysSinceApplied(job: Job): number | null {
  if (!job.applied) return null;
  const parts = job.applied.slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, mo, day] = parts;
  const applied = new Date(y, mo - 1, day);
  if (isNaN(applied.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - applied.getTime()) / 86_400_000);
}

// A submitted job that has gone FOLLOWUP_DUE_DAYS+ days since application with
// no status change - the "you applied, chase it" signal. Deliberately gated on
// the submitted status ALONE: once it advances to interview/offer (or is
// rejected/closed) the clock stops, and pre-submission statuses never start it.
export function isFollowUpDue(job: Job): boolean {
  if (job.status !== "submitted") return false;
  const n = daysSinceApplied(job);
  return n !== null && n >= FOLLOWUP_DUE_DAYS;
}

// The shared label for a follow-up-due job, mirroring deadlineLabel/
// undraftedDeadlineText so every render site (Board strip + Insights) reads
// identically. "urgent" tone: a stalled application is a real, actionable lag.
export function followUpLabel(job: Job): { text: string; tone: string } {
  const n = daysSinceApplied(job) ?? FOLLOWUP_DUE_DAYS;
  return { text: `applied ${n}d ago - follow up`, tone: "urgent" };
}

export interface NeedsAttention {
  overdue: Job[];
  dueSoon: Job[];
  followUps: Job[];
  staleDrafts: Job[];
  staleLeads: Job[];
  total: number;
}

export function computeNeedsAttention(jobs: Job[]): NeedsAttention {
  // Deadline buckets consider only PRE-SUBMISSION active jobs (lead/queued/
  // drafted). A submitted job's application deadline is moot - you already
  // applied - so a passed deadline there is NOT "Overdue"; the follow-up clock
  // below is what matters once submitted (followUps). This also keeps the
  // deadline buckets and followUps status-disjoint, so nothing double-counts.
  const preSubmission = jobs.filter((j) => PRE_SUBMISSION_ACTIVE.includes(j.status));
  // Each job lands in at MOST ONE bucket, by urgency precedence
  // (overdue > due-soon > follow-up > stale-draft > stale-lead). Without this a
  // drafted job due within 3 days matched BOTH due-soon (drafted is an active
  // status) and stale-draft, so the strip rendered it twice and `total`
  // double-counted it. `claim` records a job's id the moment it is placed, and
  // every later bucket skips a claimed job. followUps is status-disjoint from
  // the others so it never actually contends, but it runs through the same
  // claim chain to keep the one-bucket-per-job invariant uniform.
  const claimed = new Set<string>();
  const claim = (j: Job) => {
    claimed.add(j.id);
    return true;
  };
  const overdue = preSubmission.filter((j) => {
    const d = daysUntil(j.deadline);
    return d !== null && d < 0 && claim(j);
  });
  const dueSoon = preSubmission.filter((j) => {
    if (claimed.has(j.id)) return false;
    const d = daysUntil(j.deadline);
    return d !== null && d >= 0 && d <= 3 && claim(j);
  });
  // Submitted, applied 7+ days ago, no reply logged: chase it. Disjoint from the
  // deadline buckets (those are pre-submission only) and the stale fallbacks
  // (drafted/lead/queued only), so this is a submitted job's only path here.
  const followUps = jobs.filter((j) => {
    if (claimed.has(j.id)) return false;
    return isFollowUpDue(j) && claim(j);
  });
  const staleDrafts = jobs.filter((j) => {
    if (claimed.has(j.id) || j.status !== "drafted") return false;
    const d = daysUntil(j.deadline);
    if (d === null) return jobAgeDays(j) > STALE_AGE_DAYS && claim(j);
    return d >= 0 && d <= 7 && claim(j);
  });
  // Deadline-less lead/queued jobs have no dated bucket to fall into at all
  // (overdue/dueSoon require a deadline); this is their only path to surfacing.
  const staleLeads = jobs.filter((j) => {
    if (claimed.has(j.id) || (j.status !== "lead" && j.status !== "queued")) return false;
    if (daysUntil(j.deadline) !== null) return false;
    return jobAgeDays(j) > STALE_AGE_DAYS && claim(j);
  });
  return {
    overdue,
    dueSoon,
    followUps,
    staleDrafts,
    staleLeads,
    total: overdue.length + dueSoon.length + followUps.length + staleDrafts.length + staleLeads.length,
  };
}

// --- "Due, not drafted" marker (Triage flow: Pursue->queue fast path + due-
// but-not-drafted marker; ops audit F5/F6, t-1783183576640) -------------------
// A queued job with no CV yet is on a collision course with the deadline
// auto-close sweep (server/lib.js shouldAutoClose): once its deadline passes
// while the job is still queued, the very next GET /api/jobs sweep silently
// flips it to closed - un-drafted, with no chance to catch it after the fact.
// This flags that window while it is still open: the SAME 0-3 day horizon as
// the dueSoon bucket above, still queued, still no CV on disk.
export function isUndraftedDueSoon(job: Job): boolean {
  if (job.status !== "queued" || job.hasCV) return false;
  const d = daysUntil(job.deadline);
  return d !== null && d >= 0 && d <= 3;
}

// The marker text for a job already known (via isUndraftedDueSoon) to be in
// that window. Split out so DeadlinePill - which some callers (TriageInbox,
// rendering a Discovery find that is not yet a Job) use with a bare deadline
// string - can format the same text off a precomputed boolean, without
// needing a whole Job.
export function undraftedDeadlineText(deadline: string | null): { text: string; tone: string } {
  const d = daysUntil(deadline);
  const when = d === null ? "due soon" : d === 0 ? "due today" : d === 1 ? "due tomorrow" : `due ${d}d`;
  return { text: `${when} - not drafted`, tone: "urgent" };
}

// Precedence-first label for a needs-attention render site: the undrafted
// marker when it applies, else the plain deadline countdown, else (deadline-
// less) the age fallback. Never null - ONE ordered chain shared by every
// needs-attention render site (Board strip / Insights panel) so a job reads
// identically wherever it surfaces, the same discipline computeNeedsAttention
// above already applies to which bucket a job lands in.
export function attentionLabel(job: Job): { text: string; tone: string } {
  if (isFollowUpDue(job)) return followUpLabel(job);
  if (isUndraftedDueSoon(job)) return undraftedDeadlineText(job.deadline);
  return deadlineLabel(job.deadline) ?? ageAttentionLabel(job);
}

// --- Derived next-action suggestion (US-3, t-1783318991874) ------------------
// A DISPLAY-ONLY hint for "what do I do next" on a job whose next_action the
// owner has NOT set. Pure function of the job's status plus the derived gaps /
// follow-up signals it already carries; it WRITES NOTHING and the caller uses it
// ONLY when job.nextAction is empty - a real, user-authored next_action ALWAYS
// wins and renders verbatim. This never PATCHes and has no "accept" step; it is
// the same derive-not-store discipline as jobCompletedDate / attentionLabel.
//
// Two branches reuse existing derivations so the suggestion can never disagree
// with the rest of the app:
//   - drafted splits on `finalizeReady` (the SAME server-derived signal the
//     drawer's "ready to finalize" hint + the table "ready" chip key off): a
//     finalize-ready draft suggests "Finalize", otherwise "Answer gaps". A
//     drafted job with no CV or with gaps still open is not finalizeReady, so it
//     correctly degrades to "Answer gaps" rather than inventing a state.
//   - submitted splits on isFollowUpDue (the SAME clock as the Follow-up
//     needs-attention bucket): due -> "Follow up", not-yet-due -> "Await response".
// Terminal statuses (rejected / closed) return null - there is nothing to do
// next, so the caller shows a plain "-" rather than a suggestion.
export function deriveNextAction(job: Job): string | null {
  switch (job.status) {
    case "lead":
      return "Triage";
    case "queued":
      return "Draft CV + cover";
    case "drafted":
      return job.finalizeReady ? "Finalize" : "Answer gaps";
    case "ready":
      return "Submit application";
    case "submitted":
      return isFollowUpDue(job) ? "Follow up" : "Await response";
    case "interview":
      return "Prep (STAR)";
    case "offer":
      return "Evaluate / negotiate";
    case "rejected":
    case "closed":
      return null;
    default:
      return null;
  }
}

// --- Accessible text-on-fill -------------------------------------------------
// Shared guard for the recurring "white text on a saturated fill" anti-pattern
// (status confirm button, insights bars, workflow step circles). Returns the
// fill plus the text color that clears WCAG AA 4.5:1; for mid-tones that pass
// with neither black nor white (e.g. indigo), it darkens the fill toward ink
// and uses white. Self-correcting for any future color.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(c: number[]): string {
  return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function relLum(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function contrast(fg: number[], bg: number[]): number {
  const l1 = relLum(fg[0], fg[1], fg[2]);
  const l2 = relLum(bg[0], bg[1], bg[2]);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const WHITE = [255, 255, 255];
const INK = [11, 15, 23]; // --color-ink

export function readableOn(hex: string): { bg: string; fg: string } {
  const rgb = hexToRgb(hex);
  const cw = contrast(WHITE, rgb);
  const ci = contrast(INK, rgb);
  if (Math.max(cw, ci) >= 4.5) return { bg: hex, fg: cw >= ci ? "#ffffff" : "#0b0f17" };
  // Mid-tone: darken the fill toward ink until white text clears AA.
  let c = rgb.slice();
  for (let i = 0; i < 30 && contrast(WHITE, c) < 4.6; i++) c = c.map((v) => v * 0.93);
  return { bg: rgbToHex(c), fg: "#ffffff" };
}
