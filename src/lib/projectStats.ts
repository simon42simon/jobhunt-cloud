// Pure task/project progress and ranking helpers (docs/pm-conventions.md
// progress aggregation), extracted out of ProjectsView so they are
// unit-testable without mounting React. No JSX, no fetch - callers pass in
// already-fetched task/project arrays.

import type { Project, Task } from "../types";

export interface ProgressStats {
  total: number;
  done: number;
  active: number;
  blocked: number;
  pct: number;
}

export function progressStats(tasks: Task[]): ProgressStats {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const active = tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { total, done, active, blocked, pct };
}

// A "what stage are these tasks in" status for a group that has no status of
// its own (the synthetic "Unscheduled tasks" bucket in ProjectsView).
export function statusFromTasks(tasks: Task[]): string {
  if (tasks.length === 0) return "not_started";
  if (tasks.every((t) => t.status === "done")) return "done";
  if (tasks.some((t) => t.status === "blocked")) return "blocked";
  if (tasks.some((t) => t.status === "in_progress" || t.status === "in_review")) return "in_progress";
  return "not_started";
}

// Project ranking: bring what needs attention to the top (Cloudscape's "order
// by usefulness / relevance" principle, applied to cards instead of nav
// links) - active/blocked work first, then queued, then settled/done work.
export function statusRank(status: string): number {
  if (status === "active" || status === "in_progress" || status === "blocked") return 0;
  if (status === "done" || status === "shipped" || status === "complete" || status === "archived") return 2;
  return 1;
}

// Stable sort by rank, ties broken by original (YAML) order.
export function rankedProjects(projects: Project[]): Project[] {
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => statusRank(a.p.status) - statusRank(b.p.status) || a.i - b.i)
    .map(({ p }) => p);
}
