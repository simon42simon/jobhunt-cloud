import type { Job } from "../types";
import { computeNeedsAttention, isFollowUpDue, type NeedsAttention } from "./utils";

// ---------------------------------------------------------------------------
// Job preset "quick views" (ENG-M3-T1). One-click coarse filters above the Jobs
// list, live in BOTH the board and the table. PURE + unit-testable (no React):
// App.tsx applies filterByPreset FIRST, then the shared track/query narrowing,
// and JobPresets.tsx renders PRESETS + presetCounts.
//
// The deadline / attention presets REUSE the SAME predicates as the
// NeedsAttentionStrip (computeNeedsAttention in lib/utils - the conceptual
// "attentionBuckets"), so a preset count can never drift from the strip it sits
// under. Overdue / Due soon / Follow up due / Needs attention all read off the
// one bucket computation; ready (the `ready` status) / interview key off status
// directly.
// ---------------------------------------------------------------------------

export interface JobPreset {
  key: string;
  label: string;
}

// Order is load-bearing: the tab bar renders these left to right, with the
// deadline-focused views (Needs attention / Overdue / Due soon) up front - the
// headline ask (deadline pressure surfaced before it becomes a same-day scramble).
export const PRESETS: JobPreset[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "overdue", label: "Overdue" },
  { key: "due-soon", label: "Due soon" },
  { key: "ready", label: "Ready to submit" },
  { key: "follow-up", label: "Follow up due" },
  { key: "interview", label: "Interview" },
];

// The "Needs attention" union: every job in any attention bucket, deduped by id
// (a job lands in at most one bucket already - computeNeedsAttention claims each
// job exactly once - but the dedupe keeps this robust if that ever changes).
// Order follows the buckets' own urgency precedence.
function attentionUnion(na: NeedsAttention): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const bucket of [na.overdue, na.dueSoon, na.followUps, na.staleDrafts, na.staleLeads]) {
    for (const j of bucket) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      out.push(j);
    }
  }
  return out;
}

// Ready to submit: a job at the `ready` status - finalized (a successful Finalize
// advanced it drafted -> ready) and awaiting external submission. This matches the
// preset's "Ready to submit" label; the earlier "drafted + finalizeReady" predicate
// meant "ready to FINALIZE" (a different stage), which the label never matched. The
// finalize-ready set is still surfaced by the "Finalize ready (N)" batch button, the
// board Finalize strip, and the card/table "ready to finalize" chip. Split out so
// filterByPreset + presetCounts share ONE definition.
function isReady(job: Job): boolean {
  return job.status === "ready";
}

// Follow up due: a submitted job past the follow-up clock. isFollowUpDue already
// gates on the submitted status, so the explicit status check is belt-and-braces
// (and keeps the rule readable next to the others).
function isFollowUp(job: Job): boolean {
  return job.status === "submitted" && isFollowUpDue(job);
}

// The subset of `jobs` for one preset key. An unknown key returns all jobs (the
// safe default), so a stale/removed localStorage key can never blank the list.
// A single call computes computeNeedsAttention at most once (only the matched
// branch runs); presetCounts below computes it exactly once for all keys.
export function filterByPreset(key: string, jobs: Job[]): Job[] {
  switch (key) {
    case "attention":
      return attentionUnion(computeNeedsAttention(jobs));
    case "overdue":
      return computeNeedsAttention(jobs).overdue;
    case "due-soon":
      return computeNeedsAttention(jobs).dueSoon;
    case "ready":
      return jobs.filter(isReady);
    case "follow-up":
      return jobs.filter(isFollowUp);
    case "interview":
      return jobs.filter((j) => j.status === "interview");
    case "all":
    default:
      return jobs;
  }
}

// Live count per preset key for the tab badges. computeNeedsAttention runs ONCE
// and is reused for every attention-derived key (do not recompute per preset),
// so all seven counts come from a single pass over the jobs. `all` is always the
// full job count.
export function presetCounts(jobs: Job[]): Record<string, number> {
  const na = computeNeedsAttention(jobs);
  return {
    all: jobs.length,
    attention: attentionUnion(na).length,
    overdue: na.overdue.length,
    "due-soon": na.dueSoon.length,
    ready: jobs.filter(isReady).length,
    "follow-up": jobs.filter(isFollowUp).length,
    interview: jobs.filter((j) => j.status === "interview").length,
  };
}
