// SIM-393 I1 - vault->cloud sync ingest surface: auth, insert-only semantics, the
// conflict matrix, cross-auth non-interchangeability, and the guardian conditions
// wired on I1 (GC-2(c) failed-token visibility feeds SIM-386; the demo 501 backstop).
//
// Boots the app in real mode with BOTH a SYNC_TOKEN_HASH and a RUNNER_TOKEN_HASH so
// the two least-privilege lanes can be proven non-interchangeable, over FileStore
// with a small file cap so the 413 path is cheap to drive. Mirrors
// tests/runner-endpoints.test.js.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashToken } from "../server/runner-lib.js";

const SYNC_TOKEN = "sync-token-abcdefghij-1234567890";
const RUNNER_TOKEN = "runner-token-zyxwvu-0987654321";
const sh = (b) => crypto.createHash("sha256").update(b).digest("hex");
const syncBearer = (t = SYNC_TOKEN) => `Bearer ${t}`;
const JOB = "Data Analyst - Acme Co";
const jobFront = () => ({ type: "job", role: "Data Analyst", employer: "Acme Co", status: "lead", tags: ["job"], deadline: "2026-08-01" });
const jobPayload = () => ({ id: JOB, role: "Data Analyst", employer: "Acme Co", front: jobFront(), body: "# Data Analyst - Acme Co\n\nnotes", tags: ["job"] });
const filePath = (name) => `/api/sync/jobs/${encodeURIComponent(JOB)}/files/${encodeURIComponent(name)}`;

// ---------------------------------------------------------------------------
// Block A: sync + runner enabled, auth OFF, small file cap.
// ---------------------------------------------------------------------------
describe("sync ingest surface (real mode, sync + runner enabled)", () => {
  let app, tmpRoot, dataDir;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-ep-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    dataDir = path.join(tmpRoot, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = dataDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    process.env.RUNNER_TOKEN_HASH = hashToken(RUNNER_TOKEN);
    process.env.SYNC_FILE_MAX_BYTES = "1024"; // tiny cap -> cheap 413
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  afterAll(() => {
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.RUNNER_TOKEN_HASH;
    delete process.env.SYNC_FILE_MAX_BYTES;
    delete process.env.JOBHUNT_DATA_DIR;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  const readActivity = () => {
    try {
      return fs.readFileSync(path.join(dataDir, "activity-log.jsonl"), "utf8");
    } catch {
      return "";
    }
  };

  describe("auth gate", () => {
    it("401s every sync route with NO token", async () => {
      expect((await request(app).get("/api/sync/manifest")).status).toBe(401);
      expect((await request(app).post("/api/sync/jobs").send(jobPayload())).status).toBe(401);
      expect((await request(app).put(filePath("x.md")).send(Buffer.from("x"))).status).toBe(401);
      expect((await request(app).post("/api/sync/runs").send({})).status).toBe(401);
    });

    it("401s with a WRONG token", async () => {
      expect((await request(app).get("/api/sync/manifest").set("authorization", "Bearer nope")).status).toBe(401);
    });

    it("GC-2(c): a failed sync-token auth is RECORDED for SIM-386 failed-auth visibility", async () => {
      await request(app).get("/api/sync/manifest").set("authorization", "Bearer nope-visible");
      const lines = readActivity().split(/\r?\n/).filter((l) => l.trim());
      const authFails = lines.map((l) => JSON.parse(l)).filter((r) => r.kind === "auth" && r.event === "login_failed" && r.surface === "sync");
      expect(authFails.length).toBeGreaterThan(0);
      // never carries credential material - whitelisted fields only
      const last = authFails[authFails.length - 1];
      expect(last.reason).toBe("bad_token");
      expect(JSON.stringify(last)).not.toContain("nope-visible");
    });
  });

  describe("cross-auth non-interchangeability (GC-2(c))", () => {
    it("the RUNNER token does NOT open the sync surface", async () => {
      expect((await request(app).get("/api/sync/manifest").set("authorization", `Bearer ${RUNNER_TOKEN}`)).status).toBe(401);
    });
    it("the SYNC token does NOT open the runner surface", async () => {
      expect((await request(app).get("/api/runner/jobs/next").set("authorization", syncBearer())).status).toBe(401);
    });
  });

  describe("insert-only job + file matrix", () => {
    it("inserts a new job (201) and reflects it in the manifest", async () => {
      const r = await request(app).post("/api/sync/jobs").set("authorization", syncBearer()).send(jobPayload());
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ created: true, id: JOB });
      const m = await request(app).get("/api/sync/manifest").set("authorization", syncBearer());
      expect(m.body.jobs.map((j) => j.id)).toContain(JOB);
      const job = m.body.jobs.find((j) => j.id === JOB);
      expect(job.rowSha).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a duplicate job is a 409 conflict, NEVER an overwrite", async () => {
      const before = await request(app).get("/api/sync/manifest").set("authorization", syncBearer());
      const beforeSha = before.body.jobs.find((j) => j.id === JOB).rowSha;
      // resend with a DIFFERENT body: must be refused and the stored row untouched
      const r = await request(app).post("/api/sync/jobs").set("authorization", syncBearer()).send({ ...jobPayload(), body: "TAMPERED" });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ conflict: "job-exists" });
      const after = await request(app).get("/api/sync/manifest").set("authorization", syncBearer());
      expect(after.body.jobs.find((j) => j.id === JOB).rowSha).toBe(beforeSha); // unchanged
    });

    it("rejects an invalid job payload (400): non-string role", async () => {
      const r = await request(app).post("/api/sync/jobs").set("authorization", syncBearer()).send({ id: "Bad - Job", role: 123, employer: "X", front: {} });
      expect(r.status).toBe(400);
    });

    it("inserts a companion file (201), and re-sending identical bytes is a 200 no-op", async () => {
      const bytes = Buffer.from("%PDF-1.4 tailored cv");
      const ins = await request(app).put(filePath("CV - Data Analyst.pdf")).set("authorization", syncBearer()).set("x-file-sha256", sh(bytes)).set("Content-Type", "application/pdf").send(bytes);
      expect(ins.status).toBe(201);
      expect(ins.body.inserted).toBe(true);
      expect(ins.body.sha256).toBe(sh(bytes));
      const noop = await request(app).put(filePath("CV - Data Analyst.pdf")).set("authorization", syncBearer()).send(bytes);
      expect(noop.status).toBe(200);
      expect(noop.body).toEqual({ noop: true, name: "CV - Data Analyst.pdf", sha256: sh(bytes) });
    });

    it("same path + DIFFERENT bytes = 409 bytes-differ; cloud copy is NOT overwritten (loud conflict filed)", async () => {
      const original = Buffer.from("%PDF-1.4 tailored cv");
      const tampered = Buffer.from("%PDF-1.4 POISONED cv");
      const r = await request(app).put(filePath("CV - Data Analyst.pdf")).set("authorization", syncBearer()).send(tampered);
      expect(r.status).toBe(409);
      expect(r.body.conflict).toBe("bytes-differ");
      expect(r.body.cloudSha).toBe(sh(original)); // the ORIGINAL still wins
      // the manifest still reports the original bytes - nothing was overwritten
      const m = await request(app).get("/api/sync/manifest").set("authorization", syncBearer());
      const f = m.body.files.find((x) => x.name === "CV - Data Analyst.pdf");
      expect(f.sha256).toBe(sh(original));
      // and a loud conflict record was filed to the activity feed
      const conflicts = readActivity().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "sync" && r.event === "conflict");
      expect(conflicts.some((c) => c.name === "CV - Data Analyst.pdf" && c.reason === "bytes-differ")).toBe(true);
    });

    it("refuses a mismatched x-file-sha256 (400) - transport integrity", async () => {
      const bytes = Buffer.from("integrity check bytes");
      const r = await request(app).put(filePath("notes.md")).set("authorization", syncBearer()).set("x-file-sha256", "deadbeef").send(bytes);
      expect(r.status).toBe(400);
    });

    it("rejects a hostile file name (400) via the shared name-safety module", async () => {
      const r = await request(app).put(filePath("../../etc/passwd")).set("authorization", syncBearer()).send(Buffer.from("x"));
      expect(r.status).toBe(400);
    });

    it("404s a file PUT for an unknown job", async () => {
      const r = await request(app).put("/api/sync/jobs/Nope%20-%20Nowhere/files/x.md").set("authorization", syncBearer()).send(Buffer.from("x"));
      expect(r.status).toBe(404);
    });

    it("413s a file over the SYNC_FILE_MAX_BYTES cap", async () => {
      const big = Buffer.alloc(2048, 0x41); // > 1024 cap
      const r = await request(app).put(filePath("big.bin")).set("authorization", syncBearer()).send(big);
      expect(r.status).toBe(413);
    });

    it("records a run summary line (201) so every run + conflict is visible in-app", async () => {
      const r = await request(app).post("/api/sync/runs").set("authorization", syncBearer()).send({ startedAt: "2026-07-17T00:00:00Z", finishedAt: "2026-07-17T00:00:05Z", inserted: { jobs: 1, files: 1 }, noops: 1, conflicts: [{ jobId: JOB, name: "CV - Data Analyst.pdf" }], clientVersion: "sync/1" });
      expect(r.status).toBe(201);
      const runs = readActivity().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "sync" && r.event === "sync-run");
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[runs.length - 1].inserted).toEqual({ jobs: 1, files: 1 });
    });

    it("PROVES the surface has no route that alters or removes an existing row/byte", async () => {
      // Snapshot the manifest, then hammer the surface with a full re-sync of the
      // SAME identifiers carrying DIFFERENT bytes/body. Insert-only means every one
      // is a 409/no-op and the manifest is byte-for-byte identical afterwards.
      const before = (await request(app).get("/api/sync/manifest").set("authorization", syncBearer())).body;
      await request(app).post("/api/sync/jobs").set("authorization", syncBearer()).send({ ...jobPayload(), body: "OVERWRITE ATTEMPT" });
      await request(app).put(filePath("CV - Data Analyst.pdf")).set("authorization", syncBearer()).send(Buffer.from("OVERWRITE ATTEMPT"));
      const after = (await request(app).get("/api/sync/manifest").set("authorization", syncBearer())).body;
      expect(after).toEqual(before); // nothing changed
    });
  });

  // Runs LAST: a successful brute-force lockout poisons this IP's failure window for
  // the rest of the process (a per-IP 15-min lockout, by design), so it must not
  // precede any test that needs the sync surface to respond.
  describe("rate limit (runs last - poisons the IP window)", () => {
    it("rate-limits repeated bad-token attempts to 429 (brute-force oracle guard)", async () => {
      let sawRateLimit = false;
      for (let i = 0; i < 25; i++) {
        const r = await request(app).get("/api/sync/manifest").set("authorization", "Bearer brute");
        if (r.status === 429) {
          sawRateLimit = true;
          break;
        }
        expect(r.status).toBe(401);
      }
      expect(sawRateLimit).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Block B: auth ON - the sync token must NOT satisfy the session cookie gate.
// ---------------------------------------------------------------------------
describe("sync surface with app-auth ON (token vs cookie gate)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-authon-"));
    const jobsDir = path.join(tmp, "Jobs");
    const docsDir = path.join(tmp, "docs");
    for (const d of [jobsDir, docsDir, path.join(tmp, "data")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = path.join(tmp, "data");
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    process.env.JOBHUNT_AUTH = "required";
    // a valid argon2 hash so auth turns ON (verify never needs to succeed here)
    process.env.JOBHUNT_AUTH_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0MImKKQjLYm0k0f0f5x0N7q1s0M0aVvY0mF1yB0m0aE";
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  afterAll(() => {
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    delete process.env.JOBHUNT_DATA_DIR;
  });

  it("sync routes 401 anonymously even with auth ON (own token gate, before the cookie gate)", async () => {
    expect((await request(app).get("/api/sync/manifest")).status).toBe(401);
  });

  it("the SYNC token OPENS the sync surface (mounted before the cookie gate)", async () => {
    expect((await request(app).get("/api/sync/manifest").set("authorization", syncBearer())).status).toBe(200);
  });

  it("the SYNC token does NOT satisfy the session cookie gate on a session-gated route", async () => {
    // /api/config is behind the cookie gate; a sync bearer token is not a session.
    expect((await request(app).get("/api/config").set("authorization", syncBearer())).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Block C: not configured (no SYNC_TOKEN_HASH) -> 501 on every sync route.
// ---------------------------------------------------------------------------
describe("sync surface disabled when not configured (501)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-off-"));
    const jobsDir = path.join(tmp, "Jobs");
    const docsDir = path.join(tmp, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.SYNC_TOKEN_HASH; // real mode, sync NOT configured
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  it("501s the manifest, jobs, files, and runs routes even with a token", async () => {
    expect((await request(app).get("/api/sync/manifest").set("authorization", syncBearer())).status).toBe(501);
    expect((await request(app).post("/api/sync/jobs").set("authorization", syncBearer()).send(jobPayload())).status).toBe(501);
    expect((await request(app).put(filePath("x.md")).set("authorization", syncBearer()).send(Buffer.from("x"))).status).toBe(501);
    expect((await request(app).post("/api/sync/runs").set("authorization", syncBearer()).send({})).status).toBe(501);
  });
});

// Note on DEMO mode: the sync surface also 501s in demo, via the SAME
// runtime.syncEnabled===false branch this block exercises (syncEnabled requires
// REAL mode, so it is always false in demo) plus the explicit `if (DEMO_MODE)`
// first line of syncAuth. The BINDING demo guarantee - GC-3, that a demo REFUSES
// TO BOOT if SYNC_TOKEN_HASH is present at all - is proven deterministically in
// tests/app-mode.test.js. A pg-backed demo-boot HTTP test is deliberately omitted
// here: it needs an ephemeral Postgres (unavailable on an elevated shell) and its
// slow provisioning would make the gate flaky for zero additional branch coverage.
