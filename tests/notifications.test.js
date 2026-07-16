import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// GET /api/notifications derives a read-mostly event feed from data the app
// ALREADY records - the durable activity log (run_finished / wave_done) plus a
// DIFF of the current tasks.yaml / portfolio.yaml against a persisted baseline
// (task_added / task_done / project_added). There is no push infra and no event
// store; the ONLY write is a small app-managed state file (docs/notify-state.json,
// baseline + read cursor). This suite is hermetic: a fresh app bound to a
// throwaway JOBHUNT_DOCS_DIR + JOBHUNT_JOBS_DIR (the same vi.resetModules +
// dynamic-import pattern the other server suites use), so it never touches the
// committed docs/ and never spawns anything (the feed endpoints never run a
// routine, so no child_process mock is needed).
let app;
let tmpRoot;
let docsDir;
let jobsDir;

const OLD = "2026-01-01T00:00:00.000Z"; // cursor far in the past -> activity events are unread
const STATE_FILE = () => path.join(docsDir, "notify-state.json");

function writeTasks(tasks) {
  const lines = ["columns:", "  - backlog", "  - todo", "  - in_progress", "  - done", "tasks:"];
  for (const t of tasks) {
    lines.push(`  - id: ${t.id}`);
    lines.push(`    title: ${JSON.stringify(t.title)}`);
    lines.push(`    status: ${t.status}`);
    if (t.created) lines.push(`    created: '${t.created}'`);
  }
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), lines.join("\n") + "\n", "utf8");
}

function writeProjects(projects) {
  const lines = ["version: 1", "projects:"];
  for (const p of projects) {
    lines.push(`  - id: ${p.id}`);
    lines.push(`    name: ${JSON.stringify(p.name)}`);
    if (p.created) lines.push(`    created: '${p.created}'`);
  }
  fs.writeFileSync(path.join(docsDir, "portfolio.yaml"), lines.join("\n") + "\n", "utf8");
}

function writeActivity(records) {
  fs.writeFileSync(
    path.join(docsDir, "activity-log.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8"
  );
}

// Pre-seed the state file so we control the baseline + cursor a test diffs
// against (the first-ever GET otherwise seeds baseline=current, cursor=now).
function seedState(baseline, cursor) {
  fs.writeFileSync(
    STATE_FILE(),
    JSON.stringify({ version: 1, cursor, baseline, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

const runStart = (runId, extra) => ({ ts: extra.start, kind: "run", runId, routine: extra.routine, label: extra.label, jobId: extra.jobId ?? null, batchId: extra.batchId ?? null, status: "running" });
const runClose = (runId, ts, status, batchId = null) => ({ ts, kind: "run", runId, status, exitCode: status === "done" ? 0 : 1, batchId });

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-notify-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // A clean slate each test: minimal tasks/projects, no activity, no state file.
  writeTasks([{ id: "t-001", title: "Existing", status: "done", created: "2026-06-30" }]);
  writeProjects([{ id: "prj-x", name: "Existing Project", created: "2026-06-30" }]);
  writeActivity([]);
  try {
    fs.rmSync(STATE_FILE(), { force: true });
  } catch {}
});

describe("GET /api/notifications - feed shape + first-run seeding", () => {
  it("returns { events, unread, cursor } and every event is well-shaped", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    writeActivity([
      runStart("r1", { start: "2026-07-03T09:00:00.000Z", routine: "discover-jobs", label: "Discover jobs" }),
      runClose("r1", "2026-07-03T10:00:00.000Z", "done"),
    ]);
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(typeof res.body.unread).toBe("number");
    expect(typeof res.body.cursor).toBe("string");
    for (const e of res.body.events) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.type).toBe("string");
      expect(typeof e.title).toBe("string");
      expect(e).toHaveProperty("ref");
      expect(typeof e.unread).toBe("boolean");
    }
  });

  it("first-ever call seeds baseline=current + cursor=now, so it does not flood (unread 0)", async () => {
    // No state file (beforeEach cleared it), no activity. Every existing task /
    // project is baselined, so nothing shows as new.
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(0);
    expect(res.body.events).toEqual([]);
    // The seed was persisted exactly once.
    expect(fs.existsSync(STATE_FILE())).toBe(true);
  });
});

describe("GET /api/notifications - run_finished + wave_done from the durable log", () => {
  it("emits run_finished for a single run and wave_done for a completed batch (no per-member run_finished)", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    writeActivity([
      // single run
      runStart("r1", { start: "2026-07-03T09:00:00.000Z", routine: "discover-jobs", label: "Discover jobs" }),
      runClose("r1", "2026-07-03T10:00:00.000Z", "done"),
      // batch b1: two runs, one done one failed, both terminal
      runStart("r2", { start: "2026-07-03T09:10:00.000Z", routine: "first-draft-job", label: "Draft CV + cover letter", jobId: "Job A", batchId: "b1" }),
      runClose("r2", "2026-07-03T10:10:00.000Z", "done", "b1"),
      runStart("r3", { start: "2026-07-03T09:20:00.000Z", routine: "first-draft-job", label: "Draft CV + cover letter", jobId: "Job B", batchId: "b1" }),
      runClose("r3", "2026-07-03T10:20:00.000Z", "failed", "b1"),
    ]);
    const res = await request(app).get("/api/notifications");
    const byType = (t) => res.body.events.filter((e) => e.type === t);

    const runs = byType("run_finished");
    expect(runs.map((e) => e.id)).toEqual(["run:r1"]); // ONLY the single run, not batch members
    expect(runs[0].ref.status).toBe("done");

    const waves = byType("wave_done");
    expect(waves.length).toBe(1);
    expect(waves[0].id).toBe("wave:b1");
    expect(waves[0].ref).toMatchObject({ kind: "batch", batchId: "b1", total: 2, done: 1, failed: 1, stopped: 0 });
    expect(waves[0].ts).toBe("2026-07-03T10:20:00.000Z"); // newest close in the batch
  });

  it("counts a USER-STOPPED batch member as stopped, not failed (t-1783091385623)", async () => {
    // `failed` used to be total - done, so a run the owner deliberately
    // stopped was reported (and tinted) as a failure. The three terminal
    // outcomes are now counted separately.
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    writeActivity([
      runStart("r6", { start: "2026-07-03T09:10:00.000Z", routine: "first-draft-job", label: "Draft", jobId: "Job A", batchId: "b3" }),
      runClose("r6", "2026-07-03T10:10:00.000Z", "done", "b3"),
      runStart("r7", { start: "2026-07-03T09:20:00.000Z", routine: "first-draft-job", label: "Draft", jobId: "Job B", batchId: "b3" }),
      runClose("r7", "2026-07-03T10:20:00.000Z", "stopped", "b3"),
      runStart("r8", { start: "2026-07-03T09:30:00.000Z", routine: "first-draft-job", label: "Draft", jobId: "Job C", batchId: "b3" }),
      runClose("r8", "2026-07-03T10:30:00.000Z", "failed", "b3"),
    ]);
    const res = await request(app).get("/api/notifications");
    const wave = res.body.events.find((e) => e.type === "wave_done");
    expect(wave.ref).toMatchObject({ kind: "batch", batchId: "b3", total: 3, done: 1, failed: 1, stopped: 1 });
  });

  it("does NOT emit wave_done while a batch still has a non-terminal run", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    writeActivity([
      runStart("r4", { start: "2026-07-03T09:10:00.000Z", routine: "first-draft-job", label: "Draft", jobId: "Job A", batchId: "b2" }),
      runClose("r4", "2026-07-03T10:10:00.000Z", "done", "b2"),
      // r5 started but never closed -> batch not complete
      runStart("r5", { start: "2026-07-03T09:20:00.000Z", routine: "first-draft-job", label: "Draft", jobId: "Job B", batchId: "b2" }),
    ]);
    const res = await request(app).get("/api/notifications");
    expect(res.body.events.some((e) => e.type === "wave_done")).toBe(false);
    // ...and the in-flight batch member does not leak out as a run_finished either.
    expect(res.body.events.some((e) => e.type === "run_finished")).toBe(false);
  });
});

describe("GET /api/notifications - task/project diff against baseline", () => {
  it("derives task_added, task_done, and project_added from the current-vs-baseline diff", async () => {
    // Baseline knew only t-001(done) and prj-x. Current adds t-new, flips t-flip to done, adds prj-new.
    seedState({ tasks: { "t-001": "done", "t-flip": "todo" }, projects: ["prj-x"] }, OLD);
    writeTasks([
      { id: "t-001", title: "Existing", status: "done", created: "2026-06-30" },
      { id: "t-flip", title: "Flip Me", status: "done", created: "2026-07-01" },
      { id: "t-new", title: "Brand New Ticket", status: "todo", created: "2026-07-03" },
    ]);
    writeProjects([
      { id: "prj-x", name: "Existing Project", created: "2026-06-30" },
      { id: "prj-new", name: "New Project", created: "2026-07-03" },
    ]);
    const res = await request(app).get("/api/notifications");
    const ids = res.body.events.map((e) => e.id);
    expect(ids).toContain("task-added:t-new");
    expect(ids).toContain("task-done:t-flip");
    expect(ids).toContain("project-added:prj-new");
    // Diff events are always unread until acknowledged.
    for (const id of ["task-added:t-new", "task-done:t-flip", "project-added:prj-new"]) {
      expect(res.body.events.find((e) => e.id === id).unread).toBe(true);
    }
    // A task that was already done at baseline does NOT re-fire.
    expect(ids).not.toContain("task-done:t-001");
    expect(ids).not.toContain("task-added:t-001");
  });
});

describe("notifications unread count + POST /api/notifications/read cursor advance", () => {
  it("counts unread relative to the cursor, then clears to 0 after read advances cursor + baseline", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    // one activity event (unread vs OLD cursor) + one brand-new task (always unread)
    writeActivity([
      runStart("r1", { start: "2026-07-03T09:00:00.000Z", routine: "discover-jobs", label: "Discover jobs" }),
      runClose("r1", "2026-07-03T10:00:00.000Z", "done"),
    ]);
    writeTasks([
      { id: "t-001", title: "Existing", status: "done", created: "2026-06-30" },
      { id: "t-new", title: "Brand New", status: "todo", created: "2026-07-03" },
    ]);

    const before = await request(app).get("/api/notifications");
    expect(before.body.unread).toBe(2); // run_finished + task_added
    const newest = before.body.events[0].ts;

    const read = await request(app).post("/api/notifications/read").send({ ts: newest });
    expect(read.status).toBe(200);
    expect(read.body.ok).toBe(true);
    expect(typeof read.body.cursor).toBe("string");

    const after = await request(app).get("/api/notifications");
    // cursor advanced past the activity event; baseline snapshotted the new task,
    // so the task_added diff is acknowledged -> everything is read.
    expect(after.body.unread).toBe(0);
  });

  it("POST /read never moves the cursor backwards", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, "2026-07-03T12:00:00.000Z");
    const res = await request(app).post("/api/notifications/read").send({ ts: OLD });
    expect(res.status).toBe(200);
    expect(res.body.cursor).toBe("2026-07-03T12:00:00.000Z"); // clamped forward, not regressed
  });

  it("POST /read with no body defaults the cursor to now and acknowledges the baseline", async () => {
    seedState({ tasks: { "t-001": "done" }, projects: ["prj-x"] }, OLD);
    writeTasks([
      { id: "t-001", title: "Existing", status: "done", created: "2026-06-30" },
      { id: "t-new", title: "Brand New", status: "todo", created: "2026-07-03" },
    ]);
    const read = await request(app).post("/api/notifications/read").send({});
    expect(read.status).toBe(200);
    const after = await request(app).get("/api/notifications");
    expect(after.body.events.some((e) => e.id === "task-added:t-new")).toBe(false); // acknowledged
  });
});
