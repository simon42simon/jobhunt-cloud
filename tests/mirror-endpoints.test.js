// SIM-393 I6 - cloud->vault mirror change-feed surface: mirrorAuth, the GC-9
// jobs-domain GET-only scope, the FULL cross-auth non-interchangeability matrix
// (MIRROR vs SYNC vs RUNNER vs the cookie gate, every direction), long-poll
// behavior (immediate delivery, event wake-up, timeout re-poll, triggers-only
// frames per GC-10), and the GC-2 mirror-pass report line.
//
// Boots the app in real mode with MIRROR + SYNC + RUNNER hashes so all three
// least-privilege lanes exist side by side, over FileStore, with a tiny
// MIRROR_LONGPOLL_HOLD_MS so the timeout leg is cheap. Mirrors
// tests/sync-endpoints.test.js.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashToken } from "../server/runner-lib.js";
import { rowShaOf } from "../server/sync-lib.js";

const MIRROR_TOKEN = "mirror-token-abcdefghij-1234567890";
const SYNC_TOKEN = "sync-token-abcdefghij-1234567890";
const RUNNER_TOKEN = "runner-token-zyxwvu-0987654321";
const sh = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bearer = (t) => `Bearer ${t}`;
const JOB = "Data Analyst - Acme Co";
const jobFront = () => ({ type: "job", role: "Data Analyst", employer: "Acme Co", status: "lead", tags: ["job"], deadline: "2026-08-01" });
const jobPayload = () => ({ id: JOB, role: "Data Analyst", employer: "Acme Co", front: jobFront(), body: "# Data Analyst - Acme Co\n\nnotes", tags: ["job"] });
const syncFilePath = (name) => `/api/sync/jobs/${encodeURIComponent(JOB)}/files/${encodeURIComponent(name)}`;
const mirrorFilePath = (name) => `/api/mirror/jobs/${encodeURIComponent(JOB)}/files/${encodeURIComponent(name)}`;

// ---------------------------------------------------------------------------
// Block A: real mode, mirror + sync + runner enabled, auth OFF.
// ---------------------------------------------------------------------------
describe("mirror surface (real mode, mirror + sync + runner enabled)", () => {
  let app, tmpRoot, dataDir;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-ep-"));
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
    process.env.MIRROR_TOKEN_HASH = hashToken(MIRROR_TOKEN);
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    process.env.RUNNER_TOKEN_HASH = hashToken(RUNNER_TOKEN);
    process.env.MIRROR_LONGPOLL_HOLD_MS = "300"; // cheap timeout leg
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  afterAll(() => {
    delete process.env.MIRROR_TOKEN_HASH;
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.RUNNER_TOKEN_HASH;
    delete process.env.MIRROR_LONGPOLL_HOLD_MS;
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
    it("401s every mirror route with NO token", async () => {
      expect((await request(app).get("/api/mirror/changes")).status).toBe(401);
      expect((await request(app).get(`/api/mirror/jobs/${encodeURIComponent(JOB)}`)).status).toBe(401);
      expect((await request(app).get(mirrorFilePath("x.md"))).status).toBe(401);
      expect((await request(app).post("/api/mirror/runs").send({})).status).toBe(401);
    });

    it("401s with a WRONG token, and the failure is RECORDED for SIM-386 (surface: mirror)", async () => {
      const r = await request(app).get("/api/mirror/changes").set("authorization", "Bearer nope-mirror-visible");
      expect(r.status).toBe(401);
      const lines = readActivity().split(/\r?\n/).filter((l) => l.trim());
      const fails = lines.map((l) => JSON.parse(l)).filter((x) => x.kind === "auth" && x.event === "login_failed" && x.surface === "mirror");
      expect(fails.length).toBeGreaterThan(0);
      const last = fails[fails.length - 1];
      expect(last.reason).toBe("bad_token");
      // whitelisted fields only - never the presented credential
      expect(JSON.stringify(last)).not.toContain("nope-mirror-visible");
    });
  });

  describe("cross-auth non-interchangeability (GC-9 extends the GC-2(c) matrix, ALL directions)", () => {
    it("the SYNC token does NOT open any mirror route", async () => {
      expect((await request(app).get("/api/mirror/changes").set("authorization", bearer(SYNC_TOKEN))).status).toBe(401);
      expect((await request(app).get(`/api/mirror/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(SYNC_TOKEN))).status).toBe(401);
      expect((await request(app).get(mirrorFilePath("x.md")).set("authorization", bearer(SYNC_TOKEN))).status).toBe(401);
      expect((await request(app).post("/api/mirror/runs").set("authorization", bearer(SYNC_TOKEN)).send({})).status).toBe(401);
    });

    it("the RUNNER token does NOT open any mirror route", async () => {
      expect((await request(app).get("/api/mirror/changes").set("authorization", bearer(RUNNER_TOKEN))).status).toBe(401);
      expect((await request(app).post("/api/mirror/runs").set("authorization", bearer(RUNNER_TOKEN)).send({})).status).toBe(401);
    });

    it("the MIRROR token does NOT open the sync WRITE routes (jobs-domain GET-only, GC-9)", async () => {
      expect((await request(app).post("/api/sync/jobs").set("authorization", bearer(MIRROR_TOKEN)).send(jobPayload())).status).toBe(401);
      expect((await request(app).put(syncFilePath("x.md")).set("authorization", bearer(MIRROR_TOKEN)).send(Buffer.from("x"))).status).toBe(401);
      expect((await request(app).post("/api/sync/runs").set("authorization", bearer(MIRROR_TOKEN)).send({})).status).toBe(401);
    });

    it("the MIRROR token does NOT open the runner surface", async () => {
      expect((await request(app).get("/api/runner/jobs/next").set("authorization", bearer(MIRROR_TOKEN))).status).toBe(401);
      expect((await request(app).post("/api/runner/jobs/x/result").set("authorization", bearer(MIRROR_TOKEN)).send({})).status).toBe(401);
    });

    it("the MIRROR token IS accepted on GET /api/sync/manifest (its diff source - the ONE shared route)", async () => {
      const r = await request(app).get("/api/sync/manifest").set("authorization", bearer(MIRROR_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty("jobs");
      expect(r.body).toHaveProperty("files");
    });

    it("the SYNC token still opens the manifest; the RUNNER token still does not", async () => {
      expect((await request(app).get("/api/sync/manifest").set("authorization", bearer(SYNC_TOKEN))).status).toBe(200);
      expect((await request(app).get("/api/sync/manifest").set("authorization", bearer(RUNNER_TOKEN))).status).toBe(401);
    });
  });

  describe("long-poll change feed (GC-10: triggers only)", () => {
    it("answers immediately when the counter is already past ?since, with a names-free frame", async () => {
      const r = await request(app).get("/api/mirror/changes?since=-1").set("authorization", bearer(MIRROR_TOKEN));
      expect(r.status).toBe(200);
      expect(typeof r.body.seq).toBe("number");
      expect(typeof r.body.ts).toBe("string");
      // The frame is a TRIGGER ONLY: exactly { seq, changed, ts } - never a job
      // name, file name, or path (GC-10).
      expect(Object.keys(r.body).sort()).toEqual(["changed", "seq", "ts"]);
    });

    it("a held poll is woken by a jobs-changed broadcast (sync insert) and reports a bumped seq", async () => {
      const base = (await request(app).get("/api/mirror/changes?since=-1").set("authorization", bearer(MIRROR_TOKEN))).body.seq;
      const held = request(app)
        .get(`/api/mirror/changes?since=${base}`)
        .set("authorization", bearer(MIRROR_TOKEN))
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 50)); // let the poll attach + hold
      // a sync-lane job insert broadcasts jobs-changed -> wakes the held poll
      const ins = await request(app).post("/api/sync/jobs").set("authorization", bearer(SYNC_TOKEN)).send(jobPayload());
      expect(ins.status).toBe(201);
      const r = await held;
      expect(r.status).toBe(200);
      expect(r.body.changed).toBe(true);
      expect(r.body.seq).toBeGreaterThan(base);
      expect(Object.keys(r.body).sort()).toEqual(["changed", "seq", "ts"]); // still names-free
    });

    it("an idle poll times out (~MIRROR_LONGPOLL_HOLD_MS) with changed:false and the SAME seq (re-poll semantics)", async () => {
      const base = (await request(app).get("/api/mirror/changes?since=-1").set("authorization", bearer(MIRROR_TOKEN))).body.seq;
      const t0 = Date.now();
      const r = await request(app).get(`/api/mirror/changes?since=${base}`).set("authorization", bearer(MIRROR_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body.changed).toBe(false);
      expect(r.body.seq).toBe(base);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // held, not answered instantly
    });
  });

  describe("jobs-domain reads (the two pull routes)", () => {
    it("GET /api/mirror/jobs/:id returns the RAW front + body + name, rowSha matching the manifest", async () => {
      const r = await request(app).get(`/api/mirror/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(MIRROR_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(JOB);
      expect(r.body.name).toBe("Data Analyst.md");
      expect(r.body.front).toEqual(jobFront());
      expect(r.body.body).toBe("# Data Analyst - Acme Co\n\nnotes");
      expect(r.body.rowSha).toBe(rowShaOf(jobFront(), "# Data Analyst - Acme Co\n\nnotes"));
      const m = await request(app).get("/api/sync/manifest").set("authorization", bearer(MIRROR_TOKEN));
      expect(m.body.jobs.find((j) => j.id === JOB).rowSha).toBe(r.body.rowSha);
    });

    it("GET /api/mirror/jobs/:id 404s an unknown id", async () => {
      expect((await request(app).get("/api/mirror/jobs/Nope%20-%20Nowhere").set("authorization", bearer(MIRROR_TOKEN))).status).toBe(404);
    });

    it("the mirror file reader streams bytes with the guarded-reader idiom (nosniff, CSP none, no-store)", async () => {
      const bytes = Buffer.from("%PDF-1.4 mirror pull bytes");
      const ins = await request(app).put(syncFilePath("CV - Data Analyst.pdf")).set("authorization", bearer(SYNC_TOKEN)).set("x-file-sha256", sh(bytes)).send(bytes);
      expect(ins.status).toBe(201);
      const r = await request(app).get(mirrorFilePath("CV - Data Analyst.pdf")).set("authorization", bearer(MIRROR_TOKEN)).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(Buffer.compare(r.body, bytes)).toBe(0);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("default-src 'none'");
      expect(r.headers["cache-control"]).toBe("private, no-store");
    });

    it("the mirror file reader 404s an unknown file and an unknown job", async () => {
      expect((await request(app).get(mirrorFilePath("nope.pdf")).set("authorization", bearer(MIRROR_TOKEN))).status).toBe(404);
      expect((await request(app).get("/api/mirror/jobs/Nope%20-%20Nowhere/files/x.md").set("authorization", bearer(MIRROR_TOKEN))).status).toBe(404);
    });
  });

  describe("mirror-pass report (GC-2 detection signal)", () => {
    it("POST /api/mirror/runs appends ONE structured, schema-bounded activity line", async () => {
      const r = await request(app).post("/api/mirror/runs").set("authorization", bearer(MIRROR_TOKEN)).send({
        trigger: "event",
        startedAt: "2026-07-18T00:00:00Z",
        finishedAt: "2026-07-18T00:00:04Z",
        created: 1,
        updated: 2,
        adopted: 3,
        skipped: 1,
        refused: 0,
        conflicts: ["divergent Data Analyst - Acme Co/notes.md vault=abc cloud=def"],
        clientVersion: "mirror-vault/1",
        evil: "ignored-field",
      });
      expect(r.status).toBe(201);
      const runs = readActivity().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === "mirror" && x.event === "mirror-pass");
      expect(runs.length).toBe(1);
      const line = runs[0];
      expect(line.trigger).toBe("event");
      expect(line.created).toBe(1);
      expect(line.updated).toBe(2);
      expect(line.adopted).toBe(3);
      expect(line.conflicts).toHaveLength(1);
      expect(line.evil).toBeUndefined(); // whitelisted fields only
    });
  });

  // Runs LAST: the lockout poisons this IP's mirror failure window for the rest
  // of the process (same posture as the sync suite).
  describe("rate limit (runs last - poisons the IP window)", () => {
    it("rate-limits repeated bad-token attempts to 429 (brute-force oracle guard)", async () => {
      let sawRateLimit = false;
      for (let i = 0; i < 25; i++) {
        const r = await request(app).get("/api/mirror/changes").set("authorization", "Bearer brute");
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
// Block B: auth ON - the mirror token must NOT satisfy the session cookie gate,
// and the cookie-less mirror routes still work (mounted before the gate).
// ---------------------------------------------------------------------------
describe("mirror surface with app-auth ON (token vs cookie gate)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-authon-"));
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
    process.env.MIRROR_TOKEN_HASH = hashToken(MIRROR_TOKEN);
    process.env.MIRROR_LONGPOLL_HOLD_MS = "300";
    process.env.JOBHUNT_AUTH = "required";
    // a valid argon2 hash so auth turns ON (verify never needs to succeed here)
    process.env.JOBHUNT_AUTH_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0MImKKQjLYm0k0f0f5x0N7q1s0M0aVvY0mF1yB0m0aE";
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  afterAll(() => {
    delete process.env.MIRROR_TOKEN_HASH;
    delete process.env.MIRROR_LONGPOLL_HOLD_MS;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    delete process.env.JOBHUNT_DATA_DIR;
  });

  it("mirror routes 401 anonymously even with auth ON (own token gate, before the cookie gate)", async () => {
    expect((await request(app).get("/api/mirror/changes")).status).toBe(401);
  });

  it("the MIRROR token OPENS the mirror feed (mounted before the cookie gate)", async () => {
    const r = await request(app).get("/api/mirror/changes?since=-1").set("authorization", bearer(MIRROR_TOKEN));
    expect(r.status).toBe(200);
  });

  it("the MIRROR token does NOT pass the cookie gate: session-gated + non-jobs reads all 401", async () => {
    // GC-9: not the config, not the board, not chats, not tasks, not activity,
    // not telemetry, not sources - a stolen mirror token reads the jobs domain
    // through its four enumerated routes and NOTHING else.
    for (const p of [
      "/api/config",
      "/api/jobs",
      `/api/jobs/${encodeURIComponent(JOB)}`,
      `/api/jobs/${encodeURIComponent(JOB)}/chat`,
      "/api/tasks",
      "/api/requests",
      "/api/activity",
      "/api/telemetry/summary",
      "/api/discovery/sources",
    ]) {
      expect((await request(app).get(p).set("authorization", bearer(MIRROR_TOKEN))).status, p).toBe(401);
    }
  });

  it("the MIRROR token cannot WRITE through the cookie gate either (PATCH/POST 401)", async () => {
    expect((await request(app).patch(`/api/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(MIRROR_TOKEN)).send({ status: "queued" })).status).toBe(401);
    expect((await request(app).post("/api/jobs").set("authorization", bearer(MIRROR_TOKEN)).send({ role: "X", employer: "Y" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Block C: mirror not configured -> 501 on every mirror route; the manifest
// refuses the mirror token when only the sync lane is configured.
// ---------------------------------------------------------------------------
describe("mirror surface disabled when not configured (501) / manifest scope", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-off-"));
    const jobsDir = path.join(tmp, "Jobs");
    const docsDir = path.join(tmp, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.MIRROR_TOKEN_HASH; // mirror NOT configured
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN); // sync IS configured
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  afterAll(() => {
    delete process.env.SYNC_TOKEN_HASH;
  });

  it("501s every mirror route even with a (would-be) token", async () => {
    expect((await request(app).get("/api/mirror/changes").set("authorization", bearer(MIRROR_TOKEN))).status).toBe(501);
    expect((await request(app).get(`/api/mirror/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(MIRROR_TOKEN))).status).toBe(501);
    expect((await request(app).get(mirrorFilePath("x.md")).set("authorization", bearer(MIRROR_TOKEN))).status).toBe(501);
    expect((await request(app).post("/api/mirror/runs").set("authorization", bearer(MIRROR_TOKEN)).send({})).status).toBe(501);
  });

  it("the manifest 401s the mirror token when the mirror lane is OFF (sync-only instance)", async () => {
    expect((await request(app).get("/api/sync/manifest").set("authorization", bearer(MIRROR_TOKEN))).status).toBe(401);
    expect((await request(app).get("/api/sync/manifest").set("authorization", bearer(SYNC_TOKEN))).status).toBe(200);
  });
});

// Note on DEMO mode: the mirror surface also 501s in demo via the SAME
// runtime.mirrorEnabled===false branch Block C exercises (mirrorEnabled requires
// REAL mode) plus the explicit `if (DEMO_MODE)` first line of mirrorAuth. The
// BINDING demo guarantee - GC-3 as extended by the 2026-07-18 delta review, that
// a demo REFUSES TO BOOT if MIRROR_TOKEN(_HASH) is present at all - is proven
// deterministically in tests/app-mode.test.js (same posture as the sync lane).
