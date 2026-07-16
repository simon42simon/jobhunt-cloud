import { describe, it, expect } from "vitest";
import { parseRoute, tasksHash, jobsHash } from "../src/lib/router";

// The dependency-free hash router behind the deep links: `#/tasks[/<id>]` (the
// task board + one task modal, t-1783257189986) and `#/jobs[/<id>]` (the Jobs
// board + one job's side-view drawer, t-1783371156974). parse/format are pure
// (no window), so they are tested here without jsdom; the live wiring (useRoute
// / navigate / clearRoute) is exercised in the app.

describe("parseRoute (hash -> typed route)", () => {
  it("parses the bare task board hash", () => {
    expect(parseRoute("#/tasks")).toEqual({ page: "tasks" });
  });

  it("tolerates a trailing slash on the board hash", () => {
    expect(parseRoute("#/tasks/")).toEqual({ page: "tasks" });
  });

  it("parses a task id", () => {
    expect(parseRoute("#/tasks/t-1783257189986")).toEqual({
      page: "tasks",
      taskId: "t-1783257189986",
    });
  });

  it("percent-decodes the id segment", () => {
    expect(parseRoute("#/tasks/a%20b%2Fc")).toEqual({ page: "tasks", taskId: "a b/c" });
  });

  it("degrades a torn percent-escape to the raw segment instead of throwing", () => {
    // decodeURIComponent("%") throws; a hand-mangled URL must never crash the
    // shell - the not-found panel handles the unknown id.
    expect(parseRoute("#/tasks/%")).toEqual({ page: "tasks", taskId: "%" });
  });

  it("tolerates a missing leading slash (#tasks)", () => {
    expect(parseRoute("#tasks")).toEqual({ page: "tasks" });
  });

  // ---- Jobs surface (t-1783371156974): identical shape, discriminated by page.
  it("parses the bare jobs board hash", () => {
    expect(parseRoute("#/jobs")).toEqual({ page: "jobs" });
  });

  it("tolerates a trailing slash on the jobs board hash", () => {
    expect(parseRoute("#/jobs/")).toEqual({ page: "jobs" });
  });

  it("parses a job id (the human-readable folder name)", () => {
    expect(parseRoute("#/jobs/Project%20Manager%20-%20UTSC")).toEqual({
      page: "jobs",
      jobId: "Project Manager - UTSC",
    });
  });

  it("degrades a torn percent-escape on a job id to the raw segment", () => {
    expect(parseRoute("#/jobs/%")).toEqual({ page: "jobs", jobId: "%" });
  });

  it("tolerates a missing leading slash (#jobs)", () => {
    expect(parseRoute("#jobs")).toEqual({ page: "jobs" });
  });

  it("discriminates tasks vs jobs by the `page` field", () => {
    expect(parseRoute("#/tasks/x")?.page).toBe("tasks");
    expect(parseRoute("#/jobs/x")?.page).toBe("jobs");
    // A jobs route never carries a taskId, and vice versa.
    expect(parseRoute("#/jobs/x")).not.toHaveProperty("taskId");
    expect(parseRoute("#/tasks/x")).not.toHaveProperty("jobId");
  });

  it.each(["", "#", "#/", "#/task", "#/tasksfoo", "#/jobsfoo", "#/foo", "#/foo/bar"])(
    "returns null for a hash this router does not own (%j)",
    (hash) => {
      expect(parseRoute(hash)).toBeNull();
    },
  );

  it("returns null for deeper paths on either surface (unknown shapes are not routes)", () => {
    expect(parseRoute("#/tasks/t-1/comments")).toBeNull();
    expect(parseRoute("#/jobs/j-1/files")).toBeNull();
  });
});

describe("tasksHash (typed route -> hash)", () => {
  it("formats the board hash with no id", () => {
    expect(tasksHash()).toBe("#/tasks");
  });

  it("formats a task hash", () => {
    expect(tasksHash("t-1783257189986")).toBe("#/tasks/t-1783257189986");
  });

  it("percent-encodes an id so it survives as ONE segment", () => {
    expect(tasksHash("a b/c")).toBe("#/tasks/a%20b%2Fc");
  });

  it.each(["t-1783257189986", "a b/c", "id?with#weird&chars", "%"])(
    "round-trips through parseRoute verbatim (%j)",
    (id) => {
      expect(parseRoute(tasksHash(id))).toEqual({ page: "tasks", taskId: id });
    },
  );
});

describe("jobsHash (typed route -> hash)", () => {
  it("formats the board hash with no id", () => {
    expect(jobsHash()).toBe("#/jobs");
  });

  it("formats a job hash", () => {
    expect(jobsHash("Data Analyst - City of Toronto")).toBe(
      "#/jobs/Data%20Analyst%20-%20City%20of%20Toronto",
    );
  });

  it("percent-encodes a slash in the id so it survives as ONE segment", () => {
    expect(jobsHash("a b/c")).toBe("#/jobs/a%20b%2Fc");
  });

  it.each([
    "Project Manager - University of Toronto Scarborough",
    "Data Analyst - City of Toronto",
    "a b/c",
    "role?with#weird&chars",
    "%",
  ])("round-trips a folder-name id through parseRoute verbatim (%j)", (id) => {
    expect(parseRoute(jobsHash(id))).toEqual({ page: "jobs", jobId: id });
  });
});
