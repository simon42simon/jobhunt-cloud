// SIM-562: the stalled threshold + one-click re-queue, over HTTP - the fix-shape's
// remaining two points not covered by runner-run-bridge.test.js /
// routine-runner-dispatch.test.js (which cover point 1's waiting-for-runner /
// running fixtures). A deliberately tiny RUNNER_STALLED_MS lets "unclaimed too
// long" be reached with a real (short) wait instead of a fake clock, mirroring
// how RUNNER_POLL_STALE_MS is already exercised via lastRunnerPollAt elsewhere
// in this suite. Hermetic on FileStore with JOBHUNT_SOURCE_DISPATCH=runner
// (forces the pg-instance decision).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { hashToken } from "../server/runner-lib.js";

const TOKEN = "test-runner-token-stalled-1234";
const bearer = () => `Bearer ${TOKEN}`;
const STALL_MS = 40;

let app;
let tmpRoot;
let jobsDir;

const JOB = "Bb Role - Bb Co";

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

const sleepPastThreshold = () => new Promise((r) => setTimeout(r, STALL_MS + 30));

async function getRun(runId) {
  const r = await request(app).get(`/api/routines/run/${runId}`);
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-stalled-"));
  const docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  const findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  fs.writeFileSync(
    path.join(docsDir, "discovery-sources.yaml"),
    yaml.dump({ version: 1, sources: [mkSource("src-stall", "Source Stall")] }),
    "utf8",
  );
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  makeJob(JOB, "drafted");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN); // real mode + runner enabled
  process.env.JOBHUNT_SOURCE_DISPATCH = "runner"; // force the pg-instance decision
  process.env.RUNNER_STALLED_MS = String(STALL_MS); // SIM-562: a reachable threshold
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  delete process.env.JOBHUNT_SOURCE_DISPATCH;
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  delete process.env.RUNNER_STALLED_MS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("stalled threshold (SIM-562 fix-shape point 3)", () => {
  it("an unclaimed source run past RUNNER_STALLED_MS surfaces as stalled, with a re-queue-able note", async () => {
    const start = await request(app).post("/api/discovery/sources/src-stall/run");
    expect(start.status).toBe(201);
    const runId = start.body.runId;
    expect(runId).toMatch(/^aj-/);

    await sleepPastThreshold();
    const r = await getRun(runId);
    expect(r.status).toBe("stalled");
    expect(r.currentActivity).toMatch(/stalled/i);
    expect(r.currentActivity).toMatch(/re-queue/i);
  });

  it("re-queue resets the clock: the SAME runId goes back to waiting-for-runner, not a fresh id", async () => {
    const start = await request(app).post("/api/discovery/sources/src-stall/run");
    // A source run is already in progress from the test above (still queued,
    // now stalled) - the running-guard 409s a fresh launch, which is exactly
    // why re-queue exists instead of just relaunching.
    expect(start.status).toBe(409);

    // Recover the stalled run's id off the source's own run history.
    const src = (await request(app).get("/api/discovery/sources/src-stall")).body;
    const stalledRunId = (src.runs || []).find((x) => x.outcome === "running").runId;
    const before = await getRun(stalledRunId);
    expect(before.status).toBe("stalled");

    const rq = await request(app).post(`/api/routines/run/${stalledRunId}/requeue`);
    expect(rq.status).toBe(200);
    expect(rq.body.ok).toBe(true);

    // Same id, clock reset: back to a fresh queued wait, never silently stuck.
    const after = await getRun(stalledRunId);
    expect(after.status).toBe("waiting-for-runner");
    expect(after.currentActivity).not.toMatch(/stalled/i);
  });

  it("re-queuing an already-claimed run is an honest 409 (claimed/running is genuinely progressing)", async () => {
    const src = (await request(app).get("/api/discovery/sources/src-stall")).body;
    const runId = (src.runs || []).find((x) => x.outcome === "running").runId;
    const claim = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
    expect(claim.status).toBe(200);
    expect(claim.body.kind).toBe("discover-jobs-source");

    const rq = await request(app).post(`/api/routines/run/${runId}/requeue`);
    expect(rq.status).toBe(409);
  });

  it("re-queuing an unknown aj id 404s", async () => {
    const rq = await request(app).post("/api/routines/run/aj-0000000000000-deadbeef/requeue");
    expect(rq.status).toBe(404);
  });

  it("a job-scoped runner-routed run also crosses into stalled (the finalize-application incident's exact path), and re-queues via its own runId", async () => {
    const launch = await request(app).post("/api/routines/run").send({ routine: "finalize-job", jobId: JOB });
    expect(launch.status).toBe(201);
    const runId = launch.body.runId; // the Map's own r<ts>_<seq> id, not an aj-* id

    await sleepPastThreshold();
    const r = await getRun(runId);
    expect(r.status).toBe("stalled");

    const rq = await request(app).post(`/api/routines/run/${runId}/requeue`);
    expect(rq.status).toBe(200);
    const after = await getRun(runId);
    // Same externally-visible runId throughout (only the internal agentJobId
    // pointer's queued-since clock reset) - un-stalled, whether it reads as
    // waiting-for-runner or running depends on this file's earlier runner
    // polls, which is not the point being proven here.
    expect(after.status).not.toBe("stalled");
    expect(["running", "waiting-for-runner"]).toContain(after.status);
  });
});
