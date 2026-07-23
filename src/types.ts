export type Status =
  | "lead"
  | "queued"
  | "drafted"
  | "ready"
  | "submitted"
  | "interview"
  | "offer"
  | "rejected"
  | "closed";

export interface Job {
  id: string;
  folder: string;
  folderPath: string;
  jobFile: string;
  jobFileName: string;
  role: string;
  employer: string;
  track: string;
  trackLabel: string;
  fit: string;
  status: Status;
  rawStatus: string;
  sector: string;
  tailoring: string;
  deadline: string | null;
  applied: string | null;
  link: string; // posting URL (the link to actually apply); "" when absent
  nextAction: string;
  nextActionDate: string | null;
  tags: string[];
  leadWith: string;
  files: { name: string; ext: string }[];
  hasCV: boolean;
  hasCoverLetter: boolean;
  // DERIVED server-side, never stored (server/index.js toJob; ADR-010..013
  // discipline). gapsAnswered: the gaps note was edited STRICTLY AFTER the CV was
  // generated - a disclosed heuristic that the owner has answered it.
  // finalizeReady: a drafted job with a CV whose gaps are answered ("ready to
  // finalize" - the signal to RUN Finalize). Both flow from ONE server rule; the
  // batch-finalize guard reuses it. Distinct from the `ready` STATUS, which means
  // "already finalized, ready to SUBMIT" (a successful Finalize advances a drafted
  // job to `ready`; see server/lib.js nextStatusAfterRun).
  gapsAnswered: boolean;
  finalizeReady: boolean;
  // Per-routine "already done" flags (server/index.js toJob; Part 1), DERIVED from
  // artifacts/status so an action run even OUTSIDE the app reads as done and its
  // button becomes a guarded Regenerate. finalizeDone is a disclosed status
  // heuristic (finalize has no distinct artifact).
  draftDone: boolean;
  finalizeDone: boolean;
  interviewPrepDone: boolean;
  offerPrepDone: boolean;
  followUpDone: boolean;
  // merge-application-pdf (t-1783650792067), same derived discipline:
  // mergePdfReady - both CURRENT rendered PDFs (cover letter + CV) exist, so
  // the optional "Merge PDF into one file" action has something to merge;
  // mergedPdfDone - a current merged "Application" PDF exists.
  mergePdfReady: boolean;
  mergedPdfDone: boolean;
  mtime: number;
}

export interface JobDetail extends Job {
  body: string;
  gaps: { name: string; content: string } | null;
  jobDescription: { name: string; content: string } | null;
  // Interview-prep materials the interview-prep routine wrote into the job folder
  // (prep sheet + STAR bank), surfaced as a first-class readable section on the
  // job page. Empty array when none exist yet. Sorted prep-sheet-first.
  prep: { name: string; content: string }[];
  // Interview-prep review loop (Part 3): the owner-editable feedback/clarifications
  // note (raw content), and the finalizeReady-analog readiness signal for Refine.
  // prepFeedbackAnswered: the note was edited after the prep docs were generated.
  prepFeedback: { name: string; content: string } | null;
  prepFeedbackAnswered: boolean;
  prepRefineReady: boolean;
  // Interview-prep consistency (feature 1, 2026-07-06 design): a read-only,
  // deterministic cross-check of the prep sheet's STAR-story citations against the
  // STAR bank. `high` findings are hard flags (a cited story the bank never defines);
  // `info` findings are advisory (an uncited bank story, or no submitted materials to
  // cross-check against). checked=false when no prep material exists yet.
  consistency: InterviewConsistency;
}

export type ConsistencySeverity = "high" | "info";

export interface ConsistencyFinding {
  severity: ConsistencySeverity;
  kind: "dangling-story" | "orphan-story" | "no-submitted";
  refs: string[];
  message: string;
}

export interface InterviewConsistency {
  checked: boolean;
  hasSubmitted: boolean;
  findings: ConsistencyFinding[];
}

// Per-job assistant chat (Part 4). A read-only assistant may recommend exactly one
// guarded action (a routine the job page runs); the human confirms it.
export interface ChatSuggestedAction {
  routine: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
  suggestedAction?: ChatSuggestedAction;
}

export interface AppConfig {
  jobsDir: string;
  statuses: Status[];
  tracks: Record<string, string>;
  weeklyTarget: number;
  // Server-declared runtime mode (RC-4 / SIM-88, server/app-mode.js): "demo" is
  // the public seeded instance (canned replays, nightly reset) and the ONLY
  // value that renders the demo chrome (DemoBanner + DemoTour). "real" - or
  // absent, tolerated for older payloads - means zero demo UI.
  appMode?: "demo" | "real";
  // Server-declared SSE capability (SIM-390 item 3): false on the pg-backed
  // cloud instances, where GET /api/stream is unavailable and the client must
  // not fire the EventSource at all (it polls instead). Absent (an older
  // server) is treated as available.
  sse?: boolean;
  // SIM-426: the companion SSC Product Hub's URL, or null when there is none
  // to link to. The hub only ever resolves for someone on the SAME machine as
  // that process - i.e. local (file-backed) dev - so the server declares this
  // null on every hosted instance (private OR public demo, both pg-backed;
  // same signal as `sse` above) and the client hides every hub deep link
  // (notification bell "Review decisions", related-entity chips, the Product
  // tab's handoff CTA) rather than rendering a dead localhost link. Absent (an
  // older server) is treated the same as null - no link.
  sscHubUrl?: string | null;
  // SIM-577: can this instance spawn a local `claude` process at all (the same
  // CLAUDE_BIN_PRESENT fact agentRunDispatch() is built from server-side)?
  // false on every pg/Railway image. JobChat and ChatCapture's assess-ticket
  // spinner both have no runner leg, so this is the one signal that tells them
  // whether to degrade honestly instead of 500ing or spinning forever. Absent
  // (an older server) is treated as available (optimistic default).
  agentSpawnAvailable?: boolean;
}

export type PhaseStatus = "shipped" | "in_progress" | "planned" | "later";

export interface RoadmapPhase {
  id: string;
  title: string;
  status: PhaseStatus;
  version?: string;
  shipped?: string;
  summary?: string;
  items: { text: string; done: boolean }[];
}

export interface Roadmap {
  product: string;
  version: string;
  updated: string;
  phases: RoadmapPhase[];
}

// ---------------------------------------------------------------------------
// Derived roadmap (ADR-012). A phase's `status` and the header product
// `version`/`updated` are DERIVED - the same derive-not-store discipline as
// ADR-010's raci.responsible (from task owners) and ADR-011's risk severity
// (from likelihood x impact) - so the Roadmap view is a pure function of the
// source-of-truth files (portfolio milestones + the changelog) and cannot
// drift from what actually shipped. The derivation is a pure client-side lib
// (src/lib/roadmapDerive.ts); roadmap.yaml stays the authored skeleton
// (titles, summaries, item checklists, the roadmap_phase links) and its stored
// `status`/`version` are treated as a tolerant fallback, never the truth.
// ---------------------------------------------------------------------------

// How a phase's status was DERIVED:
//   "release"    - phase.version is a released version in the changelog; a cut
//                  release cannot un-ship, so it wins over any milestone rollup.
//   "milestones" - rolled up from the phase's linked portfolio milestones
//                  (roadmap_phase === phase.id), with the authored item
//                  checklist as a completeness guard (all milestones done but an
//                  open item => still in_progress, never falsely shipped).
//   "authored"   - no released version AND no linked milestones, so the stored
//                  status is passed through unchanged (tolerant fallback - an
//                  un-charted phase like phase-1/backlog is never blanked).
export type PhaseStatusBasis = "release" | "milestones" | "authored";

// A RoadmapPhase whose `status` is the DERIVED value the board columns key off
// (it OVERRIDES the stored roadmap.yaml status - that is the whole point).
// `authoredStatus` preserves the stored value so a disagreement can be surfaced
// in the UI and asserted in tests; `basis` records how the status was derived;
// `linkedMilestones` is how many portfolio milestones pinned to this phase fed
// the rollup. Additive: extends RoadmapPhase, changes no existing field's shape.
export interface DerivedPhase extends RoadmapPhase {
  status: PhaseStatus; // DERIVED - overrides the stored value
  authoredStatus: PhaseStatus; // the stored roadmap.yaml value (for the affordance + tests)
  basis: PhaseStatusBasis;
  linkedMilestones: number;
}

// A Roadmap with DERIVED header + phases. `version`/`updated` come from the
// latest released changelog entry (not the hand-typed roadmap.version/updated);
// `authoredVersion` preserves the stored roadmap.version for reference. Tolerant:
// an empty/unparseable changelog falls back to the stored values.
export interface DerivedRoadmap {
  product: string;
  version: string; // DERIVED: latest released changelog version
  updated: string; // DERIVED: latest released changelog date
  authoredVersion: string; // the stored roadmap.version
  phases: DerivedPhase[];
}

export interface OrgGroup {
  id: string;
  label: string;
}

export interface OrgRole {
  id: string;
  title: string;
  kind: "human" | "orchestrator" | "agent";
  group: string;
  reports_to: string | null;
  status: string;
  agent_file: string | null;
  playbook?: string;
  mode?: string;
  one_liner: string;
  owns?: string[];
  collaborates_with?: string[];
  skills?: string[];
}

export interface ManagementLoopStep {
  id: string;
  label: string;
  detail: string;
}

export interface ManagementPrinciple {
  text: string;
  source: string;
}

export interface OrgManagement {
  template: string;
  philosophy_doc: string;
  recursive: boolean;
  shadow_mode: boolean;
  loop: ManagementLoopStep[];
  principles: ManagementPrinciple[];
}

export interface OrgData {
  version: number;
  updated: string;
  management?: OrgManagement;
  groups: OrgGroup[];
  roles: OrgRole[];
}

export type TaskType = "bug" | "feature" | "chore" | "spike";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

// One entry in a task's append-only comment log (the assess-ticket routine's
// CTO verdicts, and any future thread). `ts` is ISO 8601, stamped by the
// server on append. The API always serves `comments` as an array (loadTasks
// normalizes a missing key to []); on disk a task with no comments stays
// keyless.
export interface TaskComment {
  author: string;
  ts: string;
  body: string;
}

// Payload for appending ONE comment via PATCH /api/tasks/:id { comment }.
// author/body must be non-empty; the server sets ts (a client can never forge
// history). This append operation is the only way to grow the log after
// creation - PATCH has no whole-array `comments` replace.
export interface NewCommentInput {
  author: string;
  body: string;
}

// One image attached to a ticket (ADR-014). SERVER-MANAGED and UNFORGEABLE, the
// same posture as `completed` and a comment's `ts`: written ONLY by the upload
// endpoint (POST /api/tasks/:id/attachments), never accepted in a POST/PATCH
// task body and NOT in the server write whitelist, so `file`/`mime`/`bytes` are
// always the server's own computed values. `file` is the server-generated
// content-addressed basename "<sha256hex>.<ext>"; the on-disk path is
// docs/attachments/<taskId>/<file>, reconstructed (never trusted from the
// client) on read-back via GET /api/tasks/:id/attachments/:file. `name` is a
// display label only and is never used to build a path.
export interface TaskAttachment {
  file: string; // "<sha256hex>.<ext>" - server-generated, content-addressed
  name: string; // display label (original filename or "pasted image.<ext>")
  mime: string; // one of the allowlisted image MIMEs
  bytes: number;
  ts: string; // ISO 8601, server-stamped on upload
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  epic: string;
  priority: "high" | "medium" | "low";
  status: string;
  created: string;
  // Server-stamped completion date (ADR-013), YYYY-MM-DD LOCAL. Present IFF the
  // task is currently in the terminal "done" column: the server stamps it on the
  // transition INTO done and clears it on any move out. Server-managed and
  // UNFORGEABLE - it is NOT in the write whitelist, so a client value is ignored;
  // never send `completed` in a POST/PATCH body.
  completed?: string;
  // Execution-pillar refs (point UP into the portfolio). Optional and tolerant of
  // unresolvable values - a task may belong to a milestone (and thus a project).
  project?: string;
  milestone?: string;
  // Server-writable refs / prose already accepted by the task write path.
  owner?: string;
  delegated_by?: string;
  wbs?: string;
  user_story?: string;
  acceptance?: string;
  // Addressed-via-tickets join (docs/product-hub-ia-v2.md section 6): a ticket
  // that resolves a review/log finding carries `source: "review:<doc-id>"`,
  // e.g. "review:enablement-reviews/2026-07-01". Verbatim text - contains ":"
  // and "/", so it is NOT id-sanitized like project/milestone/owner/etc.
  source?: string;
  // Ticket-system (Linear-style) fields. All optional + backward-compatible: a task
  // without them round-trips untouched. `labels` + `checklist` are arrays/objects
  // validated for shape on write, stored as-is.
  type?: TaskType;
  labels?: string[];
  estimate?: number;
  assignee?: string;
  checklist?: ChecklistItem[];
  // Append-only comment log. Optional in the type (legacy payloads may omit
  // it) but the API always serves it as an array, [] when empty.
  comments?: TaskComment[];
  // Server-managed image attachments (ADR-014). Absent when the ticket has none
  // (saveTasks strips an empty array, like `comments`). NEVER client-settable:
  // written only by POST /api/tasks/:id/attachments, not in the write whitelist,
  // so it is deliberately absent from NewTaskInput.
  attachments?: TaskAttachment[];
}

// Permissive write DTO for creating a task (POST /api/tasks). Looser than Task so a
// plain-string form (priority/status typed `string`) is assignable; the server
// validates + defaults. Only `title` is required.
export interface NewTaskInput {
  title: string;
  detail?: string;
  epic?: string;
  priority?: string;
  status?: string;
  project?: string;
  milestone?: string;
  owner?: string;
  delegated_by?: string;
  wbs?: string;
  user_story?: string;
  acceptance?: string;
  source?: string;
  type?: TaskType;
  labels?: string[];
  estimate?: number;
  assignee?: string;
  checklist?: ChecklistItem[];
  // Initial comments, accepted at creation only (ts optional - the server
  // stamps one when absent). After creation, append via the `comment` PATCH
  // operation (api.addTaskComment).
  comments?: (NewCommentInput & { ts?: string })[];
}

// The stored RACI block on a project (ADR-010). Deliberately carries ONLY the
// genuinely new, hand-authored, non-duplicative edges:
//   - `accountable` is NOT stored here - the project's top-level `accountable`
//     field IS the single RACI Accountable (design section 0: do not duplicate).
//   - `responsible` is NOT stored here - it is DERIVED at read time from the
//     distinct task owners under the project (design section D / the involvement
//     join). Storing it would create a parallel store that could drift.
// Flat lists of agents.yaml role ids or the literal 'owner'; referential
// integrity is a read/test invariant, not a write-time gate.
export interface ProjectRaci {
  consulted: string[];
  informed: string[];
}

// A project stakeholder (ADR-011; PMBOK Stakeholder performance domain).
// OPTIONAL + additive and DEFERRED in ADR-010: present only when a project has a
// GENUINE external human party (e.g. a hiring manager or referrer on a Career
// Delivery job). For internal OS projects the sponsor + RACI already ARE the
// register, so the array is omitted (design section E: adding empty scored rows
// to internal projects is ceremony, not information). `name` is the required
// display label (an external human has no agents.yaml id); `role` is an OPTIONAL
// agents.yaml role id or 'owner' that, when set, resolves a title + a colored
// Avatar. interest/influence are the power/interest-grid axes and engagement is
// the PMBOK engagement-assessment level; the app CARRIES these to render the row
// but never COMPUTES a grid (no discriminating power at a scale of one human
// stakeholder). Referential integrity is a read/test invariant, not a write gate.
export interface Stakeholder {
  name: string;
  role?: string;
  interest?: "high" | "medium" | "low";
  influence?: "high" | "medium" | "low";
  engagement?: "unaware" | "resistant" | "neutral" | "supportive" | "leading";
}

// A project risk (ADR-011; PMBOK likelihood x impact). OPTIONAL + additive and
// DEFERRED in ADR-010: present only on a project with a genuine OPEN risk; a
// project with none omits the array. `description`, `likelihood`, and `impact`
// are required so a severity tint (lib/statusColors.riskSeverity) is always
// derivable; id/mitigation/status/owner are optional. `owner` is an agents.yaml
// role id; referential integrity is a read/test invariant, not a write gate
// (portfolio.yaml is hand-edited). Deliberately light: no probability/cost
// scoring, no per-line risk register beyond the qualitative matrix.
export interface Risk {
  id?: string;
  description: string;
  likelihood: "high" | "medium" | "low";
  impact: "high" | "medium" | "low";
  mitigation?: string;
  status?: "open" | "mitigating" | "closed";
  owner?: string;
}

export interface Project {
  id: string;
  name: string;
  department: string;
  owner: string;
  accountable: string;
  goal: string;
  status: string;
  target?: string;
  created?: string;
  // Operational-management fields (ADR-010; all OPTIONAL + additive, so existing
  // rows stay byte-valid). See docs/research/2026-07-03-operational-management.md.
  origin_request?: string | null; // intake-ledger request id (the charter link); null if chartered retroactively
  sponsor?: string; // role id or 'owner'; authorizes + resources. Default: owner
  project_manager?: string; // role id; runs the day-to-day MOS loop. Default: = accountable
  raci?: ProjectRaci;
  // Stakeholder register + risk list (ADR-011; OPTIONAL + additive, deferred in
  // ADR-010 until a project has a genuine external stakeholder or an open risk).
  // Rendered only when non-empty (graceful absence, like empty Consulted/Informed).
  stakeholders?: Stakeholder[];
  risks?: Risk[];
}

export interface Milestone {
  id: string;
  project: string;
  name: string;
  definition_of_done: string;
  target?: string;
  status: string;
  roadmap_phase?: string;
  created?: string;
}

export interface Portfolio {
  version: number;
  updated: string;
  projects: Project[];
  milestones: Milestone[];
}

export interface TaskBoardData {
  columns: string[];
  tasks: Task[];
}

export interface Discovery {
  "Date Found": string;
  Title: string;
  Employer: string;
  Sector: string;
  Track: string;
  Fit: string;
  Tailoring: string;
  Deadline: string;
  Location: string;
  Source: string;
  Link: string;
  Decision: string;
  Notes: string;
  tracked: boolean;
  // Canonical source join key stamped by the discover-jobs routine (Discovery
  // Sources v1). Optional + tolerant: legacy finds omit it, and the client join
  // falls back to matching the raw `Source` label through the alias index (the
  // same resolveFindSourceId logic the server uses).
  sourceId?: string;
}

export interface DiscoveryData {
  config: string[][];
  discoveries: Discovery[];
  // `runLog` (the xlsx Run Log sheet) is deliberately NOT declared here -
  // retired at the server boundary (audit F1c, t-1783183576657): it duplicated
  // the per-source run history docs/discovery-sources.yaml now owns
  // (ADR-016's `runs[]`, served by GET /api/discovery/sources), and nothing in
  // this codebase ever read it off the GET /api/discovery response.
  // Set by the server when Excel holds the workbook open: the read degrades to the
  // last good data (or empty) plus this flag + a "close Excel" message instead of a 500.
  locked?: boolean;
  message?: string;
}

// Triage verdict written back into a discovery row's Decision cell. "clear"
// BLANKS the cell (returns the find to undecided/New) - the persist side of
// undoing a decision whose prior state was undecided (t-1783178044080).
export type DiscoveryDecision = "skip" | "maybe" | "pursue" | "clear";

export interface DecideResult {
  ok: boolean;
  locked?: boolean;
  message?: string;
  title?: string;
  link?: string;
  decision?: DiscoveryDecision;
  output?: string;
}

// ---------------------------------------------------------------------------
// Discovery Sources (Channels) v1 — the managed-source console + triage inbox.
// GET /api/discovery/sources returns DerivedSource[] (stored config + DERIVED
// signals) plus the honest unassigned bucket. status / jobCount / newSinceVisit
// / pursuedPct / due / nextRunAt are ALL server-derived (never stored), so the
// health pill can never drift from the run history + finds on disk.
// ---------------------------------------------------------------------------
// "apify" is a DETERMINISTIC, server-side, cost-capped run path (no scout agent):
// the server calls Apify's REST API, maps the dataset to finds, and writes them
// through the SAME discovery.py path (docs/proposals/2026-07-06-apify-discovery-source.md).
export type SourceType = "employer" | "board" | "apify";
export type SourceCadence = "manual" | "daily" | "weekly" | "monthly";
export type SourceActive = "yes" | "maybe" | "no";
export type SourceStatus =
  | "never-run"
  | "healthy"
  | "running"
  | "due"
  | "stale"
  | "failed"
  | "paused";
export type RunOutcome = "succeeded" | "failed" | "incomplete" | "running";
export type RunTrigger = "manual" | "scheduled" | "all-due";

// SERVER-DERIVED (never stored) honesty classification of a source's newest
// terminal SUCCEEDED run (docs/data-schema.md schema v4 §2.2, server
// deriveLastRunSignal) - read DIRECTLY, never re-derived client-side (the
// contractGaps rule). Makes a leadsFound-0 run legible:
//   "leads"      - the run landed new leads.
//   "dedup"      - zero new but candidates WERE reviewed: the scrape worked,
//                  everything was already tracked/filtered (HEALTHY - the
//                  University Affairs case: leadsFound 0, candidatesReviewed 8).
//   "quiet"      - zero new and 0 candidates reviewed: the source genuinely
//                  listed nothing relevant. Healthy.
//   "unverified" - zero new and NO counters reported: numerically identical to
//                  a broken scrape - the honest "cannot tell" state.
// null (on DerivedSource) = no terminal succeeded run to classify.
export type LastRunSignal = "leads" | "dedup" | "quiet" | "unverified";

// v4 stored fetch strategy: how the scout should reach the posting list.
// fetchNote (free text) carries verified quirks the enum can't (University
// Affairs: "query params are cosmetic - filter client-side").
export type FetchMode = "direct-list" | "google-site" | "alert-email";

// SERVER-DERIVED (never stored) scrape-contract gap on a source (docs/data-schema.md
// §5 Decision 3a): the subset of the two required-but-freeform concepts NOT present
// (case-insensitively) in the source's declared outputFields[], computed ONCE
// server-side (server/index.js computeContractGaps) against one canonical alias
// table. Components read this field directly - they never re-guess the alias match.
export type ContractGap = "direct-link" | "deadline";

// One entry in a source's append-only instruction-proposal log (docs/
// data-schema.md §5 Decision 4, DISC-W3). SERVER-MANAGED and UNFORGEABLE - the
// same posture as TaskComment/TaskAttachment: `id` ("ip-<epochms>"), `ts`,
// `status`, and `resolvedAt` are stamped by the server (a client-sent value is
// ignored), and resolution is ONE-WAY (pending -> approved | rejected; a
// re-resolve is a 400). `ownerComment` is the owner note that triggered the
// propose run (may be "" - a cold start is legitimate); `rationale` is the
// scout's short "why this changes"; `rejectionReason` is required on reject and
// feeds the NEXT propose run's prompt (a rejected proposal is archived, never
// deleted). Served on every source as `instructionProposals`, newest-first.
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface InstructionProposal {
  id: string;
  ts: string;
  ownerComment: string;
  proposedInstructions: string;
  rationale: string;
  status: ProposalStatus;
  resolvedAt?: string;
  rejectionReason?: string;
}

// One persisted run in a source's history (newest-first, capped at 20). The
// server appends an optimistic { outcome:"running", leadsFound:null } record the
// instant a run launches and flips it to its terminal outcome + lead counts on
// close, so a running source is observable by re-reading GET /api/discovery/sources.
export interface RunRecord {
  runId: string;
  startedAt: string;
  durationMs: number | null;
  outcome: RunOutcome;
  leadsFound: number | null;
  leadsNew: number | null;
  // v4 honesty counters - AGENT-REPORTED via POST .../runs/:runId/report (only
  // the scout knows what it reviewed). Absent/null = unreported (a pre-v4 run,
  // or the scout skipped the best-effort report) - never a fake 0.
  candidatesReviewed?: number | null;
  alreadyTracked?: number | null;
  filteredOut?: number | null;
  trigger: RunTrigger;
  errorReason?: string;
}

export interface DerivedSource {
  id: string;
  name: string;
  type: SourceType;
  sector: string;
  active: SourceActive;
  urls: string[];
  cadence: SourceCadence;
  // v4 stored fetch strategy (always served: null / "" when unset).
  fetchMode: FetchMode | null;
  fetchNote: string;
  instructions: string;
  outputFields: string[];
  aliases: string[];
  // Optional closed-enum linkage to the 7 canonical track keys GET /api/config
  // serves (docs/data-schema.md §5 Decision 1). Absent/empty = "all tracks" (a
  // generic board genuinely serves every track); a source with 2+ tracks is TAG
  // membership (serves each), never an exclusive "primary track" owner.
  tracks: string[];
  lastRunAt: string | null;
  lastVisitedAt: string | null;
  notes: string;
  runs: RunRecord[]; // newest-first, <= 20
  status: SourceStatus;
  due: boolean;
  nextRunAt: string | null;
  // v4: SERVER-DERIVED classification of the newest terminal succeeded run
  // (see LastRunSignal above; null = nothing to classify). The health pill and
  // last-run caption read this directly so a healthy dedup-heavy zero can
  // never render like a broken/unverified scrape.
  lastRunSignal: LastRunSignal | null;
  jobCount: number;
  newSinceVisit: number;
  pursuedPct: number; // 0-100
  contractGaps: ContractGap[];
  // apify run path (type:"apify" only). The stored actor + run input; served
  // back so the Edit form round-trips them. `fieldMap` is optional per-actor
  // output-field alias overrides for the server's defensive mapper.
  actorId?: string;
  input?: Record<string, unknown>;
  fieldMap?: Record<string, string>;
  // SERVER-COMPUTED (never stored): whether Apify is enabled AND an APIFY_TOKEN
  // is present, so the client can gate Run-now on a real run being possible.
  // Presence only, never the token value. Absent for non-apify sources.
  apifyConfigured?: boolean;
  // Instruction-proposal loop (DISC-W3). `instructionProposals` is the
  // append-only SERVER-managed log, served newest-first like `runs`.
  // `instructionsApprovedFrom` + `instructionsUpdatedAt` are the provenance
  // stamps (display rule: both set = "Approved <date> from a proposal";
  // instructionsUpdatedAt alone = "Set manually <date>" - a manual edit clears
  // instructionsApprovedFrom and re-stamps instructionsUpdatedAt so provenance
  // can never lie; neither = never set via the loop). `proposeRunId` is DERIVED
  // live process state - the id of the in-flight propose-instructions run,
  // null when idle - so the "Reviewing your note…" busy state survives a page
  // reload instead of living only in the client.
  instructionProposals: InstructionProposal[];
  instructionsApprovedFrom: string | null;
  instructionsUpdatedAt: string | null;
  proposeRunId: string | null;
}

// A raw find label that matched no managed source, grouped for the "unassigned
// finds" prompt ("add a source or alias for these").
export interface UnassignedSource {
  label: string;
  count: number;
}

export interface SourcesData {
  sources: DerivedSource[];
  unassignedCount: number;
  unassignedSources: UnassignedSource[];
  // Set when the workbook is open in Excel: the source registry still serves;
  // finds counts reflect the last-good read (or 0). Render as a soft note.
  locked?: boolean;
  message?: string;
}

// Write DTO for POST / PATCH a source. Only `name` is required on POST; PATCH
// accepts any subset except `id`. `lastRunAt` / `runs` are server-managed and
// ignored if sent. A present-but-invalid enum -> 400 { error }; an explicit id
// collision -> 409. type:"apify" additionally requires a non-empty `actorId`
// (else 400) and accepts `input`/`fieldMap` only as plain objects (else 400).
export interface SourceInput {
  name?: string;
  id?: string;
  type?: SourceType;
  sector?: string;
  active?: SourceActive;
  cadence?: SourceCadence;
  url?: string;
  urls?: string[];
  instructions?: string;
  outputFields?: string[];
  aliases?: string[];
  // Closed enum (the 7 canonical track keys) - a present-but-invalid value is a
  // 400, same posture as type/sector/active/cadence. Absent/[] = "all tracks".
  tracks?: string[];
  notes?: string;
  lastVisitedAt?: string | null;
  // apify-only (type:"apify"). `actorId` is the Apify actor (username~actorName);
  // `input` is the actor run-input JSON object; `fieldMap` is optional per-actor
  // output-field alias overrides. Ignored/absent for non-apify types.
  actorId?: string;
  input?: Record<string, unknown>;
  fieldMap?: Record<string, string>;
}

// Append-only activity feed record. Every record carries { ts, kind }; the rest is
// kind-specific. Routine runs emit kind:"run" (start + close); the hook script
// (ops/activity-log-append.mjs) emits kind:"delegation". Open-ended for future kinds.
export type ActivityKind = "run" | "delegation";

export interface ActivityRecord {
  ts: string;
  kind: ActivityKind | string;
  // run records
  runId?: string;
  routine?: string;
  label?: string;
  jobId?: string | null;
  status?: string;
  exitCode?: number | null;
  // delegation / future records may carry arbitrary extra fields
  [k: string]: unknown;
}

// waiting-for-runner / stalled (SIM-562): honest substates of a queued
// runner-routed run - no runner seen recently, and unclaimed past the stalled
// threshold, respectively. Neither is terminal (see isRunPending below); both
// exist so the UI can stop pretending a run is actively RUNNING (an animated
// bar, ticked steps) when nothing has claimed it yet.
export type RunStatus = "running" | "waiting-for-runner" | "stalled" | "done" | "failed" | "stopped";

// The one place "is this run still pending" is decided - useRunPolling (keep
// polling), RunPanel/RunDock (elapsed timer, dismiss-X gating) all key off
// this so they can never quietly disagree about which statuses are terminal.
const RUN_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["done", "failed", "stopped"]);
export function isRunPending(status: RunStatus): boolean {
  return !RUN_TERMINAL_STATUSES.has(status);
}

// Finish stats off the CLI's terminal `result` event (t-1783650926662).
// Each field is null when the CLI did not report it.
export interface RunStats {
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  // SIM-574 (JP-2): token usage, when the CLI emits a `usage` block (real
  // invocations - not the demo's hand-authored transcripts). null when absent,
  // never fabricated. Not yet surfaced in RunPanel (backend-only so far).
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheCreate: number | null } | null;
}

export interface RoutineRun {
  id: string;
  routine: string;
  label: string;
  jobId: string | null;
  prompt: string;
  status: RunStatus;
  output: string;
  exitCode: number | null;
  startedAt: string;
  // Live progress (t-1783650926662), folded off the agent's own stream-json
  // events server-side. All optional: a record missing them degrades to the
  // pre-progress UI (indeterminate sweep, no milestones).
  currentActivity?: string | null; // what the agent is doing right now
  stages?: string[]; // the routine's milestone labels (empty/absent = none defined)
  stageIndex?: number; // furthest milestone reached (-1 = none yet)
  expectedMs?: number | null; // median duration of recent successful runs of this routine
  stats?: RunStats | null; // set once the terminal result event lands
}

// Optional YAML frontmatter parsed off a doc's Markdown (server/lib.js
// parseFrontmatter), surfaced as `meta` on DocSummary/DocContent. All keys
// optional. Schema (docs/product-hub-ia-v2.md sections 4 + 6):
//   type    - "source" | "review" | "log" | "brief" | "debrief"
//   agent   - source agent role id (a docs/agents.yaml `id`)
//   recs    - integer: recommendation/finding count a review/log declares
//   status  - "shipped" | "deferred" | "mixed" (brief/debrief verdict)
//   date    - "YYYY-MM-DD"
//   release - e.g. "v0.12.0"
// Authored by hand or a routine, never written by the app; the index
// signature tolerates whatever extra YAML a doc actually declares.
export interface DocMeta {
  type?: "source" | "review" | "log" | "brief" | "debrief";
  agent?: string;
  recs?: number;
  status?: "shipped" | "deferred" | "mixed";
  date?: string;
  release?: string;
  [k: string]: unknown;
}

// One entry in the docs browser tree (GET /api/docs). `name` is the id GET
// /api/doc/:name expects back - a bare id ("governance") or "routines/<id>".
// `meta` is present only when the doc opens with a YAML frontmatter block;
// `title` always comes from the BODY's H1 (or a prettified filename), never
// from meta, so the two can never desync.
export interface DocSummary {
  name: string;
  title: string;
  group: string;
  meta?: DocMeta;
}

export interface DocContent {
  name: string;
  content: string; // frontmatter-stripped body
  meta?: DocMeta;
}

// ---------------------------------------------------------------------------
// Usage-journey telemetry read model (ADR-017). The small aggregate served by
// GET /api/telemetry/summary (server/index.js summarizeTelemetry) - the ONLY
// telemetry read surface in v1 (no raw-event dump). byKind is the full closed
// enum map (view/action/run), pre-seeded so all three kinds are always present;
// bySurface / byName are top-N descending; malformed counts torn jsonl lines.
// firstTs / lastTs are ISO (null when there is no usage yet). EVENTS, NEVER
// CONTENT: every field is a count, an id, or a timestamp - no user text.
// ---------------------------------------------------------------------------
export interface TelemetrySummary {
  totalEvents: number;
  firstTs: string | null;
  lastTs: string | null;
  byKind: Record<string, number>;
  bySurface: { surface: string; count: number }[];
  byName: { name: string; count: number }[];
  malformed: number;
}

export interface BatchStatus {
  batchId: string;
  total: number;
  running: number;
  done: number;
  failed: number;
  queued: number;
  runs: { jobId: string; status: string }[];
}

// ---------------------------------------------------------------------------
// Notification feed (GET /api/notifications). A read-mostly event stream the
// server derives from data it already records: the durable activity log
// (run_finished / wave_done, which carry a REAL timestamp) plus a diff of
// tasks/portfolio against a persisted baseline (task_added / task_done /
// project_added, which are "since last acknowledge" detections with NO reliable
// time - present them as "new", not a clock). The `ref` is a discriminated
// union keyed by `kind` so a consumer can build a click-through per event type.
// ---------------------------------------------------------------------------
export type NotificationType =
  | "run_finished"
  | "wave_done"
  | "task_added"
  | "task_done"
  | "project_added"
  | "login_failed";

export interface NotificationRunRef {
  kind: "run";
  runId: string;
  routine: string;
  jobId: string | null;
  status: string;
}

export interface NotificationBatchRef {
  kind: "batch";
  batchId: string;
  total: number;
  done: number;
  // Genuine failures ONLY (t-1783091385623): a user-stopped batch member is
  // counted in `stopped`, not lumped into `failed`, so a deliberately stopped
  // wave never reads as blocked.
  failed: number;
  stopped: number;
}

export interface NotificationTaskRef {
  kind: "task";
  id: string;
}

export interface NotificationProjectRef {
  kind: "project";
  id: string;
}

// SIM-386 failed-login visibility: one event per alert window (the server's
// threshold fold guarantees no per-failure spam); `count` is the window's
// failure count. Carries a REAL activity-log timestamp, so it is timed.
export interface NotificationAuthRef {
  kind: "auth";
  count: number;
}

export type NotificationRef =
  | NotificationRunRef
  | NotificationBatchRef
  | NotificationTaskRef
  | NotificationProjectRef
  | NotificationAuthRef;

export interface Notification {
  id: string;
  type: NotificationType;
  // ISO 8601. Trustworthy as a clock ONLY for run_finished / wave_done; for the
  // task_/project_ detection events it is a detection stamp, so the UI keys off
  // the type (see lib/notifications.isTimedNotification) instead of showing it.
  ts: string;
  title: string;
  ref: NotificationRef;
  unread: boolean;
}

export interface NotificationFeed {
  events: Notification[];
  unread: number;
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Intake ledger (GET/POST/PATCH /api/requests, ADR-009). The ORIGIN node of the
// orchestration chain: the VERBATIM owner/chatbot prompt, the CTO assessment,
// and the ids of the tasks/projects it spawned. App-managed store
// docs/requests.yaml. `spawned` and `origin_request` (on Project) are the two
// ends of the same edge, so the chain is verifiable from either side.
// ---------------------------------------------------------------------------
export interface SpawnedRefs {
  tasks: string[]; // ids of tasks this request spawned (deduped)
  projects: string[]; // ids of projects this request spawned (deduped)
}

export interface IntakeRequest {
  id: string; // r-<epochms>, server-stamped
  text: string; // VERBATIM prompt - never id-sanitized, never trimmed of content
  source: "session" | "chatbot";
  created: string; // YYYY-MM-DD (localDateISO at creation)
  ts: string; // ISO 8601
  assessment?: string; // CTO verdict / plan; present once assessed
  spawned: SpawnedRefs;
}

export interface RequestsData {
  requests: IntakeRequest[];
}

// Write DTO for POST /api/requests. Only `text` is required (non-blank); the
// server stamps id/created/ts and defaults source to 'session'. `spawned` is
// merged + deduped on PATCH, never replaced.
export interface NewRequestInput {
  text: string;
  source?: "session" | "chatbot";
  assessment?: string;
  spawned?: Partial<SpawnedRefs>;
}
