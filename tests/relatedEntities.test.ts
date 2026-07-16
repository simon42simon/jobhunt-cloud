import { describe, it, expect } from "vitest";
import {
  extractProjectIds,
  extractTaskIds,
  isTicketId,
  relatedEntitiesForAssessment,
  resolveEpicProject,
  ticketProject,
} from "../src/lib/relatedEntities";
import type { Milestone, Portfolio, Project, Task } from "../src/types";

// Unit tests for the related-entity derivation (t-1783255872307 +
// t-1783256391885) - the PURE helpers behind the "Related" chip strips on
// RunPanel / ChatCapture. Node-env style like chatbotQueue.test.ts: no DOM,
// no fetch, plain fixtures.

function mkTask(over: Partial<Task> & { id: string }): Task {
  return {
    id: over.id,
    title: over.title ?? `Task ${over.id}`,
    detail: over.detail ?? "",
    epic: over.epic ?? "general",
    priority: over.priority ?? "medium",
    status: over.status ?? "triage",
    created: over.created ?? "2026-07-05",
    ...over,
  };
}

function mkProject(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    department: "engineering",
    owner: "software-architect",
    accountable: "cto",
    goal: "",
    status: "in_progress",
    ...over,
  };
}

function mkPortfolio(projects: Project[], milestones: Milestone[] = []): Portfolio {
  return { version: 1, updated: "2026-07-05", projects, milestones };
}

const PORTFOLIO = mkPortfolio(
  [
    // Epic IS the project id (the discovery-sources / usage-telemetry shape).
    mkProject({ id: "discovery-sources", name: "Discovery Sources v1" }),
    // Project id is the epic prefixed "prj-" (the dominant shape).
    mkProject({ id: "prj-connected-execution", name: "Connected Execution" }),
    mkProject({ id: "prj-product-hub-ia-v2", name: "Product Hub IA v2" }),
  ],
  [
    {
      id: "prj-connected-execution-m1",
      project: "prj-connected-execution",
      name: "M1",
      definition_of_done: "",
      status: "done",
    },
  ],
);

describe("isTicketId", () => {
  it("accepts t-<epochms> ticket ids", () => {
    expect(isTicketId("t-1783255872307")).toBe(true);
  });

  it("rejects job-folder ids, blanks, and malformed t- shapes", () => {
    expect(isTicketId("advisor-mitacs")).toBe(false);
    expect(isTicketId("t-")).toBe(false);
    expect(isTicketId("t-12x9")).toBe(false);
    expect(isTicketId("prj-connected-execution")).toBe(false);
    expect(isTicketId(null)).toBe(false);
    expect(isTicketId(undefined)).toBe(false);
  });
});

describe("extractTaskIds", () => {
  it("finds ids, dedupes, and keeps first-mention order", () => {
    const text = "Fixed in t-1783000000002 (see t-1783000000001, again t-1783000000002).";
    expect(extractTaskIds(text)).toEqual(["t-1783000000002", "t-1783000000001"]);
  });

  it("ignores short t-<n> noise (a list marker is not a ticket)", () => {
    expect(extractTaskIds("step t-1 then t-2")).toEqual([]);
  });

  it("does not match inside a longer word", () => {
    expect(extractTaskIds("format-1783000000001 is not a ticket")).toEqual([]);
  });
});

describe("extractProjectIds", () => {
  it("finds known project ids in text (portfolio order), including prj-* shapes", () => {
    const text = "Belongs to prj-connected-execution; also touches discovery-sources.";
    expect(extractProjectIds(text, PORTFOLIO)).toEqual(["discovery-sources", "prj-connected-execution"]);
  });

  it("respects slug boundaries: a longer slug never matches its prefix project", () => {
    expect(extractProjectIds("see discovery-sources-v2 notes", PORTFOLIO)).toEqual([]);
  });

  it("returns nothing without a portfolio or without text", () => {
    expect(extractProjectIds("prj-connected-execution", null)).toEqual([]);
    expect(extractProjectIds("", PORTFOLIO)).toEqual([]);
  });
});

describe("resolveEpicProject", () => {
  it("resolves an epic that IS a project id", () => {
    expect(resolveEpicProject("discovery-sources", PORTFOLIO)?.id).toBe("discovery-sources");
  });

  it("resolves an epic via the prj- prefix", () => {
    expect(resolveEpicProject("product-hub-ia-v2", PORTFOLIO)?.id).toBe("prj-product-hub-ia-v2");
  });

  it("returns null for a plain category epic (general) - never invents a link", () => {
    expect(resolveEpicProject("general", PORTFOLIO)).toBeNull();
    expect(resolveEpicProject("infra", PORTFOLIO)).toBeNull();
  });

  it("returns null without an epic or a portfolio", () => {
    expect(resolveEpicProject(undefined, PORTFOLIO)).toBeNull();
    expect(resolveEpicProject("discovery-sources", null)).toBeNull();
  });
});

describe("ticketProject", () => {
  it("prefers the direct project ref when it resolves", () => {
    const t = mkTask({ id: "t-1", project: "discovery-sources", epic: "product-hub-ia-v2" });
    expect(ticketProject(t, PORTFOLIO)?.id).toBe("discovery-sources");
  });

  it("falls through an UNRESOLVABLE direct ref to the milestone join", () => {
    const t = mkTask({ id: "t-1", project: "no-such-project", milestone: "prj-connected-execution-m1" });
    expect(ticketProject(t, PORTFOLIO)?.id).toBe("prj-connected-execution");
  });

  it("resolves via the milestone's owning project", () => {
    const t = mkTask({ id: "t-1", milestone: "prj-connected-execution-m1" });
    expect(ticketProject(t, PORTFOLIO)?.id).toBe("prj-connected-execution");
  });

  it("falls back to the epic mapping when no ref resolves", () => {
    const t = mkTask({ id: "t-1", milestone: "ghost-m1", epic: "product-hub-ia-v2" });
    expect(ticketProject(t, PORTFOLIO)?.id).toBe("prj-product-hub-ia-v2");
  });

  it("returns null when nothing resolves (unresolvable epic)", () => {
    expect(ticketProject(mkTask({ id: "t-1", epic: "general" }), PORTFOLIO)).toBeNull();
    expect(ticketProject(undefined, PORTFOLIO)).toBeNull();
    expect(ticketProject(mkTask({ id: "t-1" }), null)).toBeNull();
  });
});

describe("relatedEntitiesForAssessment", () => {
  const ticket = mkTask({ id: "t-1783000000001", title: "Fix the flaky poll", epic: "product-hub-ia-v2" });
  const other = mkTask({ id: "t-1783000000002", title: "Harden the SSE stream", epic: "general" });
  const tasks = [ticket, other];

  it("puts the assessed ticket first (labelled by its title), then its project", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: ticket.id,
      text: "",
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out.slice(0, 2)).toEqual([
      { kind: "task", id: "t-1783000000001", label: "Fix the flaky poll" },
      { kind: "project", id: "prj-product-hub-ia-v2", label: "Product Hub IA v2" },
    ]);
  });

  it("labels an unknown-but-valid ticket id with the id itself (never blank)", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: "t-1783999999999",
      text: "",
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out).toEqual([{ kind: "task", id: "t-1783999999999", label: "t-1783999999999" }]);
  });

  it("emits no project chip when the epic is not genuinely resolvable", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: other.id,
      text: "",
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out).toEqual([{ kind: "task", id: other.id, label: other.title }]);
  });

  it("adds resolvable text-referenced tasks and drops unresolvable ones", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: ticket.id,
      text: `Related: ${other.id} and the ghost t-1783888888888.`,
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out).toContainEqual({ kind: "task", id: other.id, label: other.title });
    expect(out.some((e) => e.id === "t-1783888888888")).toBe(false);
  });

  it("dedupes: a re-mention of the ticket or its project never doubles a chip", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: ticket.id,
      text: `Assessed ${ticket.id} under prj-product-hub-ia-v2.`,
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out.filter((e) => e.id === ticket.id)).toHaveLength(1);
    expect(out.filter((e) => e.id === "prj-product-hub-ia-v2")).toHaveLength(1);
  });

  it("adds text-referenced projects with their names", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: ticket.id,
      text: "Also touches discovery-sources.",
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out).toContainEqual({ kind: "project", id: "discovery-sources", label: "Discovery Sources v1" });
  });

  it("a non-ticket scope (null ticketId) derives from the text alone", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: null,
      text: `See ${other.id} and prj-connected-execution.`,
      tasks,
      portfolio: PORTFOLIO,
    });
    expect(out).toEqual([
      { kind: "task", id: other.id, label: other.title },
      { kind: "project", id: "prj-connected-execution", label: "Connected Execution" },
    ]);
  });

  it("degrades gracefully without a portfolio (task chips only)", () => {
    const out = relatedEntitiesForAssessment({
      ticketId: ticket.id,
      text: `Related: ${other.id}, prj-connected-execution.`,
      tasks,
      portfolio: null,
    });
    expect(out).toEqual([
      { kind: "task", id: ticket.id, label: ticket.title },
      { kind: "task", id: other.id, label: other.title },
    ]);
  });
});
