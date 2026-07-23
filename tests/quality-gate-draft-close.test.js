// SIM-598 (JP-6) - the fail-closed quality gate wired into the LOCAL-SPAWN
// run-close path (maybeAutoAdvanceJob, server/index.js), the path a job on
// Simon's own laptop actually takes: the render script writes the CV/cover
// letter straight to the job folder on disk, then the agent process exits -
// there is no HTTP artifact-post step to reject here (see
// tests/quality-gate-runner-endpoint.test.js for that path). The only lever
// this path has is withholding the queued -> drafted status advance, which is
// exactly what "a violating artifact can never be reported done" means for a
// local run. Mirrors tests/finalize-queue.test.js's exact mocked-spawn
// harness (that suite proves the SAME auto-advance wiring on the happy path;
// this one proves the gate that now sits in front of it).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildDocxFixture } from "./helpers/docx-fixture.mjs";

// The batch endpoint launches the real claude.exe via startRun; mock spawn
// BEFORE importing the server (same pattern as finalize-queue.test.js).
function makeFakeProc(onBeforeClose) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => {
    try {
      if (onBeforeClose) onBeforeClose();
    } catch {
      /* a fixture-write failure should surface as a test assertion failure, not a hang */
    }
    proc.emit("close", 0);
  });
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app, tmpRoot, fixture, docsDir;

function jobFront(role, employer, status) {
  return [
    "---", "type: job", `role: ${role}`, `employer: ${employer}`,
    `status: ${status}`, "sector: private", "tags: [job]",
    "---", "", `# ${role} - ${employer}`, "",
  ].join("\n");
}

function makeJob(folder, status) {
  const [role, employer] = folder.split(" - ");
  const dir = path.join(fixture, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${role}.md`), jobFront(role, employer, status), "utf8");
  return { dir, role };
}

const jobById = async (jid) => (await request(app).get(`/api/jobs/${encodeURIComponent(jid)}`)).body;
const activityFeed = async () => (await request(app).get("/api/activity")).body;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-quality-gate-draft-"));
  fixture = path.join(tmpRoot, "Jobs");
  docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("SIM-598 quality gate at the local-spawn run-close path", () => {
  it("an over-2-page draft CV (.docx, --no-pdf) lands on disk but does NOT advance queued -> drafted", async () => {
    const JOB = "Overflow Role - Overflow Co";
    const { dir, role } = makeJob(JOB, "queued");
    const cvPath = path.join(dir, `${role} CV.docx`);
    spawnMock.mockImplementationOnce(() => makeFakeProc(() => fs.writeFileSync(cvPath, buildDocxFixture(1300))));

    const res = await request(app).post("/api/routines/batch").send({ routine: "first-draft-job", jobIds: [JOB] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    await sleep(150);

    const job = await jobById(JOB);
    expect(job.hasCV).toBe(true); // the render DID write the file
    expect(job.status).toBe("queued"); // but the gate withheld the status advance - not reported done

    const block = (await activityFeed()).find((r) => r.kind === "quality-gate-block" && r.jobId === JOB);
    expect(block).toBeTruthy();
    expect(block.attemptedStatus).toBe("drafted");
    expect(block.routine).toBe("first-draft-job");
    expect(block.reason).toMatch(/page/i);
  });

  it("an in-cap draft CV (.docx) advances queued -> drafted normally (the gate is not just 'always block')", async () => {
    const JOB = "Inbounds Role - Inbounds Co";
    const { dir, role } = makeJob(JOB, "queued");
    const cvPath = path.join(dir, `${role} CV.docx`);
    spawnMock.mockImplementationOnce(() => makeFakeProc(() => fs.writeFileSync(cvPath, buildDocxFixture(400))));

    const res = await request(app).post("/api/routines/batch").send({ routine: "first-draft-job", jobIds: [JOB] });
    expect(res.status).toBe(201);
    await sleep(150);

    const job = await jobById(JOB);
    expect(job.hasCV).toBe(true);
    expect(job.status).toBe("drafted");
  });

  it("a failed render (exit 1) leaves the job at queued regardless of the gate (evidence-backed only, unchanged prior behavior)", async () => {
    const JOB = "Failed Role - Failed Co";
    makeJob(JOB, "queued");
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("close", 1));
      return proc;
    });

    const res = await request(app).post("/api/routines/batch").send({ routine: "first-draft-job", jobIds: [JOB] });
    expect(res.status).toBe(201);
    await sleep(150);
    expect((await jobById(JOB)).status).toBe("queued");
  });
});
