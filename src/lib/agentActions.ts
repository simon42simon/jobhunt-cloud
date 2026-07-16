// Which Agent actions (scope:job routines) the job drawer offers, DERIVED from
// the job's status PLUS a small context object for gates status alone cannot
// express. Two actions are unconditional (the core application pipeline:
// first-draft-job + finalize-job); the rest are GATED:
//   - interview-prep shows only at `interview`, offer-prep only at `offer`
//     (US-4/US-5) - pure status gates, nothing else shows them.
//   - draft-follow-up (US-6) is gated on ctx.followUpDue, the DERIVED
//     isFollowUpDue(job) signal (submitted + applied >= FOLLOWUP_DUE_DAYS days
//     ago), which status alone cannot capture. isFollowUpDue is only ever true
//     at `submitted`, so ctx.followUpDue already encodes the status - this gate
//     need not (and must NOT, to avoid a second source of truth) re-check it.
// Kept as a pure (status, ctx) -> action[] function (no JSX, no job object) so
// the gate is a small testable seam - the drawer just maps over the result.
// Labels + telemetry event names live here beside the routine ids so the
// button, the copy-CLI string (`run <routine> for "<folder>"`), and the J3
// run-trigger event all stay in one honest place. Launch itself is unchanged:
// the drawer still calls onRun(routine, jobId) exactly as Draft/Finalize do.

import type { Status } from "../types";

export type AgentAction = {
  routine: string;
  label: string;
  // Stable, content-free telemetry name for the J3 "run" trigger (was an
  // inline draft|finalize ternary in the drawer).
  event: string;
  // The specific noun the drawer's guarded "Regenerate" button names when this
  // action is already done (t-1783374313180): the button reads
  // "Regenerate <regenLabel>" instead of the bare word "Regenerate", so three
  // done actions no longer all collapse to the same unlabelled control. Each
  // value is distinct so the owner can tell CV/cover-letter from finalized
  // output from interview prep at a glance.
  regenLabel: string;
};

// Always shown, every status - the core CV/cover-letter pipeline.
const BASE_ACTIONS: readonly AgentAction[] = [
  { routine: "first-draft-job", label: "Draft CV + cover letter", event: "draft", regenLabel: "CV + cover letter" },
  { routine: "finalize-job", label: "Finalize (after gaps)", event: "finalize", regenLabel: "finalized CV + cover letter" },
];

// Shown ONLY at the matching status. Labels mirror the backend routine labels
// (server/index.js ROUTINES) so the drawer names the action the same way the
// Run panel/dock does.
const STATUS_GATED: Partial<Record<Status, AgentAction>> = {
  interview: { routine: "interview-prep", label: "Interview prep (STAR)", event: "interview-prep", regenLabel: "interview prep" },
  offer: { routine: "offer-prep", label: "Prep offer / negotiation", event: "offer-prep", regenLabel: "offer prep" },
};

// Shown ONLY when the job is follow-up-due (US-6): a submitted application that
// has sat FOLLOWUP_DUE_DAYS+ days with no reply (isFollowUpDue in lib/utils).
// Not a raw status gate - it rides ctx.followUpDue - because that signal is
// derived. It drafts a NEVER-sent follow-up email into the job folder: the same
// "edits files, never submits" contract as every other action. Label mirrors
// the backend routine label (server/index.js ROUTINES["draft-follow-up"]).
const FOLLOW_UP_ACTION: AgentAction = {
  routine: "draft-follow-up",
  label: "Draft follow-up email",
  event: "draft-follow-up",
  regenLabel: "follow-up email",
};

// Interview-prep REFINE (Part 3): the "finalize" analog for the interview loop.
// Gated on the DERIVED ctx.interviewPrepDone (a prep draft exists to refine), not
// on status alone - exactly how Finalize conceptually follows Draft. Label mirrors
// the backend routine label (server/index.js ROUTINES["interview-prep-refine"]).
const INTERVIEW_REFINE_ACTION: AgentAction = {
  routine: "interview-prep-refine",
  label: "Refine interview prep",
  event: "interview-prep-refine",
  regenLabel: "interview prep",
};

// "Merge PDF into one file" (t-1783650792067): an OPTIONAL post-finalize
// convenience that stitches the rendered cover letter + CV PDFs into one
// submission-ready PDF. Gated on the DERIVED ctx.mergePdfReady (both current
// PDFs exist in the job folder - server toJob), NOT on status: the PDFs render
// at finalize-job, so this surfaces at whatever status the job holds once
// there is actually something to merge, and never before. Label mirrors the
// backend routine label (server/index.js ROUTINES["merge-application-pdf"]).
const MERGE_PDF_ACTION: AgentAction = {
  routine: "merge-application-pdf",
  label: "Merge PDF into one file",
  event: "merge-application-pdf",
  regenLabel: "merged application PDF",
};

export function agentActionsFor(
  status: Status,
  ctx?: { followUpDue?: boolean; interviewPrepDone?: boolean; mergePdfReady?: boolean },
): AgentAction[] {
  const actions: AgentAction[] = [...BASE_ACTIONS];
  // Merge rides directly behind the pipeline it completes (draft -> finalize
  // -> merge), ahead of the stage-specific prep actions.
  if (ctx?.mergePdfReady) actions.push(MERGE_PDF_ACTION);
  const gated = STATUS_GATED[status];
  if (gated) actions.push(gated);
  // Refine appears right after interview-prep, but only once a prep draft exists.
  if (status === "interview" && ctx?.interviewPrepDone) actions.push(INTERVIEW_REFINE_ACTION);
  if (ctx?.followUpDue) actions.push(FOLLOW_UP_ACTION);
  return actions;
}
