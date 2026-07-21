// SIM-388 + SIM-390 - the demo posture, end to end: boot the REAL server in
// APP_MODE=demo on an ephemeral embedded Postgres (the exact backend the public
// demo runs) and prove, over the wire:
//   - SIM-388: the per-IP write limiter is armed (429 past the threshold with
//     the pinned body), and reads stay unlimited even after writes are capped.
//   - SIM-390 item 3: GET /api/config declares sse:false on the pg backend.
//   - SIM-390 item 4: GET /api/jobs/:id/chat is 200 + empty for a chat-less
//     job on PgStore (it used to 404 for EVERY job there), 404 only for a
//     genuinely nonexistent job.
//   - SIM-390 item 2: a demo replay's run output names the ACTUAL job, not the
//     canned "Demo/Operations Analyst.md" placeholder.
//   - SIM-390 item 5: the boot seed lands the discovery texture (sources with
//     run history, seeded finds served by GET /api/discovery).
//
// Provisioning failures skip cleanly (same posture as every PG suite) unless
// REQUIRE_EMBEDDED_PG=1 (CI / de-elevated runners), where they hard-fail.

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCluster } from "./helpers/embedded-pg.mjs";
import { DEMO_WRITE_LIMIT_BODY } from "../server/auth.js";
import { UPLOAD_DEMO_MAX_BYTES, UPLOAD_DEMO_MAX_COUNT } from "../server/lib.js";

const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  console.warn(`[demo-mode.test] embedded Postgres unavailable - skipping (${cluster.reason})`);
}

let app;
let store;
let tmpDocs;
const WRITE_MAX = 30; // low ceiling so the 429 is cheap to reach (roomy enough for the GC-4 upload tests)

if (cluster.available) {
  tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), "jh-demo-mode-"));
  for (const d of ["docs", "Jobs", "blob"]) fs.mkdirSync(path.join(tmpDocs, d), { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_DOCS_DIR = path.join(tmpDocs, "docs");
  process.env.JOBHUNT_JOBS_DIR = path.join(tmpDocs, "Jobs");
  process.env.JOBHUNT_BLOB_DIR = path.join(tmpDocs, "blob");
  process.env.APP_MODE = "demo";
  process.env.STORE_BACKEND = "pg";
  process.env.DATABASE_URL = cluster.url;
  process.env.DEMO_DB_ASSERT = "127.0.0.1"; // positively marks the throwaway test DB
  process.env.JOBHUNT_DEMO_WRITE_RATELIMIT_MAX = String(WRITE_MAX);
  // A long window so the memory store cannot roll over mid-suite and un-429 the
  // final assertion (the production default stays 60s).
  process.env.JOBHUNT_DEMO_WRITE_RATELIMIT_WINDOW_MS = "600000";
  process.env.JOBHUNT_DEMO_REPLAY_STEP_MS = "1"; // replay finishes in milliseconds
  ({ app, store } = await import("../server/index.js"));
}

afterAll(async () => {
  delete process.env.APP_MODE;
  delete process.env.STORE_BACKEND;
  delete process.env.DATABASE_URL;
  delete process.env.DEMO_DB_ASSERT;
  delete process.env.JOBHUNT_DEMO_WRITE_RATELIMIT_MAX;
  delete process.env.JOBHUNT_DEMO_WRITE_RATELIMIT_WINDOW_MS;
  delete process.env.JOBHUNT_DEMO_REPLAY_STEP_MS;
  if (cluster.available) {
    // Close the app store's worker connection BEFORE the cluster dies, or the
    // dropped socket surfaces as an unhandled teardown error.
    try {
      if (store && typeof store.close === "function") store.close();
    } catch {}
    await cluster.stop();
    try {
      fs.rmSync(tmpDocs, { recursive: true, force: true });
    } catch {}
  }
});

// Writes are budgeted per IP for the whole suite (window 60s > suite runtime),
// so every test below accounts for how many writes it spends. Order matters:
// vitest runs a file's tests serially, in declaration order.
let writesSpent = 0;

suite("demo mode, end to end (embedded PG)", () => {
  it("boots seeded: jobs present, config declares demo + sse:false", async () => {
    const cfg = await request(app).get("/api/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.appMode).toBe("demo");
    expect(cfg.body.sse).toBe(false); // SIM-390 item 3: pg backend -> no SSE
    // SIM-426: the SSC Hub only ever resolves on the hub's own machine (local
    // dev) - every pg-backed instance (this one included) declares null so the
    // client hides the hub deep links instead of rendering a dead localhost one.
    expect(cfg.body.sscHubUrl).toBeNull();

    const jobs = await request(app).get("/api/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.body.length).toBeGreaterThan(5);
  });

  it("SIM-390 item 5: discovery is not sparse - sources carry run history, finds are served", async () => {
    const sources = await request(app).get("/api/discovery/sources");
    expect(sources.status).toBe(200);
    const list = sources.body.sources;
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const s of list) {
      expect(s.status).not.toBe("never-run"); // the QA finding, inverted
      expect(s.lastRunAt).toBeTruthy();
      expect((s.runs || []).length).toBeGreaterThan(0);
    }
    const disc = await request(app).get("/api/discovery");
    expect(disc.status).toBe(200);
    expect(disc.body.discoveries.length).toBeGreaterThanOrEqual(5); // "0 finds", inverted
    for (const f of disc.body.discoveries) {
      expect(f.Link).toContain("demo.example.test"); // unambiguously fictional
    }
  });

  it("SIM-390 item 4: chat is 200 + empty for a chat-less job on PgStore, 404 only when the job is missing", async () => {
    const jobs = (await request(app).get("/api/jobs")).body;
    // The seed writes exactly ONE per-job chat, so of any two seeded jobs at
    // least one is chat-less - both must be 200 (each used to 404 on PgStore,
    // whose jobFolderPath is null for every job), and at least one is empty.
    const bodies = [];
    for (const j of jobs.slice(0, 2)) {
      const res = await request(app).get(`/api/jobs/${encodeURIComponent(j.id)}/chat`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.messages)).toBe(true);
      bodies.push(res.body.messages);
    }
    expect(bodies.some((m) => m.length === 0)).toBe(true);

    const missing = await request(app).get(`/api/jobs/${encodeURIComponent("No Such Role - Nowhere Co")}/chat`);
    expect(missing.status).toBe(404);
  });

  it("SIM-425: posting a chat message on demo/hosted never spawns the CLI - honest disabled response, no 500, transcript unchanged", async () => {
    const jobs = (await request(app).get("/api/jobs")).body;
    const target = jobs[0];
    const before = (await request(app).get(`/api/jobs/${encodeURIComponent(target.id)}/chat`)).body.messages;

    const res = await request(app)
      .post(`/api/jobs/${encodeURIComponent(target.id)}/chat`)
      .send({ message: "What makes me a fit for this role?" });
    writesSpent++;
    expect(res.status).toBe(200); // never a 500, even though no `claude` CLI exists here
    expect(res.body.disabled).toBe(true);
    expect(res.body.reason).toBe("The live assistant is turned off in the hosted demo.");
    // No invented user or assistant turn was appended - the transcript the
    // client falls back to is exactly what it already held.
    expect(res.body.messages).toEqual(before);

    const after = (await request(app).get(`/api/jobs/${encodeURIComponent(target.id)}/chat`)).body.messages;
    expect(after).toEqual(before);
  });

  it("SIM-390 item 2: the canned replay names the actual replayed job", async () => {
    const jobs = (await request(app).get("/api/jobs")).body;
    const hero = jobs.find((j) => j.status === "queued") || jobs[0];
    const launch = await request(app)
      .post("/api/routines/run")
      .send({ routine: "first-draft-job", jobId: hero.id });
    writesSpent++;
    expect(launch.status).toBe(201);

    // Poll the run to terminal (reads are never rate-limited).
    let run = null;
    for (let i = 0; i < 200; i++) {
      const res = await request(app).get(`/api/routines/run/${launch.body.runId}`);
      expect(res.status).toBe(200);
      run = res.body;
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(run.status).toBe("done");
    expect(run.stats && run.stats.costUsd).toBe(0); // still a zero-spend replay
    // The transcript names THIS job's folder + role file, not the placeholder.
    expect(run.output).toContain(`${hero.id}/${hero.role}.md`);
    expect(run.output).not.toContain("Demo/Operations Analyst.md");

    // SIM-422: the transcript claims "a fictional CV and cover letter are ready
    // for review" - the drawer must actually carry them, not stay empty while
    // the run panel says DONE. And the readiness flip (hasCV/hasCoverLetter)
    // is what nextStatusAfterRun needs to auto-advance queued/lead -> drafted.
    const after = (await request(app).get(`/api/jobs/${encodeURIComponent(hero.id)}`)).body;
    expect(after.hasCV).toBe(true);
    expect(after.hasCoverLetter).toBe(true);
    expect((after.files || []).some((f) => /cv/i.test(f.name))).toBe(true);
    expect((after.files || []).some((f) => /cover/i.test(f.name))).toBe(true);
    if (hero.status === "queued" || hero.status === "lead") {
      expect(after.status).toBe("drafted");
    }
  });

  it("GC-4 (SIM-393 I4): the demo upload is capped at <= 1 MB - over-cap is a 413", async () => {
    const jobs = (await request(app).get("/api/jobs")).body;
    const target = jobs[jobs.length - 1];
    const big = Buffer.alloc(UPLOAD_DEMO_MAX_BYTES + 1, 0x41); // one byte over the demo ceiling
    const r = await request(app)
      .post(`/api/jobs/${encodeURIComponent(target.id)}/files`)
      .set("x-file-name", encodeURIComponent("too-big.bin"))
      .set("content-type", "application/octet-stream")
      .send(big);
    writesSpent++;
    expect(r.status).toBe(413); // the 15 MB real-instance default does NOT apply here
  });

  it("GC-4 (SIM-393 I4): a small demo upload works (writable showcase), then the per-job count cap 409s", async () => {
    const jobs = (await request(app).get("/api/jobs")).body;
    const target = jobs[jobs.length - 1];
    const detail = (await request(app).get(`/api/jobs/${encodeURIComponent(target.id)}`)).body;
    const existing = (detail.files || []).length;
    const room = Math.max(0, UPLOAD_DEMO_MAX_COUNT - existing);
    // fill the remaining per-job budget - each small upload lands (the demo is
    // a writable showcase; GC-4 chose the working-small-upload posture over 501)
    for (let i = 0; i < room; i++) {
      const ok = await request(app)
        .post(`/api/jobs/${encodeURIComponent(target.id)}/files`)
        .set("x-file-name", encodeURIComponent(`demo-upload-${i}.md`))
        .set("content-type", "text/markdown")
        .send(Buffer.from(`fictional demo upload ${i}`));
      writesSpent++;
      expect(ok.status).toBe(201);
      expect(ok.body.name).toBe(`demo-upload-${i}.md`);
    }
    // the file over the count cap is refused with the pinned 409
    const over = await request(app)
      .post(`/api/jobs/${encodeURIComponent(target.id)}/files`)
      .set("x-file-name", encodeURIComponent("one-too-many.md"))
      .set("content-type", "text/markdown")
      .send(Buffer.from("over the per-job cap"));
    writesSpent++;
    expect(over.status).toBe(409);
    expect(over.body.error).toContain(`maximum of ${UPLOAD_DEMO_MAX_COUNT} files`);
  });

  it("SIM-388: writes 429 past the per-IP threshold with the pinned body; reads stay open", async () => {
    // Spend the remaining write budget.
    for (let i = writesSpent; i < WRITE_MAX; i++) {
      const res = await request(app).post("/api/tasks").send({ title: `demo write ${i}` });
      expect(res.status).toBe(201);
    }
    const limited = await request(app).post("/api/tasks").send({ title: "over the line" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(DEMO_WRITE_LIMIT_BODY);
    expect(limited.headers).toHaveProperty("ratelimit-limit");

    // Reads are untouched even with the write budget exhausted.
    for (let i = 0; i < 20; i++) {
      expect((await request(app).get("/api/jobs")).status).toBe(200);
    }
    expect((await request(app).get("/api/config")).status).toBe(200);
  });
});
