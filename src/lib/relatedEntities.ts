import type { Portfolio, Project, Task } from "../types";

// Related-entity derivation for a CTO assessment (t-1783255872307 +
// t-1783256391885): given an assessed ticket and the assessment/output text,
// derive the entities the owner should be able to OPEN from that surface -
// the ticket itself, its epic/project (the charter surface), and any other
// tasks/projects the text references. Pure + DOM-free so it unit-tests
// node-env style (the chatbotQueue.ts convention); the three chip surfaces
// (RunPanel, ChatCapture, and IntakeView's stored spawned ids) all ride the
// same vocabulary, so what counts as "related" is decided in exactly one
// place.
//
// Resolvability rule (load-bearing): a chip is only emitted when it can
// actually be OPENED. A project chip must resolve to a real portfolio project
// (ProjectsView falls back to its default selection on an unknown id, which
// would read as a lie); a text-referenced task chip must resolve on the board
// (TaskBoard scroll-focus on a missing id lands nowhere). The one exception is
// the assessed ticket itself, which is always emitted (it was just filed, and
// even a label-less id chip is an honest handle to it).

// The navigation payload of the app's deep-link primitive: "open the Product
// Hub at the page for this entity". App.tsx owns it as `hubFocus` state,
// ProductHub consumes-and-clears it, TaskBoard/ProjectsView apply it.
// Prop-driven on purpose - no router dependency.
export interface EntityRef {
  kind: "task" | "project";
  id: string;
}

// A chip: an openable entity plus its human label (task title / project name,
// falling back to the raw id so a resolvable-but-unnamed ref never blanks).
export interface RelatedEntity extends EntityRef {
  label: string;
}

// Ticket ids are `t-<epochms>` (server-stamped). A routine run's `jobId` is
// EITHER a ticket id (assess-ticket / work-ticket scope) or a job folder id
// (first-draft-job scope) - this is the one test that tells them apart, so
// RunPanel gates its chip strip on it.
const TICKET_ID_RE = /^t-\d+$/;

export function isTicketId(id: string | null | undefined): id is string {
  return typeof id === "string" && TICKET_ID_RE.test(id);
}

// Task-id references inside free text. 6+ digits so a stray "t-1" list marker
// can never read as a ticket ref; real ids carry 13 (epoch ms).
const TASK_REF_RE = /\bt-\d{6,}\b/g;

// Escape a portfolio id for use inside a RegExp. Ids are kebab slugs today,
// but escaping keeps a future odd character from turning into regex syntax.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every task-id-shaped reference in the text, deduped, in first-mention order.
// Callers still validate each id against the live board before linking it.
export function extractTaskIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(TASK_REF_RE)) seen.add(m[0]);
  return [...seen];
}

// Project references in the text. Project ids here are NAMED slugs
// ("prj-connected-execution", "discovery-sources"), not a uniform p-<digits>
// shape, so a free-form pattern cannot find them without false positives.
// Instead we scan for each KNOWN portfolio id with slug boundaries on both
// sides - which both covers the dominant prj-* shape and guarantees every hit
// is resolvable (no dead chips). The boundary check keeps a longer slug from
// matching its prefix ("discovery-sources-v2" never reads as
// "discovery-sources"). Returns portfolio order.
export function extractProjectIds(text: string, portfolio: Portfolio | null): string[] {
  if (!portfolio || !text) return [];
  const out: string[] = [];
  for (const p of portfolio.projects) {
    const re = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(p.id)}(?![A-Za-z0-9-])`);
    if (re.test(text)) out.push(p.id);
  }
  return out;
}

// A task's `epic` resolved to a portfolio project, when that mapping genuinely
// exists. Two shapes occur in the data: the epic IS a project id
// ("discovery-sources", "usage-telemetry"), or the project id is the epic
// prefixed "prj-" ("product-hub-ia-v2" -> "prj-product-hub-ia-v2"). Anything
// else ("general", "infra", ...) is a plain category with no charter surface -
// null, so no chip is invented for it.
export function resolveEpicProject(epic: string | undefined, portfolio: Portfolio | null): Project | null {
  if (!epic || !portfolio) return null;
  return (
    portfolio.projects.find((p) => p.id === epic) ??
    portfolio.projects.find((p) => p.id === `prj-${epic}`) ??
    null
  );
}

// The project a ticket belongs to, trying each edge in strength order and
// taking the first that RESOLVES: the direct `project` ref, the `milestone`
// ref's owning project (the same join ProjectChip's resolveProjectId uses),
// then the epic mapping above. An unresolvable stronger ref falls through
// rather than blocking a resolvable weaker one.
export function ticketProject(task: Task | undefined, portfolio: Portfolio | null): Project | null {
  if (!task || !portfolio) return null;
  if (task.project) {
    const direct = portfolio.projects.find((p) => p.id === task.project);
    if (direct) return direct;
  }
  if (task.milestone) {
    const m = portfolio.milestones.find((ms) => ms.id === task.milestone);
    const viaMilestone = m ? portfolio.projects.find((p) => p.id === m.project) : undefined;
    if (viaMilestone) return viaMilestone;
  }
  return resolveEpicProject(task.epic, portfolio);
}

// The full chip strip for one assessment, deduped, in a fixed honest order:
// the assessed ticket first, its project second (the charter surface), then
// the other tasks/projects the text references. `ticketId` is the run's
// `jobId` (when isTicketId) or the report row's task id; null derives from
// text alone (the non-ticket-scoped case).
export function relatedEntitiesForAssessment(input: {
  ticketId: string | null;
  text: string;
  tasks: Task[];
  portfolio: Portfolio | null;
}): RelatedEntity[] {
  const { ticketId, text, tasks, portfolio } = input;
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const out: RelatedEntity[] = [];
  const seen = new Set<string>();
  const push = (e: RelatedEntity) => {
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // 1. The assessed ticket itself - always first, label falls back to the id.
  if (isTicketId(ticketId)) {
    push({ kind: "task", id: ticketId, label: taskById.get(ticketId)?.title ?? ticketId });
  }

  // 2. Its epic/project, only when genuinely resolvable in the portfolio.
  const project = isTicketId(ticketId) ? ticketProject(taskById.get(ticketId), portfolio) : null;
  if (project) push({ kind: "project", id: project.id, label: project.name });

  // 3. Task ids referenced in the text - only ones that resolve on the board
  //    (the seen-set drops a re-mention of the assessed ticket).
  for (const id of extractTaskIds(text)) {
    const t = taskById.get(id);
    if (t) push({ kind: "task", id, label: t.title });
  }

  // 4. Project ids referenced in the text (already resolvability-guaranteed).
  for (const id of extractProjectIds(text, portfolio)) {
    const p = portfolio?.projects.find((pp) => pp.id === id);
    if (p) push({ kind: "project", id, label: p.name });
  }

  return out;
}
