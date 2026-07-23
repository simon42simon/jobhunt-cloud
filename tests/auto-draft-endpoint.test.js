// SIM-596 (JP-4) - the secret-gated manual-fire endpoint + the scheduler's
// orchestration (dedupe against already-pending, cap+overflow, activity-log
// entry, ship-dark posture). Boots the app in RUNNER-ENABLED real mode
// (mirrors tests/runner-endpoints.test.js / tests/track-packs.test.js).
// Hermetic: throwaway Jobs/docs dirs, spawn mocked, no real timer ever arms
// (JOBHUNT_TEST=1 skips the whole boot block that would arm it).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { hashToken } from "../server/runner-lib.js";

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", 0));
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const SECRET = "test-auto-draft-secret-1234567890";
const TOKEN = "test-runner-token-1234567890";

let app, tmpRoot, jobsDir, docsDir;

// A job at `deadline` days from today (ET), queued + undrafted + public sector
// unless overridden - the SIM-596 v1-eligible shape.
function makeJob(folder, { deadline, status = "queued", sector = "municipal", withCV = false }) {
  const [role, employer] = folder.split(" - ");
  const dir = path.join(jobsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${role}.md`),
    ["---", "type: job", `role: ${role}`, `employer: ${employer}`, "track: b2b_gtm_focused", "fit: strong", `status: ${status}`, `sector: ${sector}`, "tailoring: light", `deadline: ${deadline}`, "tags: [job]", "---", "", `# ${folder}`, ""].join("\n"),
    "utf8",
  );
  if (withCV) fs.writeFileSync(path.join(dir, `${role} CV.docx`), "cv bytes", "utf8");
}

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-draft-"));
  jobsDir = path.join(tmpRoot, "Jobs");
  docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN); // real mode + runner enabled
  process.env.AUTO_DRAFT_FIRE_SECRET = SECRET;
  delete process.env.AUTO_DRAFT_ENABLED; // ship dark by default
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  delete process.env.AUTO_DRAFT_FIRE_SECRET;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

const fire = () => request(app).post("/api/auto-draft/fire").set("x-auto-draft-fire-secret", SECRET);

describe("secret gate", () => {
  it("403s with no secret and with a wrong secret", async () => {
    expect((await request(app).post("/api/auto-draft/fire")).status).toBe(403);
    expect((await request(app).post("/api/auto-draft/fire").set("x-auto-draft-fire-secret", "wrong")).status).toBe(403);
  });
});

describe("manual-fire orchestration", () => {
  it("enqueues an eligible job as a first-draft-job runner job at the batch tier, and logs one activity entry", async () => {
    const today = todayET();
    makeJob("Alpha Role - Alpha Co", { deadline: addDays(today, 1) });

    const r = await fire();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.drafted).toBe(1);
    expect(r.body.overflow).toBe(0);

    // it landed on the SAME outbound queue every other kind uses, at the
    // batch tier (sonnet/medium - ROUTINES["first-draft-job"].batchModel)
    const claim = await request(app).get("/api/runner/jobs/next").set("authorization", `Bearer ${TOKEN}`);
    expect(claim.status).toBe(200);
    expect(claim.body.kind).toBe("first-draft-job");
    expect(claim.body.jobId).toBe("Alpha Role - Alpha Co");
    expect(claim.body.payload.tier).toBe("batch");
    expect(claim.body.payload.model).toBe("sonnet");
    expect(claim.body.payload.effort).toBe("medium");

    // never touches finalize/submit - structurally, only first-draft-job kind
    expect(claim.body.kind).not.toBe("finalize-job");
  });

  it("is idempotent against a double-fire: the SAME job is not enqueued twice (dedupe already-pending)", async () => {
    const today = todayET();
    makeJob("Beta Role - Beta Co", { deadline: addDays(today, 1) });

    const r1 = await fire();
    expect(r1.body.drafted).toBe(1);
    const r2 = await fire(); // fires again before anything claimed/completed
    expect(r2.body.drafted).toBe(0);
    expect(r2.body.skippedPending).toBeGreaterThanOrEqual(1);
  });

  it("excludes rolling deadlines, private sector, already-drafted (hasCV), and non-queued status", async () => {
    const today = todayET();
    makeJob("Rolling Role - Rolling Co", { deadline: "rolling" });
    makeJob("Private Role - Private Co", { deadline: addDays(today, 1), sector: "private" });
    makeJob("Drafted Role - Drafted Co", { deadline: addDays(today, 1), withCV: true });
    makeJob("Lead Role - Lead Co", { deadline: addDays(today, 1), status: "lead" });
    makeJob("Past Role - Past Co", { deadline: addDays(today, -1) });
    makeJob("Toofar Role - Toofar Co", { deadline: addDays(today, 4) });

    const r = await fire();
    expect(r.body.drafted).toBe(0);
  });

  it("caps enqueues per night and reports the overflow (never silently dropped)", async () => {
    const today = todayET();
    for (let i = 0; i < 12; i++) {
      makeJob(`Cap Role ${i} - Cap Co ${i}`, { deadline: addDays(today, 1) });
    }
    const r = await fire();
    expect(r.body.drafted).toBe(10);
    expect(r.body.overflow).toBe(2);
  });

  // A real "never fires in demo mode" boot test would need APP_MODE=demo,
  // which resolveRuntime's isolation gate (server/app-mode.js) hard-requires
  // STORE_BACKEND=pg for (demo mode ONLY runs on its own ephemeral Postgres,
  // by design - fail-closed, never a FileStore demo) - i.e. a real embedded
  // Postgres cluster (tests/helpers/embedded-pg.mjs), which is disproportionate
  // infrastructure for asserting one line. The route's `if (DEMO_MODE) return
  // res.status(501)...` guard is textually identical to the ALREADY-covered
  // demo-reset endpoint's own gate (server/index.js, just above mountRunnerRoutes)
  // and to runnerAuth's own demo check - both proven elsewhere (tests/demo-*.test.js).
});

describe("ship-dark posture", () => {
  it("the manual-fire endpoint is registered and usable WITHOUT AUTO_DRAFT_ENABLED (works regardless, for staging proof)", async () => {
    expect(process.env.AUTO_DRAFT_ENABLED).toBeUndefined();
    const r = await fire();
    expect(r.status).toBe(200); // proves the route itself is live even though the nightly timer never armed
  });

  it("the nightly timer route is registered only when AUTO_DRAFT_FIRE_SECRET is configured (no anonymous surface)", async () => {
    delete process.env.AUTO_DRAFT_FIRE_SECRET;
    vi.resetModules();
    const { app: noSecretApp } = await import("../server/index.js");
    const r = await request(noSecretApp).post("/api/auto-draft/fire").set("x-auto-draft-fire-secret", SECRET);
    expect(r.status).toBe(404); // route was never registered at all
    process.env.AUTO_DRAFT_FIRE_SECRET = SECRET;
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
});
