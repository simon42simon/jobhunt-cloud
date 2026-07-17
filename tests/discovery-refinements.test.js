import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// [DISC] University Affairs field-run refinements (t-1783200897663):
//   (a) RUN HONESTY COUNTERS - candidatesReviewed / alreadyTracked /
//       filteredOut on the SourceRun record, agent-reported via
//       POST /api/discovery/sources/:id/runs/:runId/report, and the derived
//       lastRunSignal ("leads" | "dedup" | "quiet" | "unverified" | null) so
//       the health pill can tell a healthy dedup-heavy run (leadsFound 0 but
//       candidates reviewed) from a broken scrape;
//   (b) GET /api/discovery/sources/:id - the single-source read (the registry
//       GET's derived per-source shape + proposeRunId + locked degrade);
//   (c) FETCH-MODE FLAG - closed enum fetchMode (direct-list | google-site |
//       alert-email) + free-text fetchNote on Source, loud 400 on a bad mode,
//       fed into the run prompt; the committed registry migrated from
//       instruction prose where unambiguous.
//
// Hermetic, same harness as instruction-proposals.test.js: throwaway docs/
// copy, the finds JSON seam, and a mocked child_process so no real agent ever
// spawns.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

function makeEmitterProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}
function makeFakeProc(exitCode = 0) {
  const proc = makeEmitterProc();
  setImmediate(() => proc.emit("close", exitCode));
  return proc;
}

const spawnMock = vi.fn(() => makeFakeProc(0));
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
function readSourcesFile() {
  return yaml.load(fs.readFileSync(SOURCES_YAML(), "utf8"));
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
  const g = await request(app).get(`/api/discovery/sources/${id}`);
  return g.status === 200 ? g.body : null;
};
const spawnedPrompt = (call = 0) => {
  const args = spawnMock.mock.calls[call][1];
  return args[args.indexOf("-p") + 1];
};

const UA = {
  id: "ua",
  name: "University Affairs",
  type: "board",
  sector: "bps",
  active: "yes",
  cadence: "weekly",
  urls: ["https://ua.example/search-jobs/"],
  instructions: "WebFetch the list directly.",
};

// Launch a scrape run for a source, holding its proc open; returns { runId, proc }.
async function launchHeldRun(id = "ua") {
  let proc;
  spawnMock.mockImplementationOnce(() => {
    proc = makeEmitterProc();
    return proc;
  });
  const res = await request(app).post(`/api/discovery/sources/${id}/run`).send({});
  expect(res.status).toBe(201);
  return { runId: res.body.runId, proc };
}
const runTerminal = async (id, runId) => {
  const s = await getSource(id);
  const rec = (s.runs || []).find((r) => r.runId === runId);
  return rec && rec.outcome !== "running";
};

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-disc-refine-"));
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
  setSources([UA]);
  setFinds([]);
  spawnMock.mockClear();
  spawnMock.mockImplementation(() => makeFakeProc(0));
  execFileMock.mockClear();
});

// ---------------------------------------------------------------------------
// (b) GET /api/discovery/sources/:id - the single-source read.
// ---------------------------------------------------------------------------
describe("GET /api/discovery/sources/:id", () => {
  it("404s on an unknown source", async () => {
    const res = await request(app).get("/api/discovery/sources/nope");
    expect(res.status).toBe(404);
  });

  it("serves ONE source in the registry GET's derived shape (status, counts, gaps, proposeRunId)", async () => {
    const res = await request(app).get("/api/discovery/sources/ua");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("ua");
    // The derived overlay, not just the stored fields:
    expect(res.body.status).toBe("never-run");
    expect(res.body.due).toBe(true);
    expect(res.body.jobCount).toBe(0);
    expect(Array.isArray(res.body.contractGaps)).toBe(true);
    expect(res.body.proposeRunId).toBeNull();
    expect(res.body.lastRunSignal).toBeNull();
    // Identical to the same source's element in the registry GET.
    const list = await request(app).get("/api/discovery/sources");
    expect(res.body).toEqual(list.body.sources.find((s) => s.id === "ua"));
  });

  it("stamps proposeRunId while a propose run is in flight (single-source poll target)", async () => {
    let proc;
    spawnMock.mockImplementationOnce(() => {
      proc = makeEmitterProc();
      return proc;
    });
    const launched = await request(app)
      .post("/api/discovery/sources/ua/instruction-proposals/propose")
      .send({ ownerComment: "x" });
    expect(launched.status).toBe(201);
    const during = await request(app).get("/api/discovery/sources/ua");
    expect(during.body.proposeRunId).toBe(launched.body.runId);
    proc.emit("close", 0);
    await waitFor(async () => (await getSource("ua")).proposeRunId === null);
  });
});

// ---------------------------------------------------------------------------
// (a) Run honesty counters - the report endpoint.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources/:id/runs/:runId/report", () => {
  it("404s on an unknown source and an unknown runId", async () => {
    expect(
      (await request(app).post("/api/discovery/sources/nope/runs/r1/report").send({ candidatesReviewed: 1 })).status
    ).toBe(404);
    expect(
      (await request(app).post("/api/discovery/sources/ua/runs/r-missing/report").send({ candidatesReviewed: 1 }))
        .status
    ).toBe(404);
  });

  it("400s loudly on bad counters (negative / non-number / none present)", async () => {
    const { runId, proc } = await launchHeldRun();
    for (const bad of [
      { candidatesReviewed: -1 },
      { alreadyTracked: "five" },
      { filteredOut: true },
      {},
      { unrelated: 3 },
    ]) {
      const res = await request(app).post(`/api/discovery/sources/ua/runs/${runId}/report`).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // Nothing landed on the record.
    const s = await getSource("ua");
    expect(s.runs[0].candidatesReviewed).toBeNull();
    proc.emit("close", 0);
    await waitFor(() => runTerminal("ua", runId));
  });

  it("records the counters on the run, persists them, and the close path preserves them", async () => {
    const { runId, proc } = await launchHeldRun();
    const res = await request(app)
      .post(`/api/discovery/sources/ua/runs/${runId}/report`)
      .send({ candidatesReviewed: 8.9, alreadyTracked: 5, filteredOut: 3 });
    expect(res.status).toBe(200);
    expect(res.body.run.candidatesReviewed).toBe(8); // floored to an integer
    expect(res.body.run.alreadyTracked).toBe(5);
    expect(res.body.run.filteredOut).toBe(3);

    // Persisted on disk (round-trips serializeRun/normalizeRun).
    const onDisk = readSourcesFile().sources.find((s) => s.id === "ua");
    expect(onDisk.runs[0].candidatesReviewed).toBe(8);

    // The UA field-run shape: run closes with 0 leads joined - the counters
    // survive finalizeSourceRun's read-modify-write.
    proc.emit("close", 0);
    await waitFor(() => runTerminal("ua", runId));
    const s = await getSource("ua");
    const rec = s.runs.find((r) => r.runId === runId);
    expect(rec.outcome).toBe("succeeded");
    expect(rec.leadsFound).toBe(0);
    expect(rec.candidatesReviewed).toBe(8);
    expect(rec.alreadyTracked).toBe(5);
    expect(rec.filteredOut).toBe(3);
    // ...and the pill-facing derivation reads it as healthy dedup, not broken.
    expect(s.lastRunSignal).toBe("dedup");
  });

  it("a run with NO report stays 'unverified' at 0 leads (the honest cannot-tell state)", async () => {
    const { runId, proc } = await launchHeldRun();
    proc.emit("close", 0);
    await waitFor(() => runTerminal("ua", runId));
    const s = await getSource("ua");
    expect(s.runs[0].candidatesReviewed).toBeNull();
    expect(s.lastRunSignal).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// (a) deriveLastRunSignal - the pure classification.
// ---------------------------------------------------------------------------
describe("deriveLastRunSignal (pure)", () => {
  const run = (over = {}) => ({
    startedAt: "2026-07-04T10:00:00.000Z",
    outcome: "succeeded",
    trigger: "manual",
    ...over,
  });

  it("null with no runs, while running, or when the newest terminal run failed", () => {
    expect(pure.deriveLastRunSignal([])).toBeNull();
    expect(pure.deriveLastRunSignal(undefined)).toBeNull();
    expect(pure.deriveLastRunSignal([run({ outcome: "running" })])).toBeNull();
    expect(pure.deriveLastRunSignal([run({ outcome: "failed", leadsNew: 0 })])).toBeNull();
  });

  it("'leads' when the run landed new leads", () => {
    expect(pure.deriveLastRunSignal([run({ leadsFound: 5, leadsNew: 2 })])).toBe("leads");
  });

  it("'dedup' at zero new WITH candidates reviewed; 'quiet' at a reported zero; 'unverified' unreported", () => {
    expect(pure.deriveLastRunSignal([run({ leadsFound: 0, leadsNew: 0, candidatesReviewed: 8 })])).toBe("dedup");
    expect(pure.deriveLastRunSignal([run({ leadsFound: 0, leadsNew: 0, candidatesReviewed: 0 })])).toBe("quiet");
    expect(pure.deriveLastRunSignal([run({ leadsFound: 0, leadsNew: 0 })])).toBe("unverified");
  });

  it("classifies the NEWEST terminal run, not an older one", () => {
    const older = run({ startedAt: "2026-07-01T00:00:00.000Z", leadsNew: 4 });
    const newest = run({ startedAt: "2026-07-04T00:00:00.000Z", leadsNew: 0, candidatesReviewed: 6 });
    expect(pure.deriveLastRunSignal([older, newest])).toBe("dedup");
    expect(pure.deriveLastRunSignal([newest, older])).toBe("dedup"); // order-insensitive
  });

  it("falls back to the scout's own report when the close path could not count leads", () => {
    expect(pure.deriveLastRunSignal([run({ candidatesReviewed: 3 })])).toBe("dedup");
    expect(pure.deriveLastRunSignal([run({})])).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// (a) The run prompt tells the scout to report against ITS OWN runId.
// ---------------------------------------------------------------------------
describe("run prompt carries the honesty-counter report instruction", () => {
  it("includes the report endpoint with the launched run's id and all three counter names", async () => {
    const { runId, proc } = await launchHeldRun();
    const prompt = spawnedPrompt();
    expect(prompt).toContain(`/api/discovery/sources/ua/runs/${runId}/report`);
    expect(prompt).toContain("candidatesReviewed");
    expect(prompt).toContain("alreadyTracked");
    expect(prompt).toContain("filteredOut");
    expect(prompt.toLowerCase()).toContain("best-effort");
    proc.emit("close", 0);
    await waitFor(() => runTerminal("ua", runId));
  });
});

// ---------------------------------------------------------------------------
// (c) fetchMode / fetchNote - closed enum at the write boundary.
// ---------------------------------------------------------------------------
describe("Source fetchMode + fetchNote", () => {
  it("creates with a valid mode + note, serves and persists them", async () => {
    const res = await request(app).post("/api/discovery/sources").send({
      name: "Walled Board",
      fetchMode: "google-site",
      fetchNote: "listing is JS-only; site: queries reach detail pages",
    });
    expect(res.status).toBe(201);
    expect(res.body.fetchMode).toBe("google-site");
    expect(res.body.fetchNote).toBe("listing is JS-only; site: queries reach detail pages");
    const onDisk = readSourcesFile().sources.find((s) => s.id === "walled-board");
    expect(onDisk.fetchMode).toBe("google-site");
    expect(onDisk.fetchNote).toContain("JS-only");
  });

  it("defaults to null / '' when absent (an unclassified source stays unclassified)", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "Plain Board" });
    expect(res.status).toBe(201);
    expect(res.body.fetchMode).toBeNull();
    expect(res.body.fetchNote).toBe("");
    // ...and the file stays byte-clean (strip-empties, like notes/lastRunAt).
    const onDisk = readSourcesFile().sources.find((s) => s.id === "plain-board");
    expect("fetchMode" in onDisk).toBe(false);
    expect("fetchNote" in onDisk).toBe(false);
  });

  it("400s loudly on an invalid mode (create and patch), changing nothing", async () => {
    const created = await request(app).post("/api/discovery/sources").send({ name: "Bad Mode", fetchMode: "rss" });
    expect(created.status).toBe(400);
    const patched = await request(app).patch("/api/discovery/sources/ua").send({ fetchMode: "scrape-harder" });
    expect(patched.status).toBe(400);
    expect((await getSource("ua")).fetchMode).toBeNull();
  });

  it("PATCH sets a mode; PATCH null clears it back to unclassified", async () => {
    const set = await request(app).patch("/api/discovery/sources/ua").send({ fetchMode: "direct-list" });
    expect(set.status).toBe(200);
    expect(set.body.fetchMode).toBe("direct-list");
    const cleared = await request(app).patch("/api/discovery/sources/ua").send({ fetchMode: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.fetchMode).toBeNull();
  });

  it("tolerant read: a hand-edited bogus mode degrades to null, never crashes", async () => {
    setSources([{ ...UA, fetchMode: "banana", fetchNote: 42 }]);
    const s = await getSource("ua");
    expect(s.fetchMode).toBeNull();
    expect(s.fetchNote).toBe("");
  });

  it("feeds the run prompt: mode line + note when set, neither when unclassified", async () => {
    setSources([{ ...UA, fetchMode: "direct-list", fetchNote: "query params are cosmetic - filter client-side" }]);
    let prompt = pure.buildSourceDiscoveryPrompt("ua", { runId: "r1_1" });
    expect(prompt).toContain("Fetch mode: direct-list");
    expect(prompt).toContain("query params are cosmetic - filter client-side");

    setSources([UA]); // unclassified
    prompt = pure.buildSourceDiscoveryPrompt("ua", { runId: "r1_1" });
    expect(prompt).not.toContain("Fetch mode:");
    expect(prompt).not.toContain("Fetch note");
  });

  // Clean-repo hermeticity (I9): the curated registry is deliberately absent from
  // the public extraction - skip the committed-content guard there, never fail.
  const committedRegistry = fs.existsSync(path.join(REPO_DOCS, "discovery-sources.yaml"));
  it.skipIf(!committedRegistry)("MIGRATION GUARD: the committed registry's fetchMode values are all valid, and University Affairs carries the field-run's mode + note", () => {
    const committed = yaml.load(fs.readFileSync(path.join(REPO_DOCS, "discovery-sources.yaml"), "utf8"));
    const withMode = committed.sources.filter((s) => s.fetchMode !== undefined);
    expect(withMode.length).toBeGreaterThanOrEqual(30); // the unambiguous majority migrated
    for (const s of withMode) {
      expect(pure.SOURCE_FETCH_MODES, `source ${s.id}`).toContain(s.fetchMode);
    }
    const ua = committed.sources.find((s) => s.id === "university-affairs-universities-canada");
    expect(ua.fetchMode).toBe("direct-list");
    expect(ua.fetchNote).toMatch(/cosmetic/i);
    expect(ua.fetchNote).toMatch(/client-side/i);
  });
});
