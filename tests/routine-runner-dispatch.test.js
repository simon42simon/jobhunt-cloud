// Runner-routed JOB-scoped routines, end to end over HTTP: an instance that
// cannot spawn agents locally (the pg/Railway image - the "[spawn error] spawn
// claude ENOENT" a cloud Finalize click used to die with) routes
// POST /api/routines/run for a whitelisted runner kind into the hybrid runner
// queue instead of spawning. The run record stays in the ordinary runs Map, so
// the whole existing surface holds: GET run/:runId polling (progress lines fold
// through the same stream-json parser), the per-(routine, jobId) duplicate
// guard, artifact egress into the job folder, the close-time status
// auto-advance (drafted -> ready once the runner's CV landed), and the lazy
// dead-laptop reconcile. Hermetic on FileStore with
// JOBHUNT_SOURCE_DISPATCH=runner forcing the pg-instance decision; spawn is
// mocked ONLY to prove it is never called on this path.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";

const TOKEN = "test-runner-token-routine-1234";
const bearer = () => `Bearer ${TOKEN}`;

const spawnMock = vi.fn(() => {
  throw new Error("spawn must never be reached on the runner-routed path");
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app;
let tmpRoot;
let docsDir;
let jobsDir;
let lastRunId; // the most recent run launched for JOB (shared across the sequential suites)

const JOB = "Aa Role - Aa Co";

function makeJob(folder, status) {
  const [role, employer] = folder.split(" - ");
  const dir = path.join(jobsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${role}.md`),
    [
      "---", "type: job", `role: ${role}`, `employer: ${employer}`,
      "track: b2b_gtm_focused", "fit: strong", `status: ${status}`,
      "sector: private", "tailoring: light", "tags: [job]",
      "---", "", `# ${folder}`, "",
    ].join("\n"),
    "utf8",
  );
}

const launch = (routine, jobId) => request(app).post("/api/routines/run").send({ routine, jobId });
const getRun = async (runId) => {
  const r = await request(app).get(`/api/routines/run/${runId}`);
  expect(r.status).toBe(200);
  return r.body;
};
async function claimNext() {
  const r = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-rrun-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  makeJob(JOB, "drafted");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN); // real mode + runner enabled
  process.env.JOBHUNT_SOURCE_DISPATCH = "runner"; // force the pg-instance decision
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  delete process.env.JOBHUNT_SOURCE_DISPATCH;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("dispatch", () => {
  it("routes a job-scoped routine into the runner queue - no local spawn, and reports the honest waiting-for-runner state (SIM-562)", async () => {
    const r = await launch("finalize-job", JOB);
    expect(r.status).toBe(201);
    lastRunId = r.body.runId;
    expect(spawnMock).not.toHaveBeenCalled();
    const run = await getRun(lastRunId);
    // No runner has EVER polled this app instance: SIM-562's honest substate,
    // not the SIM-543-era "running" that painted the finalize dialog's
    // animated bar for an hour with a dead laptop behind it.
    expect(run.status).toBe("waiting-for-runner");
    expect(run.agentJobId).toMatch(/^aj-/);
    expect(run.currentActivity).toMatch(/no laptop runner connected/i);
    // Internal fold cursors never leak onto the wire.
    expect(Object.keys(run).some((k) => k.startsWith("_"))).toBe(false);
  });

  it("keeps the per-(routine, jobId) duplicate guard while the run is queued", async () => {
    const dup = await launch("finalize-job", JOB);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already in progress/);
  });

  // SIM-543 contract: Stop on a run whose job is still QUEUED cancels it
  // server-side (the cloud queue is ours to edit until a runner claims);
  // only a CLAIMED/RUNNING job earns the honest 409 - covered after the
  // claim below. Ordering note: the queued-cancel case is proven in
  // tests/runner-run-bridge.test.js so THIS file's single job survives for
  // the claim -> result lifecycle it exists to test.
});

describe("claim -> progress -> artifact -> result", () => {
  let claim;

  it("the laptop claims the job with the routine kind and target job", async () => {
    claim = await claimNext();
    expect(claim.kind).toBe("finalize-job");
    expect(claim.jobId).toBe(JOB);
  });

  it("refuses Stop honestly once the laptop owns the claimed job", async () => {
    const r = await request(app).post(`/api/routines/run/${lastRunId}/stop`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/laptop/);
  });

  it("relayed progress lines surface on the run-panel poll", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/progress`)
      .set("authorization", bearer())
      .send({ lines: ["re-tailoring the CV against the gaps note"] });
    expect(r.status).toBe(200);
    const run = await getRun(lastRunId);
    expect(run.output).toMatch(/re-tailoring the CV/);
  });

  it("a posted artifact lands in the job folder; the done result closes the run and auto-advances drafted -> ready", async () => {
    const art = await request(app)
      .post(`/api/runner/jobs/${claim.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .set("x-artifact-name", "Aa Role - CV.pdf")
      .set("x-artifact-mime", "application/pdf")
      .set("content-type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 fake"));
    expect(art.status).toBe(201);

    // SIM-613/615: finalize-job requires BOTH PDFs to land (server/index.js's
    // finalize-job recipe checks for a current cover letter AND a current CV -
    // posting only one and reporting done is exactly the false-success bug the
    // fail-closed rule now catches, so this end-to-end happy path posts both.
    const cover = await request(app)
      .post(`/api/runner/jobs/${claim.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .set("x-artifact-name", "Aa Role - Cover Letter.pdf")
      .set("x-artifact-mime", "application/pdf")
      .set("content-type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 fake"));
    expect(cover.status).toBe(201);

    const res = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "done" });
    expect(res.status).toBe(200);

    // The result endpoint closed the run push-style - no run-panel poll needed
    // first (the GET here only reads the already-terminal record).
    const run = await getRun(lastRunId);
    expect(run.status).toBe("done");
    expect(run.exitCode).toBe(0);

    // Close bookkeeping ran: the finalize auto-advance saw the runner's CV
    // (draftDone) and flipped the job pre-submission status drafted -> ready.
    const jobs = (await request(app).get("/api/jobs")).body;
    expect(jobs.find((j) => j.id === JOB).status).toBe("ready");
  });

  it("the duplicate guard releases once the run is terminal", async () => {
    const r = await launch("finalize-job", JOB);
    expect(r.status).toBe(201);
    lastRunId = r.body.runId;
  });
});

describe("failure honesty", () => {
  it("a failed runner result flips the run to failed with the error in the output", async () => {
    const claim = await claimNext();
    const res = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "failed", error: "local run exited 1" });
    expect(res.status).toBe(200);
    const run = await getRun(lastRunId);
    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/local run exited 1/);
  });

  it("a dead runner job (laptop offline) is reconciled at the next launch - fails the wedged run, frees the guard", async () => {
    const r = await launch("finalize-job", JOB);
    expect(r.status).toBe(201);
    const wedged = r.body.runId;
    const claim = await claimNext();

    // Simulate the laptop dying: flip the claimed row to dead directly in the
    // FileStore's agent-jobs.json (what the lease sweep would do).
    const ajFile = path.join(docsDir, "agent-jobs.json");
    const data = JSON.parse(fs.readFileSync(ajFile, "utf8"));
    data.jobs.find((j) => j.id === claim.id).status = "dead";
    fs.writeFileSync(ajFile, JSON.stringify(data), "utf8");

    // The next launch's sweep flips the wedged run instead of 409ing forever.
    const again = await launch("finalize-job", JOB);
    expect(again.status).toBe(201);
    const old = await getRun(wedged);
    expect(old.status).toBe("failed");
    expect(old.output).toMatch(/lease expired/);
  });
});
