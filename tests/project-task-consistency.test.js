import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { computeProjectTaskConsistency, resolveDataDir } from "../server/lib.js";

// Deterministic guard for project<->task linkage (ADR-021, t-1783371847653):
// answers "can a project be marked done with no real work behind it?" and surfaces
// genuine ROUTE breakage (dangling/orphan refs) so a real bug is not mistaken for a
// data gap. Fixture cases pin the detection; the live-data cases guard the real SoT.

const projects = (...p) => p;
const P = (id, status, over = {}) => ({ id, name: id, status, ...over });
const M = (id, project, status = "done") => ({ id, project, status });

describe("computeProjectTaskConsistency (fixtures)", () => {
  it("HIGH-flags a done project with ZERO linked tasks (direct or via milestone)", () => {
    const portfolio = { projects: projects(P("prj-a", "done")), milestones: [] };
    const out = computeProjectTaskConsistency(portfolio, []);
    expect(out.checked).toBe(true);
    const f = out.findings.find((x) => x.kind === "done-project-no-tasks");
    expect(f).toBeTruthy();
    expect(f.severity).toBe("high");
    expect(f.projectId).toBe("prj-a");
  });

  it("resolves a task to its project via the milestone's parent (the app's rule) - no false 'no tasks' flag", () => {
    const portfolio = { projects: projects(P("prj-a", "done")), milestones: [M("prj-a-m1", "prj-a")] };
    // Task links only via milestone (no direct project ref) - must still count.
    const out = computeProjectTaskConsistency(portfolio, [{ id: "t1", status: "done", milestone: "prj-a-m1" }]);
    expect(out.findings.some((f) => f.kind === "done-project-no-tasks")).toBe(false);
  });

  it("HIGH-flags a done project whose linked tasks are not all terminal (a project cannot be more done than its work)", () => {
    const portfolio = { projects: projects(P("prj-a", "done")), milestones: [] };
    const out = computeProjectTaskConsistency(portfolio, [
      { id: "t1", status: "done", project: "prj-a" },
      { id: "t2", status: "in_progress", project: "prj-a" },
    ]);
    const f = out.findings.find((x) => x.kind === "done-project-incomplete-tasks");
    expect(f).toBeTruthy();
    expect(f.message).toContain("t2");
  });

  it("does NOT flag a done project whose linked tasks are all terminal (done/canceled)", () => {
    const portfolio = { projects: projects(P("prj-a", "done")), milestones: [] };
    const out = computeProjectTaskConsistency(portfolio, [
      { id: "t1", status: "done", project: "prj-a" },
      { id: "t2", status: "canceled", project: "prj-a" },
    ]);
    expect(out.findings).toHaveLength(0);
  });

  it("does NOT flag an in-progress project with no tasks (the gate is only for 'done' projects)", () => {
    const portfolio = { projects: projects(P("prj-a", "in_progress")), milestones: [] };
    expect(computeProjectTaskConsistency(portfolio, []).findings).toHaveLength(0);
  });

  it("flags genuine ROUTE breakage: dangling project ref, dangling milestone ref, orphan milestone", () => {
    const portfolio = { projects: projects(P("prj-a", "in_progress")), milestones: [M("m-orphan", "prj-ghost")] };
    const out = computeProjectTaskConsistency(portfolio, [
      { id: "t1", status: "done", project: "prj-nope" },
      { id: "t2", status: "done", milestone: "m-nope" },
    ]);
    expect(out.findings.some((f) => f.kind === "dangling-project-ref" && f.taskId === "t1")).toBe(true);
    expect(out.findings.some((f) => f.kind === "dangling-milestone-ref" && f.taskId === "t2")).toBe(true);
    expect(out.findings.some((f) => f.kind === "orphan-milestone" && f.milestoneId === "m-orphan")).toBe(true);
  });
});

// ---- Live-data guard over the real docs/portfolio.yaml + docs/tasks.yaml ------
// The linkage ROUTE is fully consistent today (no dangling/orphan refs, no
// incomplete-done projects) and must STAY that way. The four legacy "done with
// zero linked tasks" projects are a documented, owner-visible backfill gap
// (v0.13.0/v0.14.0/v0.15.0/v0.19.0 shipped before the task-linkage discipline);
// they are the EXACT known baseline here. If a fifth appears, or the route breaks,
// or a done project gains an unfinished task, this test goes red.
describe("computeProjectTaskConsistency (live portfolio.yaml + tasks.yaml)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const docs = path.join(here, "..", "docs");
  const portfolio = yaml.load(fs.readFileSync(path.join(docs, "portfolio.yaml"), "utf8")) || {};
  // ADR-023: portfolio.yaml stays a tracked ledger in docs/; the live tasks moved
  // to the data zone (env > config dataDir > docs).
  // Clean-repo hermeticity (I9): the live board lives in the data zone, which the
  // public extraction deliberately does not carry - skip there, never fail.
  const tasksPath = path.join(resolveDataDir(path.join(here, "..")), "tasks.yaml");
  const live = fs.existsSync(tasksPath);
  const tasks = live ? (yaml.load(fs.readFileSync(tasksPath, "utf8")) || {}).tasks || [] : [];
  const out = computeProjectTaskConsistency(portfolio, tasks);

  // Owner-visible baseline: shrink this list as tickets are backfilled/linked.
  // usage-telemetry backfilled 2026-07-07 (its 4 epic:usage-telemetry tasks linked); baseline shrank 4->3.
  const KNOWN_LEGACY_UNLINKED = [
    "prj-exec-views-chatbot",
    "prj-owner-feedback-wave",
    "prj-ops-management-mvp",
  ];

  it.skipIf(!live)("has NO route breakage (dangling/orphan refs) and NO incomplete-done projects", () => {
    const routeKinds = new Set(["dangling-project-ref", "dangling-milestone-ref", "orphan-milestone", "done-project-incomplete-tasks"]);
    const offenders = out.findings.filter((f) => routeKinds.has(f.kind)).map((f) => `${f.kind}: ${f.message}`);
    expect(offenders).toEqual([]);
  });

  it.skipIf(!live)("has no NEW 'done project with zero linked tasks' beyond the documented legacy baseline", () => {
    const noTasks = out.findings.filter((f) => f.kind === "done-project-no-tasks").map((f) => f.projectId).sort();
    expect(noTasks).toEqual([...KNOWN_LEGACY_UNLINKED].sort());
  });
});
