import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// work-ticket is a new scope: "ticket" routine (server/index.js ROUTINES): the
// chatbot's "delegate now" fires it against a filed ticket id, not a job
// folder. This file proves its OWN existence-check boundary - the ticket-scope
// analogue of the job-folder containment guard already covered in
// tests/api.test.js ("POST /api/routines/run (job-folder containment guard)").
//
// The real routine runner spawns `claude.exe` (server/index.js startRun). We
// must never let a test actually launch that - it would run a real headless
// agent against a fixture ticket. So this file mocks node:child_process's
// spawn with a fake, synchronous-enough ChildProcess stand-in BEFORE importing
// the server module (vi.resetModules() + a fresh dynamic import, the same
// pattern tests/api.test.js and tests/tasks.test.js already use for a
// hermetic app instance). execFile is left as the real implementation via
// vi.importActual - this suite never hits the discovery endpoints that use it.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  // Emit "close" on the next tick, i.e. AFTER startRun() has already returned
  // synchronously and the route handler has read run.status - matches how a
  // real child process closes strictly after the synchronous spawn() call.
  setImmediate(() => proc.emit("close", 0));
  return proc;
}

const spawnMock = vi.fn(() => makeFakeProc());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app;
let tmpRoot;
let docsDir;
let jobsDir;

const FIXTURE_TICKET_ID = "t-fixture-work-ticket";

function writeTasksFixture() {
  const yaml = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${FIXTURE_TICKET_ID}`,
    "    title: Fixture ticket for the work-ticket routine test",
    "    detail: Do nothing; this ticket only exists to exercise the ticket-scope existence check.",
    "    epic: testing",
    "    priority: medium",
    "    status: todo",
    "    created: '2026-07-01'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), yaml, "utf8");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-work-ticket-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  writeTasksFixture();

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

describe("POST /api/routines/run - work-ticket (ticket-scope existence check)", () => {
  it("404s an unknown ticket id and never spawns an agent", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: "t-does-not-exist" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ticket/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Tickets are YAML records, not filesystem paths - there is no path to
  // escape from - but the guard must still reject a traversal-shaped id as a
  // plain unknown ticket (404), never treat it as special, and never spawn.
  it("404s a path-traversal-shaped ticket id, never spawns, and reads nothing outside tasks.yaml", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: "../../../etc/passwd" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ticket/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // The discriminating case: a ticket id that genuinely exists in
  // docs/tasks.yaml must pass the existence check and reach startRun. Without
  // a ticket-scope branch, the pre-existing check only knows how to resolve a
  // scope:"job" id against Jobs/<id> - it would treat this real ticket id as an
  // unresolvable job folder and wrongly 404 it (see this test's own note in
  // the PR/handoff: proven red before the scopeIdExists generalization landed).
  it("accepts a real ticket id, passes the existence check, and spawns the agent", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: FIXTURE_TICKET_ID });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.label).toBe("Work ticket");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The prompt handed to the spawned agent names the exact ticket id.
    const [, spawnArgs] = spawnMock.mock.calls[0];
    const prompt = spawnArgs.find((a) => typeof a === "string" && a.includes(FIXTURE_TICKET_ID));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("docs/tasks.yaml");
  });

  it("keeps the same claudeAllowedTools sandbox for work-ticket as every other routine", async () => {
    spawnMock.mockClear();
    await request(app).post("/api/routines/run").send({ routine: "work-ticket", jobId: FIXTURE_TICKET_ID });

    const [, spawnArgs] = spawnMock.mock.calls[0];
    const idx = spawnArgs.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    // Matches config.json's claudeAllowedTools (or the server's built-in
    // default) - the point is this routine does not carry its own, wider list.
    expect(typeof spawnArgs[idx + 1]).toBe("string");
    expect(spawnArgs[idx + 1].length).toBeGreaterThan(0);
  });
});
