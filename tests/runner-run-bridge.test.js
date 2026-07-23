// SIM-543 - the runner-run honesty surface, end to end over HTTP:
// (1) GET /api/routines/run/:runId answers for aj-* ids the in-memory runs Map
//     never held (runner-routed SOURCE runs; any run after a restart), synthesized
//     from the agent-job row - the RunPanel used to poll those into 404 forever
//     (a phantom "RUNNING" dialog no backend state could correct).
// (2) The queued wait note is runner-liveness-aware ("no laptop runner
//     connected" vs "waiting for the runner").
// (3) Stop CANCELS a still-queued job server-side (and the source record flips
//     in the same motion); a claimed job earns the honest 409; the canceled
//     corpse can never 409-block the next launch.
// (4) A failed result's error text (e.g. the runner's spawn-error capture)
//     surfaces in the bridged run output and the source record's errorReason.
// Hermetic on FileStore with JOBHUNT_SOURCE_DISPATCH=runner, mirroring
// tests/discovery-runner-dispatch.test.js.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { hashToken } from "../server/runner-lib.js";
import { validateRunnerBoot } from "../ops/agent-runner.mjs";

const TOKEN = "test-runner-token-bridge-1234";
const bearer = () => `Bearer ${TOKEN}`;

let app;
let tmpRoot;
let claimedNonce; // the src-a claim's single-use nonce, carried across tests

const mkSource = (id, name) => ({
  id,
  name,
  type: "employer",
  sector: "public",
  urls: [`https://example.org/${id}/careers`],
  instructions: "Scan the board.",
  cadence: "weekly",
  active: "yes",
  runs: [],
});

async function startRun(srcId) {
  const r = await request(app).post(`/api/discovery/sources/${srcId}/run`);
  expect(r.status).toBe(201);
  return r.body;
}

async function claimNext() {
  const r = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
  expect(r.status).toBe(200);
  return r.body;
}

async function getBridgedRun(runId) {
  return request(app).get(`/api/routines/run/${runId}`);
}

async function getSource(srcId) {
  const r = await request(app).get(`/api/discovery/sources/${srcId}`);
  expect(r.status).toBe(200);
  return r.body;
}

const runById = (body, id) => (body.runs || []).find((r) => r.runId === id);

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-bridge-"));
  const docsDir = path.join(tmpRoot, "docs");
  const jobsDir = path.join(tmpRoot, "Jobs");
  const findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  fs.writeFileSync(
    path.join(docsDir, "discovery-sources.yaml"),
    yaml.dump({ version: 1, sources: [mkSource("src-a", "Source A"), mkSource("src-b", "Source B")] }),
    "utf8",
  );
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
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
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("aj-* run-status bridge + liveness", () => {
  it("bridges a queued source run the runs Map never held, honestly as waiting-for-runner (SIM-562) with the no-runner-connected note", async () => {
    const { runId } = await startRun("src-a");
    expect(runId).toMatch(/^aj-/);
    const r = await getBridgedRun(runId);
    expect(r.status).toBe(200);
    // No runner has EVER polled this server: a distinct status, not a reworded
    // "running" - the fix-shape's first fixture (SIM-562).
    expect(r.body.status).toBe("waiting-for-runner");
    expect(r.body.currentActivity).toMatch(/no laptop runner connected/i);
  });

  it("Stop cancels the queued job, flips the record, and never 409-blocks the relaunch", async () => {
    const src = await getSource("src-a");
    const runId = (src.runs || []).find((x) => x.outcome === "running").runId;
    const stop = await request(app).post(`/api/routines/run/${runId}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.canceled).toBe(true);
    // The record flipped in the same motion (afterCancel reconcile).
    const after = await getSource("src-a");
    const rec = runById(after, runId);
    expect(rec.outcome).toBe("failed");
    expect(rec.errorReason).toMatch(/canceled by owner/i);
    // The corpse cannot 409 the next launch (launchSourceRun sweeps first).
    const again = await startRun("src-a");
    expect(again.runId).toMatch(/^aj-/);
    // A second stop on the ALREADY-terminal first job is an idempotent ok.
    const stop2 = await request(app).post(`/api/routines/run/${runId}/stop`);
    expect(stop2.status).toBe(200);
    expect(stop2.body.canceled).toBe(false);
  });

  it("after a runner poll, a queued run transitions to the plain running/waiting note (SIM-562 fixture: runner connects -> running)", async () => {
    // src-a has a queued run from the test above; the claim below stamps
    // lastRunnerPollAt (and claims that very job).
    const claim = await claimNext();
    expect(claim.kind).toBe("discover-jobs-source");
    claimedNonce = claim.nonce;
    // Enqueue src-b AFTER the poll: queued + recently-seen runner = plain wait,
    // reported as the ordinary "running" status (not waiting-for-runner).
    const { runId } = await startRun("src-b");
    const r = await getBridgedRun(runId);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("running");
    expect(r.body.currentActivity).toMatch(/waiting for the laptop runner/i);
  });

  it("a claimed run bridges as running-on-the-laptop and its Stop is an honest 409", async () => {
    // src-a's relaunched job was claimed in the previous test.
    const src = await getSource("src-a");
    const rec = (src.runs || []).find((x) => x.outcome === "running");
    const r = await getBridgedRun(rec.runId);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("running");
    const stop = await request(app).post(`/api/routines/run/${rec.runId}/stop`);
    expect(stop.status).toBe(409);
    expect(stop.body.error).toMatch(/laptop/i);
  });

  it("a failed result's error text (spawn-error capture) reaches the bridged output AND the record", async () => {
    // Fail the claimed src-a job with the exact error shape the runner's
    // spawn-error capture posts.
    const src = await getSource("src-a");
    const rec = (src.runs || []).find((x) => x.outcome === "running");
    // The claim from two tests ago belongs to this job; re-derive its nonce by
    // claiming is impossible (single claim) - so fetch the claim we stored.
    const fail = await request(app)
      .post(`/api/runner/jobs/${rec.runId}/result`)
      .set("authorization", bearer())
      .send({ nonce: claimedNonce, status: "failed", error: "spawn failed: spawn claude.exe ENOENT (bin=claude.exe cwd=C:\\data)" });
    expect(fail.status).toBe(200);
    const r = await getBridgedRun(rec.runId);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("failed");
    expect(r.body.output).toMatch(/spawn failed: spawn claude\.exe ENOENT/);
    const after = await getSource("src-a");
    expect(runById(after, rec.runId).outcome).toBe("failed");
    expect(runById(after, rec.runId).errorReason).toMatch(/spawn failed/);
  });

  it("an unknown aj id still 404s", async () => {
    const r = await getBridgedRun("aj-0000000000000-deadbeef");
    expect(r.status).toBe(404);
  });
});

describe("runner boot validation", () => {
  it("refuses a workspace dir that does not exist (the container-config-on-laptop class)", () => {
    const problems = validateRunnerBoot({
      workspaceDir: path.join(tmpRoot, "definitely-missing"),
      jobsDir: path.join(tmpRoot, "definitely-missing", "Jobs"),
      claudeBin: "claude.exe",
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/JOBHUNT_JOBS_DIR/);
  });

  it("passes a real workspace dir and flags an absolute claude path that is missing", () => {
    expect(validateRunnerBoot({ workspaceDir: tmpRoot, jobsDir: path.join(tmpRoot, "Jobs"), claudeBin: "claude.exe" })).toEqual([]);
    const problems = validateRunnerBoot({
      workspaceDir: tmpRoot,
      jobsDir: path.join(tmpRoot, "Jobs"),
      claudeBin: path.join(tmpRoot, "nope", "claude.exe"),
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/claude binary not found/);
  });
});
