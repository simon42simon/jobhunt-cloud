import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Intake ledger (ADR-009) + the project PM/RACI fields (ADR-010), built together
// so they share one data model. These persist to docs/requests.yaml /
// docs/portfolio.yaml, so the app is pointed at a THROWAWAY copy of docs/ via the
// JOBHUNT_DOCS_DIR seam - the committed docs are never mutated. Each test
// re-copies the committed docs (beforeEach) so the ledger/portfolio start fresh
// and no test can bleed into another (FIRST: Isolated, Repeatable).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
// ADR-023: live board files left docs/ for the data zone; suites overlay the
// committed synthetic fixtures so the server boots against tracked test data.
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

let app;
let tmpRoot; // parent of the throwaway docs + jobs dirs
let docsDir; // throwaway copy of docs/ (the JOBHUNT_DOCS_DIR target)
let jobsDir; // throwaway (empty) Jobs fixture - app boot resolves a jobs dir

const REQ_FILE = () => path.join(docsDir, "requests.yaml");
const PORTFOLIO_FILE = () => path.join(docsDir, "portfolio.yaml");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function restoreDocs() {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-req-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  restoreDocs();
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir; // the seam under test - never the real docs/
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => restoreDocs());

// Sanity: the seam is honored - we are writing the throwaway copy, not docs/.
it("operates on the throwaway docs copy, not the committed docs/", () => {
  expect(docsDir.startsWith(tmpRoot)).toBe(true);
  expect(path.resolve(docsDir)).not.toBe(path.resolve(REPO_DOCS));
});

describe("GET /api/requests", () => {
  it("returns { requests: [...] } with every request well-shaped", async () => {
    const res = await request(app).get("/api/requests");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
    for (const r of res.body.requests) {
      expect(typeof r.id).toBe("string");
      expect(r.id.startsWith("r-")).toBe(true);
      expect(typeof r.text).toBe("string");
      expect(["session", "chatbot"]).toContain(r.source);
      expect(r.created).toMatch(YMD);
      expect(typeof r.ts).toBe("string");
      expect(Array.isArray(r.spawned.tasks)).toBe(true);
      expect(Array.isArray(r.spawned.projects)).toBe(true);
    }
  });

  it("yields { requests: [] } when requests.yaml does not exist (never a 500)", async () => {
    fs.rmSync(REQ_FILE(), { force: true });
    expect(fs.existsSync(REQ_FILE())).toBe(false);
    const res = await request(app).get("/api/requests");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });
});

describe("backfill (deterministic ledger derived from tasks.yaml)", () => {
  it("carries the intake request itself - verbatim owner text, source session, linked to its spawning task", async () => {
    const res = await request(app).get("/api/requests");
    const r = res.body.requests.find((x) => x.id === "r-1783097277925");
    expect(r).toBeDefined();
    expect(r.source).toBe("session"); // labelled 'intake', not 'chatbot'
    expect(r.spawned.tasks).toContain("t-1783097277925");
    expect(r.text).toContain("Owner request"); // verbatim owner line, not a paraphrase
    expect(typeof r.assessment).toBe("string");
  });

  it("marks chatbot-sourced requests source 'chatbot'", async () => {
    const res = await request(app).get("/api/requests");
    const r = res.body.requests.find((x) => x.id === "r-1783042256172");
    expect(r).toBeDefined();
    expect(r.source).toBe("chatbot");
    expect(r.spawned.tasks).toContain("t-1783042256172");
  });
});

describe("POST /api/requests", () => {
  it("creates a request, stamping id/created/ts and defaulting source to 'session'", async () => {
    const res = await request(app).post("/api/requests").send({ text: "make the intake visible" });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^r-\d+$/);
    expect(res.body.created).toMatch(YMD);
    expect(res.body.ts).toMatch(ISO);
    expect(res.body.source).toBe("session");
    expect(res.body.text).toBe("make the intake visible");
    expect(res.body.spawned).toEqual({ tasks: [], projects: [] });
  });

  it("stores text VERBATIM with special chars (: # \") and newlines intact, round-tripping through disk", async () => {
    const text = 'Fix this: the "Board" tab # and\nline two\ttabbed  ';
    const res = await request(app).post("/api/requests").send({ text });
    expect(res.status).toBe(201);
    expect(res.body.text).toBe(text); // never id-sanitized, never trimmed of content

    // survives a reload from disk (loadRequests re-parses the YAML), not just echoed.
    const saved = (await request(app).get("/api/requests")).body.requests.find((r) => r.id === res.body.id);
    expect(saved.text).toBe(text);
  });

  it("accepts an explicit source 'chatbot' and optional assessment + spawned (deduped)", async () => {
    const res = await request(app)
      .post("/api/requests")
      .send({
        text: "chatbot ask",
        source: "chatbot",
        assessment: "CTO verdict here",
        spawned: { tasks: ["t-1", "t-1", "t-2"], projects: ["prj-a"] },
      });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("chatbot");
    expect(res.body.assessment).toBe("CTO verdict here");
    expect(res.body.spawned).toEqual({ tasks: ["t-1", "t-2"], projects: ["prj-a"] });
  });

  it("rejects blank text with 400 (missing, empty, whitespace-only)", async () => {
    expect((await request(app).post("/api/requests").send({})).status).toBe(400);
    expect((await request(app).post("/api/requests").send({ text: "" })).status).toBe(400);
    expect((await request(app).post("/api/requests").send({ text: "   \n\t " })).status).toBe(400);
  });
});

describe("PATCH /api/requests/:id", () => {
  it("sets/replaces assessment and MERGES + dedupes spawned (never a replace)", async () => {
    const created = await request(app)
      .post("/api/requests")
      .send({ text: "seed", spawned: { tasks: ["t-1"] } });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const first = await request(app)
      .patch(`/api/requests/${id}`)
      .send({ assessment: "first verdict", spawned: { tasks: ["t-1", "t-2"], projects: ["prj-a"] } });
    expect(first.status).toBe(200);
    expect(first.body.assessment).toBe("first verdict");
    expect(first.body.spawned).toEqual({ tasks: ["t-1", "t-2"], projects: ["prj-a"] }); // t-1 not duplicated

    // a second PATCH UNIONS more refs (does not drop t-1/t-2/prj-a) and replaces assessment.
    const second = await request(app)
      .patch(`/api/requests/${id}`)
      .send({ assessment: "revised verdict", spawned: { tasks: ["t-3"], projects: ["prj-a", "prj-b"] } });
    expect(second.status).toBe(200);
    expect(second.body.assessment).toBe("revised verdict");
    expect(second.body.spawned).toEqual({ tasks: ["t-1", "t-2", "t-3"], projects: ["prj-a", "prj-b"] });

    // persisted to disk.
    const saved = (await request(app).get("/api/requests")).body.requests.find((r) => r.id === id);
    expect(saved.spawned).toEqual({ tasks: ["t-1", "t-2", "t-3"], projects: ["prj-a", "prj-b"] });
    expect(saved.assessment).toBe("revised verdict");
  });

  it("404s on an unknown id and never creates one", async () => {
    const res = await request(app).patch("/api/requests/r-does-not-exist").send({ assessment: "x" });
    expect(res.status).toBe(404);
    const list = (await request(app).get("/api/requests")).body.requests;
    expect(list.find((r) => r.id === "r-does-not-exist")).toBeUndefined();
  });

  it("leaves every other request untouched after a patch (no collateral edits)", async () => {
    const a = (await request(app).post("/api/requests").send({ text: "req A" })).body;
    const b = (await request(app).post("/api/requests").send({ text: "req B" })).body;
    await request(app).patch(`/api/requests/${a.id}`).send({ assessment: "only A" });

    const list = (await request(app).get("/api/requests")).body.requests;
    const savedB = list.find((r) => r.id === b.id);
    expect(savedB).toEqual(b); // byte-for-value identical
  });
});

describe("hardening: a partial / hand-edited requests.yaml normalizes to [] not a throw", () => {
  it("a syntactically broken YAML file yields { requests: [] } (never a 500)", async () => {
    fs.writeFileSync(REQ_FILE(), "requests:\n  - id: r-1\n   text: : : broken : :\n", "utf8");
    const res = await request(app).get("/api/requests");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });

  it("a file whose `requests` is not a list yields { requests: [] }", async () => {
    fs.writeFileSync(REQ_FILE(), "requests: not-a-list\n", "utf8");
    const res = await request(app).get("/api/requests");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });
});

describe("atomic round-trip", () => {
  it("persists a POSTed request and leaves no .tmp staging file behind", async () => {
    const res = await request(app).post("/api/requests").send({ text: "durable" });
    expect(res.status).toBe(201);
    const saved = (await request(app).get("/api/requests")).body.requests.find((r) => r.id === res.body.id);
    expect(saved).toMatchObject({ id: res.body.id, text: "durable" });
    expect(fs.existsSync(REQ_FILE() + ".tmp")).toBe(false);
  });
});

// ---- Part B: portfolio PM/RACI fields (ADR-010) ---------------------------
describe("GET /api/portfolio - additive PM/RACI fields (present AND absent)", () => {
  it("serves the additive fields on the backfilled projects (pass-through)", async () => {
    const p = (await request(app).get("/api/portfolio")).body.projects.find(
      (x) => x.id === "prj-product-hub-ia-v2"
    );
    expect(p).toBeDefined();
    expect(p.sponsor).toBe("owner");
    expect(p.project_manager).toBe("cto");
    expect(p.origin_request).toBe(null); // pre-intake project, chartered retroactively
    expect(p.raci.consulted).toContain("ui-ux-expert"); // reviewed m1+m2, owned no task
    expect(p.raci.informed).toContain("owner");
  });

  it("NEVER stores raci.responsible or raci.accountable (derived-not-stored, ADR-010 / design D)", async () => {
    const projects = (await request(app).get("/api/portfolio")).body.projects;
    for (const p of projects) {
      if (!p.raci) continue;
      expect(p.raci.responsible).toBeUndefined(); // = the distinct task owners, derived at read time
      expect(p.raci.accountable).toBeUndefined(); // = the top-level `accountable` field, not duplicated
    }
  });

  it("passes a project WITHOUT the new fields through unchanged (no fields injected)", async () => {
    fs.writeFileSync(
      PORTFOLIO_FILE(),
      [
        "version: 1",
        "projects:",
        "  - id: prj-bare",
        "    name: Bare Project",
        "    department: engineering",
        "    owner: cto",
        "    accountable: cto",
        "    goal: minimal",
        "    status: done",
        "milestones: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const p = (await request(app).get("/api/portfolio")).body.projects.find((x) => x.id === "prj-bare");
    expect(p).toBeDefined();
    expect(p.origin_request).toBeUndefined();
    expect(p.sponsor).toBeUndefined();
    expect(p.project_manager).toBeUndefined();
    expect(p.raci).toBeUndefined();
  });

  it("passes a project WITH the new fields through intact", async () => {
    fs.writeFileSync(
      PORTFOLIO_FILE(),
      [
        "version: 1",
        "projects:",
        "  - id: prj-withfields",
        "    name: With Fields",
        "    department: engineering",
        "    owner: cto",
        "    accountable: cto",
        "    goal: x",
        "    status: done",
        "    origin_request: r-123",
        "    sponsor: owner",
        "    project_manager: software-architect",
        "    raci:",
        "      consulted: [ui-ux-expert]",
        "      informed: [owner]",
        "milestones: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const p = (await request(app).get("/api/portfolio")).body.projects.find((x) => x.id === "prj-withfields");
    expect(p.origin_request).toBe("r-123");
    expect(p.sponsor).toBe("owner");
    expect(p.project_manager).toBe("software-architect");
    expect(p.raci).toEqual({ consulted: ["ui-ux-expert"], informed: ["owner"] });
  });

  it("every role value in the new fields resolves to a real agents.yaml id or 'owner' (read/test invariant)", async () => {
    const portfolio = (await request(app).get("/api/portfolio")).body;
    const roleIds = new Set((await request(app).get("/api/agents")).body.roles.map((r) => r.id));
    roleIds.add("owner");
    for (const p of portfolio.projects) {
      if (p.sponsor != null) expect(roleIds.has(p.sponsor)).toBe(true);
      if (p.project_manager != null) expect(roleIds.has(p.project_manager)).toBe(true);
      if (p.origin_request != null) expect(typeof p.origin_request).toBe("string");
      if (p.raci) {
        for (const role of [...(p.raci.consulted || []), ...(p.raci.informed || [])]) {
          expect(roleIds.has(role)).toBe(true);
        }
      }
      // ADR-011: a stakeholder `role` and a risk `owner`, WHEN present, must
      // resolve to a real role id (a stakeholder's free-text `name` may be an
      // external human with no id and is NOT checked).
      for (const s of p.stakeholders || []) {
        if (s.role != null) expect(roleIds.has(s.role), `stakeholder role ${s.role}`).toBe(true);
      }
      for (const rk of p.risks || []) {
        if (rk.owner != null) expect(roleIds.has(rk.owner), `risk owner ${rk.owner}`).toBe(true);
      }
    }
  });
});

// ---- Part C: portfolio stakeholders[] + risks[] (ADR-011) -----------------
// These arrays are OPTIONAL + additive and DEFERRED in ADR-010 until a project
// has a genuine external stakeholder or open risk. GET /api/portfolio must pass
// them through byte-for-value unchanged (ensureArrays only defaults the
// top-level arrays), and a project WITHOUT them must still load (backward-compat).
describe("GET /api/portfolio - stakeholders[] + risks[] (ADR-011)", () => {
  it("serves prj-operational-system's genuine open risk (the first populated instance)", async () => {
    const p = (await request(app).get("/api/portfolio")).body.projects.find(
      (x) => x.id === "prj-operational-system"
    );
    expect(p).toBeDefined();
    expect(Array.isArray(p.risks)).toBe(true);
    expect(p.risks.length).toBeGreaterThanOrEqual(1);
    const risk = p.risks[0];
    // the real currency-drift risk: medium x high => High severity chip client-side.
    expect(risk.likelihood).toBe("medium");
    expect(risk.impact).toBe("high");
    expect(risk.status).toBe("mitigating");
    expect(risk.owner).toBe("cto");
    expect(typeof risk.description).toBe("string");
    expect(risk.description.length).toBeGreaterThan(0);
    // internal OS project: no stakeholder register (sponsor + RACI ARE it).
    expect(p.stakeholders).toBeUndefined();
  });

  it("passes stakeholders[] and risks[] through byte-for-value unchanged (pass-through)", async () => {
    fs.writeFileSync(
      PORTFOLIO_FILE(),
      [
        "version: 1",
        "projects:",
        "  - id: prj-ext",
        "    name: External Stakeholder Project",
        "    department: career-delivery",
        "    owner: application-writer",
        "    accountable: cto",
        "    goal: land the offer",
        "    status: in_progress",
        "    stakeholders:",
        "      - name: Hiring manager (Acme)", // external human: no role id, name is the identity
        "        interest: high",
        "        influence: high",
        "        engagement: neutral",
        "      - name: Referrer",
        "        role: owner", // when set, a real role id / 'owner'
        "        interest: medium",
        "        influence: low",
        "    risks:",
        "      - id: risk-timeline",
        "        description: The posting closes in five days.",
        "        likelihood: high",
        "        impact: high",
        "        status: open",
        "        mitigation: Prioritize the tailoring pass.",
        "        owner: cto",
        "milestones: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const p = (await request(app).get("/api/portfolio")).body.projects.find((x) => x.id === "prj-ext");
    expect(p).toBeDefined();
    expect(p.stakeholders).toEqual([
      { name: "Hiring manager (Acme)", interest: "high", influence: "high", engagement: "neutral" },
      { name: "Referrer", role: "owner", interest: "medium", influence: "low" },
    ]);
    expect(p.risks).toEqual([
      {
        id: "risk-timeline",
        description: "The posting closes in five days.",
        likelihood: "high",
        impact: "high",
        status: "open",
        mitigation: "Prioritize the tailoring pass.",
        owner: "cto",
      },
    ]);
  });

  it("passes a project WITHOUT stakeholders/risks through with neither injected (backward-compat)", async () => {
    fs.writeFileSync(
      PORTFOLIO_FILE(),
      [
        "version: 1",
        "projects:",
        "  - id: prj-noreg",
        "    name: No Register Project",
        "    department: engineering",
        "    owner: cto",
        "    accountable: cto",
        "    goal: minimal",
        "    status: done",
        "milestones: []",
        "",
      ].join("\n"),
      "utf8"
    );
    const p = (await request(app).get("/api/portfolio")).body.projects.find((x) => x.id === "prj-noreg");
    expect(p).toBeDefined();
    expect(p.stakeholders).toBeUndefined();
    expect(p.risks).toBeUndefined();
  });
});
