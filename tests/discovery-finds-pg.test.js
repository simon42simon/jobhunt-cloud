// SIM-547 - discovery finds on the pg backend, end to end over HTTP: the
// Railway/pg image ships NO python, so on a finds-capable store (PgStore) the
// whole finds lifecycle runs against the discovery_finds table instead of
// shelling discovery.py - read (GET /api/discovery), triage (POST
// /api/discovery/decide), pursue (POST /api/discovery/pursue -> tracked
// derivation), the apify write path (store.addFind with dedup), and the
// pre-run prune (POST /api/discovery/run-all-due). The suite boots the REAL
// app with STORE_BACKEND=pg over an ephemeral embedded Postgres and mocks
// node:child_process.execFile as a tripwire: any discovery.py execFile firing
// in pg mode is the exact "spawn python ENOENT" production 500 this ticket
// fixes, so the mock records every call and the suite asserts ZERO of them
// touch discovery.py. The FileStore/laptop path stays byte-identical and is
// pinned by the existing suites (discovery-get / discovery-apify /
// discover-prune / discovery-decide-clear).
//
// Skips cleanly when the embedded cluster cannot boot (elevated shell /
// offline) - EXCEPT under REQUIRE_EMBEDDED_PG=1, where provisioning failure
// throws (the guardian hard-fail; tests/helpers/embedded-pg.mjs).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCluster } from "./helpers/embedded-pg.mjs";

const SENTINEL_TOKEN = "apify_api_SENTINEL-DO-NOT-LEAK-547";

// ---- child_process tripwire: RECORD every execFile/spawn, then PASS THROUGH
// to the real implementation. Recording (not stubbing) on purpose: the embedded
// Postgres cluster itself may drive child_process through this same mocked
// registry, so a canned fake would break the cluster - while a passthrough
// keeps everything working and still lets the suite assert that NO recorded
// call ever touches discovery.py (the "spawn python ENOENT" production 500).
const execFileCalls = [];
const spawnCalls = [];
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execFile: (...a) => {
      execFileCalls.push(a);
      return actual.execFile(...a);
    },
    spawn: (...a) => {
      spawnCalls.push(a);
      return actual.spawn(...a);
    },
  };
});

process.env.JOBHUNT_TEST = "1";
const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  // eslint-disable-next-line no-console
  console.warn(`[discovery-finds-pg] PgStore leg SKIPPED: ${cluster.reason}`);
}

const pythonCalls = () =>
  execFileCalls.filter((args) => (Array.isArray(args[1]) ? args[1] : []).some((a) => String(a).includes("discovery.py")));

async function waitFor(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

suite("discovery finds on STORE_BACKEND=pg (SIM-547)", () => {
  let app, store, tmpRoot;

  const getDiscovery = () => request(app).get("/api/discovery");
  const findByTitle = async (title) => {
    const res = await getDiscovery();
    return (res.body.discoveries || []).find((f) => f.Title === title);
  };
  const getSource = async (id) => (await request(app).get(`/api/discovery/sources/${id}`)).body;
  const writeFixture = (items) => {
    const p = path.join(tmpRoot, `apify-fixture-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(items), "utf8");
    return p;
  };
  const setApifySource = () =>
    store.saveSources({
      version: 1,
      sources: [
        { id: "ap", name: "Indeed Apify", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "misceres~indeed-scraper", input: { position: "pm" }, runs: [] },
      ],
    });

  beforeAll(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-finds-pg-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.STORE_BACKEND = "pg";
    process.env.DATABASE_URL = cluster.url;
    // The finds must come from the TABLE: no fixture seam, no demo, no python.
    delete process.env.JOBHUNT_DISCOVERY_FINDS;
    delete process.env.APP_MODE;

    const mod = await import("../server/index.js");
    app = mod.app;
    store = mod.store;
  });

  afterAll(async () => {
    for (const k of ["STORE_BACKEND", "DATABASE_URL", "APIFY_TOKEN", "JOBHUNT_APIFY_ENABLED", "JOBHUNT_APIFY_FIXTURE"]) {
      delete process.env[k];
    }
    // Close the store's worker connection BEFORE stopping the cluster (the
    // demo-mode.test.js teardown rule).
    try {
      if (store) store.close();
    } catch {}
    if (cluster.available) await cluster.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    store.truncateAllForTests();
    execFileCalls.length = 0;
    spawnCalls.length = 0;
    for (const k of ["APIFY_TOKEN", "JOBHUNT_APIFY_ENABLED", "JOBHUNT_APIFY_FIXTURE"]) delete process.env[k];
  });

  it("GET /api/discovery serves discovery_finds rows in the workbook-dump shape - no python, no locked flag", async () => {
    expect(store.addFind({ date: "2026-07-20", title: "Operations Analyst", employer: "Acme", sector: "private", track: "t", fit: "strong", deadline: "rolling", location: "Toronto", source: "Board A", link: "https://x/1", notes: "n", sourceId: "src-a" })).toEqual({ added: true });
    const res = await getDiscovery();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("runLog"); // retired at the boundary (audit F1c)
    expect(res.body).not.toHaveProperty("locked"); // there is no workbook to lock
    expect(res.body.config).toEqual([]);
    expect(res.body.discoveries).toEqual([
      {
        "Date Found": "2026-07-20",
        Title: "Operations Analyst",
        Employer: "Acme",
        Sector: "private",
        Track: "t",
        Fit: "strong",
        Tailoring: "",
        Deadline: "rolling",
        Location: "Toronto",
        Source: "Board A",
        Link: "https://x/1",
        Decision: "",
        Notes: "n",
        tracked: false,
        sourceId: "src-a",
      },
    ]);
    expect(pythonCalls()).toHaveLength(0);
  });

  it("tracked is DERIVED against jobs (link key), never stored: pursuing a find flips it", async () => {
    store.addFind({ date: "2026-07-20", title: "Logistics Planner", employer: "Ironwood", sector: "private", link: "https://x/2", source: "Board A" });
    expect((await findByTitle("Logistics Planner")).tracked).toBe(false);
    const res = await request(app)
      .post("/api/discovery/pursue")
      .send({ title: "Logistics Planner", employer: "Ironwood", sector: "private", link: "https://x/2" });
    expect(res.status).toBe(201);
    expect((await findByTitle("Logistics Planner")).tracked).toBe(true);
    expect(pythonCalls()).toHaveLength(0);
  });

  it("POST /api/discovery/decide triages the row in the table: skip/maybe/pursue write, clear blanks, unknown 404s", async () => {
    store.addFind({ date: "2026-07-20", title: "Field Coordinator", employer: "Verdant", link: "https://x/3", source: "Board A" });
    for (const decision of ["skip", "maybe", "pursue"]) {
      const res = await request(app).post("/api/discovery/decide").send({ title: "Field Coordinator", link: "https://x/3", decision });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect((await findByTitle("Field Coordinator")).Decision).toBe(decision);
    }
    const cleared = await request(app).post("/api/discovery/decide").send({ title: "Field Coordinator", link: "https://x/3", decision: "clear" });
    expect(cleared.status).toBe(200);
    expect((await findByTitle("Field Coordinator")).Decision).toBe("");
    const missing = await request(app).post("/api/discovery/decide").send({ title: "No Such Row", link: "https://x/none", decision: "skip" });
    expect(missing.status).toBe(404);
    expect(pythonCalls()).toHaveLength(0);
  });

  it("addFind dedups like discovery.py add: same title+employer or link is a dup; a tracked job link is refused", async () => {
    expect(store.addFind({ date: "2026-07-20", title: "PM", employer: "Acme", link: "https://x/4" }).added).toBe(true);
    expect(store.addFind({ date: "2026-07-21", title: "pm", employer: "ACME", link: "https://x/other" })).toEqual({ added: false, reason: "dup" });
    expect(store.addFind({ date: "2026-07-21", title: "Different Role", employer: "Beta", link: "HTTPS://X/4" })).toEqual({ added: false, reason: "dup" });
    store.createJob({ role: "Existing Job", employer: "Gamma", status: "lead", link: "https://x/tracked" });
    expect(store.addFind({ date: "2026-07-21", title: "New Role", employer: "Delta", link: "https://x/tracked" })).toEqual({ added: false, reason: "tracked" });
  });

  it("apify run on pg writes mapped finds into discovery_finds (dedup counted), leadsNew from the table join - zero python", async () => {
    setApifySource();
    process.env.JOBHUNT_APIFY_ENABLED = "1";
    process.env.APIFY_TOKEN = SENTINEL_TOKEN;
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([
      { positionName: "Product Manager", company: "Acme", jobUrl: "https://a/1", location: "Toronto" },
      { positionName: "Senior PM", company: "Beta", jobUrl: "https://a/2", location: "Remote" },
    ]);
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(201);
    const done = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "succeeded");
    expect(done).toBe(true);
    const rec = (await getSource("ap")).runs[0];
    expect(rec.leadsNew).toBe(2); // baseline 0 -> 2 rows in the table
    expect(rec.candidatesReviewed).toBe(2);
    expect(rec.alreadyTracked).toBe(0);
    const disc = await getDiscovery();
    expect(disc.body.discoveries.map((f) => f.Title).sort()).toEqual(["Product Manager", "Senior PM"]);
    expect(disc.body.discoveries.every((f) => f.sourceId === "ap")).toBe(true); // provenance stamped

    // Re-run the same fixture: both finds are dups -> alreadyTracked, no new rows.
    const res2 = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res2.status).toBe(201);
    const done2 = await waitFor(async () => {
      const runs = (await getSource("ap")).runs;
      return runs.length === 2 && runs.every((r) => r.outcome === "succeeded");
    });
    expect(done2).toBe(true);
    const rec2 = (await getSource("ap")).runs.find((r) => r.runId !== rec.runId);
    expect(rec2.leadsNew).toBe(0);
    expect(rec2.alreadyTracked).toBe(2);
    expect((await getDiscovery()).body.discoveries).toHaveLength(2);
    expect(pythonCalls()).toHaveLength(0); // the whole flow never shells out
    // ... and never spawns a claude agent (deterministic server-side path).
    expect(spawnCalls.filter((a) => String(a[0]).toLowerCase().includes("claude"))).toHaveLength(0);
  });

  it("the pre-run prune deletes expired undecided untracked rows from the table (run-all-due path) - zero python", async () => {
    store.addFind({ date: "2026-01-02", title: "Dead Lead", employer: "Old Co", deadline: "2026-01-01", link: "https://x/dead" });
    store.addFind({ date: "2026-01-02", title: "Dead But Pursued", employer: "Kept Co", deadline: "2026-01-01", link: "https://x/kept" });
    store.decideFind({ title: "Dead But Pursued", link: "https://x/kept", decision: "pursue" });
    store.addFind({ date: "2026-01-02", title: "Rolling Lead", employer: "Open Co", deadline: "rolling", link: "https://x/rolling" });
    store.addFind({ date: "2026-01-02", title: "Dead But Tracked", employer: "Track Co", deadline: "2026-01-01", link: "https://x/tr" });
    store.createJob({ role: "Dead But Tracked", employer: "Track Co", status: "lead", link: "https://x/tr" });

    const res = await request(app).post("/api/discovery/run-all-due").send({});
    expect(res.status).toBe(200); // no due sources -> total 0, but the prune ran
    expect(res.body.total).toBe(0);
    const titles = (await getDiscovery()).body.discoveries.map((f) => f.Title).sort();
    expect(titles).toEqual(["Dead But Pursued", "Dead But Tracked", "Rolling Lead"]);
    expect(pythonCalls()).toHaveLength(0);
  });
});
