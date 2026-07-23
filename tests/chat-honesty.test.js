// SIM-577: honest degradation for JobChat (POST /api/jobs/:id/chat) and the
// ChatCapture assessment leg (assess-ticket/work-ticket, scope:"ticket") on an
// instance that cannot spawn a local `claude` process - the pg/Railway image
// class SIM-535's runner-routing wave missed. Both used to fall through to
// spawn(CLAUDE_BIN, ...) unconditionally (chat gated ONLY by DEMO_MODE;
// ticket-scoped routines deliberately excluded from the runner-routing gate)
// -> ENOENT -> a leaked 500 (chat) / a spinner nothing could ever resolve
// ("Awaiting CTO assessment..."). Mirrors the SIM-562 fix-shape (PR #14):
// derive an honest state from the SAME existing capability fact
// (CLAUDE_BIN_PRESENT), response-only, no new heartbeat/state machine.
//
// JOBHUNT_CLAUDE_BIN is the test seam (mirrors JOBHUNT_PYTHON) that points
// CLAUDE_BIN_PRESENT at a controlled path, so both the "unavailable" and
// "available" cases are hermetic - neither depends on whether THIS machine
// happens to have a real claude binary installed at the guessed path.
//
// spawn is mocked so neither describe block can ever launch a real process;
// the "available" block additionally proves the new gates never fire when a
// binary IS present (no behavior change for the laptop/dev posture).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

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

const TICKET_ID = "t-fixture-chat-honesty";
const JOB = "Cc Role - Cc Co";

function writeTasksFixture(docsDir) {
  const yaml = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${TICKET_ID}`,
    "    title: Fixture ticket for the SIM-577 honesty test",
    "    detail: Free-typed chatbot text; only exists to exercise the routine launch.",
    "    epic: testing",
    "    priority: medium",
    "    status: triage",
    "    created: '2026-07-23'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), yaml, "utf8");
}

function makeJob(jobsDir) {
  const [role, employer] = JOB.split(" - ");
  const dir = path.join(jobsDir, JOB);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${role}.md`),
    [
      "---", "type: job", `role: ${role}`, `employer: ${employer}`,
      "track: b2b_gtm_focused", "fit: strong", "status: drafted",
      "sector: private", "tailoring: light", "tags: [job]",
      "---", "", `# ${JOB}`, "",
    ].join("\n"),
    "utf8",
  );
}

describe("SIM-577 - agent execution UNAVAILABLE (no local claude binary, no runner configured)", () => {
  let app;
  let tmpRoot;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-chat-honesty-off-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    makeJob(jobsDir);
    writeTasksFixture(docsDir);

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_CLAUDE_BIN = path.join(tmpRoot, "no-such-claude-binary.exe"); // deliberately absent
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.RUNNER_TOKEN_HASH; // real mode, runner NOT configured either
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  afterAll(() => {
    delete process.env.JOBHUNT_CLAUDE_BIN;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/config declares agentSpawnAvailable:false", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.agentSpawnAvailable).toBe(false);
  });

  it("JobChat: POST never 500s, never spawns, returns an honest disabled response with the transcript unchanged", async () => {
    spawnMock.mockClear();
    const before = (await request(app).get(`/api/jobs/${encodeURIComponent(JOB)}/chat`)).body.messages;

    const res = await request(app)
      .post(`/api/jobs/${encodeURIComponent(JOB)}/chat`)
      .send({ message: "What makes me a fit for this role?" });

    expect(res.status).toBe(200); // never a 500, even though no `claude` CLI exists here
    expect(res.body.disabled).toBe(true);
    expect(res.body.reason).toBe("Agent chat runs on the laptop runner - unavailable on this instance.");
    expect(res.body.messages).toEqual(before); // no invented user or assistant turn was appended
    expect(spawnMock).not.toHaveBeenCalled();

    const after = (await request(app).get(`/api/jobs/${encodeURIComponent(JOB)}/chat`)).body.messages;
    expect(after).toEqual(before);
  });

  it("assess-ticket: fails immediately with the honest reason (never a leaked ENOENT), and never spawns", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: TICKET_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Agent execution runs on the laptop runner - unavailable on this instance.");
    expect(res.body.error).not.toMatch(/ENOENT|spawn error/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("work-ticket: same honest failure, never spawns", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: TICKET_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Agent execution runs on the laptop runner - unavailable on this instance.");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("SIM-577 - agent execution AVAILABLE (regression: unaffected when a local claude binary IS present)", () => {
  let app;
  let tmpRoot;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-chat-honesty-on-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    makeJob(jobsDir);
    writeTasksFixture(docsDir);

    const fakeBin = path.join(tmpRoot, "fake-claude-binary");
    fs.writeFileSync(fakeBin, "not a real binary - spawn is mocked in this suite", "utf8");

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_CLAUDE_BIN = fakeBin; // exists -> CLAUDE_BIN_PRESENT true
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.RUNNER_TOKEN_HASH;
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  afterAll(() => {
    delete process.env.JOBHUNT_CLAUDE_BIN;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/config declares agentSpawnAvailable:true", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.agentSpawnAvailable).toBe(true);
  });

  it("JobChat: still spawns and answers normally - the new gate never fires when a binary IS present", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post(`/api/jobs/${encodeURIComponent(JOB)}/chat`)
      .send({ message: "What makes me a fit for this role?" });

    expect(res.status).toBe(200);
    expect(res.body.disabled).toBeUndefined();
    expect(res.body.reply).toBeDefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("assess-ticket: still spawns normally - the new gate never fires when a binary IS present", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: TICKET_ID });

    expect(res.status).toBe(201);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
