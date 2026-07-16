import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// assess-ticket is the second scope: "ticket" routine (server/index.js
// ROUTINES): the CTO triage pass over a filed chatbot ticket. By charter it is
// COMMENT-ONLY - the prompt instructs the agent to read the ticket + minimal
// context and record exactly one assessment comment (author "cto") through
// PATCH /api/tasks/:id, never to execute the work, edit code, or hand-edit
// tasks.yaml. This file mirrors tests/work-ticket.test.js: registration, the
// ticket-scope existence boundary, the prompt's charter language, and the
// unchanged claudeAllowedTools sandbox.
//
// The real routine runner spawns `claude.exe` (server/index.js startRun). We
// must never let a test actually launch that, so node:child_process's spawn is
// mocked with a fake ChildProcess stand-in BEFORE importing the server module
// (same pattern as work-ticket.test.js).
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
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

const FIXTURE_TICKET_ID = "t-fixture-assess-ticket";

function writeTasksFixture() {
  const yaml = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${FIXTURE_TICKET_ID}`,
    "    title: Fixture ticket for the assess-ticket routine test",
    "    detail: Free-typed chatbot text; only exists to exercise the ticket-scope check.",
    "    epic: testing",
    "    priority: medium",
    "    status: triage",
    "    created: '2026-07-02'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), yaml, "utf8");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-assess-ticket-"));
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

describe("assess-ticket routine registration", () => {
  it("is listed by GET /api/routines with scope ticket and the 'CTO assessment' label", async () => {
    const res = await request(app).get("/api/routines");

    expect(res.status).toBe(200);
    const assess = res.body.find((r) => r.id === "assess-ticket");
    expect(assess).toBeDefined();
    expect(assess.scope).toBe("ticket");
    expect(assess.label).toBe("CTO assessment");
  });
});

describe("POST /api/routines/run - assess-ticket (ticket-scope existence check)", () => {
  it("404s an unknown ticket id and never spawns an agent", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: "t-does-not-exist" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ticket/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("404s a path-traversal-shaped ticket id and never spawns", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: "../../../etc/passwd" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ticket/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts a real ticket id and spawns with the comment-only charter prompt", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: FIXTURE_TICKET_ID });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBeDefined();
    expect(res.body.label).toBe("CTO assessment");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, spawnArgs] = spawnMock.mock.calls[0];
    const prompt = spawnArgs.find((a) => typeof a === "string" && a.includes(FIXTURE_TICKET_ID));
    expect(prompt).toBeDefined();
    // The agent is pointed at the API, not the file: read the ticket via GET
    // /api/tasks and write ONE comment (author "cto") via PATCH.
    expect(prompt).toContain("/api/tasks");
    expect(prompt).toContain('"author":"cto"');
    expect(prompt).toMatch(/EXACTLY ONE assessment comment/i);
    // The comment's required content: assessment, plan, subtask checklist,
    // suggested owner + priority.
    expect(prompt).toMatch(/valid, a duplicate, or needs-info/i);
    expect(prompt).toMatch(/plan/i);
    expect(prompt).toMatch(/checklist/i);
    expect(prompt).toMatch(/owner and priority/i);
    // Comment-only charter: never execute, never edit, never hand-edit
    // tasks.yaml, never create other tickets.
    expect(prompt).toMatch(/never do the work|do NOT execute the work/i);
    expect(prompt).toMatch(/do NOT edit any code or files/i);
    expect(prompt).toMatch(/never hand-edit docs\/tasks\.yaml/i);
    expect(prompt).toMatch(/do NOT create or modify any other ticket/i);
  });

  it("keeps the same claudeAllowedTools sandbox as every other routine (no widened per-routine list)", async () => {
    spawnMock.mockClear();
    await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: FIXTURE_TICKET_ID });

    const [, spawnArgs] = spawnMock.mock.calls[0];
    const idx = spawnArgs.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(typeof spawnArgs[idx + 1]).toBe("string");
    expect(spawnArgs[idx + 1].length).toBeGreaterThan(0);
    // Same permission mode as the rest of the runner - never skip-permissions.
    expect(spawnArgs).toContain("--permission-mode");
    expect(spawnArgs).not.toContain("--dangerously-skip-permissions");
  });
});
