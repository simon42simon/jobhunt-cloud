import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// Per-scope keyed run lock (t-1783198713071). Evidence: docs/activity-log.jsonl
// 2026-07-03 records two finalize-job runs against the SAME job overlapping for
// ~4.5 minutes (r1783121457664_6 started 23:30:57.665Z, r1783121486457_7
// started 23:31:26.457Z, both terminal ~23:35) - two agents concurrently
// writing one job folder's generated artifacts. The fix, guarded here:
//   - POST /api/routines/run 409s while a run of the SAME (routine, jobId) is
//     live OR an identical batch item is still queued (a queued item is a
//     promised launch);
//   - a DIFFERENT job or a DIFFERENT routine on the same job is unaffected
//     (the lock is keyed, not global - same posture as maxConcurrentRuns);
//   - the lock releases when the run reaches a terminal state;
//   - POST /api/routines/batch SKIPS duplicates (already running / queued /
//     listed twice in the same request) rather than 409ing, mirroring
//     run-all-due's posture for sources, and its `total` stays honest.
//
// Hermetic: throwaway Jobs/docs dirs, spawn mocked (no real claude.exe).

function makeEmitterProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}
const spawnMock = vi.fn(() => {
  const proc = makeEmitterProc();
  setImmediate(() => proc.emit("close", 0));
  return proc;
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app;
let tmpRoot;
let fixture;

// Held-open procs the test closes explicitly (the guard is only observable
// while a run is genuinely live).
function holdNextSpawns(n) {
  const procs = [];
  for (let i = 0; i < n; i++) {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeEmitterProc();
      procs.push(proc);
      return proc;
    });
  }
  return procs;
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
async function closeAll(procs) {
  for (const p of procs) p.emit("close", 0);
  await settle();
}

function makeJob(folder) {
  const [role, employer] = folder.split(" - ");
  const dir = path.join(fixture, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${role}.md`),
    [
      "---", "type: job", `role: ${role}`, `employer: ${employer}`,
      "track: b2b_gtm_focused", "fit: strong", "status: drafted",
      "sector: private", "tailoring: light", "tags: [job]",
      "---", "", `# ${folder}`, "", "**Lead with:** x", "",
    ].join("\n"),
    "utf8"
  );
}

// Five jobs so a batch can saturate MAX_CONCURRENT_RUNS (4) and leave one
// QUEUED - the queued-item half of the guard needs a genuinely queued item.
const JOBS = ["Aa Role - Aa Co", "Bb Role - Bb Co", "Cc Role - Cc Co", "Dd Role - Dd Co", "Ee Role - Ee Co"];

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-perjob-"));
  fixture = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  // Seed a minimal task board: the ticket-scope guard test files a real ticket,
  // and loadTasks (deliberately) does not tolerate a missing tasks.yaml.
  fs.writeFileSync(
    path.join(docsDir, "tasks.yaml"),
    "columns: [backlog, todo, in_progress, done]\ntasks: []\n",
    "utf8"
  );
  for (const f of JOBS) makeJob(f);
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

const run = (routine, jobId) => request(app).post("/api/routines/run").send({ routine, jobId });

describe("POST /api/routines/run - per-(routine, jobId) duplicate guard", () => {
  it("REGRESSION (activity log 2026-07-03): a second finalize-job on the SAME job while the first is live is a 409, released on close", async () => {
    spawnMock.mockClear();
    const procs = holdNextSpawns(1);
    const first = await run("finalize-job", JOBS[0]);
    expect(first.status).toBe(201);

    // The exact double-trigger from the log: same routine, same jobId, while running.
    const dup = await run("finalize-job", JOBS[0]);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already in progress/);
    expect(spawnMock).toHaveBeenCalledTimes(1); // no second agent ever spawned

    await closeAll(procs);
    // Lock released: the same (routine, jobId) launches cleanly again.
    const procs2 = holdNextSpawns(1);
    const again = await run("finalize-job", JOBS[0]);
    expect(again.status).toBe(201);
    await closeAll(procs2);
  });

  it("is KEYED, not global: a different job, or a different routine on the same job, still launches", async () => {
    spawnMock.mockClear();
    const procs = holdNextSpawns(3);
    expect((await run("finalize-job", JOBS[0])).status).toBe(201);
    // Different jobId, same routine -> allowed.
    expect((await run("finalize-job", JOBS[1])).status).toBe(201);
    // Same jobId, different routine -> allowed (the key is routine+jobId).
    expect((await run("first-draft-job", JOBS[0])).status).toBe(201);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    await closeAll(procs);
  });

  it("guards ticket-scoped routines the same way (409 names the scope)", async () => {
    // A ticket the work-ticket routine can resolve.
    const created = await request(app).post("/api/tasks").send({ title: "guard ticket" });
    expect(created.status).toBe(201);
    const tid = created.body.id;
    const procs = holdNextSpawns(1);
    expect((await run("work-ticket", tid)).status).toBe(201);
    const dup = await run("work-ticket", tid);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/ticket/);
    await closeAll(procs);
  });

  it("409s for a job that is QUEUED in a batch but not yet running (a queued item is a promised launch)", async () => {
    spawnMock.mockClear();
    const procs = holdNextSpawns(4); // saturate MAX_CONCURRENT_RUNS
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "first-draft-job", jobIds: JOBS });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(5);
    expect(spawnMock).toHaveBeenCalledTimes(4); // 4 running, 1 queued

    // The 5th job sits in the queue - a single-run trigger for it must 409,
    // or the drain would double-run it.
    const queuedJob = JOBS[4];
    const dup = await run("first-draft-job", queuedJob);
    expect(dup.status).toBe(409);

    // Drain: close the 4 live procs; the queued 5th spawns; close it too.
    const fifth = holdNextSpawns(1);
    await closeAll(procs);
    expect(spawnMock).toHaveBeenCalledTimes(5);
    await closeAll(fifth);
  });
});

describe("POST /api/routines/batch - duplicates are skipped, total stays honest", () => {
  it("skips a job already RUNNING for the same routine (and keeps the rest)", async () => {
    spawnMock.mockClear();
    const procs = holdNextSpawns(2);
    expect((await run("first-draft-job", JOBS[0])).status).toBe(201);

    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "first-draft-job", jobIds: [JOBS[0], JOBS[1]] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1); // JOBS[0] skipped, JOBS[1] queued/launched
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await closeAll(procs);
  });

  it("dedupes a job listed twice in the SAME request", async () => {
    spawnMock.mockClear();
    const procs = holdNextSpawns(1);
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "first-draft-job", jobIds: [JOBS[2], JOBS[2]] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await closeAll(procs);
  });
});
