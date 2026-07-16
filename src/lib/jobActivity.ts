import type { ActivityRecord, Job } from "../types";

// Pure derivation for the per-job Activity timeline (US-7, t-1783353402918). A
// READ-ONLY, newest-first history of a single job, MERGED from data the app
// already serves - no new store, no new write path, no frontmatter status-history
// capture (that fuller version is parked). Two milestone sources are folded into
// one chronological list:
//   1. Routine RUN starts from the activity feed (docs/activity-log.jsonl, GET
//      /api/activity) whose `jobId` matches THIS job's folder id. The feed writes
//      two records per run - a START carrying { ts, routine, label, jobId,
//      status:"running" } and a CLOSE carrying only { runId, status, exitCode }
//      (no jobId) - so filtering on jobId naturally keeps just the start (the
//      milestone), the same join the drawer's Last-run badge relies on.
//   2. The job's dated frontmatter milestones: `applied` and `deadline`.
//
// DOM-free / fetch-free so it unit-tests node-env style (tests/jobActivity.test.ts),
// the same discipline as lib/decisions.ts and lib/utils.ts's deriveNextAction: it
// WRITES NOTHING and is a pure function of its inputs. Display formatting (relative
// vs absolute time, icons) lives in the component, so this stays locale-free and
// trivially testable.

export type JobActivityKind = "run" | "applied" | "deadline";

export interface JobActivityEntry {
  // Stable React key. Runs key off runId; the two date milestones off their kind
  // (a job has at most one applied + one deadline).
  id: string;
  kind: JobActivityKind;
  // Human, timeline-appropriate (past-tense) label. Meaning is carried by this
  // text, never by color alone (CC-A11Y).
  label: string;
  // The raw timestamp: a full ISO-8601 datetime for a run, a "YYYY-MM-DD" date
  // for the applied/deadline milestones. The component formats it.
  ts: string;
  // Epoch ms sort key. Newest-first = descending on this value.
  sortMs: number;
  // Date-granularity (applied/deadline) vs a precise datetime (run) - the
  // component renders a date vs a datetime title accordingly.
  dateOnly: boolean;
  // Run entries only: the routine id (for the fallback label + any per-routine
  // affordance). Absent on date milestones.
  routine?: string;
  // Run entries only: how many CONSECUTIVE same-routine runs this row stands for
  // (>= 1). A job finalized five times in a row collapses to a single row with
  // runCount 5 rather than five identical rows (US-7 QA refinement 2026-07-06).
  // The row keeps the NEWEST run's id/ts/label; the count is surfaced as "xN".
  // Absent on date milestones.
  runCount?: number;
  // Collapsed groups only (runCount > 1): the individual member runs, newest-first,
  // so the drawer can EXPAND the "xN" row into each run with its own timestamp
  // (owner feedback 2026-07-06: the collapsed row should open). Each member is a
  // plain run entry (no nested runCount/runs). Absent on single runs + milestones.
  runs?: JobActivityEntry[];
}

// Past-tense, timeline-appropriate labels for the job-scoped routines (the same
// five the drawer's Agent actions launch). A timeline lists things that already
// HAPPENED, so "Drafted"/"Finalized" reads better than the present-tense action
// labels the buttons use. This is display phrasing, not a second source of truth
// for what a routine IS; an unmapped routine falls back to the feed's own stamped
// `label`, then to the raw routine id - so a new routine never renders blank.
const ROUTINE_PAST_LABEL: Record<string, string> = {
  "first-draft-job": "Drafted CV + cover letter",
  "finalize-job": "Finalized application",
  "interview-prep": "Interview prep run",
  "offer-prep": "Offer / negotiation prep",
  "draft-follow-up": "Drafted follow-up email",
};

function runLabel(r: ActivityRecord): string {
  const routine = typeof r.routine === "string" ? r.routine : "";
  if (routine && ROUTINE_PAST_LABEL[routine]) return ROUTINE_PAST_LABEL[routine];
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (label) return label;
  return routine || "Activity";
}

// Parse a "YYYY-MM-DD" date at LOCAL midnight (the same discipline as
// utils.daysUntil / daysSinceApplied, so an "applied" milestone lands on the same
// calendar day the rest of the app reads it as). Returns null for a
// missing/unparseable date so the caller simply omits that milestone.
function dateMs(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  // Strict YYYY-MM-DD and NOTHING else. The applied/deadline frontmatter is a
  // bare calendar date by rule (owner call, US-7 QA 2026-07-06); a value carrying
  // a time, a range, or a note ("2026-07-10 (firm)") is not a clean date
  // milestone, so we omit it rather than salvage a partial slice.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  // Reject an impossible date that JS silently rolls over (2026-02-30 -> Mar 2):
  // the parsed components must survive the Date round-trip unchanged.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

// Derive the merged, newest-first activity timeline for one job. `job` is
// deliberately a structural subset (id + the two dated fields) so a JobDetail, a
// Job, or a test fixture all satisfy it. `activityLog` is the newest-first feed
// GET /api/activity serves; passing [] (e.g. while it is still loading, or on a
// fetch failure) is safe and simply yields only the date milestones.
export function deriveJobActivity(
  job: Pick<Job, "id" | "applied" | "deadline">,
  activityLog: ActivityRecord[],
): JobActivityEntry[] {
  const entries: JobActivityEntry[] = [];
  const seenRuns = new Set<string>();

  for (const r of activityLog) {
    if (r.kind !== "run") continue;
    // Only THIS job's runs. Close records carry no jobId, so this also drops
    // them; task/source runs (jobId is a ticket id or a source id) never match a
    // job folder id.
    if (!r.jobId || r.jobId !== job.id) continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    // Dedup by runId so a duplicated feed line can't double an entry; a start
    // record is unique per run. Fall back to ts+routine when a runId is absent.
    const runKey = r.runId || `${r.ts}:${r.routine ?? ""}`;
    if (seenRuns.has(runKey)) continue;
    seenRuns.add(runKey);
    entries.push({
      id: `run:${runKey}`,
      kind: "run",
      label: runLabel(r),
      ts: r.ts,
      sortMs: ms,
      dateOnly: false,
      routine: typeof r.routine === "string" ? r.routine : undefined,
    });
  }

  const appliedMs = dateMs(job.applied);
  if (appliedMs !== null) {
    entries.push({
      id: "applied",
      kind: "applied",
      label: "Applied",
      // dateMs already validated this is a clean YYYY-MM-DD, so trim() yields the
      // exact 10-char date (no stray frontmatter whitespace leaks into the UI).
      ts: (job.applied as string).trim(),
      sortMs: appliedMs,
      dateOnly: true,
    });
  }

  const deadlineMs = dateMs(job.deadline);
  if (deadlineMs !== null) {
    entries.push({
      id: "deadline",
      kind: "deadline",
      label: "Deadline",
      ts: (job.deadline as string).trim(),
      sortMs: deadlineMs,
      dateOnly: true,
    });
  }

  // Newest-first. Deterministic tiebreak on id so equal-timestamp entries (a run
  // exactly at a milestone's midnight) always order the same way in the UI + tests.
  entries.sort((a, b) => b.sortMs - a.sortMs || b.id.localeCompare(a.id));
  return collapseConsecutiveRuns(entries);
}

// Collapse ADJACENT run entries of the SAME routine into a single row carrying a
// runCount (US-7 QA refinement 2026-07-06). Operates on the already newest-first
// sorted list, so a group is folded into its NEWEST member (kept first): the row
// keeps that run's id/ts/label and reports how many runs it stands for. Only runs
// that are truly consecutive in the timeline collapse - a date milestone (or a
// different routine) between two same-routine runs breaks the group, because the
// intervening milestone is real history the reader should still see. Runs with no
// routine id are never folded together (an unknown routine is not "the same
// routine" as another unknown one). Date milestones pass through untouched and
// carry no runCount.
function collapseConsecutiveRuns(entries: JobActivityEntry[]): JobActivityEntry[] {
  // A single member run stripped of any group state (no runCount/runs) so it can
  // be listed under the expanded "xN" row on its own.
  const member = (x: JobActivityEntry): JobActivityEntry => ({
    id: x.id,
    kind: "run",
    label: x.label,
    ts: x.ts,
    sortMs: x.sortMs,
    dateOnly: false,
    routine: x.routine,
  });
  const out: JobActivityEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "run" &&
      e.kind === "run" &&
      prev.routine !== undefined &&
      prev.routine === e.routine
    ) {
      prev.runCount = (prev.runCount ?? 1) + 1;
      // Retain each folded run (newest-first: prev is the newest, seeded first)
      // so the drawer can expand the row into the individual runs.
      if (!prev.runs) prev.runs = [member(prev)];
      prev.runs.push(member(e));
      continue;
    }
    out.push(e.kind === "run" ? { ...e, runCount: 1 } : e);
  }
  return out;
}
