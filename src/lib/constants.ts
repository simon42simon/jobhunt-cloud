import type { Status } from "../types";
import { FIT_ACCENT, PIPELINE_ACCENT, TRACK_ACCENT } from "./statusColors";

// Column order matches the vault's documented status lifecycle.
export const STATUS_ORDER: Status[] = [
  "lead",
  "queued",
  "drafted",
  "ready",
  "submitted",
  "interview",
  "offer",
  "rejected",
  "closed",
];

export const STATUS_LABEL: Record<Status, string> = {
  lead: "Lead",
  queued: "Queued",
  drafted: "Drafted",
  ready: "Ready",
  submitted: "Submitted",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  closed: "Closed",
};

// Accent color per status (used on column headers + card stripes). Re-exported
// from lib/statusColors.ts's PIPELINE_ACCENT (UX F7, audit-2026-07-04) - this
// used to be its own unvetted map (slate-500/violet-500/indigo-500 all failed
// WCAG AA as the 12px text they render as in JobTable's status select,
// JobCard's border, KanbanBoard's column dot, etc). Do not add a color here;
// add it to PIPELINE_ACCENT so it gets the same contrast sweep.
export const STATUS_ACCENT: Record<Status, string> = PIPELINE_ACCENT;

// "Active" statuses get a pipeline; rejected/closed are the archive.
export const ACTIVE_STATUSES: Status[] = [
  "lead",
  "queued",
  "drafted",
  "ready",
  "submitted",
  "interview",
  "offer",
];

// Pre-application active statuses: the subset of ACTIVE_STATUSES BEFORE an
// application is submitted. The deadline-driven needs-attention buckets
// (overdue / dueSoon in lib/utils.computeNeedsAttention) gate on THIS, not on
// all active statuses - once a job is submitted the application deadline is
// moot (you already applied), so a submitted job with a passed deadline is a
// false "Overdue". The follow-up clock (isFollowUpDue) takes over there instead.
// `ready` (finalized but not yet submitted) is still pre-submission: its posting
// deadline very much matters (submit before it passes), so it belongs here too.
export const PRE_SUBMISSION_ACTIVE: Status[] = ["lead", "queued", "drafted", "ready"];

// Re-exported from lib/statusColors.ts's FIT_ACCENT (UX F7) - "stretch"
// (rose-500 #f43f5e) failed AA as its own translucent-pill text.
export { FIT_ACCENT };

// Per-status trigger + impact, shown in the confirm popup on every status change.
// Mirrors the canonical table in docs/blueprint.md (section 4.4).
export const STATUS_INFO: Record<
  Status,
  { trigger: string; impact: string; effect?: string; next?: string }
> = {
  lead: {
    trigger: "A posting was discovered or you captured it.",
    impact: "It is on the radar with no work done yet.",
    next: "Triage it; move to Queued if worth pursuing.",
  },
  queued: {
    trigger: "You decided this role is worth pursuing.",
    impact: "It is committed to the drafting queue.",
    next: "Run Draft (first-draft-job) to generate the CV + cover letter.",
  },
  drafted: {
    trigger: "first-draft-job generated a first-draft CV + cover letter + gaps page.",
    impact: "Draft materials now exist in the job folder.",
    next: "Answer the gaps page, then run Finalize (a successful Finalize advances it to Ready).",
  },
  ready: {
    trigger: "A successful Finalize run: the CV + cover letter are ATS-finalized and the submission PDFs rendered.",
    impact: "The application is finalized and ready for you to submit externally.",
    effect: "Set automatically by the server when Finalize succeeds on a drafted job (never auto-submitted).",
    next: "Submit it on the employer's site, then mark it Submitted.",
  },
  submitted: {
    trigger: "You submitted the application externally (never auto-submitted).",
    impact: "It counts toward your weekly target and the response clock starts.",
    effect: "Stamps applied = today (only if not already set).",
    next: "Wait for a response; log any interview invite.",
  },
  interview: {
    trigger: "The employer invited you to interview.",
    impact: "This is now an active opportunity.",
    next: "Build STAR stories and prep.",
  },
  offer: {
    trigger: "The employer extended an offer.",
    impact: "You are near close.",
    next: "Evaluate and negotiate (offer comparison, salary prep).",
  },
  rejected: {
    trigger: "The employer declined, or you were turned down.",
    impact: "Terminal and archived; it leaves the active pipeline.",
    next: "No further action; it informs future discovery.",
  },
  closed: {
    trigger: "The posting closed, you withdrew, or chose not to pursue.",
    impact: "It leaves the active pipeline. This is how you remove a job - never by deleting files.",
    next: "No further action.",
  },
};

export const TRACK_LABEL: Record<string, string> = {
  industry_outreach_focused: "Industry Outreach",
  higher_ed_generalist_focused: "Higher-Ed Generalist",
  b2b_gtm_focused: "B2B GTM",
  operations_leadership_focused: "Operations Leadership",
  public_sector_focused: "Public Sector",
  aerospace_defence_focused: "Aerospace / Defence",
  fire_alarm_focused: "Fire / Life-Safety",
};

// Re-exported from lib/statusColors.ts's TRACK_ACCENT (UX F7) - three of the
// seven hues failed AA as their own translucent-pill text.
export { TRACK_ACCENT };
