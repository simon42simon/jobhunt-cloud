import { describe, it, expect, vi } from "vitest";
import {
  buildChatbotRequestInput,
  buildTaskSpawnLink,
  filterChatbotReports,
  isClosedReport,
  latestCtoComment,
  linkChatbotCaptureToIntake,
  partitionReports,
  reportSource,
  type IntakeLedgerWriter,
} from "../src/lib/chatbotQueue";
import type { NewRequestInput, Task, TaskComment } from "../src/types";

// Unit tests for the pure selectors behind ChatCapture's "My reports" queue.
// Node-env style (no DOM/React) matching tests/statusColors.test.ts - this
// project has no component-render test layer by design.

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "A report",
    detail: "",
    epic: "product",
    priority: "medium",
    status: "triage",
    created: "2026-07-01",
    ...over,
  };
}

describe("filterChatbotReports", () => {
  it("keeps chatbot- AND qa-report-labelled tasks, drops the rest", () => {
    const tasks = [
      mkTask({ id: "t-1", labels: ["chatbot"] }),
      mkTask({ id: "t-2", labels: ["backend"] }), // non-report label
      mkTask({ id: "t-3", labels: ["chatbot", "bug"] }),
      mkTask({ id: "t-4" }), // no labels
      mkTask({ id: "t-5", labels: ["qa-report", "bug"] }), // QA-filed bug
    ];
    const out = filterChatbotReports(tasks);
    expect(out.map((t) => t.id).sort()).toEqual(["t-1", "t-3", "t-5"]);
  });

  it("excludes tickets whose only labels are unrelated (bug alone is not a report)", () => {
    const tasks = [
      mkTask({ id: "t-1", labels: ["bug"] }),
      mkTask({ id: "t-2", labels: ["backend", "chore"] }),
      mkTask({ id: "t-3", labels: ["qa-report"] }),
    ];
    expect(filterChatbotReports(tasks).map((t) => t.id)).toEqual(["t-3"]);
  });

  it("treats a missing labels field as no labels (never throws)", () => {
    const tasks = [mkTask({ id: "t-1", labels: undefined }), mkTask({ id: "t-2", labels: ["chatbot"] })];
    expect(filterChatbotReports(tasks).map((t) => t.id)).toEqual(["t-2"]);
  });

  it("orders newest-first by created date", () => {
    const tasks = [
      mkTask({ id: "t-a", labels: ["chatbot"], created: "2026-07-01" }),
      mkTask({ id: "t-b", labels: ["chatbot"], created: "2026-07-03" }),
      mkTask({ id: "t-c", labels: ["chatbot"], created: "2026-07-02" }),
    ];
    expect(filterChatbotReports(tasks).map((t) => t.id)).toEqual(["t-b", "t-c", "t-a"]);
  });

  it("breaks same-day ties by id, newest (larger epoch id) first", () => {
    const tasks = [
      mkTask({ id: "t-1783042256121", labels: ["chatbot"], created: "2026-07-03" }),
      mkTask({ id: "t-1783042299803", labels: ["chatbot"], created: "2026-07-03" }),
    ];
    expect(filterChatbotReports(tasks).map((t) => t.id)).toEqual(["t-1783042299803", "t-1783042256121"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [
      mkTask({ id: "t-1", labels: ["chatbot"], created: "2026-07-01" }),
      mkTask({ id: "t-2", labels: ["chatbot"], created: "2026-07-02" }),
    ];
    const snapshot = tasks.map((t) => t.id);
    filterChatbotReports(tasks);
    expect(tasks.map((t) => t.id)).toEqual(snapshot);
  });
});

// The open/done grouping behind "My reports" (t-1783119900332): open reports
// are the scan target; done AND canceled both read as closed.
describe("isClosedReport / partitionReports", () => {
  it("treats done and canceled as closed, every other status as open", () => {
    expect(isClosedReport(mkTask({ status: "done" }))).toBe(true);
    expect(isClosedReport(mkTask({ status: "canceled" }))).toBe(true);
    for (const s of ["triage", "backlog", "todo", "in_progress", "in_review"]) {
      expect(isClosedReport(mkTask({ status: s }))).toBe(false);
    }
  });

  it("splits a reports list into open vs closed halves", () => {
    const reports = [
      mkTask({ id: "t-1", status: "triage" }),
      mkTask({ id: "t-2", status: "done" }),
      mkTask({ id: "t-3", status: "in_progress" }),
      mkTask({ id: "t-4", status: "canceled" }),
    ];
    const { open, closed } = partitionReports(reports);
    expect(open.map((t) => t.id)).toEqual(["t-1", "t-3"]);
    expect(closed.map((t) => t.id)).toEqual(["t-2", "t-4"]);
  });

  it("preserves the input (newest-first) order within each half", () => {
    // Already sorted newest-first, as filterChatbotReports hands it over.
    const reports = [
      mkTask({ id: "t-3", status: "done", created: "2026-07-03" }),
      mkTask({ id: "t-2", status: "todo", created: "2026-07-02" }),
      mkTask({ id: "t-1", status: "done", created: "2026-07-01" }),
    ];
    const { open, closed } = partitionReports(reports);
    expect(open.map((t) => t.id)).toEqual(["t-2"]);
    expect(closed.map((t) => t.id)).toEqual(["t-3", "t-1"]);
  });

  it("returns empty halves for an empty list and does not mutate the input", () => {
    expect(partitionReports([])).toEqual({ open: [], closed: [] });
    const reports = [mkTask({ id: "t-1", status: "done" }), mkTask({ id: "t-2", status: "todo" })];
    const snapshot = reports.map((t) => t.id);
    partitionReports(reports);
    expect(reports.map((t) => t.id)).toEqual(snapshot);
  });
});

describe("reportSource", () => {
  it("returns 'you' for a chatbot-filed report", () => {
    expect(reportSource(mkTask({ labels: ["chatbot"] }))).toBe("you");
  });

  it("returns 'qa' for a qa-report bug ticket", () => {
    expect(reportSource(mkTask({ labels: ["qa-report", "bug"] }))).toBe("qa");
  });

  it("QA-filed wins when a ticket carries BOTH labels", () => {
    expect(reportSource(mkTask({ labels: ["chatbot", "qa-report"] }))).toBe("qa");
    expect(reportSource(mkTask({ labels: ["qa-report", "chatbot"] }))).toBe("qa");
  });

  it("defaults to 'you' when labels are missing (never throws)", () => {
    expect(reportSource(mkTask({ labels: undefined }))).toBe("you");
  });
});

describe("latestCtoComment", () => {
  const cto = (body: string, ts: string): TaskComment => ({ author: "cto", ts, body });
  const other = (body: string, ts: string): TaskComment => ({ author: "frontend-engineer", ts, body });

  it("returns the last comment authored by the CTO", () => {
    const comments = [cto("first", "2026-07-01T00:00:00Z"), other("noise", "2026-07-02T00:00:00Z"), cto("latest", "2026-07-03T00:00:00Z")];
    expect(latestCtoComment(comments)?.body).toBe("latest");
  });

  it("ignores non-CTO authors", () => {
    const comments = [cto("verdict", "2026-07-01T00:00:00Z"), other("reply", "2026-07-02T00:00:00Z")];
    expect(latestCtoComment(comments)?.body).toBe("verdict");
  });

  it("returns null when there is no CTO comment", () => {
    expect(latestCtoComment([other("reply", "2026-07-01T00:00:00Z")])).toBeNull();
  });

  it("returns null for an empty or undefined log", () => {
    expect(latestCtoComment([])).toBeNull();
    expect(latestCtoComment(undefined)).toBeNull();
  });
});

// D1 (ADR-009): the intake-ledger side-write that completes the origin chain for
// in-app chatbot captures. These cover the two payload builders (shape/convention
// match) and the fail-soft orchestration.
describe("buildChatbotRequestInput", () => {
  it("marks the request as a chatbot capture and carries the verbatim ask", () => {
    const input = buildChatbotRequestInput("The Insights tab shows the wrong count.");
    expect(input).toEqual({ text: "The Insights tab shows the wrong count.", source: "chatbot" });
  });

  it("trims surrounding whitespace so request text matches the stored task detail", () => {
    // ChatCapture files the task with `detail: text.trim()`; the ledger text
    // mirrors it. Interior content (`:` `#` `"`, newlines) is preserved verbatim.
    expect(buildChatbotRequestInput("  a line\n\nb: c #d \"e\"  ").text).toBe('a line\n\nb: c #d "e"');
  });
});

describe("buildTaskSpawnLink", () => {
  it("links the request to the spawned task via the SpawnedRefs shape", () => {
    expect(buildTaskSpawnLink("t-42")).toEqual({ spawned: { tasks: ["t-42"] } });
  });
});

describe("linkChatbotCaptureToIntake", () => {
  // A minimal in-memory stand-in for the ledger API (structural subset of `api`).
  function mkWriter(over: Partial<IntakeLedgerWriter> = {}): IntakeLedgerWriter {
    return {
      addRequest: vi.fn(async (_input: NewRequestInput) => ({ id: "r-100" })),
      updateRequest: vi.fn(async () => ({})),
      ...over,
    };
  }

  it("files a chatbot request, then links it to the task, and returns the new request id", async () => {
    const writer = mkWriter();
    const requestId = await linkChatbotCaptureToIntake("bug: the count is off", "t-7", writer);

    expect(requestId).toBe("r-100");
    expect(writer.addRequest).toHaveBeenCalledTimes(1);
    expect(writer.addRequest).toHaveBeenCalledWith({ text: "bug: the count is off", source: "chatbot" });
    expect(writer.updateRequest).toHaveBeenCalledTimes(1);
    // Linked to the request the server just minted (r-100), not the client-side task id.
    expect(writer.updateRequest).toHaveBeenCalledWith("r-100", { spawned: { tasks: ["t-7"] } });
  });

  it("is fail-soft: an addRequest failure is swallowed (logged), never thrown, and skips the link", async () => {
    const onError = vi.fn();
    const writer = mkWriter({
      addRequest: vi.fn(async () => {
        throw new Error("500 intake down");
      }),
    });

    // Must resolve (never reject) - a rejection here could break the caller's flow.
    await expect(linkChatbotCaptureToIntake("x", "t-9", writer, onError)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(writer.updateRequest).not.toHaveBeenCalled();
  });

  it("is fail-soft: an updateRequest (link) failure is swallowed and returns null", async () => {
    const onError = vi.fn();
    const writer = mkWriter({
      updateRequest: vi.fn(async () => {
        throw new Error("404 request not found");
      }),
    });

    await expect(linkChatbotCaptureToIntake("x", "t-9", writer, onError)).resolves.toBeNull();
    expect(writer.addRequest).toHaveBeenCalledTimes(1); // request was still filed
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("swallows silently when no onError sink is supplied (still never throws)", async () => {
    const writer = mkWriter({
      addRequest: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(linkChatbotCaptureToIntake("x", "t-1", writer)).resolves.toBeNull();
  });
});

// Proves the D1 contract at the api-call layer: ONE capture produces BOTH a task
// AND a linked intake request, and an intake-write failure does NOT break task
// creation. This mirrors ChatCapture.queueTicket's exact ordering (file the task
// first, then fire the best-effort ledger link) without a DOM/React render layer.
describe("chatbot capture: task + linked intake (queueTicket ordering)", () => {
  async function captureLikeQueueTicket(
    text: string,
    addTask: (t: { title: string; labels: string[] }) => Promise<Task>,
    writer: IntakeLedgerWriter,
    onError?: (e: unknown) => void,
  ): Promise<Task> {
    const task = await addTask({ title: text.split("\n")[0], labels: ["chatbot"] });
    // Fire-and-forget in the component; awaited here only so the test can assert
    // the linkage settled. Its failure can never reject (fail-soft), so the task
    // return above is unaffected either way.
    await linkChatbotCaptureToIntake(text, task.id, writer, onError);
    return task;
  }

  it("produces BOTH a task (labelled chatbot) and a request linked back to it", async () => {
    const addTask = vi.fn(async () => ({ id: "t-500", labels: ["chatbot"] }) as Task);
    const writer: IntakeLedgerWriter = {
      addRequest: vi.fn(async () => ({ id: "r-500" })),
      updateRequest: vi.fn(async () => ({})),
    };

    const task = await captureLikeQueueTicket("Add a dark-mode toggle", addTask, writer);

    expect(task.id).toBe("t-500");
    expect(task.labels).toContain("chatbot");
    expect(writer.addRequest).toHaveBeenCalledWith({ text: "Add a dark-mode toggle", source: "chatbot" });
    expect(writer.updateRequest).toHaveBeenCalledWith("r-500", { spawned: { tasks: ["t-500"] } });
  });

  it("still returns the task when the intake ledger write fails (task creation unbroken)", async () => {
    const addTask = vi.fn(async () => ({ id: "t-501", labels: ["chatbot"] }) as Task);
    const writer: IntakeLedgerWriter = {
      addRequest: vi.fn(async () => {
        throw new Error("intake ledger unreachable");
      }),
      updateRequest: vi.fn(),
    };
    const onError = vi.fn();

    const task = await captureLikeQueueTicket("Something broke", addTask, writer, onError);

    expect(task.id).toBe("t-501"); // the primary capture survived the ledger failure
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
