import { describe, it, expect } from "vitest";
import {
  computeReviewLogRows,
  computeStatus,
  dateFromName,
  progressionStage,
  untriagedRecsCount,
} from "../src/lib/addressed";
import type { DocSummary, Task } from "../src/types";

// Unit tests for the addressed-via-tickets join (docs/product-hub-ia-v2.md
// sections 4a + 6): given docs (with meta) and tasks, compute each review/log
// doc's linked tickets, done tickets, and clear/open/not-tracked status.
// Hand-built fixtures, no fetch, no DOM. Layer: unit (pure functions over
// plain data).

const baseTask = {
  detail: "",
  epic: "",
  priority: "high" as const,
  created: "2026-07-01",
};

function task(id: string, source: string | undefined, status: string): Task {
  return { id, title: id, ...baseTask, status, source };
}

describe("computeReviewLogRows", () => {
  it("computes addressed = done-count / linked-count for a review doc with source-tagged tickets", () => {
    const doc: DocSummary = {
      name: "enablement-reviews/2026-07-01",
      title: "Weekly Review",
      group: "reviews",
      meta: { type: "review" },
    };
    const tasks: Task[] = [
      task("t1", "review:enablement-reviews/2026-07-01", "done"),
      task("t2", "review:enablement-reviews/2026-07-01", "todo"),
      task("t3", "review:enablement-reviews/2026-07-01", "done"),
    ];

    const [row] = computeReviewLogRows([doc], tasks);

    expect(row.linked).toHaveLength(3);
    expect(row.done).toHaveLength(2);
  });

  it("the audit doc scenario: 5 linked tickets, 4 done, yields 4/5 and status 'open'", () => {
    const doc: DocSummary = {
      name: "audits/2026-07-01-ultracode-audit",
      title: "ULTRACODE Audit",
      group: "reviews",
      meta: { type: "review" },
    };
    const tasks: Task[] = [
      task("a1", "review:audits/2026-07-01-ultracode-audit", "done"),
      task("a2", "review:audits/2026-07-01-ultracode-audit", "done"),
      task("a3", "review:audits/2026-07-01-ultracode-audit", "done"),
      task("a4", "review:audits/2026-07-01-ultracode-audit", "done"),
      task("a5", "review:audits/2026-07-01-ultracode-audit", "todo"),
    ];

    const [row] = computeReviewLogRows([doc], tasks);

    expect(row.linked).toHaveLength(5);
    expect(row.done).toHaveLength(4);
    expect(row.status).toBe("open"); // one linked ticket is still not done
  });

  it("a doc with meta.recs shows linked-vs-recs so untriaged (recs - linked) recommendations are visible", () => {
    const doc: DocSummary = {
      name: "log",
      title: "Log",
      group: "reviews",
      meta: { type: "log", recs: 6 },
    };
    const tasks: Task[] = [
      task("l1", "review:log", "done"),
      task("l2", "review:log", "done"),
      task("l3", "review:log", "todo"),
      task("l4", "review:log", "done"),
    ];

    const [row] = computeReviewLogRows([doc], tasks);

    expect(row.linked).toHaveLength(4);
    const untriaged = doc.meta!.recs! - row.linked.length;
    expect(untriaged).toBe(2);
    // recs (6) > linked (4): recs are not fully covered, so status is "open"
    // even though every linked ticket happens to be done.
    expect(row.status).toBe("open");
  });

  it("a doc with zero linked tickets yields 0/0 gracefully, without throwing", () => {
    const doc: DocSummary = {
      name: "agent-roster-audit",
      title: "Agent Roster Audit",
      group: "reviews",
      meta: { type: "review" },
    };
    const tasks: Task[] = [task("other", "review:some-other-doc", "done")];

    expect(() => computeReviewLogRows([doc], tasks)).not.toThrow();
    const [row] = computeReviewLogRows([doc], tasks);

    expect(row.linked).toHaveLength(0);
    expect(row.done).toHaveLength(0);
    expect(row.status).toBe("not-tracked");
  });

  it("matches a task to a doc only when task.source is exactly 'review:' + the doc name", () => {
    const doc: DocSummary = {
      name: "weekly-review",
      title: "Weekly Review",
      group: "reviews",
      meta: { type: "review" },
    };
    const tasks: Task[] = [
      task("exact", "review:weekly-review", "done"),
      // Prefix collision: a longer doc name that starts with the same string.
      task("prefix", "review:weekly-review-extended", "done"),
      // Different scheme entirely.
      task("other-scheme", "log:weekly-review", "done"),
      // No source field at all.
      task("no-source", undefined, "done"),
    ];

    const [row] = computeReviewLogRows([doc], tasks);

    expect(row.linked.map((t) => t.id)).toEqual(["exact"]);
  });

  it("filters out docs that are neither type 'review' nor 'log'", () => {
    const docs: DocSummary[] = [
      { name: "source-doc", title: "Some Source", group: "sources", meta: { type: "source" } },
      { name: "review-doc", title: "A Review", group: "reviews", meta: { type: "review" } },
    ];

    const rows = computeReviewLogRows(docs, []);

    expect(rows.map((r) => r.doc.name)).toEqual(["review-doc"]);
  });

  it("sorts rows newest-first by date, with dateless docs sorting last", () => {
    const docs: DocSummary[] = [
      { name: "old", title: "Old", group: "reviews", meta: { type: "review", date: "2026-01-01" } },
      { name: "new", title: "New", group: "reviews", meta: { type: "review", date: "2026-06-01" } },
      { name: "no-date-doc", title: "No Date", group: "reviews", meta: { type: "review" } },
    ];

    const rows = computeReviewLogRows(docs, []);

    expect(rows.map((r) => r.doc.name)).toEqual(["new", "old", "no-date-doc"]);
  });
});

describe("dateFromName", () => {
  it("extracts a YYYY-MM-DD date anywhere in the doc id", () => {
    expect(dateFromName("enablement-reviews/2026-07-01")).toBe("2026-07-01");
    expect(dateFromName("audits/2026-07-01-ultracode-audit")).toBe("2026-07-01");
  });

  it("returns null when the id has no embedded date", () => {
    expect(dateFromName("agent-roster-audit")).toBeNull();
  });
});

describe("computeStatus", () => {
  it("is 'not-tracked' when no recs are declared and nothing is linked yet", () => {
    expect(computeStatus(undefined, [], [])).toBe("not-tracked");
  });

  it("is 'clear' when every linked ticket is done and there are no undeclared recs", () => {
    const linked = [task("t1", "review:x", "done")];
    expect(computeStatus(undefined, linked, linked)).toBe("clear");
  });

  it("is 'open' when a linked ticket is not yet done", () => {
    const linked = [task("t1", "review:x", "todo")];
    expect(computeStatus(undefined, linked, [])).toBe("open");
  });

  it("is 'open' when linked tickets are all done but fewer than the declared recs", () => {
    const linked = [task("t1", "review:x", "done")];
    expect(computeStatus(2, linked, linked)).toBe("open");
  });
});

describe("untriagedRecsCount", () => {
  it("is 0 when the doc declares no recs at all", () => {
    expect(untriagedRecsCount(undefined, [])).toBe(0);
    expect(untriagedRecsCount(undefined, [task("t1", "review:x", "done")])).toBe(0);
  });

  it("is recs minus linked-ticket count when recs are declared", () => {
    const linked = [task("t1", "review:x", "done"), task("t2", "review:x", "todo")];
    expect(untriagedRecsCount(6, linked)).toBe(4);
  });

  it("floors at 0 when more tickets are linked than recs were declared", () => {
    const linked = [task("t1", "review:x", "done"), task("t2", "review:x", "done"), task("t3", "review:x", "done")];
    expect(untriagedRecsCount(2, linked)).toBe(0);
  });

  it("is 0 when recs are fully triaged (linked count meets recs)", () => {
    const linked = [task("t1", "review:x", "todo"), task("t2", "review:x", "todo")];
    expect(untriagedRecsCount(2, linked)).toBe(0);
  });
});

describe("progressionStage", () => {
  it("maps done-family statuses to 'done'", () => {
    expect(progressionStage("done")).toBe("done");
    expect(progressionStage("shipped")).toBe("done");
    expect(progressionStage("complete")).toBe("done");
  });

  it("maps blocked-family statuses to 'blocked'", () => {
    expect(progressionStage("blocked")).toBe("blocked");
    expect(progressionStage("paused")).toBe("blocked");
    expect(progressionStage("canceled")).toBe("blocked");
  });

  it("maps in-flight statuses to 'in-progress'", () => {
    expect(progressionStage("in_progress")).toBe("in-progress");
    expect(progressionStage("active")).toBe("in-progress");
    expect(progressionStage("in_review")).toBe("in-progress");
  });

  it("falls back to 'not-started' for todo/backlog/unknown statuses", () => {
    expect(progressionStage("todo")).toBe("not-started");
    expect(progressionStage("backlog")).toBe("not-started");
    expect(progressionStage("some-unknown-status")).toBe("not-started");
  });
});
