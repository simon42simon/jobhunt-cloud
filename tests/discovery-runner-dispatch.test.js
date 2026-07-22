// SIM-535 - runner-routed source discovery lifecycle, end to end over HTTP:
// an instance that cannot spawn agents locally (the pg/Railway image) routes
// POST /api/discovery/sources/:id/run into the hybrid runner queue; the claim
// is enriched with the live source record + tracked-links index; the runner's
// result payload is ingested (finds filed via the pursue-equivalent createJob
// contract with server-side link dedup) and the source's run record flips to
// its honest terminal state with counters + leadsFound/leadsNew - all WITHOUT
// readDiscovery (the workbook does not exist on pg). Hermetic on FileStore
// with JOBHUNT_SOURCE_DISPATCH=runner forcing the dispatch decision.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { hashToken } from "../server/runner-lib.js";

const TOKEN = "test-runner-token-dispatch-1234";
const bearer = () => `Bearer ${TOKEN}`;

let app;
let tmpRoot;
let docsDir;

const SOURCE = {
  id: "src-a",
  name: "Source A",
  type: "employer",
  sector: "public",
  urls: ["https://example.org/careers"],
  instructions: "Scan the board.",
  cadence: "weekly",
  active: "yes",
  runs: [],
};

const runById = (body, id) => (body.runs || []).find((r) => r.runId === id);

async function startRun() {
  const r = await request(app).post("/api/discovery/sources/src-a/run");
  expect(r.status).toBe(201);
  return r.body;
}

async function claimNext() {
  const r = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
  expect(r.status).toBe(200);
  return r.body;
}

async function getSource() {
  const r = await request(app).get("/api/discovery/sources/src-a");
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-disp-"));
  docsDir = path.join(tmpRoot, "docs");
  const jobsDir = path.join(tmpRoot, "Jobs");
  const findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  fs.writeFileSync(path.join(docsDir, "discovery-sources.yaml"), yaml.dump({ version: 1, sources: [SOURCE] }), "utf8");
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

describe("dispatch", () => {
  it("refuses discover-jobs-source on the generic owner enqueue (single bookkeeping path)", async () => {
    const r = await request(app).post("/api/agent-jobs").send({ kind: "discover-jobs-source" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sources\/:id\/run/);
  });

  it("routes Run-now into the runner queue with the optimistic record + lastRunAt", async () => {
    const body = await startRun();
    expect(body.runId).toMatch(/^aj-/);
    expect(body.source.lastRunAt).toBeTruthy();
    const rec = runById(body.source, body.runId);
    expect(rec).toBeTruthy();
    expect(rec.outcome).toBe("running");
    expect(body.source.status).toBe("running"); // derived health pill
  });

  it("409s a second run while one is queued", async () => {
    const r = await request(app).post("/api/discovery/sources/src-a/run");
    expect(r.status).toBe(409);
  });
});

describe("claim enrichment -> result ingest", () => {
  let claim;

  it("enriches the claim with the live source record + tracked-links index", async () => {
    claim = await claimNext();
    expect(claim.kind).toBe("discover-jobs-source");
    expect(claim.jobId).toBeNull();
    expect(claim.payload.sourceId).toBe("src-a");
    expect(claim.payload.source).toMatchObject({ id: "src-a", instructions: "Scan the board." });
    expect(Array.isArray(claim.payload.trackedLinks)).toBe(true);
  });

  it("ingests a done result: files deduped finds as jobs and flips the record", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({
        nonce: claim.nonce,
        status: "done",
        result: {
          counters: { candidatesReviewed: 5, alreadyTracked: 1, filteredOut: 2 },
          finds: [
            { title: "Analyst", employer: "OCI", link: "https://example.org/jobs/1", deadline: "rolling", sector: "public", track: "public_sector_focused", status: "queued" },
            { title: "Analyst Duplicate", employer: "Other", link: "https://example.org/JOBS/1 " }, // same link (case/space-insensitive) -> deduped
            { title: "Officer", employer: "MaRS", link: "https://example.org/jobs/2", deadline: "2027-01-15" },
          ],
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(false);

    const jobs = (await request(app).get("/api/jobs")).body;
    const created = jobs.filter((j) => j.source === "src-a");
    expect(created).toHaveLength(2);
    const analyst = created.find((j) => j.role === "Analyst");
    expect(analyst).toMatchObject({ status: "queued", deadline: "rolling", link: "https://example.org/jobs/1" });
    const officer = created.find((j) => j.role === "Officer");
    expect(officer).toMatchObject({ status: "lead", deadline: "2027-01-15" });

    const src = await getSource();
    const rec = runById(src, claim.id);
    expect(rec).toBeTruthy();
    expect(rec.outcome).toBe("succeeded");
    expect(rec.leadsNew).toBe(2);
    expect(rec.leadsFound).toBe(2);
    expect(rec.candidatesReviewed).toBe(5);
    expect(rec.alreadyTracked).toBe(1);
    expect(rec.filteredOut).toBe(2);
    expect(typeof rec.durationMs).toBe("number");
    expect(src.status).not.toBe("running");
  });

  it("a replayed result is an idempotent no-op (never a double-file)", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "done", result: { counters: {}, finds: [{ title: "Again", employer: "X", link: "https://example.org/jobs/9" }] } });
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(true);
    const jobs = (await request(app).get("/api/jobs")).body;
    expect(jobs.filter((j) => j.source === "src-a")).toHaveLength(2); // unchanged
  });
});

describe("failure honesty", () => {
  it("a failed run flips the record to failed with the error", async () => {
    await startRun();
    const claim = await claimNext();
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "failed", error: "local run exited 1" });
    expect(r.status).toBe(200);
    const rec = runById(await getSource(), claim.id);
    expect(rec.outcome).toBe("failed");
    expect(rec.errorReason).toBe("local run exited 1");
  });

  it("done with a missing/rejected finds payload lands as incomplete, never a fake success", async () => {
    await startRun();
    const claim = await claimNext();
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "done" }); // no result body at all
    expect(r.status).toBe(200);
    const rec = runById(await getSource(), claim.id);
    expect(rec.outcome).toBe("incomplete");
    expect(rec.errorReason).toMatch(/finds payload rejected/);
  });

  it("a dead runner job is reconciled lazily on the registry read", async () => {
    await startRun();
    const claim = await claimNext();
    // Simulate the laptop dying: the lease sweep would mark the claimed job
    // dead; do it directly in the FileStore's agent-jobs.json (DATA_DIR follows
    // the test docs dir).
    const ajFile = path.join(docsDir, "agent-jobs.json");
    const data = JSON.parse(fs.readFileSync(ajFile, "utf8"));
    const row = data.jobs.find((j) => j.id === claim.id);
    row.status = "dead";
    fs.writeFileSync(ajFile, JSON.stringify(data), "utf8");

    const rec = runById(await getSource(), claim.id);
    expect(rec).toBeTruthy();
    expect(rec.outcome).toBe("failed");
    expect(rec.errorReason).toMatch(/lease expired/);
  });
});
