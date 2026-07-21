// SIM-388 - per-IP write rate limit on the public demo.
//
// Two layers, matching how the limiter ships:
//  1. UNIT: createDemoWriteLimiter mounted on a scratch express app - proves the
//     threshold, the pinned 429 body, the standardHeaders, that every WRITE verb
//     (POST/PUT/PATCH/DELETE) counts, and that reads are NEVER limited or
//     counted (skip, not just pass-through).
//  2. REAL-MODE REGRESSION: the actual server app booted in the default (real,
//     file-backed, auth-off) posture takes a 100-POST flood with ZERO 429s -
//     the limiter is demo-scoped and current dev behavior is unchanged.
// The demo-mode WIRING (index.js mounts the limiter when DEMO_MODE) is proven
// end-to-end in tests/demo-mode.test.js against a real demo boot on embedded PG.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDemoWriteLimiter, DEMO_WRITE_LIMIT_BODY } from "../server/auth.js";

// ---- unit: the limiter itself ----------------------------------------------

function scratchApp(env) {
  const app = express();
  app.use(express.json());
  app.use("/api", createDemoWriteLimiter(env));
  const ok = (req, res) => res.status(201).json({ ok: true });
  app.post("/api/tasks", ok);
  app.put("/api/things/:id", ok);
  app.patch("/api/things/:id", ok);
  app.delete("/api/things/:id", ok);
  app.get("/api/jobs", (req, res) => res.json({ jobs: [] }));
  return app;
}

describe("createDemoWriteLimiter (unit)", () => {
  it("429s writes past the threshold with the pinned body + standard headers", async () => {
    const app = scratchApp({ JOBHUNT_DEMO_WRITE_RATELIMIT_MAX: "3" });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/tasks").send({ title: `t${i}` });
      expect(res.status).toBe(201); // under the limit: unaffected
    }
    const limited = await request(app).post("/api/tasks").send({ title: "over" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(DEMO_WRITE_LIMIT_BODY); // pinned body
    // standardHeaders: true emits the draft RateLimit-* headers, never X-RateLimit-*.
    expect(limited.headers).toHaveProperty("ratelimit-limit");
    expect(limited.headers).not.toHaveProperty("x-ratelimit-limit");
  });

  it("counts every write verb against the same per-IP budget", async () => {
    const app = scratchApp({ JOBHUNT_DEMO_WRITE_RATELIMIT_MAX: "4" });
    expect((await request(app).post("/api/tasks").send({})).status).toBe(201);
    expect((await request(app).put("/api/things/1").send({})).status).toBe(201);
    expect((await request(app).patch("/api/things/1").send({})).status).toBe(201);
    expect((await request(app).delete("/api/things/1")).status).toBe(201);
    // 5th write of ANY verb tips it over.
    expect((await request(app).put("/api/things/2").send({})).status).toBe(429);
  });

  it("never limits reads - even after the write budget is exhausted", async () => {
    const app = scratchApp({ JOBHUNT_DEMO_WRITE_RATELIMIT_MAX: "1" });
    expect((await request(app).post("/api/tasks").send({})).status).toBe(201);
    expect((await request(app).post("/api/tasks").send({})).status).toBe(429);
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get("/api/jobs");
      expect(res.status).toBe(200);
    }
  });

  it("reads are skipped, not counted: a GET flood never eats the write budget", async () => {
    const app = scratchApp({ JOBHUNT_DEMO_WRITE_RATELIMIT_MAX: "2" });
    for (let i = 0; i < 50; i++) {
      expect((await request(app).get("/api/jobs")).status).toBe(200);
    }
    // The full write budget is still available after the read flood.
    expect((await request(app).post("/api/tasks").send({})).status).toBe(201);
    expect((await request(app).post("/api/tasks").send({})).status).toBe(201);
    expect((await request(app).post("/api/tasks").send({})).status).toBe(429);
  });

  it("defaults to 60 writes per minute when no env override is set", async () => {
    const app = scratchApp({});
    for (let i = 0; i < 60; i++) {
      expect((await request(app).post("/api/tasks").send({})).status).toBe(201);
    }
    expect((await request(app).post("/api/tasks").send({})).status).toBe(429);
  });
});

// ---- real-mode regression: no limiter outside demo --------------------------

describe("real mode (default boot): writes are NOT rate-limited", () => {
  let app;
  let fixture;

  // Explicit timeout (default is 10s): a fresh `import("../server/index.js")"
  // is a real dynamic module load - fine standalone, but under the FULL suite
  // (many other files' own server boots/embedded-PG fixtures competing for
  // CPU) it occasionally missed the default window (GATE 2 fix-lane finding,
  // 2026-07-21 - a timing flake, not a behavior regression: this hook does no
  // network I/O, only fs setup + one module import).
  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jh-writelimit-"));
    fs.mkdirSync(path.join(fixture, "Jobs"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
    // loadTasks reads tasks.yaml NON-tolerantly (data-zone file); seed a minimal one.
    fs.writeFileSync(
      path.join(fixture, "docs", "tasks.yaml"),
      "columns: [backlog, todo, in_progress, done]\ntasks: []\n",
      "utf8",
    );
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = path.join(fixture, "Jobs");
    process.env.JOBHUNT_DOCS_DIR = path.join(fixture, "docs");
    ({ app } = await import("../server/index.js"));
  }, 30000);

  afterAll(() => {
    try {
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch {}
  });

  it("a 100-POST flood on /api/tasks stays 429-free (current dev behavior unchanged)", async () => {
    for (let i = 0; i < 100; i++) {
      const res = await request(app).post("/api/tasks").send({ title: `flood ${i}` });
      expect(res.status, `i=${i} body=${JSON.stringify(res.body)}`).not.toBe(429);
      expect(res.status, `i=${i} body=${JSON.stringify(res.body)}`).toBeLessThan(300);
    }
  });
});
