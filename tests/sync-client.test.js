// SIM-393 I2 - the laptop-side sync client (ops/sync-data.mjs) against the REAL
// I1 ingest surface: the app boots in test mode with SYNC_TOKEN_HASH set and
// LISTENS on a loopback port (through a request recorder), and the client runs
// against it over real HTTP with a temp fixture "vault" - never the real vault.
//
// Proves the I2 DoD matrix on BOTH store backends (surface behavior could differ
// at the store seam): full first sync; idempotent re-run (ZERO pushes); additive
// new-file sync; conflict skip + loud report (cloud copy untouched); owner
// resolution via --resolve import-as-copy (dated sibling, no overwrite); hostile
// filename rejected CLIENT-SIDE (shared name-safety - the server never sees it);
// and the GC-6 client posture: http:// refusal, redirect refusal, TLS-bypass
// refusal, lockfile yield, and read-only-on-the-vault (fixture byte/mtime
// snapshot unchanged after every run).
//
// The PG half self-provisions an ephemeral embedded Postgres and skips cleanly
// when it cannot start - EXCEPT under REQUIRE_EMBEDDED_PG=1 (guardian D4), where
// a provisioning failure hard-fails instead of going vacuously green.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { hashToken } from "../server/runner-lib.js";
import { sha256Hex } from "../server/sync-lib.js";
import { localDateStamp } from "../server/store-helpers.js";
import { startCluster } from "./helpers/embedded-pg.mjs";
import {
  runSync,
  resolveOptions,
  parseResolve,
  datedCopyName,
  assertSyncUrl,
  EXIT_CLEAN,
  EXIT_ERRORS,
  EXIT_CONFLICTS,
} from "../ops/sync-data.mjs";
import { readJobsDomain, VaultReadError } from "../ops/vault-read.mjs";

const SYNC_TOKEN = "sync-client-test-token-0123456789";
const JOB_A = "Data Analyst - Acme Co";
const JOB_B = "Ops Lead - Beta Ltd";
const CV = "CV - Data Analyst.pdf";

// ---- fixture vault (temp dir; the REAL vault is never touched) ---------------
const jobMd = (role, employer, status = "lead") =>
  ["---", "type: job", `role: ${role}`, `employer: ${employer}`, `status: ${status}`, "tags: [job]", 'deadline: "2026-08-01"', "---", "", `# ${role}`, ""].join("\n");

function makeVault(root) {
  const jobsDir = path.join(root, "Jobs");
  const a = path.join(jobsDir, JOB_A);
  const b = path.join(jobsDir, JOB_B);
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, "Data Analyst.md"), jobMd("Data Analyst", "Acme Co"));
  fs.writeFileSync(path.join(a, CV), Buffer.from("%PDF-1.4 the tailored analyst cv"));
  fs.writeFileSync(path.join(a, "notes.md"), "meeting notes\n");
  fs.writeFileSync(path.join(b, "Ops Lead.md"), jobMd("Ops Lead", "Beta Ltd", "queued"));
  fs.writeFileSync(path.join(b, "Cover - Ops Lead.docx"), Buffer.from("PK docx cover bytes"));
  return jobsDir;
}

// Recursive (name -> {mtimeMs,size,sha}) snapshot to PROVE the vault is untouched.
function vaultSnapshot(dir) {
  const out = {};
  for (const folder of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, folder))) {
      const p = path.join(dir, folder, f);
      const st = fs.statSync(p);
      out[`${folder}/${f}`] = { mtimeMs: st.mtimeMs, size: st.size, sha: sha256Hex(fs.readFileSync(p)) };
    }
  }
  return out;
}

// Boot the real app behind a request recorder listening on 127.0.0.1.
async function listenWithRecorder(app) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${decodeURIComponent(req.url)}`);
    app(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, calls };
}

const clientEnv = () => ({ SYNC_TOKEN, SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK: "1" });
const quiet = () => {};

// =============================================================================
// pure helpers (no server needed)
// =============================================================================
describe("sync client pure helpers", () => {
  it("dry-run is the DEFAULT; --push opts into writing", () => {
    const env = { SYNC_JOBS_DIR: "C:/tmp/jobs", SYNC_CLOUD_URL: "https://x.example" };
    expect(resolveOptions([], env).push).toBe(false);
    expect(resolveOptions(["--push"], env).push).toBe(true);
    expect(resolveOptions(["--dry-run"], env).push).toBe(false);
  });

  it("parseResolve accepts ONLY import-as-copy (no overwrite mode exists)", () => {
    expect(parseResolve(`${JOB_A}/${CV}=import-as-copy`)).toEqual({ jobId: JOB_A, name: CV });
    expect(() => parseResolve(`${JOB_A}/${CV}=overwrite`)).toThrow(/import-as-copy/);
    expect(() => parseResolve("garbage")).toThrow();
  });

  it("datedCopyName follows the app's dated-copy convention and bumps on collision", () => {
    const stamp = "2026-07-17";
    expect(datedCopyName("CV - X.pdf", new Set(), stamp)).toBe("CV - X (2026-07-17).pdf");
    expect(datedCopyName("CV - X.pdf", new Set(["CV - X (2026-07-17).pdf"]), stamp)).toBe("CV - X (2026-07-17) (2).pdf");
  });

  it("GC-6: refuses http:// URLs outright without the loopback test seam", () => {
    expect(() => assertSyncUrl("http://127.0.0.1:9999/", { env: {} })).toThrow(/https/);
    expect(() => assertSyncUrl("http://example.com/", { env: {} })).toThrow(/https/);
  });

  it("GC-6: the test seam allows LOOPBACK http only - a public http URL is still refused", () => {
    const env = { SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK: "1" };
    expect(assertSyncUrl("http://127.0.0.1:9999/", { env }).hostname).toBe("127.0.0.1");
    expect(() => assertSyncUrl("http://example.com/", { env })).toThrow(/https/);
  });

  it("GC-6: https host pinning is enforced through the seam path too", () => {
    const env = { SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK: "1" };
    expect(() => assertSyncUrl("https://evil.example/", { env, requireHost: "good.example" })).toThrow(/pinned/);
  });

  it("the strict vault reader ABORTS on a non-folder entry under Jobs/ (migrate-data posture)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-vaultread-"));
    const jobsDir = makeVault(root);
    fs.writeFileSync(path.join(jobsDir, "stray.txt"), "x");
    expect(() => readJobsDomain(jobsDir)).toThrow(VaultReadError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lazyBytes defers companion bytes but still stats them (hydration-cache seam)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-vaultlazy-"));
    const jobsDir = makeVault(root);
    const jobs = readJobsDomain(jobsDir, [], { lazyBytes: true });
    const cv = jobs.find((j) => j.id === JOB_A).files.find((f) => f.name === CV);
    expect(cv.bytes).toBeNull();
    expect(cv.size).toBeGreaterThan(0);
    expect(sha256Hex(cv.read())).toBe(sha256Hex(fs.readFileSync(path.join(jobsDir, JOB_A, CV))));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// =============================================================================
// Block A: FileStore backend - the full client matrix over real HTTP
// =============================================================================
describe("sync client against the real I1 surface (FileStore)", () => {
  let tmpRoot, vaultJobs, stateDir, dataDir;
  let server, cloudUrl, calls;
  let baselineSnapshot;

  const opts = (extra = {}) => ({
    jobsDir: vaultJobs,
    cloudUrl,
    stateDir,
    push: true,
    resolves: [],
    ...extra,
  });
  const run = (o = {}, env = clientEnv()) => runSync(opts(o), { env, log: quiet });
  const since = () => calls.length;
  const callsSince = (mark) => calls.slice(mark);
  const cloudManifest = async () => {
    const r = await fetch(`${cloudUrl}/api/sync/manifest`, { headers: { authorization: `Bearer ${SYNC_TOKEN}` } });
    expect(r.status).toBe(200);
    return r.json();
  };
  const readActivity = () => {
    try {
      return fs
        .readFileSync(path.join(dataDir, "activity-log.jsonl"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-client-file-"));
    vaultJobs = makeVault(path.join(tmpRoot, "vault"));
    stateDir = path.join(tmpRoot, "state");
    // the CLOUD side is a separate FileStore rooted elsewhere in the temp tree
    const cloudJobs = path.join(tmpRoot, "cloud", "Jobs");
    const docsDir = path.join(tmpRoot, "cloud", "docs");
    dataDir = path.join(tmpRoot, "cloud", "data");
    for (const d of [cloudJobs, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = cloudJobs;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = dataDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    vi.resetModules();
    const { app } = await import("../server/index.js");
    ({ server, url: cloudUrl, calls } = await listenWithRecorder(app));
    baselineSnapshot = vaultSnapshot(vaultJobs);
  });

  afterAll(async () => {
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.JOBHUNT_DATA_DIR;
    if (server) await new Promise((r) => server.close(r));
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("DRY-RUN (the default): one manifest GET, a correct plan, ZERO cloud writes", async () => {
    const mark = since();
    const r = await run({ push: false });
    expect(r.dryRun).toBe(true);
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.plan.newJobs.sort()).toEqual([JOB_A, JOB_B].sort());
    expect(r.plan.newFiles).toHaveLength(3);
    expect(callsSince(mark)).toEqual(["GET /api/sync/manifest"]);
    expect((await cloudManifest()).jobs).toHaveLength(0); // nothing landed
  });

  it("FULL FIRST SYNC (--push): both jobs + all companion files land; containment verified", async () => {
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.inserted).toEqual({ jobs: 2, files: 3 });
    expect(r.conflicts).toEqual([]);
    expect(r.errors).toEqual([]);
    const m = await cloudManifest();
    expect(m.jobs.map((j) => j.id).sort()).toEqual([JOB_A, JOB_B].sort());
    expect(m.files).toHaveLength(3);
    const cv = m.files.find((f) => f.name === CV);
    expect(cv.sha256).toBe(sha256Hex(fs.readFileSync(path.join(vaultJobs, JOB_A, CV))));
    // the run summary landed in the app's activity feed (loud, owner-visible)
    const runs = readActivity().filter((x) => x.kind === "sync" && x.event === "sync-run");
    expect(runs).toHaveLength(1);
    expect(runs[0].inserted).toEqual({ jobs: 2, files: 3 });
  });

  it("IDEMPOTENT RE-RUN: zero pushes (no POST /api/sync/jobs, no file PUT), all no-ops", async () => {
    const mark = since();
    const logLines = [];
    const r = await runSync(opts(), { env: clientEnv(), log: (m) => logLines.push(m) });
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.inserted).toEqual({ jobs: 0, files: 0 });
    expect(r.noops).toBe(3);
    const writes = callsSince(mark).filter((c) => c.startsWith("POST /api/sync/jobs") || c.startsWith("PUT "));
    expect(writes).toEqual([]); // manifest GETs + the run-summary POST only
    // the hash cache did its job: nothing re-hashed on an unchanged vault
    expect(logLines.some((l) => l.includes("(0 hashed fresh"))).toBe(true);
  });

  it("ADDITIVE NEW-FILE SYNC: exactly one PUT for the one new vault file", async () => {
    fs.writeFileSync(path.join(vaultJobs, JOB_A, "Interview Prep.md"), "# prep\n");
    const mark = since();
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.inserted).toEqual({ jobs: 0, files: 1 });
    const puts = callsSince(mark).filter((c) => c.startsWith("PUT "));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain("Interview Prep.md");
    baselineSnapshot = vaultSnapshot(vaultJobs); // fixture legitimately grew
  });

  it("CONFLICT (same path, different bytes): SKIPPED client-side, cloud copy untouched, loudly reported", async () => {
    const originalSha = sha256Hex(fs.readFileSync(path.join(vaultJobs, JOB_A, CV)));
    fs.writeFileSync(path.join(vaultJobs, JOB_A, CV), Buffer.from("%PDF-1.4 REWRITTEN locally"));
    const mark = since();
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CONFLICTS); // exit code distinguishes conflicts
    expect(r.errors).toEqual([]);
    const c = r.conflicts.find((x) => x.reason === "bytes-differ");
    expect(c).toMatchObject({ jobId: JOB_A, name: CV, cloudSha: originalSha });
    expect(c.vaultSha).not.toBe(originalSha);
    expect(c.vaultMtimeIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // the client never even attempted the overwrite - no PUT for that name
    expect(callsSince(mark).filter((x) => x.startsWith("PUT ") && x.includes(CV))).toEqual([]);
    // cloud copy untouched
    expect((await cloudManifest()).files.find((f) => f.name === CV).sha256).toBe(originalSha);
    // and the conflict is in the posted run summary (owner-visible in-app)
    const runs = readActivity().filter((x) => x.kind === "sync" && x.event === "sync-run");
    const last = runs[runs.length - 1];
    expect(last.conflicts.some((x) => x.reason === "bytes-differ" && x.name === CV)).toBe(true);
    baselineSnapshot = vaultSnapshot(vaultJobs);
  });

  it("FRONTMATTER DRIFT on an existing job: reported, never applied (cloud-owned rows)", async () => {
    const before = (await cloudManifest()).jobs.find((j) => j.id === JOB_B).rowSha;
    fs.writeFileSync(path.join(vaultJobs, JOB_B, "Ops Lead.md"), jobMd("Ops Lead", "Beta Ltd", "interview"));
    const mark = since();
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CONFLICTS);
    expect(r.conflicts.some((c) => c.reason === "frontmatter-drift" && c.jobId === JOB_B)).toBe(true);
    expect(callsSince(mark).filter((x) => x.startsWith("POST /api/sync/jobs"))).toEqual([]); // no row push
    expect((await cloudManifest()).jobs.find((j) => j.id === JOB_B).rowSha).toBe(before); // unchanged
    baselineSnapshot = vaultSnapshot(vaultJobs);
  });

  it("--resolve import-as-copy: vault bytes land as a DATED SIBLING; original never overwritten", async () => {
    const originalSha = (await cloudManifest()).files.find((f) => f.name === CV).sha256;
    const vaultSha = sha256Hex(fs.readFileSync(path.join(vaultJobs, JOB_A, CV)));
    const r = await run({ resolves: [parseResolve(`${JOB_A}/${CV}=import-as-copy`)] });
    expect(r.resolved).toHaveLength(1);
    const as = r.resolved[0].as;
    expect(as).toBe(`CV - Data Analyst (${localDateStamp()}).pdf`);
    const m = await cloudManifest();
    expect(m.files.find((f) => f.name === CV).sha256).toBe(originalSha); // untouched
    expect(m.files.find((f) => f.name === as).sha256).toBe(vaultSha); // both byte-sets live
    expect(r.conflicts.some((c) => c.name === CV)).toBe(false); // resolved, not re-raised
  });

  it("RE-RUN AFTER RESOLUTION: the pair counts as resolved (no repeated conflict, no re-upload)", async () => {
    const mark = since();
    const r = await run();
    expect(r.conflicts.some((c) => c.reason === "bytes-differ" && c.name === CV)).toBe(false);
    expect(r.exitCode).toBe(EXIT_CONFLICTS); // the JOB_B frontmatter drift is still (correctly) loud
    expect(callsSince(mark).filter((x) => x.startsWith("PUT ") && x.includes("CV - Data Analyst"))).toEqual([]);
  });

  it("HOSTILE FILENAME rejected CLIENT-SIDE: the server never sees it (shared name-safety)", async () => {
    fs.writeFileSync(path.join(vaultJobs, JOB_A, "CV..evil.md"), "poisoned\n");
    const mark = since();
    const r = await run();
    expect(r.conflicts.some((c) => c.reason === "unsafe-name" && c.name === "CV..evil.md")).toBe(true);
    expect(r.exitCode).toBe(EXIT_CONFLICTS);
    expect(callsSince(mark).some((x) => x.includes("evil"))).toBe(false); // zero requests carry the name
    fs.rmSync(path.join(vaultJobs, JOB_A, "CV..evil.md"));
    baselineSnapshot = vaultSnapshot(vaultJobs);
  });

  it("GC-6 http refusal: without the loopback test seam the run refuses before ANY request", async () => {
    const mark = since();
    await expect(run({}, { SYNC_TOKEN })).rejects.toThrow(/https/);
    expect(callsSince(mark)).toEqual([]);
  });

  it("GC-6 TLS-bypass refusal: NODE_TLS_REJECT_UNAUTHORIZED=0 refuses to run", async () => {
    const mark = since();
    await expect(run({}, { ...clientEnv(), NODE_TLS_REJECT_UNAUTHORIZED: "0" })).rejects.toThrow(/TLS/);
    expect(callsSince(mark)).toEqual([]);
  });

  it("GC-6 redirect refusal: a redirecting endpoint aborts the run, nothing is pushed", async () => {
    const redirector = http.createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${cloudUrl}${req.url}`);
      res.end();
    });
    await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
    const mark = since();
    try {
      await expect(
        runSync(opts({ cloudUrl: `http://127.0.0.1:${redirector.address().port}` }), { env: clientEnv(), log: quiet }),
      ).rejects.toThrow();
      expect(callsSince(mark)).toEqual([]); // the redirect target never got the follow-up
    } finally {
      await new Promise((r) => redirector.close(r));
    }
  });

  it("missing SYNC_TOKEN refuses to run (env-only; the script reads no secrets file)", async () => {
    await expect(run({}, { SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK: "1" })).rejects.toThrow(/SYNC_TOKEN/);
  });

  it("LOCKFILE: a second concurrent instance yields cleanly (exit 0, zero requests)", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "jobhunt-sync.lock"), JSON.stringify({ pid: process.pid, startedAt: "2026-07-17T00:00:00Z" }));
    const mark = since();
    const r = await run();
    expect(r).toEqual({ exitCode: EXIT_CLEAN, alreadyRunning: true });
    expect(callsSince(mark)).toEqual([]);
    fs.rmSync(path.join(stateDir, "jobhunt-sync.lock"));
  });

  it("READ-ONLY ON THE VAULT by construction: every fixture byte + mtime is exactly as last written", () => {
    expect(vaultSnapshot(vaultJobs)).toEqual(baselineSnapshot);
    // ... and the client's own writes all live in the state dir, outside the vault
    const state = fs.readdirSync(stateDir);
    expect(state).toContain("jobhunt-sync-cache.json");
    expect(state).toContain("jobhunt-sync.log");
    expect(state).not.toContain("jobhunt-sync.lock"); // released
  });
});

// =============================================================================
// Block B: PgStore backend - same client, the surface where store behavior could
// differ (job_files.sha256 column, on-conflict-do-nothing SQL, 404 path).
// =============================================================================
const cluster = await startCluster();
const pgSuite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  console.warn(`[sync-client] PgStore leg SKIPPED: ${cluster.reason}`);
}

pgSuite("sync client against the real I1 surface (PgStore)", () => {
  let tmpRoot, vaultJobs, stateDir;
  let server, cloudUrl, calls, store;

  const opts = (extra = {}) => ({ jobsDir: vaultJobs, cloudUrl, stateDir, push: true, resolves: [], ...extra });
  const run = (o = {}) => runSync(opts(o), { env: clientEnv(), log: quiet });
  const cloudManifest = async () => {
    const r = await fetch(`${cloudUrl}/api/sync/manifest`, { headers: { authorization: `Bearer ${SYNC_TOKEN}` } });
    expect(r.status).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-client-pg-"));
    vaultJobs = makeVault(path.join(tmpRoot, "vault"));
    stateDir = path.join(tmpRoot, "state");
    const docsDir = path.join(tmpRoot, "docs");
    const blobDir = path.join(tmpRoot, "blob");
    for (const d of [docsDir, blobDir, path.join(tmpRoot, "Jobs")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = path.join(tmpRoot, "Jobs");
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_BLOB_DIR = blobDir;
    process.env.STORE_BACKEND = "pg";
    process.env.DATABASE_URL = cluster.url;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    vi.resetModules();
    const mod = await import("../server/index.js");
    store = mod.store;
    ({ server, url: cloudUrl, calls } = await listenWithRecorder(mod.app));
  });

  afterAll(async () => {
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.STORE_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.JOBHUNT_BLOB_DIR;
    if (server) await new Promise((r) => server.close(r));
    try {
      if (store && typeof store.close === "function") store.close();
    } catch {}
    await cluster.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("full first sync lands both jobs + files in Postgres, containment verified", async () => {
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.inserted).toEqual({ jobs: 2, files: 3 });
    expect(r.errors).toEqual([]);
    const m = await cloudManifest();
    expect(m.jobs.map((j) => j.id).sort()).toEqual([JOB_A, JOB_B].sort());
    expect(m.files).toHaveLength(3);
  });

  it("idempotent re-run: zero pushes against the PG surface", async () => {
    const mark = calls.length;
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.inserted).toEqual({ jobs: 0, files: 0 });
    expect(r.noops).toBe(3);
    expect(calls.slice(mark).filter((c) => c.startsWith("POST /api/sync/jobs") || c.startsWith("PUT "))).toEqual([]);
  });

  it("bytes-differ conflict: PG copy untouched, loud report, exit code 2", async () => {
    const originalSha = (await cloudManifest()).files.find((f) => f.name === CV).sha256;
    fs.writeFileSync(path.join(vaultJobs, JOB_A, CV), Buffer.from("%PDF-1.4 locally reworked"));
    const r = await run();
    expect(r.exitCode).toBe(EXIT_CONFLICTS);
    expect(r.conflicts.some((c) => c.reason === "bytes-differ" && c.name === CV && c.cloudSha === originalSha)).toBe(true);
    expect((await cloudManifest()).files.find((f) => f.name === CV).sha256).toBe(originalSha);
    // loud in-app: the run summary line reached the PG activity log
    const activity = store
      .readActivityText()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const last = activity.filter((x) => x.kind === "sync" && x.event === "sync-run").pop();
    expect(last.conflicts.some((x) => x.reason === "bytes-differ" && x.name === CV)).toBe(true);
  });

  it("--resolve import-as-copy lands the dated sibling in PG; both byte-sets live", async () => {
    const vaultSha = sha256Hex(fs.readFileSync(path.join(vaultJobs, JOB_A, CV)));
    const r = await run({ resolves: [parseResolve(`${JOB_A}/${CV}=import-as-copy`)] });
    expect(r.resolved).toHaveLength(1);
    const m = await cloudManifest();
    expect(m.files.find((f) => f.name === r.resolved[0].as).sha256).toBe(vaultSha);
    expect(m.files.find((f) => f.name === CV).sha256).not.toBe(vaultSha);
    // and a follow-up run reports the pair as settled
    const r2 = await run();
    expect(r2.conflicts.some((c) => c.name === CV)).toBe(false);
    expect(r2.exitCode).toBe(EXIT_CLEAN);
  });
});
