import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// Discovery Sources v1 (ADR-016): the managed-source registry
// (docs/discovery-sources.yaml), its derived-view GET, the CRUD + per-source run
// endpoints, and the migration's alias join. Hermetic:
//   - JOBHUNT_DOCS_DIR points at a throwaway copy of docs/ (the real seed is
//     copied in; per-test fixtures overwrite discovery-sources.yaml);
//   - JOBHUNT_DISCOVERY_FINDS is the finds test seam - a JSON fixture the server
//     reads instead of running python/xlsx, so the jobCount join is deterministic;
//   - node:child_process.spawn is mocked so the per-source "Run now" never
//     launches a real claude agent (mirrors discover-prune.test.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

// A fake agent process that closes with a chosen exit code on the next tick.
function makeFakeProc(exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", exitCode));
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc(0));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...a) => spawnMock(...a) };
});

let app;
let pure; // exported pure helpers under test
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
// Overwrite the registry with a controlled fixture (bypasses the committed seed).
function setSources(sources) {
  fs.writeFileSync(SOURCES_YAML(), yaml.dump({ version: 1, sources }), "utf8");
}
// Point the finds seam at a controlled set of workbook finds.
function setFinds(discoveries) {
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries, runLog: [] }), "utf8");
}
async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-disc-src-"));
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
});

// ---------------------------------------------------------------------------
// Pure status derivation (deriveSourceStatus) - the health pill, never stored.
// ---------------------------------------------------------------------------
describe("deriveSourceStatus (pure)", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const now = new Date();

  it("active:no -> paused (wins over everything else)", () => {
    const s = { active: "no", cadence: "daily", lastRunAt: daysAgo(30), runs: [{ outcome: "running", startedAt: daysAgo(0) }] };
    expect(pure.deriveSourceStatus(s, now).status).toBe("paused");
  });

  it("a live run -> running", () => {
    const s = { active: "yes", cadence: "weekly", runs: [{ outcome: "running", startedAt: daysAgo(0) }] };
    expect(pure.deriveSourceStatus(s, now).status).toBe("running");
  });

  it("last terminal run failed -> failed", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(1), runs: [{ outcome: "failed", startedAt: daysAgo(1) }] };
    expect(pure.deriveSourceStatus(s, now).status).toBe("failed");
  });

  it("no runs and no lastRunAt -> never-run (and due for a scheduled source)", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: null, runs: [] };
    const d = pure.deriveSourceStatus(s, now);
    expect(d.status).toBe("never-run");
    expect(d.due).toBe(true); // a never-run scheduled source should run
    expect(d.nextRunAt).toBe(null);
  });

  it("ran recently within the cadence window -> healthy, not due", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(3), runs: [{ outcome: "succeeded", startedAt: daysAgo(3) }] };
    const d = pure.deriveSourceStatus(s, now);
    expect(d.status).toBe("healthy");
    expect(d.due).toBe(false);
  });

  it("overdue by >1x but <2x the interval -> due", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(8), runs: [{ outcome: "succeeded", startedAt: daysAgo(8) }] };
    const d = pure.deriveSourceStatus(s, now);
    expect(d.status).toBe("due");
    expect(d.due).toBe(true);
  });

  it("overdue by >=2x the interval -> stale", () => {
    const s = { active: "yes", cadence: "weekly", lastRunAt: daysAgo(15), runs: [{ outcome: "succeeded", startedAt: daysAgo(15) }] };
    expect(pure.deriveSourceStatus(s, now).status).toBe("stale");
  });

  it("manual cadence is never due and has a null nextRunAt", () => {
    const s = { active: "yes", cadence: "manual", lastRunAt: daysAgo(90), runs: [{ outcome: "succeeded", startedAt: daysAgo(90) }] };
    const d = pure.deriveSourceStatus(s, now);
    expect(d.due).toBe(false);
    expect(d.nextRunAt).toBe(null);
    expect(d.status).toBe("healthy");
  });

  it("nextRunAt = lastRunAt + cadence interval", () => {
    const lastRunAt = "2026-07-01T00:00:00.000Z";
    const s = { active: "yes", cadence: "weekly", lastRunAt, runs: [{ outcome: "succeeded", startedAt: lastRunAt }] };
    const d = pure.deriveSourceStatus(s, new Date("2026-07-02T00:00:00.000Z"));
    expect(d.nextRunAt).toBe("2026-07-08T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// GET /api/discovery/sources - derived fields + the name/alias/sourceId join.
// ---------------------------------------------------------------------------
describe("GET /api/discovery/sources (derived fields + join)", () => {
  beforeEach(() => {
    setSources([
      { id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly", aliases: ["OCI/OVIN", "OCI via Glassdoor"] },
      { id: "acme", name: "Acme Corp", type: "employer", sector: "private", active: "maybe", cadence: "manual", lastVisitedAt: "2026-06-28T00:00:00.000Z" },
      { id: "paused-co", name: "Paused Co", type: "employer", sector: "private", active: "no", cadence: "daily" },
    ]);
    setFinds([
      { Title: "A", Source: "OCI", Decision: "pursue", "Date Found": "2026-06-25" },
      { Title: "B", Source: "OCI/OVIN", Decision: "skip", "Date Found": "2026-06-25" },
      { Title: "C", Source: "OCI via Glassdoor", tracked: true, "Date Found": "2026-06-29" },
      { Title: "D", sourceId: "acme", Decision: "skip", "Date Found": "2026-06-25" }, // stamped id join
      { Title: "E", Source: "Acme Corp", Decision: "pursue", "Date Found": "2026-06-30" }, // name join, newer than visit
      { Title: "F", Source: "Some Random Board", Decision: "skip", "Date Found": "2026-06-25" }, // unassigned
      { Title: "G", Source: "careerbeacon", Decision: "skip", "Date Found": "2026-06-25" }, // unassigned
    ]);
  });

  it("counts finds by name, alias, and stamped sourceId; reports the unassigned bucket", async () => {
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.sources.map((s) => [s.id, s]));

    // OCI: 3 finds from 3 distinct Source strings (name + 2 aliases) - fails if
    // the alias join is not applied.
    expect(byId.oci.jobCount).toBe(3);
    expect(byId.oci.pursuedPct).toBe(67); // 2 of 3 pursued/tracked (pursue + tracked)

    // Acme: 2 finds, one via stamped sourceId, one via name.
    expect(byId.acme.jobCount).toBe(2);
    expect(byId.acme.pursuedPct).toBe(50);
    // newSinceVisit: only the 2026-06-30 find is newer than the 2026-06-28 visit.
    expect(byId.acme.newSinceVisit).toBe(1);

    // never visited -> all finds are "new".
    expect(byId.oci.newSinceVisit).toBe(3);

    // The two unmatched finds are the honest unassigned bucket.
    expect(res.body.unassignedCount).toBe(2);
    const labels = res.body.unassignedSources.map((u) => u.label).sort();
    expect(labels).toEqual(["Some Random Board", "careerbeacon"].sort());
  });

  it("derives status: paused / never-run per source", async () => {
    const res = await request(app).get("/api/discovery/sources");
    const byId = Object.fromEntries(res.body.sources.map((s) => [s.id, s]));
    expect(byId["paused-co"].status).toBe("paused");
    expect(byId.oci.status).toBe("never-run"); // no runs seeded
    expect(byId.oci.due).toBe(true); // scheduled + never run
  });

  it("degrades to jobCount 0 (never a 500) when finds are unavailable", async () => {
    fs.writeFileSync(findsFile, "{ not valid json", "utf8");
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    expect(res.body.sources.every((s) => s.jobCount === 0)).toBe(true);
    expect(res.body.unassignedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST / PATCH / DELETE - CRUD + closed-enum validation.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources (create + validation)", () => {
  beforeEach(() => setSources([]));

  it("creates a source, stamps a slug id, and applies defaults", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "City of Toronto" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("city-of-toronto");
    expect(res.body.type).toBe("board");
    expect(res.body.active).toBe("yes");
    expect(res.body.cadence).toBe("manual");
    expect(res.body.outputFields).toEqual(["title", "employer", "location", "deadline", "salary", "link"]);
    expect(res.body.status).toBe("never-run");
    // persisted (not just echoed).
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.sources.find((s) => s.id === "city-of-toronto")).toBeDefined();
  });

  it("requires a name", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ type: "board" });
    expect(res.status).toBe(400);
  });

  it("accepts apify as a built type but requires a sanitized actorId (400 without one)", async () => {
    // apify is now a first-class source type (ADR 2026-07-06); the reserved-type
    // 400 is replaced by the actorId requirement (guardian C2).
    const res = await request(app).post("/api/discovery/sources").send({ name: "X", type: "apify" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorId/i);
  });

  it("rejects a bad sector / cadence / active with 400", async () => {
    for (const [k, v] of [["sector", "bogus"], ["cadence", "hourly"], ["active", "sometimes"]]) {
      const res = await request(app).post("/api/discovery/sources").send({ name: "X", [k]: v });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(new RegExp(`${k} must be one of`));
    }
  });

  it("409s an explicit id that already exists", async () => {
    setSources([{ id: "dup", name: "Dup", type: "board", sector: "private", active: "yes", cadence: "manual" }]);
    const res = await request(app).post("/api/discovery/sources").send({ name: "Another", id: "dup" });
    expect(res.status).toBe(409);
  });

  it("accepts url (singular) and folds it into the urls list", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "One URL", url: "https://x.example/careers" });
    expect(res.status).toBe(201);
    expect(res.body.urls).toEqual(["https://x.example/careers"]);
  });
});

describe("PATCH /api/discovery/sources/:id", () => {
  beforeEach(() =>
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly", instructions: "old" }])
  );

  it("edits fields (active, cadence, instructions, lastVisitedAt)", async () => {
    const res = await request(app)
      .patch("/api/discovery/sources/oci")
      .send({ active: "maybe", cadence: "monthly", instructions: "new crawl steps", lastVisitedAt: "2026-07-04T12:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe("maybe");
    expect(res.body.cadence).toBe("monthly");
    expect(res.body.instructions).toBe("new crawl steps");
    expect(res.body.lastVisitedAt).toBe("2026-07-04T12:00:00.000Z");
  });

  it("rejects a bad enum with 400 and does not persist the change", async () => {
    const res = await request(app).patch("/api/discovery/sources/oci").send({ cadence: "hourly", instructions: "should not stick" });
    expect(res.status).toBe(400);
    const after = await request(app).get("/api/discovery/sources");
    expect(after.body.sources.find((s) => s.id === "oci").instructions).toBe("old");
  });

  it("404s an unknown source", async () => {
    const res = await request(app).patch("/api/discovery/sources/nope").send({ active: "no" });
    expect(res.status).toBe(404);
  });

  it("never accepts server-managed fields (lastRunAt / runs) from the client", async () => {
    const res = await request(app)
      .patch("/api/discovery/sources/oci")
      .send({ lastRunAt: "2000-01-01T00:00:00.000Z", runs: [{ outcome: "succeeded", startedAt: "2000-01-01T00:00:00.000Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.lastRunAt).toBe(null); // ignored, unforgeable
    expect(res.body.runs).toEqual([]);
  });
});

describe("DELETE /api/discovery/sources/:id", () => {
  it("removes a source (404 on unknown)", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    expect((await request(app).delete("/api/discovery/sources/oci")).status).toBe(200);
    expect((await request(app).delete("/api/discovery/sources/oci")).status).toBe(404);
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.sources.find((s) => s.id === "oci")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-source "Run now" - optimistic running record + close-path finalize.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources/:id/run", () => {
  beforeEach(() => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    setFinds([{ Title: "A", Source: "OCI", Decision: "skip", "Date Found": "2026-06-25" }]);
  });

  it("appends a running record, then the close path flips it to a terminal outcome", async () => {
    const res = await request(app).post("/api/discovery/sources/oci/run").send({});
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Optimistic: exactly one run record, trigger manual, correlated by runId.
    expect(res.body.source.runs.length).toBe(1);
    expect(res.body.source.runs[0].trigger).toBe("manual");
    expect(res.body.source.runs[0].runId).toBe(res.body.runId);

    // The mocked agent exits 0 -> the close path updates the record to succeeded.
    const done = await waitFor(async () => {
      const g = await request(app).get("/api/discovery/sources");
      const rec = g.body.sources.find((s) => s.id === "oci").runs[0];
      return rec && rec.outcome === "succeeded";
    });
    expect(done).toBe(true);
    const g = await request(app).get("/api/discovery/sources");
    const rec = g.body.sources.find((s) => s.id === "oci").runs[0];
    expect(rec.leadsNew).toBe(0); // finds unchanged since the baseline
    expect(typeof rec.durationMs).toBe("number");
  });

  it("409s a second concurrent run for the same source", async () => {
    setSources([
      { id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly", runs: [{ runId: "r-live", outcome: "running", startedAt: new Date().toISOString(), trigger: "manual" }] },
    ]);
    const res = await request(app).post("/api/discovery/sources/oci/run").send({});
    expect(res.status).toBe(409);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("404s an unknown source", async () => {
    const res = await request(app).post("/api/discovery/sources/nope/run").send({});
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finalizeRunRecord (pure) - the close-path doc transform.
// ---------------------------------------------------------------------------
describe("finalizeRunRecord (pure)", () => {
  it("flips the matching running record to its terminal outcome + fields", () => {
    const doc = { sources: [{ id: "oci", runs: [{ runId: "r1", outcome: "running", startedAt: "2026-07-04T00:00:00.000Z", trigger: "manual" }] }] };
    pure.finalizeRunRecord(doc, { sourceId: "oci", runId: "r1", outcome: "succeeded", durationMs: 1234, leadsFound: 5, leadsNew: 2 });
    const rec = doc.sources[0].runs[0];
    expect(rec.outcome).toBe("succeeded");
    expect(rec.durationMs).toBe(1234);
    expect(rec.leadsFound).toBe(5);
    expect(rec.leadsNew).toBe(2);
  });

  it("falls back to the running record when the runId is not found", () => {
    const doc = { sources: [{ id: "oci", runs: [{ outcome: "running", startedAt: "2026-07-04T00:00:00.000Z" }] }] };
    pure.finalizeRunRecord(doc, { sourceId: "oci", runId: "missing", outcome: "failed", durationMs: 10 });
    expect(doc.sources[0].runs[0].outcome).toBe("failed");
  });

  it("no-ops on an unknown source (never throws)", () => {
    const doc = { sources: [{ id: "oci", runs: [] }] };
    expect(() => pure.finalizeRunRecord(doc, { sourceId: "ghost", runId: "x", outcome: "succeeded" })).not.toThrow();
  });

  it("caps the run history at 20", () => {
    const runs = [];
    for (let i = 0; i < 24; i++) runs.push({ runId: `r${i}`, outcome: "succeeded", startedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` });
    runs.push({ runId: "r-live", outcome: "running", startedAt: "2026-07-01T00:00:00.000Z" });
    const doc = { sources: [{ id: "oci", runs }] };
    pure.finalizeRunRecord(doc, { sourceId: "oci", runId: "r-live", outcome: "succeeded", durationMs: 1 });
    expect(doc.sources[0].runs.length).toBe(20);
    expect(doc.sources[0].runs.some((r) => r.runId === "r-live")).toBe(true); // newest kept
  });
});

// ---------------------------------------------------------------------------
// Migration seed correctness - the COMMITTED docs/discovery-sources.yaml joins
// the real legacy Source strings through its curated aliases.
// ---------------------------------------------------------------------------
// Clean-repo hermeticity (I9): the curated registry is deliberately absent from
// the public extraction - skip the committed-seed suite there, never fail.
describe.skipIf(!fs.existsSync(path.join(REPO_DOCS, "discovery-sources.yaml")))("migration seed (committed discovery-sources.yaml) alias join", () => {
  beforeEach(() => {
    restoreDocs(); // use the real committed seed, not a fixture
    setFinds([
      { Title: "a", Source: "OCI", "Date Found": "2026-06-25" },
      { Title: "b", Source: "OCI/OVIN", "Date Found": "2026-06-25" },
      { Title: "c", Source: "OCI via Glassdoor", "Date Found": "2026-06-25" },
      { Title: "d", Source: "OPS gojobs", "Date Found": "2026-06-25" },
      { Title: "e", Source: "careers.uoguelph.ca", "Date Found": "2026-06-25" },
      { Title: "f", Source: "york.hua.hrsmart.com", "Date Found": "2026-06-25" }, // York REGION, not York U
      { Title: "g", Source: "careerbeacon", "Date Found": "2026-06-25" }, // deliberately unmapped
    ]);
  });

  it("collapses messy legacy Source strings onto the right seeded source", async () => {
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.sources.map((s) => [s.id, s]));
    expect(byId.oci.jobCount).toBe(3); // OCI + OCI/OVIN + OCI via Glassdoor
    expect(byId.ops.jobCount).toBe(1); // OPS gojobs
    expect(byId["university-of-guelph"].jobCount).toBe(1); // careers.uoguelph.ca -> the dedicated Guelph source (v0.35 carve-out)
    expect(byId["other-ontario-universities"].jobCount).toBe(0); // no longer owns the uoguelph alias; it's the OTHER-universities bucket
    expect(byId["york-region"].jobCount).toBe(1); // york.hua.hrsmart.com
    expect(byId["york-university"].jobCount).toBe(0); // must NOT swallow the hrsmart string
    expect(res.body.unassignedCount).toBe(1); // careerbeacon only
    expect(res.body.unassignedSources[0].label).toBe("careerbeacon");
  });
});

// ---------------------------------------------------------------------------
// Sources v2 (data-schema.md §5): tracks (Decision 1), nextRunAt across all
// four cadences (Decision 2), server-derived contractGaps (Decision 3a), and
// the strengthened scrape-contract run prompt (Decision 3).
// ---------------------------------------------------------------------------
describe("tracks: closed-enum write validation + all-tracks default (Decision 1)", () => {
  beforeEach(() => setSources([]));

  it("defaults to [] (all tracks) when not sent on create, and serves tracks on GET", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "Generic Board" });
    expect(res.status).toBe(201);
    expect(res.body.tracks).toEqual([]);
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.sources.find((s) => s.id === "generic-board").tracks).toEqual([]);
  });

  it("accepts and persists valid track ids on create", async () => {
    const res = await request(app)
      .post("/api/discovery/sources")
      .send({ name: "Aero Employer", tracks: ["aerospace_defence_focused", "b2b_gtm_focused"] });
    expect(res.status).toBe(201);
    expect(res.body.tracks).toEqual(["aerospace_defence_focused", "b2b_gtm_focused"]);
    // persisted (not just echoed)
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.sources.find((s) => s.id === "aero-employer").tracks).toEqual([
      "aerospace_defence_focused",
      "b2b_gtm_focused",
    ]);
  });

  it("rejects an unknown track id with a loud 400 (same posture as the other enums)", async () => {
    const res = await request(app)
      .post("/api/discovery/sources")
      .send({ name: "X", tracks: ["aerospace_defence_focused", "not_a_track"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tracks values must be one of/);
  });

  it("rejects a non-array tracks with 400", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "X", tracks: "b2b_gtm_focused" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tracks must be an array/);
  });

  it("PATCH sets, replaces, and clears tracks; a bad value 400s and does not persist", async () => {
    setSources([{ id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly" }]);
    const set = await request(app).patch("/api/discovery/sources/oci").send({ tracks: ["public_sector_focused"] });
    expect(set.status).toBe(200);
    expect(set.body.tracks).toEqual(["public_sector_focused"]);

    const bad = await request(app).patch("/api/discovery/sources/oci").send({ tracks: ["bogus_track"] });
    expect(bad.status).toBe(400);
    const after = await request(app).get("/api/discovery/sources");
    expect(after.body.sources.find((s) => s.id === "oci").tracks).toEqual(["public_sector_focused"]);

    const clear = await request(app).patch("/api/discovery/sources/oci").send({ tracks: [] });
    expect(clear.status).toBe(200);
    expect(clear.body.tracks).toEqual([]); // back to all-tracks
  });

  it("tolerantly drops a hand-edited unknown track on READ (write stays loud, read never breaks)", () => {
    const s = pure.normalizeSource({ id: "x", name: "X", tracks: ["public_sector_focused", "hand_typed_junk"] });
    expect(s.tracks).toEqual(["public_sector_focused"]);
  });
});

describe("nextRunAt derivation across all four cadences (Decision 2)", () => {
  const lastRunAt = "2026-07-01T00:00:00.000Z";
  const now = new Date("2026-07-01T12:00:00.000Z");
  const mk = (cadence) => ({
    active: "yes",
    cadence,
    lastRunAt,
    runs: [{ outcome: "succeeded", startedAt: lastRunAt }],
  });

  it("daily = lastRunAt + 1d", () => {
    expect(pure.deriveSourceStatus(mk("daily"), now).nextRunAt).toBe("2026-07-02T00:00:00.000Z");
  });
  it("weekly = lastRunAt + 7d", () => {
    expect(pure.deriveSourceStatus(mk("weekly"), now).nextRunAt).toBe("2026-07-08T00:00:00.000Z");
  });
  it("monthly = lastRunAt + 30d", () => {
    expect(pure.deriveSourceStatus(mk("monthly"), now).nextRunAt).toBe("2026-07-31T00:00:00.000Z");
  });
  it("manual = always null (never due)", () => {
    const d = pure.deriveSourceStatus(mk("manual"), now);
    expect(d.nextRunAt).toBe(null);
    expect(d.due).toBe(false);
  });
  it("monthly due/stale windows: overdue >=30d -> due, >=60d -> stale", () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const at = (n) => ({ active: "yes", cadence: "monthly", lastRunAt: daysAgo(n), runs: [{ outcome: "succeeded", startedAt: daysAgo(n) }] });
    expect(pure.deriveSourceStatus(at(10)).status).toBe("healthy");
    expect(pure.deriveSourceStatus(at(31)).status).toBe("due");
    expect(pure.deriveSourceStatus(at(61)).status).toBe("stale");
  });
});

describe("contractGaps: server-derived scrape-contract gap (Decision 3a)", () => {
  it("computeContractGaps (pure): default fields -> no gaps; alias match is case-insensitive", () => {
    expect(pure.computeContractGaps(["title", "employer", "location", "deadline", "salary", "link"])).toEqual([]);
    expect(pure.computeContractGaps(["Apply Link", "Closing Date"])).toEqual([]); // aliases, any case
    expect(pure.computeContractGaps(["title", "link"])).toEqual(["deadline"]);
    expect(pure.computeContractGaps(["title", "deadline"])).toEqual(["direct-link"]);
    expect(pure.computeContractGaps(["title", "employer"])).toEqual(["direct-link", "deadline"]);
    expect(pure.computeContractGaps([])).toEqual(["direct-link", "deadline"]);
  });

  it("GET serves contractGaps per source, derived from its declared outputFields", async () => {
    setSources([
      { id: "complete", name: "Complete", type: "board", sector: "private", active: "yes", cadence: "manual", outputFields: ["title", "deadline", "link"] },
      { id: "gappy", name: "Gappy", type: "board", sector: "private", active: "yes", cadence: "manual", outputFields: ["title", "employer"] },
    ]);
    const res = await request(app).get("/api/discovery/sources");
    const byId = Object.fromEntries(res.body.sources.map((s) => [s.id, s]));
    expect(byId.complete.contractGaps).toEqual([]);
    expect(byId.gappy.contractGaps).toEqual(["direct-link", "deadline"]);
  });

  it("a write responds with the re-derived contractGaps (edit outputFields -> gaps update)", async () => {
    setSources([{ id: "s1", name: "S1", type: "board", sector: "private", active: "yes", cadence: "manual", outputFields: ["title", "deadline", "link"] }]);
    const res = await request(app).patch("/api/discovery/sources/s1").send({ outputFields: ["title"] });
    expect(res.status).toBe(200);
    expect(res.body.contractGaps).toEqual(["direct-link", "deadline"]);
  });

  it("the committed seed's sources all satisfy the contract today (calm all-clear, not a bug)", async () => {
    restoreDocs();
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    expect(res.body.sources.every((s) => s.contractGaps.length === 0)).toBe(true);
  });
});

describe("buildSourceDiscoveryPrompt: scrape-contract enforcement wording (Decision 3)", () => {
  it("requires the direct posting URL + deadline and flags unresolvable ones for triage, never silent filing", () => {
    setSources([
      { id: "oci", name: "OCI", type: "board", sector: "bps", active: "yes", cadence: "weekly", urls: ["https://x.example/jobs"], instructions: "crawl it", outputFields: ["title", "deadline", "link"] },
    ]);
    const prompt = pure.buildSourceDiscoveryPrompt("oci");
    // direct link: the actual JD/apply page, never a search/listing page
    expect(prompt).toMatch(/direct posting page/i);
    expect(prompt).toMatch(/never a search-results page/i);
    // deadline required
    expect(prompt).toMatch(/Deadline MUST be set/i);
    // missing -> flagged for triage attention, not silently filed
    expect(prompt).toMatch(/flagged for triage attention/i);
    expect(prompt).toMatch(/Do NOT silently drop or skip/i);
    // still scoped + provenance-stamped like before (no regression)
    expect(prompt).toContain('Source id: "oci"');
    expect(prompt).toContain('source_id argument set to "oci"');
  });

  it("instructs the scout to SKIP an already-expired posting, not fetch/record it (t-1783422051088)", () => {
    setSources([
      { id: "ops", name: "OPS Careers", type: "board", sector: "provincial", active: "yes", cadence: "weekly", urls: ["https://x.example/jobs"], instructions: "crawl it" },
    ]);
    const prompt = pure.buildSourceDiscoveryPrompt("ops");
    expect(prompt).toMatch(/SKIP any posting whose application deadline has ALREADY PASSED/);
    expect(prompt).toMatch(/do NOT call discovery\.py add for it/i);
    // the skip is only for a VISIBLY-past deadline; an unknown one is still recorded
    expect(prompt).toMatch(/treat the posting as open and record it/i);
  });

  it("falls back to the plain global routine for a vanished source", () => {
    setSources([]);
    expect(pure.buildSourceDiscoveryPrompt("ghost")).toBe("run discover-jobs");
  });
});
