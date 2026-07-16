import { describe, it, expect } from "vitest";
import { agentInvolvement, normalizeRoutine, projectParticipants, projectResponsible } from "../src/lib/involvement";
import type { ActivityRecord, Portfolio, Task } from "../src/types";

// Pure-join unit tests for the participant/involvement model (docs/pm-conventions.md
// section 9). Hand-built fixtures - no fetch, no DOM - so this stays fast and
// deterministic. Layer: unit (the module is pure functions over plain data).

// ---- fixtures ---------------------------------------------------------------
// Two projects:
//  - prj-a: owner software-architect, accountable ui-ux-expert. Has one milestone
//    (m1) and is the target of the milestone-parent-path test.
//  - prj-b: owner product-manager, accountable cto. No milestones, no tasks
//    reference it directly except t3 - used to prove filtering excludes it from
//    prj-a's participants.
const portfolio: Portfolio = {
  version: 1,
  updated: "2026-07-01",
  projects: [
    {
      id: "prj-a",
      name: "Project A",
      department: "eng",
      owner: "software-architect",
      accountable: "ui-ux-expert",
      goal: "Ship A",
      status: "active",
    },
    {
      id: "prj-b",
      name: "Project B",
      department: "eng",
      owner: "product-manager",
      accountable: "cto",
      goal: "Ship B",
      status: "active",
    },
  ],
  milestones: [
    {
      id: "m1",
      project: "prj-a",
      name: "M1",
      definition_of_done: "done",
      status: "active",
    },
  ],
};

const baseTask = {
  detail: "",
  epic: "",
  priority: "high" as const,
  status: "open",
  created: "2026-07-01",
};

const tasks: Task[] = [
  // Belongs to prj-a directly. owner duplicates prj-a's project owner (dedup
  // route 1); delegated_by is a brand-new agent.
  { id: "t1", title: "T1", ...baseTask, project: "prj-a", owner: "software-architect", delegated_by: "product-manager" },
  // Belongs to prj-a ONLY via its milestone (m1 -> prj-a) - no `project` field
  // set directly. owner is new; delegated_by duplicates prj-a's accountable
  // (dedup route 2).
  { id: "t2", title: "T2", ...baseTask, milestone: "m1", owner: "frontend-engineer", delegated_by: "ui-ux-expert" },
  // Belongs to prj-b, not prj-a - proves prj-a's participant list doesn't leak
  // unrelated tasks. Also used by agentInvolvement's "cto" case.
  { id: "t3", title: "T3", ...baseTask, project: "prj-b", owner: "cto", delegated_by: "release-manager" },
];

const activity: ActivityRecord[] = [
  // The key alias case: routine "manager" is the CTO seat's template name, not
  // an agents.yaml id - it must surface under agentId "cto".
  { ts: "2026-07-01T00:00:00Z", kind: "run", runId: "r1", routine: "manager", label: "integration check" },
  { ts: "2026-07-01T00:05:00Z", kind: "run", runId: "r2", routine: "frontend-engineer", label: "build UI" },
  { ts: "2026-07-01T00:10:00Z", kind: "delegation", runId: "r3", routine: "test-engineer", label: "write tests" },
];

describe("normalizeRoutine", () => {
  it("maps the 'manager' template name to the 'cto' role id", () => {
    expect(normalizeRoutine("manager")).toBe("cto");
  });

  it("passes every other routine value through unchanged (identity)", () => {
    expect(normalizeRoutine("frontend-engineer")).toBe("frontend-engineer");
    expect(normalizeRoutine("test-engineer")).toBe("test-engineer");
    expect(normalizeRoutine("cto")).toBe("cto");
  });

  it("returns an empty string for a missing routine", () => {
    expect(normalizeRoutine(null)).toBe("");
    expect(normalizeRoutine(undefined)).toBe("");
  });
});

describe("agentInvolvement", () => {
  const sources = { portfolio, tasks, activity };

  it("includes a project where the agent is owner, and one where it is only accountable", () => {
    const inv = agentInvolvement("cto", sources);
    // cto is not owner of anything, but IS accountable for prj-b.
    expect(inv.projects.map((p) => p.id)).toEqual(["prj-b"]);
  });

  it("includes a task where the agent is owner", () => {
    const inv = agentInvolvement("frontend-engineer", sources);
    expect(inv.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("includes a task where the agent is only delegated_by", () => {
    const inv = agentInvolvement("release-manager", sources);
    expect(inv.tasks.map((t) => t.id)).toEqual(["t3"]);
    expect(inv.projects).toEqual([]);
  });

  // The key case: activity-log records write routine:"manager", not "cto" - the
  // join must apply the alias, or the CTO's own delegations vanish from its
  // involvement.
  it("surfaces a routine:'manager' activity record under agentId 'cto' via the alias", () => {
    const inv = agentInvolvement("cto", sources);
    expect(inv.activity).toHaveLength(1);
    expect(inv.activity[0].runId).toBe("r1");
  });

  it("matches activity records whose routine already equals the agent id (no alias needed)", () => {
    const inv = agentInvolvement("frontend-engineer", sources);
    expect(inv.activity.map((a) => a.runId)).toEqual(["r2"]);
  });

  it("returns empty projects, tasks, and activity for an agent with no involvement at all", () => {
    const inv = agentInvolvement("security-privacy-guardian", sources);
    expect(inv.projects).toEqual([]);
    expect(inv.tasks).toEqual([]);
    expect(inv.activity).toEqual([]);
  });
});

describe("projectParticipants", () => {
  it("unions project owner + accountable with task owner + delegated_by, excluding unrelated tasks", () => {
    const participants = projectParticipants("prj-a", { portfolio, tasks });
    expect(participants).toEqual(["software-architect", "ui-ux-expert", "product-manager", "frontend-engineer"]);
    // t3's agents (cto, release-manager) belong to prj-b, not prj-a.
    expect(participants).not.toContain("cto");
    expect(participants).not.toContain("release-manager");
  });

  it("counts a task that only references a milestone (no direct `project` field) toward the milestone's parent project", () => {
    const participants = projectParticipants("prj-a", { portfolio, tasks });
    // t2 sets `milestone: "m1"` and no `project`; m1's project is prj-a.
    expect(participants).toContain("frontend-engineer");
  });

  it("dedupes an agent that qualifies via more than one route (first-seen wins, no repeat)", () => {
    const participants = projectParticipants("prj-a", { portfolio, tasks });
    // software-architect: project owner AND t1's task owner - one entry.
    expect(participants.filter((id) => id === "software-architect")).toHaveLength(1);
    // ui-ux-expert: project accountable AND t2's delegated_by - one entry.
    expect(participants.filter((id) => id === "ui-ux-expert")).toHaveLength(1);
  });

  it("returns an empty array for an unknown project id", () => {
    expect(projectParticipants("prj-does-not-exist", { portfolio, tasks })).toEqual([]);
  });
});

describe("projectResponsible", () => {
  // Regression for ticket t-1783145481634 / charter AC-J6-2: the RACI
  // Responsible set is the distinct task owners under a project, MINUS the
  // project's own owner and accountable, so the single Accountable is not
  // double-counted as Responsible. A dedicated fixture puts BOTH the project
  // owner and the project accountable on the board as task owners, next to a
  // plain owner who is neither.
  const raciPortfolio: Portfolio = {
    version: 1,
    updated: "2026-07-01",
    projects: [
      {
        id: "prj-r",
        name: "Project R",
        department: "eng",
        owner: "software-architect",
        accountable: "ui-ux-expert",
        goal: "Ship R",
        status: "active",
      },
    ],
    milestones: [],
  };
  const raciTasks: Task[] = [
    // owner == project owner -> must NOT appear in Responsible.
    { id: "r1", title: "R1", ...baseTask, project: "prj-r", owner: "software-architect" },
    // owner == project accountable -> the exact double-count the ticket flagged
    // (Accountable also showing as Responsible); must NOT appear.
    { id: "r2", title: "R2", ...baseTask, project: "prj-r", owner: "ui-ux-expert" },
    // owner is neither owner nor accountable -> the genuine Responsible; MUST
    // remain.
    { id: "r3", title: "R3", ...baseTask, project: "prj-r", owner: "frontend-engineer" },
  ];

  it("excludes the project owner and accountable, keeping non-privileged task owners", () => {
    const responsible = projectResponsible("prj-r", { portfolio: raciPortfolio, tasks: raciTasks });
    // Only frontend-engineer survives; owner + accountable are stripped.
    expect(responsible).toEqual(["frontend-engineer"]);
    expect(responsible).not.toContain("software-architect"); // project owner
    expect(responsible).not.toContain("ui-ux-expert"); // project accountable (the leaked double-count)
  });

  // Same contract exercised through the shared fixture: prj-a's owner
  // (software-architect) also owns t1, so it must be stripped, while t2's owner
  // (frontend-engineer, neither owner nor accountable) remains.
  it("strips a project owner that also owns a task on the shared fixture", () => {
    const responsible = projectResponsible("prj-a", { portfolio, tasks });
    expect(responsible).toEqual(["frontend-engineer"]);
    expect(responsible).not.toContain("software-architect");
  });

  it("returns an empty array for an unknown project id", () => {
    expect(projectResponsible("prj-does-not-exist", { portfolio, tasks })).toEqual([]);
  });
});
