// RC-3 / SIM-87 I7 - runner HTTP endpoints + auth gates (MF-3/MF-4/MF-5/MF-7).
// Boots the app in RUNNER-ENABLED real mode (RUNNER_TOKEN_HASH set, FileStore, auth
// off) and drives the outbound-only queue endpoints via supertest.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";

const TOKEN = "test-runner-token-1234567890";
const bearer = (t = TOKEN) => `Bearer ${t}`;

function makeJob(dir, folder) {
  const [role, employer] = folder.split(" - ");
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, `${role}.md`),
    ["---", "type: job", `role: ${role}`, `employer: ${employer}`, "status: drafted", "sector: private", "tags: [job]", "---", "", `# ${folder}`, ""].join("\n"),
    "utf8",
  );
}

let app, tmpRoot, JOB;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ep-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  JOB = "Analyst - OCI";
  makeJob(jobsDir, JOB);

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN); // real mode + runner enabled
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("owner enqueue (MF-3)", () => {
  it("rejects an unknown/non-whitelisted kind (400)", async () => {
    const r = await request(app).post("/api/agent-jobs").send({ kind: "rm-rf", jobId: JOB });
    expect(r.status).toBe(400);
  });

  it("rejects a job-scoped enqueue for a missing job (404)", async () => {
    const r = await request(app).post("/api/agent-jobs").send({ kind: "finalize-job", jobId: "Nope - Nowhere" });
    expect(r.status).toBe(404);
  });

  it("enqueues a whitelisted job with a data-only note (201)", async () => {
    const r = await request(app).post("/api/agent-jobs").send({ kind: "finalize-job", jobId: JOB, note: "please finalize" });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^aj-/);
  });
});

describe("runner-token gate (MF-5)", () => {
  it("401s /jobs/next with no token and with a wrong token", async () => {
    expect((await request(app).get("/api/runner/jobs/next")).status).toBe(401);
    expect((await request(app).get("/api/runner/jobs/next").set("authorization", bearer("wrong"))).status).toBe(401);
  });
});

describe("claim -> artifact -> result lifecycle", () => {
  let claim;

  it("claims a queued finalize-job for JOB with a valid token", async () => {
    // ensure a fresh finalize-job for JOB is queued, then drain until we hold it
    await request(app).post("/api/agent-jobs").send({ kind: "finalize-job", jobId: JOB });
    for (let i = 0; i < 10; i++) {
      const rr = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
      if (rr.status !== 200) break;
      if (rr.body.jobId === JOB && rr.body.kind === "finalize-job") {
        claim = rr.body;
        break;
      }
    }
    expect(claim).toBeTruthy();
    expect(claim.kind).toBe("finalize-job");
    expect(claim.jobId).toBe(JOB);
    expect(claim.nonce).toMatch(/^[0-9a-f]{48}$/);
  });

  it("heartbeats the claimed job", async () => {
    const r = await request(app).post(`/api/runner/jobs/${claim.id}/heartbeat`).set("authorization", bearer());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("REJECTS an artifact of a kind the routine may not post (MF-2): finalize-job + prep", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .set("x-artifact-name", "STAR prep.md")
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("prep content", "utf8"));
    expect(r.status).toBe(400);
  });

  it("REJECTS an artifact with a bad nonce (MF-7)", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", "deadbeef")
      .set("x-artifact-name", "CV - Analyst.pdf")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF fake", "utf8"));
    expect(r.status).toBe(403);
  });

  it("ACCEPTS a permitted CV artifact and writes it to the CLAIMED job (MF-4 target-from-row)", async () => {
    const r = await request(app)
      .post(`/api/runner/jobs/${claim.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .set("x-artifact-name", "CV - Analyst.pdf")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 tailored cv", "utf8"));
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("cv");
    // the artifact landed in the claimed job's folder
    const detail = await request(app).get(`/api/jobs/${encodeURIComponent(JOB)}`);
    expect(detail.body.hasCV).toBe(true);
  });

  it("rejects a result with the wrong nonce, then finalizes with the right one (idempotent replay)", async () => {
    const bad = await request(app).post(`/api/runner/jobs/${claim.id}/result`).set("authorization", bearer()).send({ nonce: "nope", status: "done" });
    expect(bad.status).toBe(403);

    const ok = await request(app).post(`/api/runner/jobs/${claim.id}/result`).set("authorization", bearer()).send({ nonce: claim.nonce, status: "done" });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const replay = await request(app).post(`/api/runner/jobs/${claim.id}/result`).set("authorization", bearer()).send({ nonce: claim.nonce, status: "done" });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
  });

  it("reports queue state for the honest pending UI", async () => {
    const r = await request(app).get("/api/runner/state");
    expect(r.status).toBe(200);
    expect(r.body.counts).toBeTruthy();
    expect(typeof r.body.counts.done).toBe("number");
  });
});

describe("runner disabled when not configured (501)", () => {
  let app2;
  beforeAll(async () => {
    delete process.env.RUNNER_TOKEN_HASH; // real mode, runner NOT configured
    vi.resetModules();
    ({ app: app2 } = await import("../server/index.js"));
  });
  afterAll(async () => {
    process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN);
    vi.resetModules();
  });
  it("501s the runner claim endpoint and the enqueue endpoint", async () => {
    expect((await request(app2).get("/api/runner/jobs/next").set("authorization", bearer())).status).toBe(501);
    expect((await request(app2).post("/api/agent-jobs").send({ kind: "finalize-job", jobId: JOB })).status).toBe(501);
  });
});
