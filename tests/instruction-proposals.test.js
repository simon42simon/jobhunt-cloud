import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// [DISC-W3] Instruction-proposal loop (t-1783198113775), server half. Guards the
// W1a decision #4 contract (docs/data-schema.md §5 Decision 4):
//   - POST /api/discovery/sources/:id/instruction-proposals/propose
//       records the owner's comment as the trigger and launches the
//       propose-instructions routine (job-search-scout) WITHOUT touching the
//       scrape bookkeeping (no lastRunAt stamp, no runs[] record - a propose
//       run is not a scrape, so cadence health must not drift);
//   - POST /api/discovery/sources/:id/instruction-proposals
//       the agent's callback files a proposal; id/ts/status are SERVER-stamped
//       and unforgeable (same posture as task comments/attachments);
//   - PATCH /api/discovery/sources/:id/instruction-proposals/:proposalId
//       approve (instructions replaced + provenance stamped) or reject with a
//       REQUIRED reason (archived, never deleted); one-way transitions only;
//   - past rejection reasons + the owner comment + current instructions + the
//       landing URLs all feed the next propose run's prompt;
//   - starting-link principle: a source is creatable with just name + url;
//   - a manual PATCH of `instructions` clears instructionsApprovedFrom and
//       re-stamps instructionsUpdatedAt, so provenance can never lie.
//
// Hermetic, same harness as discovery-sources-lifecycle.test.js: throwaway
// docs/ copy, the finds JSON seam, and a mocked child_process so no real agent
// ever spawns.

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
// Auto-closes on the next tick (the default agent).
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
  const g = await request(app).get("/api/discovery/sources");
  return g.body.sources.find((s) => s.id === id);
};
// The prompt startRun actually spawned with (argv is ["-p", prompt, ...]).
const spawnedPrompt = (call = 0) => {
  const args = spawnMock.mock.calls[call][1];
  return args[args.indexOf("-p") + 1];
};
const flagValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
};

// One standard source under test.
const OCI = {
  id: "oci",
  name: "OCI",
  type: "board",
  sector: "bps",
  active: "yes",
  cadence: "weekly",
  urls: ["https://oci.example/careers"],
  instructions: "OLD INSTRUCTIONS: start at the careers page.",
};

async function fileProposal(id = "oci", body = {}) {
  return request(app)
    .post(`/api/discovery/sources/${id}/instruction-proposals`)
    .send({ proposedInstructions: "NEW INSTRUCTIONS: start at /jobs, open each posting.", rationale: "verified 3 links", ownerComment: "misses senior roles", ...body });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-instr-prop-"));
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
  setSources([OCI]);
  setFinds([]);
  spawnMock.mockClear();
  spawnMock.mockImplementation(() => makeFakeProc(0));
  execFileMock.mockClear();
});

// ---------------------------------------------------------------------------
// 1. POST .../instruction-proposals/propose - the owner-comment + run trigger.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources/:id/instruction-proposals/propose", () => {
  it("404s on an unknown source", async () => {
    const res = await request(app).post("/api/discovery/sources/nope/instruction-proposals/propose").send({ ownerComment: "x" });
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("launches the propose-instructions run as job-search-scout (sonnet/medium) and returns the runId", async () => {
    const res = await request(app)
      .post("/api/discovery/sources/oci/instruction-proposals/propose")
      .send({ ownerComment: "misses senior roles" });
    expect(res.status).toBe(201);
    expect(res.body.runId).toMatch(/^r\d+/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1];
    expect(flagValue(args, "--agent")).toBe("job-search-scout");
    expect(flagValue(args, "--model")).toBe("sonnet");
    expect(flagValue(args, "--effort")).toBe("medium");
    // ADR-005 posture unchanged: allow-list + permission-mode, never skip.
    expect(args.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(args).toContain("--permission-mode");
    expect(args).not.toContain("--dangerously-skip-permissions");
    await waitFor(() => runsSettled());
  });

  it("builds the prompt from the landing URLs, current instructions, and the owner comment", async () => {
    await request(app)
      .post("/api/discovery/sources/oci/instruction-proposals/propose")
      .send({ ownerComment: "misses senior roles" });
    const prompt = spawnedPrompt();
    expect(prompt).toContain("https://oci.example/careers");
    expect(prompt).toContain("OLD INSTRUCTIONS: start at the careers page.");
    expect(prompt).toContain("misses senior roles");
    // ...and points the agent at the callback endpoint, never the YAML file.
    expect(prompt).toContain("/api/discovery/sources/oci/instruction-proposals");
    await waitFor(() => runsSettled());
  });

  it("feeds PAST REJECTION REASONS into the next run's prompt", async () => {
    setSources([
      {
        ...OCI,
        instructionProposals: [
          {
            id: "ip-1",
            ts: "2026-07-01T00:00:00.000Z",
            ownerComment: "first try",
            proposedInstructions: "bad idea",
            rationale: "",
            status: "rejected",
            resolvedAt: "2026-07-02T00:00:00.000Z",
            rejectionReason: "links opened search pages, not postings",
          },
        ],
      },
    ]);
    await request(app).post("/api/discovery/sources/oci/instruction-proposals/propose").send({ ownerComment: "try again" });
    const prompt = spawnedPrompt();
    expect(prompt).toContain("links opened search pages, not postings");
    await waitFor(() => runsSettled());
  });

  it("works with NO owner comment (cold start / first proposal for a new source)", async () => {
    setSources([{ id: "acme", name: "Acme", urls: ["https://acme.example/careers"] }]);
    const res = await request(app).post("/api/discovery/sources/acme/instruction-proposals/propose").send({});
    expect(res.status).toBe(201);
    const prompt = spawnedPrompt();
    expect(prompt).toContain("https://acme.example/careers");
    expect(prompt.toLowerCase()).toContain("first proposal");
    await waitFor(() => runsSettled());
  });

  it("does NOT stamp lastRunAt and does NOT append a runs[] record (cadence health must not drift)", async () => {
    let proc;
    spawnMock.mockImplementationOnce(() => {
      proc = makeEmitterProc();
      return proc;
    });
    const res = await request(app).post("/api/discovery/sources/oci/instruction-proposals/propose").send({ ownerComment: "x" });
    expect(res.status).toBe(201);
    const s = await getSource("oci");
    expect(s.lastRunAt).toBeNull(); // a propose run is NOT a scrape
    expect(s.runs).toEqual([]);
    expect(s.status).toBe("never-run"); // never shows as a scrape "running"
    proc.emit("close", 0);
    await waitFor(() => runsSettled());
  });

  it("409s while a propose run is already in flight for this source, and serves proposeRunId while it runs", async () => {
    let proc;
    spawnMock.mockImplementationOnce(() => {
      proc = makeEmitterProc();
      return proc;
    });
    const first = await request(app).post("/api/discovery/sources/oci/instruction-proposals/propose").send({ ownerComment: "a" });
    expect(first.status).toBe(201);

    const during = await getSource("oci");
    expect(during.proposeRunId).toBe(first.body.runId); // survives a page reload

    const second = await request(app).post("/api/discovery/sources/oci/instruction-proposals/propose").send({ ownerComment: "b" });
    expect(second.status).toBe(409);

    proc.emit("close", 0);
    await waitFor(async () => (await getSource("oci")).proposeRunId === null);
    expect((await getSource("oci")).proposeRunId).toBeNull();
  });

  it("is rejected by the generic /api/routines/run (source-scoped) and hidden from GET /api/routines", async () => {
    const run = await request(app).post("/api/routines/run").send({ routine: "propose-instructions", jobId: "oci" });
    expect(run.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    const list = await request(app).get("/api/routines");
    expect(list.body.find((r) => r.id === "propose-instructions")).toBeUndefined();
  });
});

// All runs in the in-memory Map reached a terminal state (so an auto-closing
// fake proc can't bleed a finalize into the next test).
async function runsSettled() {
  const s = await getSource("oci");
  return !s || s.proposeRunId === null;
}

// ---------------------------------------------------------------------------
// 2. POST .../instruction-proposals - the agent's callback files a proposal.
// ---------------------------------------------------------------------------
describe("POST /api/discovery/sources/:id/instruction-proposals", () => {
  it("404s on an unknown source and 400s on blank proposedInstructions", async () => {
    expect((await fileProposal("nope")).status).toBe(404);
    expect((await fileProposal("oci", { proposedInstructions: "   " })).status).toBe(400);
    expect((await fileProposal("oci", { proposedInstructions: 42 })).status).toBe(400);
  });

  it("files a pending proposal: server-stamped id/ts, persisted to disk, served newest-first", async () => {
    const res = await fileProposal();
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^ip-\d+/);
    expect(res.body.status).toBe("pending");
    expect(Number.isFinite(Date.parse(res.body.ts))).toBe(true);
    expect(res.body.ownerComment).toBe("misses senior roles");
    expect(res.body.proposedInstructions).toContain("NEW INSTRUCTIONS");
    expect(res.body.rationale).toBe("verified 3 links");

    // Persisted (round-trips through saveSources/normalizeSource).
    const onDisk = readSourcesFile().sources.find((s) => s.id === "oci");
    expect(onDisk.instructionProposals).toHaveLength(1);
    expect(onDisk.instructionProposals[0].id).toBe(res.body.id);

    // Served on the derived GET, newest-first.
    const second = await fileProposal("oci", { proposedInstructions: "EVEN NEWER" });
    const s = await getSource("oci");
    expect(s.instructionProposals).toHaveLength(2);
    expect(s.instructionProposals[0].id).toBe(second.body.id);
  });

  it("FORGE RESISTANCE: client-supplied id/ts/status/resolvedAt/rejectionReason are ignored", async () => {
    const res = await fileProposal("oci", {
      id: "ip-forged",
      ts: "1999-01-01T00:00:00.000Z",
      status: "approved",
      resolvedAt: "1999-01-01T00:00:00.000Z",
      rejectionReason: "smuggled",
    });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe("ip-forged");
    expect(res.body.ts).not.toBe("1999-01-01T00:00:00.000Z");
    expect(res.body.status).toBe("pending");
    expect(res.body.resolvedAt).toBeUndefined();
    expect(res.body.rejectionReason).toBeUndefined();
    // And the "approved" smuggle did NOT touch the live instructions.
    expect((await getSource("oci")).instructions).toBe(OCI.instructions);
  });

  it("FORGE RESISTANCE: instructionProposals / provenance are not writable through the source endpoints", async () => {
    // Creation cannot seed proposals or provenance.
    const created = await request(app).post("/api/discovery/sources").send({
      name: "Forge Co",
      instructionProposals: [{ id: "ip-x", status: "approved", proposedInstructions: "evil" }],
      instructionsApprovedFrom: "ip-x",
      instructionsUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(created.status).toBe(201);
    expect(created.body.instructionProposals).toEqual([]);
    expect(created.body.instructionsApprovedFrom).toBeNull();
    expect(created.body.instructionsUpdatedAt).toBeNull();

    // PATCH cannot replace / clear the append-only log or stamp provenance.
    await fileProposal();
    const patched = await request(app).patch("/api/discovery/sources/oci").send({
      instructionProposals: [],
      instructionsApprovedFrom: "ip-x",
      instructionsUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.instructionProposals).toHaveLength(1);
    expect(patched.body.instructionsApprovedFrom).toBeNull();
    expect(patched.body.instructionsUpdatedAt).toBeNull();
  });

  it("an unrelated source PATCH preserves the proposal log on disk (no drop on round-trip)", async () => {
    await fileProposal();
    const res = await request(app).patch("/api/discovery/sources/oci").send({ notes: "unrelated edit" });
    expect(res.status).toBe(200);
    const onDisk = readSourcesFile().sources.find((s) => s.id === "oci");
    expect(onDisk.instructionProposals).toHaveLength(1);
    expect(onDisk.notes).toBe("unrelated edit");
  });
});

// ---------------------------------------------------------------------------
// 3. PATCH .../instruction-proposals/:proposalId - approve / reject.
// ---------------------------------------------------------------------------
describe("PATCH /api/discovery/sources/:id/instruction-proposals/:proposalId", () => {
  it("404s on unknown source / proposal; 400s on a bad target status", async () => {
    const p = (await fileProposal()).body;
    expect((await request(app).patch("/api/discovery/sources/nope/instruction-proposals/x").send({ status: "approved" })).status).toBe(404);
    expect((await request(app).patch("/api/discovery/sources/oci/instruction-proposals/ip-missing").send({ status: "approved" })).status).toBe(404);
    for (const bad of [{}, { status: "pending" }, { status: "done" }]) {
      const res = await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send(bad);
      expect(res.status).toBe(400);
    }
    expect((await getSource("oci")).instructionProposals[0].status).toBe("pending"); // untouched
  });

  it("APPROVE replaces the source's instructions and stamps provenance (persisted)", async () => {
    const p = (await fileProposal()).body;
    const res = await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send({ status: "approved" });
    expect(res.status).toBe(200);
    // The response is the derived source, post-approval.
    expect(res.body.instructions).toBe(p.proposedInstructions);
    expect(res.body.instructionsApprovedFrom).toBe(p.id);
    const approved = res.body.instructionProposals.find((x) => x.id === p.id);
    expect(approved.status).toBe("approved");
    expect(Number.isFinite(Date.parse(approved.resolvedAt))).toBe(true);
    expect(res.body.instructionsUpdatedAt).toBe(approved.resolvedAt);
    // Persisted on disk, not just in the response.
    const onDisk = readSourcesFile().sources.find((s) => s.id === "oci");
    expect(onDisk.instructions).toBe(p.proposedInstructions);
    expect(onDisk.instructionsApprovedFrom).toBe(p.id);
    expect(onDisk.instructionProposals[0].status).toBe("approved");
  });

  it("REJECT requires a non-blank rejectionReason (400, nothing persisted without one)", async () => {
    const p = (await fileProposal()).body;
    for (const bad of [{ status: "rejected" }, { status: "rejected", rejectionReason: "  " }, { status: "rejected", rejectionReason: 7 }]) {
      const res = await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send(bad);
      expect(res.status).toBe(400);
    }
    const s = await getSource("oci");
    expect(s.instructionProposals[0].status).toBe("pending");
    expect(s.instructionProposals[0].rejectionReason).toBeUndefined();
  });

  it("REJECT archives the proposal with the reason; instructions and provenance untouched; never deleted", async () => {
    const p = (await fileProposal()).body;
    const res = await request(app)
      .patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`)
      .send({ status: "rejected", rejectionReason: "still misses senior roles" });
    expect(res.status).toBe(200);
    expect(res.body.instructions).toBe(OCI.instructions); // untouched
    expect(res.body.instructionsApprovedFrom).toBeNull();
    const rejected = res.body.instructionProposals.find((x) => x.id === p.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("still misses senior roles");
    expect(Number.isFinite(Date.parse(rejected.resolvedAt))).toBe(true);
    // Archived = still on disk (the training context for the next run).
    const onDisk = readSourcesFile().sources.find((s) => s.id === "oci");
    expect(onDisk.instructionProposals).toHaveLength(1);
    // ...and the reason demonstrably feeds the next propose run.
    await request(app).post("/api/discovery/sources/oci/instruction-proposals/propose").send({ ownerComment: "again" });
    expect(spawnedPrompt()).toContain("still misses senior roles");
    await waitFor(() => runsSettled());
  });

  it("ONE-WAY: a resolved proposal can never be re-resolved (approve->reject 400, approve->approve 400)", async () => {
    const p = (await fileProposal()).body;
    await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send({ status: "approved" });
    for (const again of [{ status: "rejected", rejectionReason: "changed my mind" }, { status: "approved" }]) {
      const res = await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send(again);
      expect(res.status).toBe(400);
    }
    // Still approved, instructions still the approved text.
    const s = await getSource("oci");
    expect(s.instructionProposals[0].status).toBe("approved");
    expect(s.instructions).toBe(p.proposedInstructions);
  });
});

// ---------------------------------------------------------------------------
// 4. Provenance honesty on the manual-edit escape hatch.
// ---------------------------------------------------------------------------
describe("manual instructions edit vs provenance", () => {
  it("a manual PATCH that CHANGES instructions clears instructionsApprovedFrom and re-stamps instructionsUpdatedAt", async () => {
    const p = (await fileProposal()).body;
    const approved = await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send({ status: "approved" });
    const stampedAt = approved.body.instructionsUpdatedAt;

    const manual = await request(app).patch("/api/discovery/sources/oci").send({ instructions: "hand-edited emergency fix" });
    expect(manual.status).toBe(200);
    expect(manual.body.instructions).toBe("hand-edited emergency fix");
    expect(manual.body.instructionsApprovedFrom).toBeNull(); // no longer from that proposal
    expect(manual.body.instructionsUpdatedAt).not.toBe(stampedAt); // "set manually <now>"
    expect(Number.isFinite(Date.parse(manual.body.instructionsUpdatedAt))).toBe(true);
  });

  it("a PATCH re-sending the IDENTICAL instructions keeps the approval provenance", async () => {
    const p = (await fileProposal()).body;
    await request(app).patch(`/api/discovery/sources/oci/instruction-proposals/${p.id}`).send({ status: "approved" });
    const res = await request(app).patch("/api/discovery/sources/oci").send({ instructions: p.proposedInstructions, notes: "no-op text" });
    expect(res.status).toBe(200);
    expect(res.body.instructionsApprovedFrom).toBe(p.id);
  });
});

// ---------------------------------------------------------------------------
// 5. Starting-link principle + read tolerance.
// ---------------------------------------------------------------------------
describe("starting-link authoring + tolerant read", () => {
  it("a source is creatable with ONLY name + landing url (instructions arrive via the loop)", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "Acme Robotics", url: "https://acme.example/careers" });
    expect(res.status).toBe(201);
    expect(res.body.urls).toEqual(["https://acme.example/careers"]);
    expect(res.body.instructions).toBe("");
    expect(res.body.instructionProposals).toEqual([]);
  });

  it("a hand-edited proposal with a bogus status degrades to pending (human re-review), never crashes", async () => {
    setSources([
      {
        ...OCI,
        instructionProposals: [{ id: "ip-weird", ts: "2026-07-01T00:00:00.000Z", proposedInstructions: "x", status: "banana" }],
      },
    ]);
    const res = await request(app).get("/api/discovery/sources");
    expect(res.status).toBe(200);
    const s = res.body.sources.find((x) => x.id === "oci");
    expect(s.instructionProposals[0].status).toBe("pending");
  });
});
