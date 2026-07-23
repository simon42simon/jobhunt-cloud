// SIM-393 I5 - the export snapshot surface: exportAuth (401 anon / 501
// unconfigured / rate-limited failures / SIM-386 feed), GET-only enforced as
// MIDDLEWARE (405 on any other verb, with POST /api/export/runs as the ONE
// sanctioned bounded report route), the gap-fill domain reads, and the
// cross-auth matrix: EXPORT_TOKEN 401s every sync route (and the runner lane,
// and the cookie gate); SYNC/RUNNER tokens 401 every export route.
//
// Boots the app in real mode with all three still-live token hashes so every
// direction of the matrix is provable. Mirrors tests/sync-endpoints.test.js.
// (SIM-614, 2026-07-23: this suite used to also carry a fourth lane, the
// cloud->vault MIRROR token - retired outright; its cross-auth legs here were
// removed rather than left asserting against routes that no longer exist.)

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashToken } from "../server/runner-lib.js";

const EXPORT_TOKEN = "export-token-abcdefghij-1234567890";
const SYNC_TOKEN = "sync-token-abcdefghij-1234567890";
const RUNNER_TOKEN = "runner-token-zyxwvu-0987654321";
const sh = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bearer = (t) => `Bearer ${t}`;
const JOB = "Analyst - Acme Co";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250]);

const buffered = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

// ---------------------------------------------------------------------------
// Block A: real mode, auth OFF, all three lanes configured.
// ---------------------------------------------------------------------------
describe("export surface (real mode, all three token lanes configured)", () => {
  let app, tmpRoot, dataDir;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "export-ep-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    dataDir = path.join(tmpRoot, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    // tasks.yaml lives in the DATA zone when JOBHUNT_DATA_DIR is set
    for (const d of [docsDir, dataDir]) {
      fs.writeFileSync(path.join(d, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    }

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = dataDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    process.env.EXPORT_TOKEN_HASH = hashToken(EXPORT_TOKEN);
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    process.env.RUNNER_TOKEN_HASH = hashToken(RUNNER_TOKEN);
    vi.resetModules();
    ({ app } = await import("../server/index.js"));

    // Seed: one job + one companion file (drawer upload) + one task + one
    // attachment, so every export domain has real content to serve.
    const created = await request(app).post("/api/jobs").send({ role: "Analyst", employer: "Acme Co", sector: "private", status: "lead" });
    expect(created.status).toBe(201);
    const up = await request(app)
      .post(`/api/jobs/${encodeURIComponent(JOB)}/files`)
      .set("x-file-name", encodeURIComponent("CV - Analyst.pdf"))
      .set("content-type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 exported cv bytes"));
    expect(up.status).toBe(201);
    const task = await request(app).post("/api/tasks").send({ title: "Export me", status: "todo" });
    expect(task.status).toBe(201);
    const att = await request(app)
      .post(`/api/tasks/${task.body.id}/attachments`)
      .set("content-type", "image/png")
      .set("x-attachment-name", "shot.png")
      .send(PNG);
    expect(att.status).toBe(201);
    this_task = { id: task.body.id, file: att.body.file };
  });
  let this_task = null;

  afterAll(() => {
    delete process.env.EXPORT_TOKEN_HASH;
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.RUNNER_TOKEN_HASH;
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

  describe("the export reads (EXPORT_TOKEN opens exactly this surface)", () => {
    it("meta carries the app version + runtime posture", async () => {
      const r = await request(app).get("/api/export/meta").set("authorization", bearer(EXPORT_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body.app).toBe("jobhunt-cloud");
      expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(r.body.appMode).toBe("real");
      expect(r.body.storeBackend).toBe("file");
    });

    it("manifest serves the jobs+files hash view (metadata only, never bytes)", async () => {
      const r = await request(app).get("/api/export/manifest").set("authorization", bearer(EXPORT_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body.jobs.map((j) => j.id)).toContain(JOB);
      const f = r.body.files.find((x) => x.jobId === JOB && x.name === "CV - Analyst.pdf");
      expect(f.sha256).toBe(sh(Buffer.from("%PDF-1.4 exported cv bytes")));
    });

    it("raw job detail serves front/body/rowSha for byte-faithful reconstruction; 404 unknown", async () => {
      const r = await request(app).get(`/api/export/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(EXPORT_TOKEN));
      expect(r.status).toBe(200);
      expect(r.body.name).toBe("Analyst.md");
      expect(r.body.rowSha).toMatch(/^[0-9a-f]{64}$/);
      expect((await request(app).get("/api/export/jobs/Nope%20-%20Nowhere").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(404);
    });

    it("the guarded file reader streams bytes with the un-scriptable idiom", async () => {
      const r = await buffered(
        request(app)
          .get(`/api/export/jobs/${encodeURIComponent(JOB)}/files/${encodeURIComponent("CV - Analyst.pdf")}`)
          .set("authorization", bearer(EXPORT_TOKEN)),
      );
      expect(r.status).toBe(200);
      expect(Buffer.from(r.body).equals(Buffer.from("%PDF-1.4 exported cv bytes"))).toBe(true);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("default-src 'none'");
      expect(r.headers["cache-control"]).toBe("private, no-store");
    });

    it("gap-fill domain reads serve tasks/requests/chats/notify-state/sources/activity/telemetry", async () => {
      const tasks = await request(app).get("/api/export/tasks").set("authorization", bearer(EXPORT_TOKEN));
      expect(tasks.status).toBe(200);
      expect(tasks.body.tasks.some((t) => t.title === "Export me")).toBe(true);
      expect((await request(app).get("/api/export/requests").set("authorization", bearer(EXPORT_TOKEN))).body).toEqual({ requests: [] });
      expect((await request(app).get("/api/export/chats").set("authorization", bearer(EXPORT_TOKEN))).body).toEqual({});
      expect((await request(app).get("/api/export/notify-state").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(200);
      expect((await request(app).get("/api/export/sources").set("authorization", bearer(EXPORT_TOKEN))).body.sources).toEqual([]);
      const act = await request(app).get("/api/export/activity").set("authorization", bearer(EXPORT_TOKEN));
      expect(act.status).toBe(200);
      expect(act.headers["content-type"]).toContain("text/plain");
      expect((await request(app).get("/api/export/telemetry").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(200);
    });

    it("attachment blobs serve only files a task references (existence allowlist)", async () => {
      const ok = await buffered(
        request(app)
          .get(`/api/export/attachments/${encodeURIComponent(this_task.id)}/${encodeURIComponent(this_task.file)}`)
          .set("authorization", bearer(EXPORT_TOKEN)),
      );
      expect(ok.status).toBe(200);
      expect(Buffer.from(ok.body).equals(PNG)).toBe(true);
      const notRef = await request(app)
        .get(`/api/export/attachments/${encodeURIComponent(this_task.id)}/deadbeef.png`)
        .set("authorization", bearer(EXPORT_TOKEN));
      expect(notRef.status).toBe(404);
      const noTask = await request(app).get("/api/export/attachments/t-nope/whatever.png").set("authorization", bearer(EXPORT_TOKEN));
      expect(noTask.status).toBe(404);
    });
  });

  describe("GET-only enforced as MIDDLEWARE (GC-2a)", () => {
    it("405s every non-GET verb on the export surface - even with a valid token", async () => {
      expect((await request(app).post("/api/export/tasks").set("authorization", bearer(EXPORT_TOKEN)).send({})).status).toBe(405);
      expect((await request(app).put("/api/export/manifest").set("authorization", bearer(EXPORT_TOKEN)).send({})).status).toBe(405);
      expect((await request(app).delete("/api/export/jobs/x").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(405);
      expect((await request(app).patch("/api/export/meta").set("authorization", bearer(EXPORT_TOKEN)).send({})).status).toBe(405);
      // and anonymously: the 405 body is a static string, disclosure-safe
      expect((await request(app).post("/api/export/tasks").send({})).status).toBe(405);
    });

    it("POST /api/export/runs is the ONE sanctioned non-GET: bounded, field-whitelisted report line (GC-2b)", async () => {
      const r = await request(app)
        .post("/api/export/runs")
        .set("authorization", bearer(EXPORT_TOKEN))
        .send({
          startedAt: "2026-07-18T00:00:00Z",
          finishedAt: "2026-07-18T00:00:09Z",
          snapshot: "20260718-000000",
          jobs: 3,
          files: 7,
          bytes: 123456,
          refused: 0,
          verified: true,
          conflicts: ["file-sha-mismatch X/y.pdf"],
          clientVersion: "export-snapshot/1",
          evil: "must-not-persist",
        });
      expect(r.status).toBe(201);
      const lines = readActivity().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const run = lines.filter((x) => x.kind === "export" && x.event === "export-run").pop();
      expect(run).toBeTruthy();
      expect(run.snapshot).toBe("20260718-000000");
      expect(run.jobs).toBe(3);
      expect(run.verified).toBe(true);
      expect(run.evil).toBeUndefined(); // whitelist, not passthrough
    });

    it("valid-token run reports are rate-capped per IP: 429 beyond the window cap (L5, I7 hardening)", async () => {
      // The suite has already spent a few reports; hammer to the shared cap (60)
      // and assert the excess is refused with NO durable line appended.
      let final = null;
      for (let i = 0; i < 61; i++) {
        final = await request(app).post("/api/export/runs").set("authorization", bearer(EXPORT_TOKEN)).send({ jobs: 0 });
        if (final.status === 429) break;
      }
      expect(final.status).toBe(429);
      const before = readActivity().split(/\r?\n/).filter(Boolean).length;
      const refused = await request(app).post("/api/export/runs").set("authorization", bearer(EXPORT_TOKEN)).send({ jobs: 0 });
      expect(refused.status).toBe(429);
      const after = readActivity().split(/\r?\n/).filter(Boolean).length;
      expect(after).toBe(before); // a refused report writes nothing durable
    });
  });

  describe("auth gate + SIM-386 visibility", () => {
    it("401s every export route anonymously", async () => {
      for (const p of ["/api/export/meta", "/api/export/manifest", "/api/export/tasks", "/api/export/activity"]) {
        expect((await request(app).get(p)).status, p).toBe(401);
      }
      expect((await request(app).post("/api/export/runs").send({})).status).toBe(401);
    });

    it("a failed export-token auth is RECORDED for SIM-386 (surface export, never the credential)", async () => {
      await request(app).get("/api/export/manifest").set("authorization", "Bearer nope-visible-export");
      const fails = readActivity()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.kind === "auth" && r.event === "login_failed" && r.surface === "export");
      expect(fails.length).toBeGreaterThan(0);
      const last = fails[fails.length - 1];
      expect(last.reason).toBe("bad_token");
      expect(JSON.stringify(last)).not.toContain("nope-visible-export");
    });
  });

  describe("cross-auth matrix (GC-2c)", () => {
    it("EXPORT_TOKEN 401s on EVERY sync route (the manifest included - sync-only now that the mirror lane is retired)", async () => {
      const h = { authorization: bearer(EXPORT_TOKEN) };
      expect((await request(app).get("/api/sync/manifest").set(h)).status).toBe(401);
      expect((await request(app).post("/api/sync/jobs").set(h).send({ id: "X - Y", role: "X", employer: "Y", front: {} })).status).toBe(401);
      expect((await request(app).put(`/api/sync/jobs/${encodeURIComponent(JOB)}/files/x.md`).set(h).send(Buffer.from("x"))).status).toBe(401);
      expect((await request(app).post("/api/sync/runs").set(h).send({})).status).toBe(401);
    });

    it("EXPORT_TOKEN 401s on the runner lane", async () => {
      expect((await request(app).get("/api/runner/jobs/next").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(401);
    });

    it("SYNC_TOKEN and RUNNER_TOKEN 401 on the export surface", async () => {
      expect((await request(app).get("/api/export/manifest").set("authorization", bearer(SYNC_TOKEN))).status).toBe(401);
      expect((await request(app).get("/api/export/meta").set("authorization", bearer(RUNNER_TOKEN))).status).toBe(401);
    });
  });

  // Runs LAST: the brute-force lockout poisons this IP's export failure window.
  describe("rate limit (runs last - poisons the IP window)", () => {
    it("rate-limits repeated bad-token attempts to 429 (brute-force oracle guard)", async () => {
      let sawRateLimit = false;
      for (let i = 0; i < 25; i++) {
        const r = await request(app).get("/api/export/manifest").set("authorization", "Bearer brute");
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
// Block B: auth ON - the export token must NOT satisfy the session cookie gate.
// ---------------------------------------------------------------------------
describe("export surface with app-auth ON (token vs cookie gate)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-authon-"));
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
    process.env.EXPORT_TOKEN_HASH = hashToken(EXPORT_TOKEN);
    process.env.JOBHUNT_AUTH = "required";
    process.env.JOBHUNT_AUTH_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0MImKKQjLYm0k0f0f5x0N7q1s0M0aVvY0mF1yB0m0aE";
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  afterAll(() => {
    delete process.env.EXPORT_TOKEN_HASH;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    delete process.env.JOBHUNT_DATA_DIR;
  });

  it("export routes 401 anonymously even with auth ON (own token gate, before the cookie gate)", async () => {
    expect((await request(app).get("/api/export/manifest")).status).toBe(401);
  });

  it("the EXPORT token OPENS the export surface (mounted before the cookie gate)", async () => {
    expect((await request(app).get("/api/export/manifest").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(200);
  });

  it("the EXPORT token does NOT pass the cookie gate - reads or writes", async () => {
    expect((await request(app).get("/api/config").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(401);
    expect((await request(app).get("/api/tasks").set("authorization", bearer(EXPORT_TOKEN))).status).toBe(401);
    expect((await request(app).post("/api/tasks").set("authorization", bearer(EXPORT_TOKEN)).send({ title: "x" })).status).toBe(401);
    expect(
      (await request(app).patch(`/api/jobs/${encodeURIComponent(JOB)}`).set("authorization", bearer(EXPORT_TOKEN)).send({ status: "closed" })).status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Block C: not configured (no EXPORT_TOKEN_HASH) -> 501 on every export route.
// ---------------------------------------------------------------------------
describe("export surface disabled when not configured (501)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-off-"));
    const jobsDir = path.join(tmp, "Jobs");
    const docsDir = path.join(tmp, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.EXPORT_TOKEN_HASH; // real mode, export NOT configured
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  it("501s the export routes even with a token", async () => {
    const h = { authorization: bearer(EXPORT_TOKEN) };
    expect((await request(app).get("/api/export/meta").set(h)).status).toBe(501);
    expect((await request(app).get("/api/export/manifest").set(h)).status).toBe(501);
    expect((await request(app).get("/api/export/tasks").set(h)).status).toBe(501);
    expect((await request(app).post("/api/export/runs").set(h).send({})).status).toBe(501);
  });
});

// Note on DEMO mode: the export surface also 501s in demo, via the SAME
// runtime.exportEnabled===false branch Block C exercises (exportEnabled requires
// REAL mode) plus the explicit `if (DEMO_MODE)` first line of exportAuth. The
// BINDING demo guarantee - GC-3, that a demo REFUSES TO BOOT if EXPORT_TOKEN or
// EXPORT_TOKEN_HASH is present at all - is proven deterministically in
// tests/app-mode.test.js (same posture as the sync lane).
