// The participant / involvement model (docs/pm-conventions.md section 9). Pure
// joins over the three files that already carry the data (portfolio.yaml,
// tasks.yaml, activity-log.jsonl) keyed on the agents.yaml role id. No React,
// no fetch - callers (ProjectsView, TeamView) pass in already-fetched data so
// this stays trivially unit-testable.

import type { ActivityRecord, Portfolio, Project, Task } from "../types";

// The one id-normalization rule the frontend needs: activity-log.jsonl writes
// routine:"manager" for CTO-level orchestration (the *template* name at
// ~/.claude/agents/manager.md, not an agents.yaml role id). The org role id
// for that seat is "cto". Every other routine value already equals its
// agents.yaml role id verbatim and needs no translation.
export function normalizeRoutine(routine: string | null | undefined): string {
  if (!routine) return "";
  return routine === "manager" ? "cto" : routine;
}

export interface InvolvementSources {
  portfolio: Portfolio;
  tasks: Task[];
  activity: ActivityRecord[];
}

export interface AgentInvolvement {
  projects: Project[];
  tasks: Task[];
  activity: ActivityRecord[];
}

// An agent's (a role id in agents.yaml) involvement is the union of:
//  1. every project where it is owner or accountable,
//  2. every task where it is owner or delegated_by,
//  3. every activity-log record whose routine (after the alias above) equals it.
export function agentInvolvement(agentId: string, sources: InvolvementSources): AgentInvolvement {
  const { portfolio, tasks, activity } = sources;
  const projects = portfolio.projects.filter((p) => p.owner === agentId || p.accountable === agentId);
  const agentTasks = tasks.filter((t) => t.owner === agentId || t.delegated_by === agentId);
  const agentActivity = activity.filter((a) => normalizeRoutine(a.routine) === agentId);
  return { projects, tasks: agentTasks, activity: agentActivity };
}

export interface ParticipantSources {
  portfolio: Portfolio;
  tasks: Task[];
}

// A project's participants are the deduped union of its owner + accountable,
// plus the owner + delegated_by of every task whose project (or whose
// milestone's project) matches. A participant is a role, not a task - the same
// id can qualify via more than one route and is only listed once. Order is
// deterministic: project owner, then accountable, then each matching task's
// owner/delegated_by in task order (first-seen wins).
export function projectParticipants(projectId: string, sources: ParticipantSources): string[] {
  const { portfolio, tasks } = sources;
  const project = portfolio.projects.find((p) => p.id === projectId);
  const milestoneIds = new Set(
    portfolio.milestones.filter((m) => m.project === projectId).map((m) => m.id)
  );

  const seen = new Set<string>();
  const out: string[] = [];
  function add(id: string | null | undefined) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  }

  if (project) {
    add(project.owner);
    add(project.accountable);
  }
  for (const t of tasks) {
    const belongsToProject = t.project === projectId || (!!t.milestone && milestoneIds.has(t.milestone));
    if (!belongsToProject) continue;
    add(t.owner);
    add(t.delegated_by);
  }
  return out;
}

// The RACI "Responsible" set for a project (ADR-010 / operational-management
// design section D, charter AC-J6-2): the DISTINCT `owner`s of the tasks whose
// project (or whose milestone's project) matches, EXCLUDING the project's own
// owner and accountable. This is the SAME task->project join as
// projectParticipants, deliberately narrowed to task owners only and then
// stripped of the project owner + accountable. Those two are the RACI
// Accountable / project lead (the top-level `owner` / `accountable` fields), so
// surfacing them here would double-count the Accountable as Responsible. We
// look the project up and pre-seed the `seen` set with its owner + accountable,
// so any task owner equal to either is skipped. Each task's delegated_by is
// excluded by construction: only `t.owner` is ever added. Derived at read time,
// never stored, so the board stays the one source of truth (design section D:
// reuse the board, never mirror it). Order is task order, first-seen wins.
export function projectResponsible(projectId: string, sources: ParticipantSources): string[] {
  const { portfolio, tasks } = sources;
  const project = portfolio.projects.find((p) => p.id === projectId);
  const milestoneIds = new Set(
    portfolio.milestones.filter((m) => m.project === projectId).map((m) => m.id)
  );
  // Pre-seed the dedup set with the project owner + accountable so a task owner
  // that equals either is filtered out (they are the RACI Accountable, not a
  // separate Responsible). delegated_by needs no seeding: it is never added.
  const seen = new Set<string>();
  if (project) {
    if (project.owner) seen.add(project.owner);
    if (project.accountable) seen.add(project.accountable);
  }
  const out: string[] = [];
  for (const t of tasks) {
    const belongsToProject = t.project === projectId || (!!t.milestone && milestoneIds.has(t.milestone));
    if (!belongsToProject || !t.owner || seen.has(t.owner)) continue;
    seen.add(t.owner);
    out.push(t.owner);
  }
  return out;
}
