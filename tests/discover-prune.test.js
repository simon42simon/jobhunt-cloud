import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// Server-side wiring for the discovery prune (ADR-008). The prune's trigger
// point moved with registry unification (t-1783183576537): the global
// discover-jobs sweep is RETIRED, and a "sweep" is now POST
// /api/discovery/run-all-due (a fan-out of per-source runs). That endpoint
// runs `discovery.py prune` FIRST (archiving dead rows) and only then launches
// the due-source agents. Prune stays best-effort - a workbook locked in Excel
// must NOT block the runs. This suite proves that wiring WITHOUT ever running
// real python or real claude: node:child_process's spawn (the agents) AND
// execFile (the prune) are both mocked before importing the server, and finds
// reads go through the JOBHUNT_DISCOVERY_FINDS seam so execFile carries ONLY
// the prune. execFileSync (resolvePython, at import) is left real and
// harmless - it only probes `--version`.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", 0));
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc());

// Swappable execFile behavior so a test can make the prune succeed or report a
// locked workbook. The callback is the 3rd or 4th arg (options are optional).
let execFileImpl;
const execFileMock = vi.fn((...args) => execFileImpl(...args));
function invokeCb(args, err, stdout, stderr) {
  const cb = typeof args[2] === "function" ? args[2] : args[3];
  setImmediate(() => cb(err, stdout, stderr));
  return new EventEmitter();
}
const pruneSucceeds = (...args) => invokeCb(args, null, "PRUNED 1 rows\n", "");
const pruneLocked = (...args) =>
  invokeCb(args, Object.assign(new Error("locked"), { code: 4 }), "", "LOCKED: Job Discovery.xlsx is open in Excel");

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...a) => spawnMock(...a), execFile: (...a) => execFileMock(...a) };
});

let app;
let tmpRoot;
let docsDir;
let jobsDir;
let findsFile;
const FIXTURE_TICKET_ID = "t-fixture-discover-prune";

// One due source (daily cadence, never run) so run-all-due has something to
// launch. A fresh id per test keeps a prior test's lastRunAt stamp from making
// the source not-due.
function setDueSource(id) {
  fs.writeFileSync(
    path.join(docsDir, "discovery-sources.yaml"),
    yaml.dump({
      version: 1,
      sources: [{ id, name: `Fixture ${id}`, type: "board", sector: "private", active: "yes", cadence: "daily" }],
    }),
    "utf8"
  );
}

async function waitFor(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-discover-prune-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  // A fixture ticket so the non-discovery control (work-ticket) passes its
  // ticket-existence check and reaches startRun.
  fs.writeFileSync(
    path.join(docsDir, "tasks.yaml"),
    ["columns:", "  - todo", "tasks:", `  - id: ${FIXTURE_TICKET_ID}`, "    title: Fixture", "    status: todo", "    created: '2026-07-03'", ""].join("\n"),
    "utf8"
  );
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  execFileImpl = pruneSucceeds;
  spawnMock.mockClear();
  execFileMock.mockClear();
});

// Find the execFile call that invoked `discovery.py prune`.
const pruneCall = () =>
  execFileMock.mock.calls.find((c) => Array.isArray(c[1]) && c[1].includes("prune"));

describe("POST /api/discovery/run-all-due - prune wiring (moved from the retired global sweep)", () => {
  it("runs `discovery.py prune` BEFORE launching the due-source fan-out", async () => {
    setDueSource("src-prune-a");
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    expect(res.body.targets).toEqual(["src-prune-a"]);

    const call = pruneCall();
    expect(call).toBeDefined();
    expect(call[1][0]).toMatch(/discovery\.py$/); // script path
    expect(call[1][1]).toBe("prune"); // subcommand

    // The fan-out's agent launch is async (bookkeeping hop); wait for it, then
    // prove prune's execFile was invoked strictly before the agent spawn.
    expect(await waitFor(() => spawnMock.mock.calls.length === 1)).toBe(true);
    expect(execFileMock.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
  });

  it("a locked workbook is skipped and the fan-out still launches (graceful degrade, never a block)", async () => {
    execFileImpl = pruneLocked;
    setDueSource("src-prune-b");
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201); // fan-out proceeded despite the locked workbook
    expect(pruneCall()).toBeDefined(); // prune WAS attempted
    expect(await waitFor(() => spawnMock.mock.calls.length === 1)).toBe(true); // ...and the agent still spawned
  });

  it("the retired global discover-jobs sweep does not prune (it is rejected outright)", async () => {
    const res = await request(app).post("/api/routines/run").send({ routine: "discover-jobs" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run-all-due/);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a non-discovery routine does NOT run prune", async () => {
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: FIXTURE_TICKET_ID });
    expect(res.status).toBe(201);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled(); // prune belongs to run-all-due only
  });
});
