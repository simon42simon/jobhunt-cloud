import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// The routine runner binds each PRODUCT routine (server/index.js ROUTINES) to
// its owning Career Delivery agent via the CLI `--agent` flag, so the run
// executes AS that agent's persona/guardrails/model default (ADR-015). This
// suite guards TWO things:
//   1. DRIFT - every scope:"job"/"global" product routine declares an `agent`
//      that resolves to a real, spawnable id in docs/agents.yaml (the single
//      source of truth for the org chart). It FAILS if a product routine is
//      added without a binding, or points at a typo'd / non-existent agent.
//   2. WIRING - startRun actually appends `--agent <id>` to the spawn argv for a
//      bound routine, and appends NOTHING for the ticket-scoped routines (whose
//      persona is embedded in the prompt), all WITHOUT weakening the
//      `--allowedTools` ceiling or `--permission-mode` posture (ADR-005).
//
// The runner spawns the real `claude.exe` (startRun); a test must never launch
// it, so node:child_process's spawn is mocked with a fake ChildProcess BEFORE
// importing the server module - the same pattern as tests/work-ticket.test.js.
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

let app;
let ROUTINES;
let tmpRoot;
let docsDir;
let jobsDir;

const FIXTURE_TICKET_ID = "t-fixture-routine-agents";
const FIXTURE_JOB = "Draft Role - Draft Co";

// The product routines and the agent each MUST bind to, per docs/agents.yaml's
// `owns` lists. Hard-coded here so the test locks INTENT: the runtime table and
// the org chart must agree with this expectation, not merely with each other.
const EXPECTED_BINDINGS = {
  "discover-jobs": "job-search-scout",
  "discover-jobs-source": "job-search-scout", // per-source Run-now (ADR-016) - same owner as the sweep
  "propose-instructions": "job-search-scout", // instruction-proposal loop (data-schema §5 D4) - probing a board is discovery work
  "first-draft-job": "application-writer",
  "finalize-job": "application-writer",
  "merge-application-pdf": "application-writer", // merge cover letter + CV PDFs into one (t-1783650792067) - writer owns the render pipeline's outputs
  "draft-follow-up": "application-writer", // draft a follow-up email (US-6) - writer owns candidate-authored outreach
  "usage-insights": "product-manager", // usage-journey insights (ADR-017 W3) - PM owns learn->recommend
  "interview-prep": "interview-offer-coach", // late-stage STAR + prep (US-4) - coach owns interview/offer readiness
  "offer-prep": "interview-offer-coach", // negotiation + offer comparison (US-5) - coach owns the offer stage
};
// "source" included so a new scope can never slip a product routine past these
// guards unbound (the 2026-07-04 governance audit caught exactly that gap).
const PRODUCT_SCOPES = new Set(["job", "global", "source"]);

// Read the REAL committed org chart - it is the source of truth that declares
// these owners - independent of any JOBHUNT_DOCS_DIR test seam.
function loadAgentRoles() {
  const p = fileURLToPath(new URL("../docs/agents.yaml", import.meta.url));
  const doc = yaml.load(fs.readFileSync(p, "utf8")) || {};
  return Array.isArray(doc.roles) ? doc.roles : [];
}

function writeTasksFixture() {
  const y = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${FIXTURE_TICKET_ID}`,
    "    title: Fixture ticket for the routine-agents test",
    "    detail: Only exists so the ticket-scope routines pass the existence check.",
    "    epic: testing",
    "    priority: medium",
    "    status: todo",
    "    created: '2026-07-04'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), y, "utf8");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-routine-agents-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(jobsDir, FIXTURE_JOB), { recursive: true }); // scope:"job" needs a real folder
  writeTasksFixture();

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  // SIM-577: startRun() now fails scope:"ticket" routines immediately when
  // CLAUDE_BIN_PRESENT is false. spawn is mocked above regardless, but
  // CLAUDE_BIN_PRESENT is a real fs.existsSync check made at module load - a
  // CI runner has no claude binary anywhere, so without this seam the
  // assess-ticket/work-ticket launches below would short-circuit before ever
  // reaching the mock. JOBHUNT_CLAUDE_BIN points it at a controlled,
  // always-present path (mirrors JOBHUNT_PYTHON).
  const fakeBin = path.join(tmpRoot, "fake-claude-binary");
  fs.writeFileSync(fakeBin, "not a real binary - spawn is mocked in this suite", "utf8");
  process.env.JOBHUNT_CLAUDE_BIN = fakeBin;
  vi.resetModules();
  ({ app, ROUTINES } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.JOBHUNT_CLAUDE_BIN;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// ---- 1. Drift guard: routine -> owning agent binding integrity --------------
describe("product routine -> agent binding (docs/agents.yaml integrity)", () => {
  it("binds every scope:job/global product routine to a real, spawnable agents.yaml id", () => {
    const roles = loadAgentRoles();
    // Valid `--agent` targets are the kind:"agent" roles (they carry an
    // agent_file / ~/.claude/agents/<id>.md). owner (human) and cto
    // (orchestrator) are NOT spawnable agents and must never be a binding.
    const spawnableAgentIds = new Set(roles.filter((r) => r.kind === "agent").map((r) => r.id));
    expect(spawnableAgentIds.size).toBeGreaterThan(0); // sanity: agents.yaml parsed

    const productRoutines = Object.entries(ROUTINES).filter(([, def]) => PRODUCT_SCOPES.has(def.scope));
    expect(productRoutines.length).toBeGreaterThan(0); // sanity: there ARE product routines

    for (const [id, def] of productRoutines) {
      // Present + non-empty: a product routine added without a binding fails here.
      expect(typeof def.agent, `product routine "${id}" must declare an owning agent`).toBe("string");
      expect(def.agent.length, `product routine "${id}" agent must be non-empty`).toBeGreaterThan(0);
      // Resolvable: a typo'd or removed agent id fails here.
      expect(
        spawnableAgentIds.has(def.agent),
        `routine "${id}" agent "${def.agent}" must be a real kind:"agent" id in docs/agents.yaml`
      ).toBe(true);
    }
  });

  it("matches the exact owner declared by agents.yaml's `owns` lists (intent lock)", () => {
    for (const [routine, expectedAgent] of Object.entries(EXPECTED_BINDINGS)) {
      expect(ROUTINES[routine], `routine "${routine}" must exist`).toBeDefined();
      expect(ROUTINES[routine].agent).toBe(expectedAgent);
    }
  });

  it("leaves the ticket-scoped routines UNBOUND (persona is in the prompt)", () => {
    for (const id of ["work-ticket", "assess-ticket"]) {
      expect(ROUTINES[id], `routine "${id}" must exist`).toBeDefined();
      expect(ROUTINES[id].scope).toBe("ticket");
      expect(ROUTINES[id].agent).toBeUndefined();
    }
  });
});

// ---- 2. Wiring: startRun appends --agent for a bound routine ----------------
describe("startRun spawn argv carries the agent binding", () => {
  it("appends `--agent application-writer` for first-draft-job, keeping the tool ceiling", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "first-draft-job", jobId: FIXTURE_JOB });

    expect(res.status).toBe(201);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = spawnMock.mock.calls[0];
    const ai = spawnArgs.indexOf("--agent");
    expect(ai).toBeGreaterThan(-1);
    expect(spawnArgs[ai + 1]).toBe("application-writer");
    // The persona binding must NOT relax the sandbox: allow-list still present,
    // permission-mode never skip-permissions (ADR-005).
    expect(spawnArgs.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(spawnArgs).toContain("--permission-mode");
    expect(spawnArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("appends `--agent application-writer` for finalize-job", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "finalize-job", jobId: FIXTURE_JOB });

    expect(res.status).toBe(201);
    const [, spawnArgs] = spawnMock.mock.calls[0];
    const ai = spawnArgs.indexOf("--agent");
    expect(ai).toBeGreaterThan(-1);
    expect(spawnArgs[ai + 1]).toBe("application-writer");
  });

  it("appends NO `--agent` for the ticket-scoped work-ticket routine", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "work-ticket", jobId: FIXTURE_TICKET_ID });

    expect(res.status).toBe(201);
    const [, spawnArgs] = spawnMock.mock.calls[0];
    expect(spawnArgs).not.toContain("--agent");
    // Sandbox unchanged for the ticket routine too.
    expect(spawnArgs.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(spawnArgs).not.toContain("--dangerously-skip-permissions");
  });
});

// ---- 3. Model / effort tiers per product routine ---------------------------
// Running AS the owning agent is completed by pinning the model + effort that
// agent documents, scoped to these button runs (ADR-015 addendum). Locked to
// intent so a silent tier change - or a dropped batch carve-out - fails here.
const EXPECTED_TIERS = {
  "discover-jobs": { model: "sonnet", effort: "medium" },
  "discover-jobs-source": { model: "sonnet", effort: "medium" },
  "propose-instructions": { model: "sonnet", effort: "medium" }, // probe + one write-back, no employer-facing output

  "first-draft-job": { model: "opus", effort: "high", batchModel: "sonnet", batchEffort: "medium" },
  "finalize-job": { model: "opus", effort: "high" },
  "merge-application-pdf": { model: "sonnet", effort: "medium" }, // runs ONE deterministic vault script (merge_application_pdf.py) - zero generative judgment, mechanical tier
  "draft-follow-up": { model: "sonnet", effort: "medium" }, // short check-in draft = routine-prep tier (like interview-prep), not the CV/cover-letter opus/high; no batch carve-out
  "usage-insights": { model: "sonnet", effort: "medium" }, // analysis tier - read/aggregate/report, no employer-facing output

  "interview-prep": { model: "sonnet", effort: "medium" }, // routine STAR + prep-sheet generation (agent file: "routine prep is Sonnet at medium")
  "offer-prep": { model: "opus", effort: "high" }, // negotiation strategy + offer analysis (agent file: high-stakes reasoning = Opus/high)
};

// Pull a `--flag value` pair out of a spawn argv (undefined if the flag absent).
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : undefined;
}

describe("product routine model/effort tiers (intent lock)", () => {
  it("pins the documented single-run tier on each product routine", () => {
    for (const [routine, tier] of Object.entries(EXPECTED_TIERS)) {
      expect(ROUTINES[routine], `routine "${routine}" must exist`).toBeDefined();
      expect(ROUTINES[routine].model, `${routine} model`).toBe(tier.model);
      expect(ROUTINES[routine].effort, `${routine} effort`).toBe(tier.effort);
    }
  });

  it("encodes application-writer's first-draft BATCH carve-out (drops to Sonnet)", () => {
    expect(ROUTINES["first-draft-job"].batchModel).toBe("sonnet");
    expect(ROUTINES["first-draft-job"].batchEffort).toBe("medium");
    // finalize-job has no documented batch carve-out -> no batch* override.
    expect(ROUTINES["finalize-job"].batchModel).toBeUndefined();
  });
});

// ---- 4. assess-ticket is comment-only: deny the file-mutation tools ---------
describe("assess-ticket disallowedTools (comment-only defense-in-depth)", () => {
  it("denies Write/Edit/NotebookEdit on assess-ticket only", () => {
    expect(ROUTINES["assess-ticket"].disallowedTools).toBe("Write,Edit,NotebookEdit");
    // work-ticket EXECUTES the ticket -> keeps the full toolset.
    expect(ROUTINES["work-ticket"].disallowedTools).toBeUndefined();
    // product routines are not deny-listed either.
    expect(ROUTINES["first-draft-job"].disallowedTools).toBeUndefined();
  });
});

// ---- 5. Wiring: startRun puts the tiers + deny-list on the spawn argv -------
describe("startRun spawn argv carries the tier + deny-list", () => {
  it("appends --model opus --effort high for a single first-draft-job run, no deny-list", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "first-draft-job", jobId: FIXTURE_JOB });
    expect(res.status).toBe(201);
    const [, args] = spawnMock.mock.calls[0];
    expect(flagValue(args, "--model")).toBe("opus");
    expect(flagValue(args, "--effort")).toBe("high");
    expect(args).not.toContain("--disallowedTools");
  });

  it("downshifts a first-draft-job BATCH to --model sonnet --effort medium (carve-out)", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "first-draft-job", jobIds: [FIXTURE_JOB] });
    expect(res.status).toBe(201);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(flagValue(args, "--model")).toBe("sonnet");
    expect(flagValue(args, "--effort")).toBe("medium");
    // still the owning agent, just a lighter tier for the batch.
    expect(flagValue(args, "--agent")).toBe("application-writer");
  });

  it("appends --disallowedTools Write,Edit,NotebookEdit for assess-ticket, no --agent", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "assess-ticket", jobId: FIXTURE_TICKET_ID });
    expect(res.status).toBe(201);
    const [, args] = spawnMock.mock.calls[0];
    expect(flagValue(args, "--disallowedTools")).toBe("Write,Edit,NotebookEdit");
    // comment-only persona is embedded in the prompt, so NO --agent binding.
    expect(args).not.toContain("--agent");
  });
});
