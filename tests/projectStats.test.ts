import { describe, it, expect } from "vitest";
import { progressStats, rankedProjects, statusFromTasks, statusRank } from "../src/lib/projectStats";
import type { Project, Task } from "../src/types";

// Unit tests for the pure project/task progress and ranking helpers
// (docs/pm-conventions.md progress aggregation), extracted out of
// ProjectsView. Hand-built fixtures, no fetch, no DOM. Layer: unit.

const baseTask = {
  detail: "",
  epic: "",
  priority: "high" as const,
  created: "2026-07-01",
};

function task(id: string, status: string): Task {
  return { id, title: id, ...baseTask, status };
}

function project(id: string, status: string): Project {
  return { id, name: id, department: "eng", owner: "cto", accountable: "cto", goal: "", status };
}

describe("progressStats", () => {
  it("counts done/active/blocked out of the total and computes a rounded percent", () => {
    const tasks = [task("t1", "done"), task("t2", "done"), task("t3", "in_progress"), task("t4", "todo")];

    const stats = progressStats(tasks);

    expect(stats).toEqual({ total: 4, done: 2, active: 1, blocked: 0, pct: 50 });
  });

  it("counts a blocked task in its own segment, distinct from done and active", () => {
    const tasks = [task("t1", "done"), task("t2", "blocked"), task("t3", "in_review")];

    const stats = progressStats(tasks);

    expect(stats.done).toBe(1);
    expect(stats.active).toBe(1); // in_review counts as active
    expect(stats.blocked).toBe(1);
    expect(stats.total).toBe(3);
  });

  it("returns all-zero stats (and a 0% - not NaN - pct) for an empty task list", () => {
    expect(progressStats([])).toEqual({ total: 0, done: 0, active: 0, blocked: 0, pct: 0 });
  });
});

describe("statusFromTasks", () => {
  it("is 'not_started' for an empty task list", () => {
    expect(statusFromTasks([])).toBe("not_started");
  });

  it("is 'done' when every task is done", () => {
    expect(statusFromTasks([task("t1", "done"), task("t2", "done")])).toBe("done");
  });

  it("is 'blocked' when any task is blocked, even if the rest are done", () => {
    expect(statusFromTasks([task("t1", "done"), task("t2", "blocked")])).toBe("blocked");
  });

  it("is 'in_progress' when a task is in_progress or in_review and none are blocked", () => {
    expect(statusFromTasks([task("t1", "todo"), task("t2", "in_progress")])).toBe("in_progress");
    expect(statusFromTasks([task("t1", "in_review")])).toBe("in_progress");
  });

  it("is 'not_started' when tasks exist but none are done, blocked, or in flight", () => {
    expect(statusFromTasks([task("t1", "todo"), task("t2", "backlog")])).toBe("not_started");
  });
});

describe("statusRank", () => {
  it("ranks active/in_progress/blocked statuses first (0)", () => {
    expect(statusRank("active")).toBe(0);
    expect(statusRank("in_progress")).toBe(0);
    expect(statusRank("blocked")).toBe(0);
  });

  it("ranks done/shipped/complete/archived statuses last (2)", () => {
    expect(statusRank("done")).toBe(2);
    expect(statusRank("shipped")).toBe(2);
    expect(statusRank("complete")).toBe(2);
    expect(statusRank("archived")).toBe(2);
  });

  it("ranks everything else (queued/unknown) in the middle (1)", () => {
    expect(statusRank("planned")).toBe(1);
    expect(statusRank("proposed")).toBe(1);
    expect(statusRank("some-future-status")).toBe(1);
  });
});

describe("rankedProjects", () => {
  it("puts active work before done work regardless of input order", () => {
    const projects = [project("p-done", "done"), project("p-active", "active")];

    const ranked = rankedProjects(projects);

    expect(ranked.map((p) => p.id)).toEqual(["p-active", "p-done"]);
  });

  it("orders active/blocked, then queued, then done in one pass", () => {
    const projects = [
      project("p-done", "done"),
      project("p-planned", "planned"),
      project("p-blocked", "blocked"),
      project("p-active", "active"),
    ];

    const ranked = rankedProjects(projects);

    expect(ranked.map((p) => p.id)).toEqual(["p-blocked", "p-active", "p-planned", "p-done"]);
  });

  it("preserves original order for projects that tie on rank (stable sort)", () => {
    const projects = [project("p-a", "active"), project("p-b", "active"), project("p-c", "active")];

    const ranked = rankedProjects(projects);

    expect(ranked.map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
  });

  it("does not mutate the input array", () => {
    const projects = [project("p-done", "done"), project("p-active", "active")];
    const copy = [...projects];

    rankedProjects(projects);

    expect(projects).toEqual(copy);
  });
});
