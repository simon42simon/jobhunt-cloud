// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Single source of truth for every status / group / type -> color mapping in
// the app. Before this module existed, ProjectsView, TeamView, TaskBoard,
// ReviewsLogsView, RoadmapBoard, BriefsDebriefsView, and ReleasesView each
// kept their own copy of these maps (some identical, some near-identical,
// some already drifted). A contrast fix landed in one file and not another -
// e.g. TaskBoard's COL_COLOR kept unvetted values (violet-500 #a855f7,
// slate-500 #64748b, #4b5563) after ProjectsView's STATUS_COLOR was already
// bumped to AA-safe tints. Fixing per-file cannot outrun that: the next
// duplicate copy reintroduces the same bug. This module is the one place a
// status/group/type color is decided; every consumer imports the accessor
// function (statusColor, groupColor, ...) instead of declaring its own map.
//
// UX F7 (audit-2026-07-04): lib/constants.ts's STATUS_ACCENT / TRACK_ACCENT /
// FIT_ACCENT (the Jobs board/table pipeline vocabulary) were exactly this
// same bypass - a second, unvetted map declared outside this module - and
// #a855f7 / #64748b were rendered as 12px TEXT (JobTable's status <select>,
// NeedsAttentionStrip, InsightsView) at 3.48:1 / 2.98:1, both failing AA's
// 4.5:1. Folded in below (PIPELINE_ACCENT, TRACK_ACCENT, FIT_ACCENT,
// ATTENTION_TONE_COLOR); lib/constants.ts now re-exports these instead of
// declaring its own hexes, and every value is covered by the same AA sweep
// (see allColorMaps() in statusColors.test.ts).
//
// WCAG AA vetting methodology: every color below renders as small (10-13px)
// text, in one of two contexts -
//   (a) flat text directly on --color-panel (#111725) / --color-panel-2
//       (#161e2e) - e.g. an accent link, a value shown with no background, or
//   (b) "pill" text where the SAME hex is also the pill's translucent
//       background (hexA(color, alpha) laid over the panel), which pulls the
//       effective background toward the text color and *reduces* contrast as
//       alpha rises.
// Every value here was checked against a contrast script (relative-luminance
// WCAG formula, alpha-composited over both panel tokens) at every alpha in
// use across the app (0.12-0.22) and clears 4.5:1 (normal-text AA) in the
// worst case, not just the alpha the color happened to be picked for. This
// is what lets new call sites reuse these colors at any of those alphas
// without a fresh contrast check. Do not add a raw hex to a component; add
// it here (and re-run the vetting) instead.

import type { LastRunSignal, ProposalStatus, RunStatus, Status } from "../types";

export function hexA(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Safe neutral fallback for any status/group/type string this module does not
// recognize. Previously several per-file maps fell back to the raw accent
// color (#5a5df0), which itself fails AA as text (3.63:1) - so an unmapped
// value silently rendered illegible text. This fallback is pre-vetted.
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
const DEFAULT_MUTED = "#a0aec0";

// ---------------------------------------------------------------------------
// Task / project / milestone / roadmap-phase status vocabulary.
// Covers: backlog, todo, in_progress, in_review, done, canceled, blocked,
// paused, not_started, planned, proposed, triage, later, archived - plus the
// aliases (active, shipped, complete) different data sources use for the same
// concept.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const STATUS_COLOR: Record<string, string> = {
  // in flight
  active: "#f59e0b",
  in_progress: "#f59e0b",
  in_review: "#22d3ee",
  // queued / not started
  planned: "#a5b4fc",
  proposed: "#a5b4fc",
  not_started: "#a0aec0",
  todo: "#38bdf8",
  backlog: "#a0aec0",
  triage: "#c4b5fd",
  // finished
  done: "#34d399",
  shipped: "#34d399",
  complete: "#34d399",
  // needs attention / stopped
  blocked: "#fda4af",
  paused: "#a0aec0",
  later: "#a0aec0",
  archived: "#a0aec0",
  canceled: "#b4bcc9",
};

export function statusColor(status: string | undefined): string {
  return (status && STATUS_COLOR[status]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Job pipeline status vocabulary (Jobs board/table - lead through closed).
// Was lib/constants.ts's STATUS_ACCENT, rendered directly as 12px text in
// JobTable's status <select>, JobCard's border stripe, KanbanBoard's column
// dot, StatusChangeModal's from/to chips, and Badges' StatusBadge. THREE of
// the eight were unvetted and failed AA: lead (slate-500 #64748b, 3.50:1),
// drafted (violet-500 #a855f7, 4.21:1 flat / 3.24:1 as its own pill), and
// submitted (indigo-500 #6366f1, 3.73:1 - the same legacy accent hue
// index.css's --color-accent was already nudged away from for exactly this
// reason). offer (emerald-500 #10b981) technically cleared 4.5:1 but with no
// margin (4.50:1 worst-case pill) - bumped to the STATUS_COLOR "done" emerald
// for headroom. Every replacement REUSES an already-vetted hue from
// STATUS_COLOR/GROUP_COLOR above rather than introducing a new one, so the
// sweep below is re-checking known-good values, not guessing new ones.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const PIPELINE_ACCENT: Record<Status, string> = {
  lead: "#a0aec0", // was slate-500 #64748b (3.50:1 FAIL) -> STATUS_COLOR's not-started muted
  queued: "#38bdf8", // was sky-500 #0ea5e9 (passed flat, failed as a 22%-alpha pill) -> STATUS_COLOR.todo
  drafted: "#c4b5fd", // was violet-500 #a855f7 (4.21:1 FAIL) -> STATUS_COLOR.triage
  ready: "#2dd4bf", // finalized, ready to submit -> GROUP_COLOR.quality teal (already AA-vetted, unique among pipeline hues)
  submitted: "#a5b4fc", // was indigo-500 #6366f1 (3.73:1 FAIL, legacy accent hue) -> STATUS_COLOR.planned/proposed
  interview: "#f59e0b", // unchanged - already AA-safe (8.34:1 / 7.76:1)
  offer: "#34d399", // was emerald-500 #10b981 (4.50:1, no margin) -> STATUS_COLOR.done, for headroom
  rejected: "#fca5a5", // was red-500 #ef4444 (4.43:1 FAIL) -> GROUP_COLOR.governance
  closed: "#b4bcc9", // was slate-600 #475569 (2.20:1 FAIL badly) -> STATUS_COLOR.canceled
};

export function pipelineAccent(status: Status | string | undefined): string {
  return (status && PIPELINE_ACCENT[status as Status]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Career-track vocabulary (Jobs board/table Track badge). Was
// lib/constants.ts's TRACK_ACCENT; three of the seven failed AA as their own
// translucent-pill text (worst-case alpha 0.22) even though they cleared
// 4.5:1 flat: higher_ed (indigo-400 #818cf8, 3.93:1 tint), b2b_gtm (pink-400
// #f472b6, 4.42:1 tint), aerospace_defence (blue-400 #60a5fa, 4.39:1 tint).
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const TRACK_ACCENT: Record<string, string> = {
  industry_outreach_focused: "#22d3ee",
  higher_ed_generalist_focused: "#93c5fd", // was indigo-400 #818cf8 (3.93:1 tint FAIL) -> GROUP_COLOR.engineering
  b2b_gtm_focused: "#f9a8d4", // was pink-400 #f472b6 (4.42:1 tint FAIL) -> GROUP_COLOR.design
  operations_leadership_focused: "#facc15",
  public_sector_focused: "#4ade80",
  aerospace_defence_focused: "#7dd3fc", // was blue-400 #60a5fa (4.39:1 tint FAIL) -> sky-300
  fire_alarm_focused: "#fb923c",
};

export function trackAccent(track: string | undefined): string {
  return (track && TRACK_ACCENT[track]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Fit-assessment vocabulary (Jobs board/table Fit badge). Was lib/constants.ts's
// FIT_ACCENT; "stretch" (rose-500 #f43f5e) cleared 4.5:1 flat by a hair
// (4.54:1 on panel-2) but failed as its own pill text (3.59:1); "strong"
// (emerald-500 #10b981) had the same no-margin 4.50:1 worst-case as pipeline's
// old "offer" hue above.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const FIT_ACCENT: Record<string, string> = {
  strong: "#34d399", // was emerald-500 #10b981 (4.50:1, no margin) -> STATUS_COLOR.done
  moderate: "#f59e0b", // unchanged - already AA-safe
  stretch: "#fda4af", // was rose-500 #f43f5e (3.59:1 tint FAIL) -> STATUS_COLOR.blocked
};

export function fitAccent(fit: string | undefined): string {
  return (fit && FIT_ACCENT[fit.toLowerCase()]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Needs-attention urgency bands (Board strip + Insights panel). Both views
// already share computeNeedsAttention (lib/utils.ts) so their BUCKETS can
// never diverge; this map extends that same discipline to COLOR, replacing
// two independently hardcoded tone arrays that both carried the identical
// unvetted #f43f5e / #a855f7 / #64748b hexes. staleDraft/staleLead
// deliberately reuse PIPELINE_ACCENT.drafted/lead so a stale-draft chip and
// the Jobs table's "Drafted" status render the exact same hue. followUp reuses
// STATUS_COLOR.in_review's cyan - a hue held by NO other attention band (the
// four others are rose/amber/violet/slate), so a "Follow up" chip is instantly
// distinguishable; being an already-vetted value it clears the AA sweep below
// (allColorMaps() folds ATTENTION_TONE_COLOR in) at flat and every tint alpha.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const ATTENTION_TONE_COLOR: Record<string, string> = {
  overdue: "#fda4af", // was rose-500 #f43f5e (FAIL) -> STATUS_COLOR.blocked / FIT_ACCENT.stretch
  dueSoon: "#f59e0b", // unchanged - already AA-safe
  followUp: "#22d3ee", // = STATUS_COLOR.in_review cyan - distinct from the other four bands, AA-safe
  staleDraft: "#c4b5fd", // was violet-500 #a855f7 (FAIL) -> = PIPELINE_ACCENT.drafted
  staleLead: "#a0aec0", // was slate-500 #64748b (FAIL) -> = PIPELINE_ACCENT.lead
};

export function attentionToneColor(key: string | undefined): string {
  return (key && ATTENTION_TONE_COLOR[key]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Org functional-group vocabulary (docs/agents.yaml `groups`). "governance"
// was missing from both prior copies of this map (added 2026-07-02) - any
// role in that group was silently falling back to the raw accent color,
// which fails AA. Keep this list in sync with docs/agents.yaml's group ids.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const GROUP_COLOR: Record<string, string> = {
  stakeholder: "#34d399",
  leadership: "#c4b5fd",
  product: "#f59e0b",
  engineering: "#93c5fd",
  design: "#f9a8d4",
  quality: "#2dd4bf",
  infra: "#a0aec0",
  docs: "#eab308",
  people: "#22d3ee",
  "career-delivery": "#fb923c",
  governance: "#fca5a5",
};

export function groupColor(group: string | undefined): string {
  return (group && GROUP_COLOR[group]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Agent onboarding/status line (TeamView drawer header) - a deliberately
// small, separate vocabulary from STATUS_COLOR above (an agent's onboarding
// state, not a project/task status), but still centralized here so it gets
// the same vetting and can't drift independently.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const ONBOARDING_STATUS_COLOR: Record<string, string> = {
  active: "#34d399",
  proposed: "#a5b4fc",
  inactive: "#a0aec0",
};

export function onboardingStatusColor(status: string | undefined): string {
  return (status && ONBOARDING_STATUS_COLOR[status]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Changelog category vocabulary (Keep a Changelog headings).
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const CHANGE_TYPE_COLOR: Record<string, string> = {
  Added: "#34d399",
  Changed: "#f59e0b",
  Fixed: "#38bdf8",
  Security: "#fda4af",
  Removed: "#a0aec0",
  Deprecated: "#c4b5fd",
  Notes: "#a0aec0",
};

export function changeTypeColor(name: string | undefined): string {
  return (name && CHANGE_TYPE_COLOR[name]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Records doc-type vocabulary (Reviews & Logs "Type" column).
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const DOC_TYPE_COLOR: Record<string, string> = {
  review: "#a5b4fc",
  log: "#22d3ee",
};

export function docTypeColor(type: string | undefined): string {
  return (type && DOC_TYPE_COLOR[type]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Addressed-via-tickets status (Reviews & Logs "Status" column) - label +
// color together since every call site needs both.
// ---------------------------------------------------------------------------
export type AddressedStatusKey = "clear" | "open" | "not-tracked";

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const ADDRESSED_STATUS_META: Record<AddressedStatusKey, { label: string; color: string }> = {
  clear: { label: "Clear", color: "#34d399" },
  open: { label: "Open", color: "#f59e0b" },
  "not-tracked": { label: "Not tracked", color: "#a0aec0" },
};

// ---------------------------------------------------------------------------
// Brief/debrief status vocabulary (Briefs & Debriefs "Status" column).
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const BRIEF_STATUS_COLOR: Record<string, string> = {
  shipped: "#34d399",
  deferred: "#f59e0b",
  mixed: "#93c5fd",
};

export function briefStatusColor(status: string | undefined): string {
  return (status && BRIEF_STATUS_COLOR[status]) || DEFAULT_MUTED;
}

// ---------------------------------------------------------------------------
// Instruction-proposal status vocabulary (Discovery DISC-W3 - the drawer's
// proposal card, the archived-history chips, and the card badge's busy tint).
// Every hue REUSES an already-vetted value from the maps above (todo sky /
// done emerald / blocked rose), so the blanket AA sweep in statusColors.test.ts
// covers this map with no new contrast vetting. label + color live together
// (the ADDRESSED_STATUS_META pattern) since every chip needs both.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const PROPOSAL_STATUS_META: Record<ProposalStatus, { label: string; color: string }> = {
  pending: { label: "Pending", color: "#38bdf8" }, // = STATUS_COLOR.todo / running sky
  approved: { label: "Approved", color: "#34d399" }, // = STATUS_COLOR.done emerald
  rejected: { label: "Rejected", color: "#fda4af" }, // = STATUS_COLOR.blocked rose
};

export function proposalStatusMeta(status: ProposalStatus): { label: string; color: string } {
  return PROPOSAL_STATUS_META[status] ?? { label: status, color: DEFAULT_MUTED };
}

// ---------------------------------------------------------------------------
// Last-run honesty signal (Discovery schema v4, server deriveLastRunSignal) -
// classifies a source's newest terminal succeeded run so a zero-lead run is
// legible. 'leads' landed new leads; 'dedup' reviewed candidates but all were
// already tracked/filtered (HEALTHY - the University Affairs case, NOT an
// alarm); 'quiet' genuinely saw nothing to review (also healthy); 'unverified'
// reported no counters - numerically identical to a broken scrape, the one
// signal that WARNS. Every hue REUSES an already-vetted value from the maps
// above (done emerald / quality teal / muted slate / in-progress amber), so
// the blanket AA sweep in statusColors.test.ts covers this map with no new
// contrast vetting. label + color live together (the ADDRESSED_STATUS_META
// pattern) since every consumer needs both.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const LAST_RUN_SIGNAL_META: Record<LastRunSignal, { label: string; color: string }> = {
  leads: { label: "New leads", color: "#34d399" }, // = STATUS_COLOR.done emerald
  dedup: { label: "All tracked", color: "#2dd4bf" }, // = GROUP_COLOR.quality teal - calm, healthy
  quiet: { label: "Quiet", color: "#a0aec0" }, // = DEFAULT_MUTED slate - nothing listed, nothing wrong
  unverified: { label: "Unverified", color: "#f59e0b" }, // = STATUS_COLOR.in_progress amber - "cannot tell"
};

export function lastRunSignalMeta(signal: LastRunSignal): { label: string; color: string } {
  return LAST_RUN_SIGNAL_META[signal] ?? { label: signal, color: DEFAULT_MUTED };
}

// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Routine-run status vocabulary (RunPanel + the RunDock chips,
// t-1783119823228). RunPanel used to keep a private TONE map whose two
// terminal hues were unvetted and rendered as 10px pill text: done
// emerald-500 #10b981 (4.50:1, zero margin) and failed red-500 #ef4444
// (4.43:1 FAIL) - exactly the per-file drift this module exists to end, and
// the dock would have needed a second copy. Every hue REUSES an
// already-vetted value from the maps above (planned indigo / done emerald /
// blocked rose / in-progress amber), so the blanket AA sweep in
// statusColors.test.ts covers this map with no new contrast vetting. label +
// color live together (the ADDRESSED_STATUS_META pattern) since panel pill
// and dock chip both need both.
// ---------------------------------------------------------------------------
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const RUN_STATUS_META: Record<RunStatus, { label: string; color: string }> = {
  running: { label: "Running", color: "#a5b4fc" }, // = STATUS_COLOR.planned / --color-accent-text
  // SIM-562: honestly "nothing is happening yet", not a failure - reuses
  // DEFAULT_MUTED slate (already vetted via LAST_RUN_SIGNAL_META.quiet).
  "waiting-for-runner": { label: "Waiting for runner", color: "#a0aec0" },
  // Needs the owner's attention (re-queue) - reuses the same amber as `stopped`.
  stalled: { label: "Stalled", color: "#f59e0b" },
  done: { label: "Done", color: "#34d399" }, // = STATUS_COLOR.done emerald
  failed: { label: "Failed", color: "#fda4af" }, // = STATUS_COLOR.blocked rose
  stopped: { label: "Stopped", color: "#f59e0b" }, // = STATUS_COLOR.in_progress amber
};

export function runStatusMeta(status: RunStatus): { label: string; color: string } {
  return RUN_STATUS_META[status] ?? { label: status, color: DEFAULT_MUTED };
}

// ---------------------------------------------------------------------------
// Project risk severity (ADR-011; PMBOK likelihood x impact matrix). A risk's
// qualitative severity is the reduction of its two 3-level axes to one of three
// bands, rendered as a colored chip on the Projects view. The colors deliberately
// REUSE already-vetted STATUS_COLOR hues (planned / in_progress / blocked), so no
// new contrast vetting is introduced - the statusColors AA sweep covers this map
// too (it is folded into allColorMaps() in statusColors.test.ts). label + color
// live together (the ADDRESSED_STATUS_META pattern) since every chip needs both.
// ---------------------------------------------------------------------------
export type RiskSeverity = "low" | "medium" | "high";

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const RISK_SEVERITY_META: Record<RiskSeverity, { label: string; color: string }> = {
  low: { label: "Low", color: "#a5b4fc" }, // = planned/proposed tint
  medium: { label: "Medium", color: "#f59e0b" }, // = in_progress amber
  high: { label: "High", color: "#fda4af" }, // = blocked rose
};

// The 3x3 risk matrix reduced by the PRODUCT of its two axes (high=3, medium=2,
// low=1): product >= 6 is High (both axes elevated), 3-4 is Medium, <= 2 is Low.
// Pure + total over all nine likelihood x impact combinations; unit-tested in
// statusColors.test.ts so the mapping can never silently drift.
const RISK_AXIS_SCORE: Record<"high" | "medium" | "low", number> = { high: 3, medium: 2, low: 1 };

export function riskSeverity(
  likelihood: "high" | "medium" | "low",
  impact: "high" | "medium" | "low"
): RiskSeverity {
  const product = RISK_AXIS_SCORE[likelihood] * RISK_AXIS_SCORE[impact];
  if (product >= 6) return "high";
  if (product >= 3) return "medium";
  return "low";
}
