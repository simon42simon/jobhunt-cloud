import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// Wave 3b: lifecycle-edge coverage for Discovery Sources v1 (ADR-016), sitting
// alongside discovery-sources.test.js (the architect's happy-path + CRUD suite).
// This file fills the MEANINGFUL gaps that file does not touch:
//   - status-precedence branches (newest-terminal wins, running>failed,
//     failed>stale, incomplete is not failed);
//   - pursuedPct / newSinceVisit math boundaries (0 / 100 / rounding / no-finds);
//   - the run close-path leadsFound/leadsNew DELTA (not just the 0 case) and the
//     failed-outcome mapping, driven deterministically via a hand-closed proc;
//   - lastRunAt stamped at launch; PATCH lastVisitedAt driving newSinceVisit to 0;
//   - DELETE leaving finds intact (they fall to the unassigned bucket);
//   - the workbook-LOCKED degrade (locked:true, never a 500) via a stubbed
//     execFile - the JOBHUNT_DISCOVERY_FINDS seam always reports locked:false, so
//     the true lock branch needs the python path simulated;
//   - loadSources read-tolerance (a hand-edited bad enum degrades, never crashes);
//   - uniqueSourceId auto-suffix on a slug collision.
//
// Hermetic, same posture as discovery-sources.test.js: a throwaway docs/ copy,
// the finds JSON seam, and a mocked child_process so no real agent ever spawns.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
// ADR-023: live board files left docs/ for the data zone; suites overlay the
// committed synthetic fixtures so the server boots against tracked test data.
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

function makeEmitterProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}
// Auto-closes on the next tick (the default agent), like discovery-sources.test.js.
function makeFakeProc(exitCode = 0) {
  const proc = makeEmitterProc();
  setImmediate(() => proc.emit("close", exitCode));
  return proc;
}

const spawnMock = vi.fn(() => makeFakeProc(0));
// execFile is stubbed too so the workbook-lock degrade test can drive the python
// path (the finds seam only ever reports locked:false). Default: hand back an
// empty finds dump so any incidental call is benign; the lock test overrides once.
const execFileMock = vi.fn((...a) => {
  const cb = a[a.length - 1];
  if (typeof cb === "function") cb(null, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "");
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...a) => spawnMock(...a), execFile: (...a) => execFileMock(...a) };
});

let app;
let pure;
let tmpRoot;
let docsDir;
let jobsDir;
let findsFile;

const SOURCES_YAML = () => path.join(docsDir, "discovery-sources.yaml");

function restoreDocs() {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
}
function setSources(sources) {
  fs.writeFileSync(SOURCES_YAML(), yaml.dump({ version: 1, sources }), "utf8");
}
function setFinds(discoveries) {
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries, runLog: [] }), "utf8");
}
async function waitFor(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const getSource = async (id) => {
  const g = await request(app).get("/api/discovery/sources");
  return g.body.sources.find((s) => s.id === id);
};

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-disc-life-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(jobsDir, { recursive: true });
  restoreDocs();
  setFinds([]);
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  vi.resetModules();
  const mod = await import("../server/index.js");
  app = mod.app;
  pure = mod;
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  restoreDocs();
  setFinds([]);
  spawnMock.mockClear();
  execFileMock.mockClear();
});

// ---------------------------------------------------------------------------
// deriveSourceStatus - the precedence branches discovery-sources.test.js leaves
// unexercised. Precedence is: paused > running > failed(newest terminal) >
// never-run > stale > due > healthy.
// ---------------------------------------------------------------------------
describe("deriveSourceStatus (pure) - uncovered precedence branches", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const now = new Date();

  it("uses the NEWEST terminal run: a succeeded-after-failed history is healthy, not failed", () => {
    const s = {
      active: "yes",
      cadence: "weekly",
      lastRunAt: daysAgo(2),
      runs: [
        { outcome: "failed", startedAt: daysAgo(9) },
        { outcome: "succeeded", startedAt: daysAgo(2) },
      ],
    };
    // If this latched onto ANY failed run it would report "failed"; the newest
    // terminal is succeeded and it ran 2d ago (inside the weekly window).
    expect(pure.deriveSourceStatus(s, now).status).toBe("healthy");
  });

  it("a live run wins over an earlier failed terminal (running > failed)", () => {
    const s = {
      active: "yes",
      cadence: "weekly",
      lastRunAt: daysAgo(1),
      runs: [
        { outcome: "failed", startedAt: daysAgo(3) },
        { outcome: "running", startedAt: daysAgo(0) },
      ],
    };
    expect(pure.deriveSourceStatus(s, now).status).toBe("running");
  });

  it("a failed terminal wins over being overdue (failed > stale)", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(20), runs: [{ outcome: "failed", startedAt: daysAgo(20) }] };
    const d = pure.deriveSourceStatus(s, now);
    expect(d.status).toBe("failed"); // 20d = >2x the weekly interval, but failed takes precedence
    expect(d.due).toBe(true); // still due for the scheduler, independent of the pill
  });

  it("an incomplete (stopped) terminal is NOT treated as failed", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(2), runs: [{ outcome: "incomplete", startedAt: daysAgo(2) }] };
    // Only outcome === "failed" trips the failed pill; incomplete + recent -> healthy.
    expect(pure.deriveSourceStatus(s, now).status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// deriveSources - pursuedPct / no-finds math boundaries (pure over doc+finds).
// ---------------------------------------------------------------------------
describe("deriveSources (pure) - pursuedPct math", () => {
  const doc = (sources) => ({ version: 1, sources });

  it("pursuedPct: 0 when none pursued, 100 when all, and rounds to the nearest %", () => {
    const d = pure.deriveSources(
      doc([
        { id: "none", name: "None", aliases: ["N"] },
        { id: "all", name: "All", aliases: ["A"] },
        { id: "third", name: "Third", aliases: ["T"] },
      ]),
      [
        { Source: "N", Decision: "skip" },
        { Source: "N", Decision: "maybe" }, // 0 / 2 -> 0
        { Source: "A", Decision: "pursue" },
        { Source: "A", tracked: true }, // pursue + tracked -> 2 / 2 -> 100 (proves the tracked OR branch)
        { Source: "T", Decision: "pursue" },
        { Source: "T", Decision: "skip" },
        { Source: "T", Decision: "skip" }, // 1 / 3 -> round(33.33) -> 33
      ]
    );
    const by = Object.fromEntries(d.sources.map((s) => [s.id, s]));
    expect(by.none.pursuedPct).toBe(0);
    expect(by.all.pursuedPct).toBe(100);
    expect(by.third.pursuedPct).toBe(33);
  });

  it("pursuedPct is 0 (not NaN) for a source with no finds", () => {
    const d = pure.deriveSources(doc([{ id: "empty", name: "Empty" }]), []);
    expect(d.sources[0].jobCount).toBe(0);
    expect(d.sources[0].pursuedPct).toBe(0);
    expect(Number.isNaN(d.sources[0].pursuedPct)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// finalizeRunRecord - close-path edge the architect's suite does not cover.
// ---------------------------------------------------------------------------
describe("finalizeRunRecord (pure) - outcome degrade", () => {
  it("degrades an unknown terminal outcome to 'incomplete' and stamps errorReason", () => {
    const doc = { sources: [{ id: "oci", runs: [{ runId: "r1", outcome: "running", startedAt: "2026-07-04T00:00:00.000Z", trigger: "manual" }] }] };
    pure.finalizeRunRecord(doc, { sourceId: "oci", runId: "r1", outcome: "bogus", durationMs: 5, errorReason: "weird" });
    const rec = doc.sources[0].runs[0];
    expect(rec.outcome).toBe("incomplete"); // "bogus" is not a RUN_OUTCOME
    expect(rec.errorReason).toBe("weird");
    expect(rec.durationMs).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// POST create - id collision auto-suffix (uniqueSourceId).
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources - slug collision", () => {
  it("auto-suffixes the derived id when the slug is already taken", async () => {
    setSources([]);
    const a = await request(app).post("/api/discovery/sources").send({ name: "OCI" });
    const b = await request(app).post("/api/discovery/sources").send({ name: "OCI" });
    expect(a.body.id).toBe("oci");
    expect(b.body.id).toBe("oci-2"); // same name, no explicit id -> deduped, not a 409 or an overwrite
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.sources.filter((s) => s.name === "OCI").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET - read tolerance: a hand-edited registry with bad enums still serves.
// ---------------------------------------------------------------------------
describe("GET /api/discovery/sources - tolerant read", () => {
  it("degrades hand-edited invalid enums to safe defaults instead of crashing", async () => {
    // Written straight to disk with values the write boundary would 400.
    setSources([{ id: "wonky", name: "Wonky", type: "scraper", sector: "outer-space", active: "sometimes", cadence: "hourly" }]);
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    const s = res.body.sources.find((x) => x.id === "wonky");
    expect(s).toBeDefined();
    expect(s.type).toBe("board"); // bad -> default
    expect(s.sector).toBe("private");
    expect(s.active).toBe("maybe");
    expect(s.cadence).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// PATCH lastVisitedAt -> newSinceVisit derivation collapses to 0.
// ---------------------------------------------------------------------------
describe("PATCH /api/discovery/sources/:id - lastVisitedAt drives newSinceVisit", () => {
  it("stamping a visit newer than every find drives newSinceVisit to 0", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    setFinds([
      { Title: "A", Source: "OCI", "Date Found": "2026-06-25" },
      { Title: "B", Source: "OCI", "Date Found": "2026-06-30" },
    ]);

    const before = await getSource("oci");
    expect(before.newSinceVisit).toBe(2); // never visited -> all finds are new

    const patch = await request(app).patch("/api/discovery/sources/oci").send({ lastVisitedAt: "2026-07-01T00:00:00.000Z" });
    expect(patch.status).toBe(200);
    expect(patch.body.newSinceVisit).toBe(0); // the mutated-source response reflects it immediately

    const after = await getSource("oci");
    expect(after.newSinceVisit).toBe(0); // and it persisted (both finds predate the visit)
  });
});

// ---------------------------------------------------------------------------
// DELETE leaves finds intact - they fall into the honest unassigned bucket.
// ---------------------------------------------------------------------------
describe("DELETE /api/discovery/sources/:id - finds survive", () => {
  it("removes only the managed config; the source's finds become unassigned", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly", aliases: ["OCI/OVIN"] }]);
    setFinds([
      { Title: "A", Source: "OCI", "Date Found": "2026-06-25" },
      { Title: "B", Source: "OCI/OVIN", "Date Found": "2026-06-25" },
    ]);

    const before = await request(app).get("/api/discovery/sources");
    expect(before.body.sources.find((s) => s.id === "oci").jobCount).toBe(2);
    expect(before.body.unassignedCount).toBe(0);

    const del = await request(app).delete("/api/discovery/sources/oci");
    expect(del.status).toBe(200);

    const after = await request(app).get("/api/discovery/sources");
    expect(after.body.sources.find((s) => s.id === "oci")).toBeUndefined();
    expect(after.body.unassignedCount).toBe(2); // the two finds are untouched, now unmatched
    expect(after.body.unassignedSources.map((u) => u.label).sort()).toEqual(["OCI", "OCI/OVIN"].sort());
  });
});

// ---------------------------------------------------------------------------
// POST run - lastRunAt anchor + the close-path leadsFound/leadsNew delta.
// A hand-closed proc makes the close path deterministic (change the finds
// between launch and close, then fire "close" ourselves).
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources/:id/run - lifecycle + delta", () => {
  it("stamps lastRunAt at launch (the cadence anchor) alongside the optimistic run", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    const res = await request(app).post("/api/discovery/sources/oci/run").send({});
    expect(res.status).toBe(201);
    expect(res.body.source.lastRunAt).toBeTruthy();
    expect(res.body.source.lastRunAt).toBe(res.body.source.runs[0].startedAt); // anchor == the run start
    // Let the default (auto-closing) agent's finalize settle so it can't bleed
    // into the next test's file.
    await waitFor(async () => (await getSource("oci")).runs[0].outcome === "succeeded");
  });

  it("finalize records leadsFound + leadsNew as the delta of finds gained during the run", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    setFinds([{ Title: "A", Source: "OCI", Decision: "skip", "Date Found": "2026-06-25" }]); // baseline: 1

    let proc;
    spawnMock.mockImplementationOnce(() => {
      proc = makeEmitterProc(); // no auto-close: we drive the close ourselves
      return proc;
    });

    const res = await request(app).post("/api/discovery/sources/oci/run").send({});
    expect(res.status).toBe(201);
    expect(res.body.source.runs[0].outcome).toBe("running"); // optimistic

    // The run "discovers" two more OCI leads before it closes.
    setFinds([
      { Title: "A", Source: "OCI", Decision: "skip", "Date Found": "2026-06-25" },
      { Title: "B", Source: "OCI", Decision: "pursue", "Date Found": "2026-07-03" },
      { Title: "C", Source: "OCI", Decision: "skip", "Date Found": "2026-07-04" },
    ]);
    proc.emit("close", 0);

    const done = await waitFor(async () => (await getSource("oci")).runs[0].outcome === "succeeded");
    expect(done).toBe(true);
    const rec = (await getSource("oci")).runs[0];
    expect(rec.leadsFound).toBe(3); // finds now joined to the source
    expect(rec.leadsNew).toBe(2); // 3 after - 1 baseline
    expect(typeof rec.durationMs).toBe("number");
  });

  it("maps a non-zero exit to a failed outcome (delta still computed)", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    setFinds([{ Title: "A", Source: "OCI", "Date Found": "2026-06-25" }]); // baseline 1, unchanged

    let proc;
    spawnMock.mockImplementationOnce(() => {
      proc = makeEmitterProc();
      return proc;
    });

    const res = await request(app).post("/api/discovery/sources/oci/run").send({});
    expect(res.status).toBe(201);
    proc.emit("close", 1); // agent exited non-zero

    const done = await waitFor(async () => (await getSource("oci")).runs[0].outcome === "failed");
    expect(done).toBe(true);
    const rec = (await getSource("oci")).runs[0];
    expect(rec.outcome).toBe("failed");
    expect(rec.leadsFound).toBe(1); // finds unchanged
    expect(rec.leadsNew).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET degrade - workbook LOCKED in Excel: serve locked:true, never a 500.
// The finds seam always reports locked:false, so drive the python path with a
// stubbed execFile that yields a lock signature.
// ---------------------------------------------------------------------------
describe("GET /api/discovery/sources - workbook-locked degrade", () => {
  it("serves the registry with locked:true (jobCount 0, never a 500) when Excel holds the workbook", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    const prevSeam = process.env.JOBHUNT_DISCOVERY_FINDS;
    delete process.env.JOBHUNT_DISCOVERY_FINDS; // force readDiscovery down the python path

    execFileMock.mockImplementationOnce((...a) => {
      const cb = a[a.length - 1];
      const err = new Error("[WinError 32] The process cannot access the file because it is being used by another process");
      cb(err, "", "being used by another process");
    });

    try {
      const res = await request(app).get("/api/discovery/sources");
      expect(res.status).toBe(200); // never a 500
      expect(res.body.locked).toBe(true);
      expect(res.body.message).toMatch(/Excel/);
      // The source registry still serves; finds just degrade to 0.
      const oci = res.body.sources.find((s) => s.id === "oci");
      expect(oci).toBeDefined();
      expect(res.body.sources.every((s) => s.jobCount === 0)).toBe(true);
      expect(res.body.unassignedCount).toBe(0);
    } finally {
      process.env.JOBHUNT_DISCOVERY_FINDS = prevSeam;
    }
  });
});

// ---------------------------------------------------------------------------
// Registry unification (t-1783183576537): the run-all-due fan-out that replaces
// the retired global discover-jobs sweep. Cap honored via the shared queue,
// lastRunAt stamped only at LAUNCH (the honest cadence anchor), running/queued
// sources skipped, and the global routine rejected with a pointer.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/run-all-due - fan-out over due sources", () => {
  const dueSources = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `src-${i}`,
      name: `Source ${i}`,
      type: "board",
      sector: "private",
      active: "yes",
      cadence: "daily", // never run + daily cadence -> due
    }));

  it("excludes PAUSED (active:'no') sources even when otherwise due (QA t-1783203025251)", async () => {
    // active is a 3-state string enum; a paused source (active:'no') is still
    // 'due' by cadence, so the old truthy `s.active &&` filter launched it -
    // defeating the pause control. The fan-out must skip it.
    setSources([
      { id: "live", name: "Live", type: "board", sector: "private", active: "yes", cadence: "daily" },
      { id: "paused", name: "Paused", type: "board", sector: "private", active: "no", cadence: "daily" },
    ]);
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    expect(res.body.targets).toEqual(["live"]); // paused source excluded
    expect(res.body.total).toBe(1);
    // let the one auto-closing run settle so it cannot bleed into the next test
    await waitFor(async () => (await getSource("live")).runs?.[0]?.outcome === "succeeded");
  });

  it("launches up to the cap, queues the rest, stamps lastRunAt only at launch", async () => {
    const procs = [];
    spawnMock.mockImplementation(() => {
      const p = makeEmitterProc(); // hand-closed: we drive the drain ourselves
      procs.push(p);
      return p;
    });
    setSources(dueSources(6));

    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    expect(res.body.batchId).toMatch(/^b\d+/);
    expect(res.body.total).toBe(6);
    expect(res.body.targets).toHaveLength(6);

    // Only MAX_CONCURRENT_RUNS (4) agents actually spawn; 2 wait in the queue.
    await waitFor(() => spawnMock.mock.calls.length === 4);
    expect(spawnMock).toHaveBeenCalledTimes(4);
    const b = await request(app).get(`/api/routines/batch/${res.body.batchId}`);
    expect(b.body.running).toBe(4);
    expect(b.body.queued).toBe(2);
    expect(b.body.total).toBe(6);

    // The cadence anchor is stamped at LAUNCH, not enqueue: exactly the 4
    // launched sources carry lastRunAt; the 2 queued ones do not yet.
    let g = await request(app).get("/api/discovery/sources");
    expect(g.body.sources.filter((s) => s.lastRunAt).length).toBe(4);

    // Closing one run frees a slot: the 5th launches and gets stamped.
    procs[0].emit("close", 0);
    await waitFor(() => spawnMock.mock.calls.length === 5);
    const fifth = await waitFor(
      async () => (await request(app).get("/api/discovery/sources")).body.sources.filter((s) => s.lastRunAt).length === 5
    );
    expect(fifth).toBe(true);

    // Drain fully; every due source ends stamped with a terminal outcome. The
    // 6th source only spawns once a slot frees, so close it when it appears.
    procs.slice(1, 5).forEach((p) => p.emit("close", 0));
    expect(await waitFor(() => spawnMock.mock.calls.length === 6)).toBe(true);
    procs[5].emit("close", 0);
    const drained = await waitFor(async () => {
      const all = (await request(app).get("/api/discovery/sources")).body.sources;
      return all.every((s) => s.lastRunAt && (s.runs || []).every((r) => r.outcome !== "running"));
    });
    expect(drained).toBe(true);
    // Fan-out provenance recorded on the run history.
    const one = await getSource("src-0");
    expect(one.runs[0].trigger).toBe("all-due");
    spawnMock.mockImplementation(() => makeFakeProc(0));
  });

  it("skips already-running sources and is a no-op when nothing is due", async () => {
    const procs = [];
    spawnMock.mockImplementation(() => {
      const p = makeEmitterProc();
      procs.push(p);
      return p;
    });
    setSources(dueSources(2));

    // src-0 is started by hand first (a manual per-source Run now)...
    const manual = await request(app).post("/api/discovery/sources/src-0/run").send({});
    expect(manual.status).toBe(201);

    // ...so the fan-out only targets src-1.
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    expect(res.body.targets).toEqual(["src-1"]);

    // With both now covered, a second fan-out finds nothing due.
    const again = await request(app).post("/api/discovery/run-all-due");
    expect(again.status).toBe(200);
    expect(again.body.batchId).toBeNull();
    expect(again.body.total).toBe(0);

    procs.forEach((p) => p.emit("close", 0));
    const settled = await waitFor(async () => {
      const all = (await request(app).get("/api/discovery/sources")).body.sources;
      return all.every((s) => (s.runs || []).every((r) => r.outcome !== "running"));
    });
    expect(settled).toBe(true);
    // The manual launch keeps manual provenance; the fan-out one is all-due.
    expect((await getSource("src-0")).runs[0].trigger).toBe("manual");
    expect((await getSource("src-1")).runs[0].trigger).toBe("all-due");
    spawnMock.mockImplementation(() => makeFakeProc(0));
  });

  it("the global discover-jobs sweep is retired: run rejects with a pointer, list hides it", async () => {
    setSources(dueSources(1));
    const res = await request(app).post("/api/routines/run").send({ routine: "discover-jobs" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run-all-due/);
    expect(spawnMock).not.toHaveBeenCalled();

    const list = await request(app).get("/api/routines");
    expect(list.status).toBe(200);
    expect(list.body.find((r) => r.id === "discover-jobs")).toBeUndefined();
  });
});
