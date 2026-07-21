import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Clean-repo hermeticity (I9): the curated docs/ taxonomy (governance, briefs/,
// routines/, enablement-reviews/) is deliberately absent from the public
// extraction - the suites asserting on that real content skip there, never fail.
const CURATED_DOCS = fs.existsSync(new URL("../docs/briefs", import.meta.url));

// Spin the real Express app over a throwaway fixture vault (JOBHUNT_TEST skips
// the watcher + port bind; JOBHUNT_JOBS_DIR points it at the fixture).
let app;
let serverMod; // the imported module, for its exported pure helpers
let fixture;

const jobA = [
  "---", "type: job", "role: Alpha Role", "employer: Alpha Co",
  "track: industry_outreach_focused", "fit: strong", "status: lead",
  // deadline far-future ON PURPOSE: a lead with a passed YYYY-MM-DD deadline
  // would be auto-closed by the lazy sweep on the first GET /api/jobs (see
  // tests/auto-close.test.js), silently changing this fixture's semantics.
  "sector: bps", "tailoring: heavy", "deadline: 2099-07-15", "tags: [job]",
  "---", "", "# Alpha Role - Alpha Co", "", "**Lead with:** alpha", "",
].join("\n");

const jobB = [
  "---", "type: job", "role: Beta Role", "employer: Beta Co",
  "track: b2b_gtm_focused", "fit: moderate", "status: queued",
  "sector: private", "tailoring: light", "deadline: 1-yr contract", "tags: [job]",
  "---", "", "# Beta Role - Beta Co", "", "**Lead with:** beta", "",
].join("\n");

const gaps = ["---", "type: gaps", "title: Alpha", "---", "", "# gaps"].join("\n");

function writeFixture() {
  fs.rmSync(fixture, { recursive: true, force: true });
  const a = path.join(fixture, "Alpha Role - Alpha Co");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "job.md"), jobA, "utf8");
  fs.writeFileSync(path.join(a, "gaps.md"), gaps, "utf8"); // must be ignored
  const b = path.join(fixture, "Beta Role - Beta Co");
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, "job.md"), jobB, "utf8");
}

const id = (s) => encodeURIComponent(s);

let findsFile;

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jh-vault-"));
  writeFixture();
  // Pursue resolves discovery provenance through the shared workbook read
  // (t-1783199066654); point it at an empty finds fixture so this suite never
  // shells out to a real python/xlsx (the same seam the sources tests use).
  findsFile = path.join(os.tmpdir(), `jh-vault-finds-${process.pid}.json`);
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  serverMod = await import("../server/index.js");
  app = serverMod.app;
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(findsFile, { force: true });
  } catch {}
});

beforeEach(() => writeFixture());

describe("GET /api/config", () => {
  it("returns the status lifecycle and tracks", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.statuses).toContain("lead");
    expect(Object.keys(res.body.tracks)).toContain("industry_outreach_focused");
  });

  it("declares SSE available on the file backend (SIM-390 item 3)", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.sse).toBe(true); // pg backends declare false - see demo-mode.test.js
  });

  it("declares the SSC Hub URL on the file backend (SIM-426) - local dev, the hub's own machine", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.sscHubUrl).toBe("http://localhost:5185"); // pg backends declare null - see demo-mode.test.js
  });
});

describe("GET /api/jobs/:id/chat (SIM-390 item 4)", () => {
  it("is 200 + empty for an existing job with no transcript", async () => {
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}/chat`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it("404s only for a job that does not exist", async () => {
    const res = await request(app).get(`/api/jobs/${id("No Such Role - Nowhere Co")}/chat`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/jobs", () => {
  it("lists job files, ignores non-job .md, and normalizes dates", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    const alpha = res.body.find((j) => j.id === "Alpha Role - Alpha Co");
    expect(alpha.deadline).toBe("2099-07-15");
    expect(alpha.leadWith).toBe("alpha");
    expect(alpha.trackLabel).toBe("Industry Outreach");
    const beta = res.body.find((j) => j.role === "Beta Role");
    expect(beta.deadline).toBe("1-yr contract");
  });
});

describe("GET /api/jobs/:id surfaces interview-prep docs", () => {
  it("returns prep[] (prep sheet before STAR bank), excluding the job + gaps files", async () => {
    const a = path.join(fixture, "Alpha Role - Alpha Co");
    // Written out of order on disk on purpose - the endpoint must sort the prep
    // sheet (the morning-of read) ahead of the STAR bank (reference).
    fs.writeFileSync(path.join(a, "STAR stories.md"), "# STAR\n- story", "utf8");
    // Prep sheet carries a YAML frontmatter fence (as the coach writes it) - the
    // endpoint must strip it so the inline render is a clean read.
    fs.writeFileSync(
      path.join(a, "Interview prep.md"),
      "---\ntype: interview-prep\nrole: Alpha\n---\n\n# Prep\n- q1",
      "utf8",
    );
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}`);
    expect(res.status).toBe(200);
    const names = res.body.prep.map((p) => p.name);
    expect(names).toEqual(["Interview prep.md", "STAR stories.md"]);
    // Frontmatter stripped, body preserved, no leading blank line.
    expect(res.body.prep[0].content.startsWith("# Prep")).toBe(true);
    expect(res.body.prep[0].content).not.toContain("type: interview-prep");
    // The job file and the gaps note own their own sections - never prep.
    expect(names).not.toContain("gaps.md");
    expect(names).not.toContain("job.md");
  });

  it("prep is [] when the folder has no prep docs", async () => {
    const res = await request(app).get(`/api/jobs/${id("Beta Role - Beta Co")}`);
    expect(res.status).toBe(200);
    expect(res.body.prep).toEqual([]);
  });
});

describe("done flags + dated-copy history (Parts 1-2)", () => {
  it("derives per-action done flags from artifacts/status", async () => {
    const a = path.join(fixture, "Alpha Role - Alpha Co");
    fs.writeFileSync(path.join(a, "Simon Kim - CV - Alpha.pdf"), "%PDF", "utf8");
    fs.writeFileSync(path.join(a, "Interview prep.md"), "# Prep", "utf8");
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}`);
    expect(res.status).toBe(200);
    expect(res.body.draftDone).toBe(true); // a CV exists
    expect(res.body.interviewPrepDone).toBe(true); // a prep doc exists
    expect(res.body.finalizeDone).toBe(false); // status lead, no applied date
    expect(res.body.offerPrepDone).toBe(false);
    expect(res.body.followUpDone).toBe(false);
  });

  it("finalizeDone flips true once the job reached submission (status heuristic)", async () => {
    await request(app).patch(`/api/jobs/${id("Beta Role - Beta Co")}`).send({ status: "submitted" });
    const res = await request(app).get(`/api/jobs/${id("Beta Role - Beta Co")}`);
    expect(res.body.finalizeDone).toBe(true);
  });

  it("finalizeDone is true at the `ready` status (a successful Finalize advanced it there)", async () => {
    await request(app).patch(`/api/jobs/${id("Beta Role - Beta Co")}`).send({ status: "ready" });
    const res = await request(app).get(`/api/jobs/${id("Beta Role - Beta Co")}`);
    expect(res.body.status).toBe("ready");
    expect(res.body.finalizeDone).toBe(true);
  });

  it("a dated regenerate copy is history: not a live artifact, excluded from prep[], kept in Files", async () => {
    const a = path.join(fixture, "Alpha Role - Alpha Co");
    // ONLY dated copies present - they must NOT read as the current CV / prep doc.
    fs.writeFileSync(path.join(a, "Simon Kim - CV - Alpha (2026-07-06).pdf"), "%PDF", "utf8");
    fs.writeFileSync(path.join(a, "Interview prep (2026-07-06).md"), "# old", "utf8");
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}`);
    expect(res.body.hasCV).toBe(false);
    expect(res.body.draftDone).toBe(false);
    expect(res.body.interviewPrepDone).toBe(false);
    expect(res.body.prep).toEqual([]);
    // history is still visible in the raw Files list
    expect(res.body.files.map((f) => f.name)).toContain("Interview prep (2026-07-06).md");
  });
});

describe("interview-prep review loop (Part 3)", () => {
  it("surfaces the feedback note and computes prepRefineReady from mtimes", async () => {
    const a = path.join(fixture, "Alpha Role - Alpha Co");
    const prep = path.join(a, "Interview prep.md");
    const fb = path.join(a, "Interview prep feedback.md");
    fs.writeFileSync(prep, "# Prep", "utf8");
    fs.writeFileSync(fb, "- [x] answered", "utf8");
    // Feedback edited AFTER the prep doc (its mtime beats the newest prep doc).
    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-05T00:00:00Z");
    fs.utimesSync(prep, older, older);
    fs.utimesSync(fb, newer, newer);
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}`);
    expect(res.body.prepFeedback?.name).toBe("Interview prep feedback.md");
    expect(res.body.prepFeedbackAnswered).toBe(true);
    expect(res.body.prepRefineReady).toBe(true);
    // the feedback note is NOT one of the prep deliverables
    expect(res.body.prep.map((p) => p.name)).not.toContain("Interview prep feedback.md");
  });

  it("prepRefineReady is false when the feedback note predates the prep docs", async () => {
    const a = path.join(fixture, "Alpha Role - Alpha Co");
    const prep = path.join(a, "Interview prep.md");
    const fb = path.join(a, "Interview prep feedback.md");
    fs.writeFileSync(prep, "# Prep", "utf8");
    fs.writeFileSync(fb, "- [ ] unanswered", "utf8");
    const oldFb = new Date("2026-07-01T00:00:00Z");
    const newPrep = new Date("2026-07-05T00:00:00Z");
    fs.utimesSync(fb, oldFb, oldFb);
    fs.utimesSync(prep, newPrep, newPrep);
    const res = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}`);
    expect(res.body.prepFeedbackAnswered).toBe(false);
    expect(res.body.prepRefineReady).toBe(false);
  });
});

describe("PUT /api/jobs/:id/file - feedback note + dated-copy guard (Part 3)", () => {
  it("allows writing the interview-prep feedback note", async () => {
    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "Interview prep feedback.md", content: "- [x] done" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(fixture, "Alpha Role - Alpha Co", "Interview prep feedback.md"), "utf8"),
    ).toBe("- [x] done");
  });

  it("rejects a dated regenerate copy (history is never overwritten via this path)", async () => {
    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "Interview prep feedback (2026-07-06).md", content: "x" });
    expect(res.status).toBe(400);
  });

  it("still rejects an arbitrary .md name", async () => {
    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "random-notes.md", content: "x" });
    expect(res.status).toBe(400);
  });
});

describe("per-job assistant chat (Part 4)", () => {
  it("GET returns an empty transcript for a chat-less job, 404 for an unknown job", async () => {
    const ok = await request(app).get(`/api/jobs/${id("Alpha Role - Alpha Co")}/chat`);
    expect(ok.status).toBe(200);
    expect(ok.body.messages).toEqual([]);
    const missing = await request(app).get(`/api/jobs/${id("Nope - Nowhere")}/chat`);
    expect(missing.status).toBe(404);
  });

  it("POST validates before any spawn: 400 on empty message, 404 on unknown job", async () => {
    const empty = await request(app)
      .post(`/api/jobs/${id("Alpha Role - Alpha Co")}/chat`)
      .send({ message: "   " });
    expect(empty.status).toBe(400);
    const missing = await request(app).post(`/api/jobs/${id("Nope - Nowhere")}/chat`).send({ message: "hi" });
    expect(missing.status).toBe(404);
  });

  it("readOnlyAssistantArgs is READ-ONLY + LOCAL: no write/network tool allowed, all hard-denied, MCP disabled", () => {
    const args = serverMod.readOnlyAssistantArgs("hello");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    const denied = args[args.indexOf("--disallowedTools") + 1];
    // Every mutation / exec / delegation / NETWORK tool is hard-denied and never pre-approved.
    for (const w of ["Edit", "Write", "MultiEdit", "Bash", "Task", "WebFetch", "WebSearch"]) {
      expect(allowed).not.toContain(w);
      expect(denied).toContain(w);
    }
    expect(allowed).toContain("Read");
    // No MCP servers may load, so no off-machine MCP tool can ever be inherited.
    expect(args).toContain("--strict-mcp-config");
  });

  it("parseAssistantReply strips a trailing ACTION marker and surfaces only a known routine", () => {
    const known = serverMod.parseAssistantReply(
      "Put your fixes in the feedback note first.\nACTION: interview-prep-refine",
    );
    expect(known.reply).toBe("Put your fixes in the feedback note first.");
    expect(known.suggestedAction).toEqual({ routine: "interview-prep-refine" });

    const none = serverMod.parseAssistantReply("Just an answer, no action.");
    expect(none.suggestedAction).toBeNull();

    // an UNKNOWN routine marker is stripped from the shown reply but never surfaced
    const bogus = serverMod.parseAssistantReply("Answer.\nACTION: delete-everything");
    expect(bogus.suggestedAction).toBeNull();
    expect(bogus.reply).toBe("Answer.");
  });
});

describe("PATCH /api/jobs/:id", () => {
  it("is a byte-identical round-trip (lead -> queued -> lead)", async () => {
    const f = path.join(fixture, "Alpha Role - Alpha Co", "job.md");
    const before = fs.readFileSync(f, "utf8");
    await request(app).patch(`/api/jobs/${id("Alpha Role - Alpha Co")}`).send({ status: "queued" });
    expect(fs.readFileSync(f, "utf8")).toContain("status: queued");
    await request(app).patch(`/api/jobs/${id("Alpha Role - Alpha Co")}`).send({ status: "lead" });
    expect(fs.readFileSync(f, "utf8")).toBe(before);
  });

  it("stamps applied = today (LOCAL date, not UTC) when reaching submitted", async () => {
    // Mirrors lib.js localDateISO: an evening ET submit must not stamp
    // tomorrow's UTC date (the old toISOString behavior this pins against).
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const res = await request(app).patch(`/api/jobs/${id("Beta Role - Beta Co")}`).send({ status: "submitted" });
    expect(res.body.status).toBe("submitted");
    expect(res.body.applied).toBe(today);
  });
});

describe("POST /api/jobs (agent-first intake)", () => {
  it("creates a lead without inventing track/fit and derives tailoring from sector", async () => {
    const res = await request(app).post("/api/jobs").send({ role: "New Role", employer: "New Co", sector: "federal" });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("");
    expect(res.body.fit).toBe("");
    expect(res.body.tailoring).toBe("heavy");
    expect(res.body.status).toBe("lead");
    expect(fs.existsSync(path.join(fixture, "New Role - New Co"))).toBe(true);
  });

  it("rejects a missing role or employer", async () => {
    const res = await request(app).post("/api/jobs").send({ role: "X" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/discovery/pursue", () => {
  it("creates a lead carrying the discovery's track + fit (already assessed)", async () => {
    const res = await request(app).post("/api/discovery/pursue").send({
      title: "Found Role",
      employer: "Found Co",
      track: "public_sector_focused",
      fit: "moderate",
      sector: "provincial",
      deadline: "2026-08-01",
    });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("public_sector_focused");
    expect(res.body.fit).toBe("moderate");
    expect(res.body.status).toBe("lead");
    expect(res.body.deadline).toBe("2026-08-01");
    expect(fs.existsSync(path.join(fixture, "Found Role - Found Co"))).toBe(true);
  });

  it("409s when the lead already exists", async () => {
    const body = { title: "Alpha Role", employer: "Alpha Co" };
    const res = await request(app).post("/api/discovery/pursue").send(body);
    expect(res.status).toBe(409);
  });

  it("carries the discovery Link into the new lead's frontmatter (the link to apply)", async () => {
    const link = "https://jobs.example.com/view/123?ref=abc&x=1";
    const res = await request(app).post("/api/discovery/pursue").send({
      title: "Linked Role",
      employer: "Linked Co",
      link,
    });
    expect(res.status).toBe(201);
    // exposed on the Job object (read path) ...
    expect(res.body.link).toBe(link);
    // ... and written into the job file's frontmatter (the SoT), parseable back.
    const file = path.join(fixture, "Linked Role - Linked Co", "Linked Role.md");
    const raw = fs.readFileSync(file, "utf8");
    const front = raw.split("---")[1];
    expect(front).toContain("link:");
    expect(front).toContain(link);
  });

  // Pursue->queue fast path (ops audit F5, t-1783183576640): the client can ask
  // to land straight in "queued" instead of the default "lead" (TriageInbox
  // requests this for a strong-fit find).
  describe("status fast path", () => {
    it("creates directly in queued when status:'queued' is requested", async () => {
      const res = await request(app).post("/api/discovery/pursue").send({
        title: "Fast Path Role",
        employer: "Fast Co",
        fit: "strong",
        status: "queued",
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("queued");
    });

    it("falls back to lead when status is absent", async () => {
      const res = await request(app).post("/api/discovery/pursue").send({
        title: "No Status Role",
        employer: "No Status Co",
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("lead");
    });

    it("falls back to lead when status is not a recognized value (never a 400 - a convenience default, not a contract)", async () => {
      const res = await request(app).post("/api/discovery/pursue").send({
        title: "Bad Status Role",
        employer: "Bad Status Co",
        status: "offer",
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("lead");
    });
  });
});

// PUT /api/jobs/:id/file writes freeform .md notes (gaps / job-description)
// inside a job folder. The main job file (<Role>.md with type:job) can NEVER be
// written here; arbitrary names, path-traversal attempts, and non-string content
// are all hard 400s. Guards fire before any file system write so a rejection must
// leave the job file byte-identical.
describe("PUT /api/jobs/:id/file", () => {
  it("happy path: writes the gaps file and returns ok with the byte count", async () => {
    const newContent = "# Gaps Analysis\n\nMissing: Python experience.\n";

    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "gaps.md", content: newContent });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.name).toBe("gaps.md");
    expect(res.body.bytes).toBe(Buffer.byteLength(newContent, "utf8"));
    const written = fs.readFileSync(
      path.join(fixture, "Alpha Role - Alpha Co", "gaps.md"),
      "utf8"
    );
    expect(written).toBe(newContent);
  });

  it("(a) rejects the main job file name with 400 and does not modify job.md", async () => {
    const jobPath = path.join(fixture, "Alpha Role - Alpha Co", "job.md");
    const before = fs.readFileSync(jobPath, "utf8");

    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "job.md", content: "HACKED" });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(jobPath, "utf8")).toBe(before);
  });

  it("(b) rejects an arbitrary .md name with 400 and does not modify job.md", async () => {
    const jobPath = path.join(fixture, "Alpha Role - Alpha Co", "job.md");
    const before = fs.readFileSync(jobPath, "utf8");

    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "notes.md", content: "sneaky" });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(jobPath, "utf8")).toBe(before);
  });

  it("(c) rejects a path-traversal name with 400 and does not modify job.md", async () => {
    const jobPath = path.join(fixture, "Alpha Role - Alpha Co", "job.md");
    const before = fs.readFileSync(jobPath, "utf8");

    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "../x.md", content: "escape attempt" });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(jobPath, "utf8")).toBe(before);
  });

  it("(d) rejects non-string content with 400 and does not modify job.md", async () => {
    const jobPath = path.join(fixture, "Alpha Role - Alpha Co", "job.md");
    const before = fs.readFileSync(jobPath, "utf8");

    const res = await request(app)
      .put(`/api/jobs/${id("Alpha Role - Alpha Co")}/file`)
      .send({ name: "gaps.md", content: 42 });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(jobPath, "utf8")).toBe(before);
  });
});

// Input validation on /api/discovery/decide fires BEFORE the Python script is
// invoked, so these tests are safe to run without the Excel workbook present.
describe("POST /api/discovery/decide (input validation)", () => {
  it("returns 400 when title is missing or blank", async () => {
    const res = await request(app)
      .post("/api/discovery/decide")
      .send({ link: "https://example.com", decision: "skip" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it("returns 400 when decision is not one of skip / maybe / pursue / clear", async () => {
    const res = await request(app)
      .post("/api/discovery/decide")
      .send({ title: "Some Job", link: "https://example.com", decision: "invalid-choice" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decision/i);
    // The verb set includes "clear" (t-1783178044080) - the round-trip coverage
    // lives in tests/discovery-decide-clear.test.js.
    expect(res.body.error).toMatch(/clear/);
  });
});

// Read-only org chart, parsed from the committed docs/agents.yaml (app data, not
// the vault). Assertions target structural invariants of the contract, not the
// volatile copy (titles, one_liners, exact role count) which the org edits freely.
describe("GET /api/agents", () => {
  it("returns 200 with groups and roles arrays", async () => {
    const res = await request(app).get("/api/agents");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.length).toBeGreaterThan(0);
  });

  it("includes the cto orchestrator reporting to the owner, fully shaped", async () => {
    const res = await request(app).get("/api/agents");

    const cto = res.body.roles.find((r) => r.id === "cto");
    expect(cto).toBeDefined();
    expect(cto.kind).toBe("orchestrator");
    expect(cto.reports_to).toBe("owner");
    expect(typeof cto.title).toBe("string");
    expect(cto.title.length).toBeGreaterThan(0);
    expect(typeof cto.group).toBe("string");
  });

  it("has exactly one orchestrator across the roster", async () => {
    const res = await request(app).get("/api/agents");

    const orchestrators = res.body.roles.filter((r) => r.kind === "orchestrator");
    expect(orchestrators.length).toBe(1);
  });

  it("resolves every reports_to and group reference to a real id (no dangling refs)", async () => {
    const res = await request(app).get("/api/agents");

    const roleIds = new Set(res.body.roles.map((r) => r.id));
    const groupIds = new Set(res.body.groups.map((g) => g.id));

    for (const r of res.body.roles) {
      // reports_to is null only for the root (owner); otherwise it must point at a real role.
      if (r.reports_to !== null) expect(roleIds.has(r.reports_to)).toBe(true);
      expect(groupIds.has(r.group)).toBe(true);
    }
  });
});

// Execution pillar: the project / milestone portfolio, read from the committed
// docs/portfolio.yaml (these tests never write, so they run over the real docs -
// no JOBHUNT_DOCS_DIR seam needed here). Assertions target the contract's
// structural invariants, not the volatile copy (names, counts, targets).
describe("GET /api/portfolio", () => {
  it("returns 200 with a version and projects + milestones arrays", async () => {
    const res = await request(app).get("/api/portfolio");

    expect(res.status).toBe(200);
    expect(res.body.version).toBeDefined();
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(Array.isArray(res.body.milestones)).toBe(true);
  });

  // The whole point of separate portfolio.yaml / agents.yaml / roadmap.yaml files
  // is that references point UP and must resolve. Integrity is a READ/TEST
  // invariant (writes are tolerant), so this is where a dangling ref gets caught -
  // the analogue of the agents no-dangling-refs check, across all three files.
  it("resolves every project/milestone reference to a real agents.yaml / roadmap.yaml id", async () => {
    const portfolio = (await request(app).get("/api/portfolio")).body;
    const agents = (await request(app).get("/api/agents")).body;
    const roadmap = (await request(app).get("/api/roadmap")).body;

    const projectIds = new Set(portfolio.projects.map((p) => p.id));
    const groupIds = new Set(agents.groups.map((g) => g.id));
    const roleIds = new Set(agents.roles.map((r) => r.id));
    const phaseIds = new Set((roadmap.phases || []).map((ph) => ph.id));

    // Every project points department -> a real group, owner + accountable -> real roles.
    for (const p of portfolio.projects) {
      expect(groupIds.has(p.department)).toBe(true);
      expect(roleIds.has(p.owner)).toBe(true);
      expect(roleIds.has(p.accountable)).toBe(true);
    }

    // Every milestone points project -> a real project, and (if pinned) roadmap_phase -> a real phase.
    for (const m of portfolio.milestones) {
      expect(projectIds.has(m.project)).toBe(true);
      if (m.roadmap_phase != null) expect(phaseIds.has(m.roadmap_phase)).toBe(true);
    }
  });
});

// Docs browser: lists + serves the committed docs/*.md (and docs/routines/,
// docs/briefs/ one level down). Runs over the REAL docs/ - no JOBHUNT_DOCS_DIR
// override in this file - because the point of the backward-compat and
// "known doc" assertions is the actual committed doc set, same as the
// agents/portfolio tests above. Never writes, so this is safe over the real dir.
describe.skipIf(!CURATED_DOCS)("GET /api/docs", () => {
  it("returns 200 with a { name, title, group } array including a top-level and a briefs/ doc", async () => {
    const res = await request(app).get("/api/docs");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const d of res.body) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.title).toBe("string");
      expect(typeof d.group).toBe("string");
    }
    const names = res.body.map((d) => d.name);
    expect(names).toContain("governance");
    expect(names).toContain("briefs/2026-07-01-product-hub-redesign");
  });

  it("never lists the app-data .yaml views (agents/portfolio/roadmap/tasks)", async () => {
    const res = await request(app).get("/api/docs");

    const names = res.body.map((d) => d.name);
    expect(names).not.toContain("agents");
    expect(names).not.toContain("portfolio");
    expect(names).not.toContain("roadmap");
    expect(names).not.toContain("tasks");
    expect(res.body.some((d) => d.name.endsWith(".yaml"))).toBe(false);
  });

  it("only ever assigns a group from the documented sidebar taxonomy", async () => {
    const res = await request(app).get("/api/docs");

    const EXPECTED_GROUPS = [
      "Product",
      "Org & Agents",
      "Routines",
      "Reviews & Logs",
      "Briefs & Debriefs",
      "Releases",
      "Docs",
    ];
    for (const d of res.body) {
      expect(EXPECTED_GROUPS).toContain(d.group);
    }
  });

  it("sorts docs into the refined taxonomy's coherent groups, not a flat catch-all", async () => {
    const res = await request(app).get("/api/docs");
    const groupOf = (name) => res.body.find((d) => d.name === name)?.group;

    // Product: core product docs, including competitive-analysis (moved off Org & Agents).
    expect(groupOf("competitive-analysis")).toBe("Product");
    expect(groupOf("blueprint")).toBe("Product");
    expect(groupOf("governance")).toBe("Product");

    // Org & Agents: living "how we run the org" reference only, not audits.
    expect(groupOf("management-philosophy")).toBe("Org & Agents");
    expect(groupOf("agent-onboarding-checklist")).toBe("Org & Agents");
    expect(groupOf("team-character-sheet-spec")).toBe("Org & Agents");

    // Routines: everything under routines/ gets its own group.
    expect(groupOf("routines/weekly-enablement-review")).toBe("Routines");

    // Reviews & Logs: the dated / point-in-time bucket (audits + build logs).
    expect(groupOf("agent-roster-audit")).toBe("Reviews & Logs");
    expect(groupOf("build-log-2026-07-01")).toBe("Reviews & Logs");

    // Briefs & Debriefs and Releases are unchanged.
    expect(groupOf("briefs/2026-07-01-product-hub-redesign")).toBe("Briefs & Debriefs");
    expect(groupOf("changelog")).toBe("Releases");
  });

  it("gives a known doc a non-empty title (falls back to a prettified filename when there is no H1)", async () => {
    const res = await request(app).get("/api/docs");

    const gov = res.body.find((d) => d.name === "governance");
    expect(gov).toBeDefined();
    expect(typeof gov.title).toBe("string");
    expect(gov.title.length).toBeGreaterThan(0);
  });
});

// GET /api/doc/* replaced the old 3-entry (blueprint/changelog/governance)
// whitelist with a general docs/ + docs/routines/ + docs/briefs/ scan. Every
// path-safety rejection here must be verified NOT to have read anything
// outside docs/ - the assertions check status, never file content, for the
// rejected cases.
describe.skipIf(!CURATED_DOCS)("GET /api/doc/*", () => {
  it("serves a top-level doc by name", async () => {
    const res = await request(app).get("/api/doc/governance");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("governance");
    expect(typeof res.body.content).toBe("string");
    expect(res.body.content.length).toBeGreaterThan(0);
  });

  it("serves a routines/ doc", async () => {
    const res = await request(app).get("/api/doc/routines/weekly-enablement-review");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("routines/weekly-enablement-review");
    expect(res.body.content).toContain("Skill: weekly-enablement-review");
  });

  it("serves a briefs/ doc", async () => {
    const res = await request(app).get("/api/doc/briefs/2026-07-01-product-hub-redesign");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("briefs/2026-07-01-product-hub-redesign");
    expect(res.body.content).toContain("Product Hub redesign");
  });

  it("still resolves the old 3-entry whitelist names (backward compat)", async () => {
    for (const name of ["blueprint", "changelog", "governance"]) {
      const res = await request(app).get(`/api/doc/${name}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(name);
      expect(res.body.content.length).toBeGreaterThan(0);
    }
  });

  it("rejects a too-deep subpath (routines/foo/bar) with 400", async () => {
    const res = await request(app).get("/api/doc/routines/foo/bar");

    expect(res.status).toBe(400);
  });

  it("404s on a well-formed but unknown doc name", async () => {
    const res = await request(app).get("/api/doc/this-doc-does-not-exist-xyz");

    expect(res.status).toBe(404);
  });

  // A literal ".." in the request path never even reaches our route: the HTTP
  // client normalizes the dot-segment before the request is sent, so Express's
  // own router 404s (no route matches "/api/package"). This is a real, useful
  // outer layer, but it is NOT our path-safety guard - the two cases below
  // exercise resolveDocPath directly via a URL-encoded traversal, which the
  // client does NOT normalize (the "%2f" only gets decoded server-side, inside
  // our own containment check).
  it("a plain '../' traversal never reaches 200 (collapsed before routing, falls through to 404)", async () => {
    const res = await request(app).get("/api/doc/../package");

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
  });

  it("rejects a url-encoded traversal ('..%2f..%2fpackage') with 400, never 200", async () => {
    const res = await request(app).get("/api/doc/..%2f..%2fpackage");

    expect(res.status).toBe(400);
  });

  // The key safety case: one encoded ".." would place the resolved path exactly
  // one level above docs/, at the repo's real package.json - a file that
  // actually exists, so a broken guard here would leak real content, not just
  // 404. This is the case flipped in the containment-check bite proof.
  it("rejects a url-encoded one-level traversal to a real file ('..%2fpackage.json') with 400, never leaking its content", async () => {
    const res = await request(app).get("/api/doc/..%2fpackage.json");

    expect(res.status).toBe(400);
    expect(res.body.content).toBeUndefined();
  });
});

// enablement-reviews/ subdir (server/index.js DOC_SUBDIRS -> "Reviews & Logs").
// This describe spins a SECOND app instance bound to a throwaway
// JOBHUNT_DOCS_DIR fixture, via vi.resetModules() + a fresh dynamic import:
// the module's DOCS_DIR is a const bound at import time, and the `app` used by
// every describe above is already bound to the real docs/ (by design - see the
// comment on "GET /api/docs" above), so a fresh import is the only way to get a
// second app pointed at a fixture within this same file. This keeps the
// assertion hermetic and immune to whatever dated file happens to live in the
// real docs/enablement-reviews/ this week (never assert on a literal
// YYYY-MM-DD filename - it breaks the moment a new weekly review is added).
describe("GET /api/docs and /api/doc/* - enablement-reviews subdir", () => {
  let reviewApp;
  let reviewDocsDir;
  const prevDocsDirEnv = process.env.JOBHUNT_DOCS_DIR;

  beforeAll(async () => {
    reviewDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-docs-review-"));
    fs.mkdirSync(path.join(reviewDocsDir, "enablement-reviews"), { recursive: true });
    fs.writeFileSync(
      path.join(reviewDocsDir, "enablement-reviews", "fixture-check.md"),
      "# Fixture enablement review\n\nhermetic fixture content.\n",
      "utf8"
    );
    process.env.JOBHUNT_DOCS_DIR = reviewDocsDir;
    vi.resetModules();
    ({ app: reviewApp } = await import("../server/index.js"));
    process.env.JOBHUNT_DOCS_DIR = prevDocsDirEnv; // restore immediately - DOCS_DIR is already bound
  });

  afterAll(() => {
    try {
      fs.rmSync(reviewDocsDir, { recursive: true, force: true });
    } catch {}
  });

  it("lists a fixture enablement-reviews/ doc under group 'Reviews & Logs'", async () => {
    const res = await request(reviewApp).get("/api/docs");

    const doc = res.body.find((d) => d.name === "enablement-reviews/fixture-check");
    expect(doc).toBeDefined();
    expect(doc.group).toBe("Reviews & Logs");
  });

  it("serves a fixture enablement-reviews/ doc's content by name", async () => {
    const res = await request(reviewApp).get("/api/doc/enablement-reviews/fixture-check");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("enablement-reviews/fixture-check");
    expect(res.body.content).toContain("hermetic fixture content");
  });
});

// `meta` (parsed optional YAML frontmatter, docs/product-hub-ia-v2.md section
// 7 B2 / server/lib.js parseFrontmatter) on GET /api/docs and GET /api/doc/*.
// Hermetic: a fresh app bound to a throwaway JOBHUNT_DOCS_DIR (same pattern as
// the enablement-reviews subdir block above), so this never depends on or
// mutates the committed docs/.
describe("GET /api/docs and GET /api/doc/* - frontmatter meta (hermetic fixture)", () => {
  let metaApp;
  let metaDocsDir;
  const prevDocsDirEnv = process.env.JOBHUNT_DOCS_DIR;

  const fmDoc = [
    "---",
    "type: review",
    "agent: people-enablement",
    "recs: 4",
    "date: 2026-07-01",
    "---",
    "",
    "# Fixture Review With Meta",
    "",
    "some review body content.",
  ].join("\n");

  const plainDoc = "# Fixture Plain Doc\n\nno frontmatter at all.\n";

  beforeAll(async () => {
    metaDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-docs-meta-"));
    fs.writeFileSync(path.join(metaDocsDir, "fixture-with-meta.md"), fmDoc, "utf8");
    fs.writeFileSync(path.join(metaDocsDir, "fixture-plain.md"), plainDoc, "utf8");
    process.env.JOBHUNT_DOCS_DIR = metaDocsDir;
    vi.resetModules();
    ({ app: metaApp } = await import("../server/index.js"));
    process.env.JOBHUNT_DOCS_DIR = prevDocsDirEnv; // restore immediately - DOCS_DIR is already bound
  });

  afterAll(() => {
    try {
      fs.rmSync(metaDocsDir, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/docs includes meta for a doc with frontmatter, and omits it for a plain doc", async () => {
    const res = await request(metaApp).get("/api/docs");

    const withMeta = res.body.find((d) => d.name === "fixture-with-meta");
    expect(withMeta).toBeDefined();
    expect(withMeta.meta).toEqual({ type: "review", agent: "people-enablement", recs: 4, date: "2026-07-01" });
    // title is the BODY's H1, never derived from meta
    expect(withMeta.title).toBe("Fixture Review With Meta");

    const plain = res.body.find((d) => d.name === "fixture-plain");
    expect(plain).toBeDefined();
    expect(plain.meta).toBeUndefined();
    expect(plain.title).toBe("Fixture Plain Doc");
  });

  it("GET /api/doc/:name returns the frontmatter-stripped body as content, plus meta", async () => {
    const res = await request(metaApp).get("/api/doc/fixture-with-meta");

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ type: "review", agent: "people-enablement", recs: 4, date: "2026-07-01" });
    expect(res.body.content).not.toContain("---");
    expect(res.body.content).not.toContain("agent: people-enablement");
    expect(res.body.content.trim()).toBe("# Fixture Review With Meta\n\nsome review body content.");
  });

  it("GET /api/doc/:name omits meta and returns the raw content for a plain doc", async () => {
    const res = await request(metaApp).get("/api/doc/fixture-plain");

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeUndefined();
    expect(res.body.content).toBe(plainDoc);
  });
});

// Robust companion to the fixture-based block above: also assert the invariant
// over whatever is in the REAL docs/enablement-reviews/ right now (there is at
// least one dated weekly review committed there). Deliberately does NOT pin
// the dated filename - that breaks every week a new review lands - it asserts
// the general rule instead, so it stays true regardless of which files exist.
describe.skipIf(!CURATED_DOCS)("GET /api/docs - real enablement-reviews/ docs (robust invariant)", () => {
  it("gives every doc whose name starts with 'enablement-reviews/' the group 'Reviews & Logs'", async () => {
    const res = await request(app).get("/api/docs");

    const reviewDocs = res.body.filter((d) => d.name.startsWith("enablement-reviews/"));
    expect(reviewDocs.length).toBeGreaterThan(0); // there is at least one committed review
    for (const d of reviewDocs) {
      expect(d.group).toBe("Reviews & Logs");
    }
  });
});

// The routine runner is ADR-005's human-gated, broad-scope path; resolveJobFolder
// is its OWN boundary check on the one filesystem path it builds from client
// input (the job folder). A job-scoped run must resolve its jobId to a real folder
// INSIDE Jobs/ - a traversal or unknown id is a 404 that never launches an agent.
describe("POST /api/routines/run (job-folder containment guard)", () => {
  it("404s a traversal jobId before launching any agent", async () => {
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "first-draft-job", jobId: "../../etc" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/job folder not found/i);
  });

  it("404s an unknown (non-existent) jobId", async () => {
    const res = await request(app)
      .post("/api/routines/run")
      .send({ routine: "first-draft-job", jobId: "No Such - Folder" });
    expect(res.status).toBe(404);
  });
});

// YAML read-endpoint normalization: a partial hand-edit that drops an expected
// array key must yield [] not undefined, so ProjectsView / TeamView .map/.filter
// never throws on a mid-edit file. Hermetic: a fresh app bound to a throwaway
// JOBHUNT_DOCS_DIR holding deliberately partial yaml files (same vi.resetModules
// pattern as the meta / enablement-reviews blocks above). A present scalar
// (version / product) is asserted preserved, so normalization only DEFAULTS
// missing keys - it never reshapes present data.
describe("YAML read endpoints normalize a partial file (missing array key -> [])", () => {
  let partialApp;
  let partialDocsDir;
  const prevDocsDirEnv = process.env.JOBHUNT_DOCS_DIR;

  beforeAll(async () => {
    partialDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-docs-partial-"));
    fs.writeFileSync(path.join(partialDocsDir, "portfolio.yaml"), "version: 1\n", "utf8"); // no projects / milestones
    fs.writeFileSync(path.join(partialDocsDir, "agents.yaml"), "version: 1\n", "utf8"); // no groups / roles
    fs.writeFileSync(path.join(partialDocsDir, "roadmap.yaml"), "product: X\n", "utf8"); // no phases
    process.env.JOBHUNT_DOCS_DIR = partialDocsDir;
    vi.resetModules();
    ({ app: partialApp } = await import("../server/index.js"));
    process.env.JOBHUNT_DOCS_DIR = prevDocsDirEnv; // restore immediately - DOCS_DIR is already bound
  });

  afterAll(() => {
    try {
      fs.rmSync(partialDocsDir, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/portfolio defaults missing projects + milestones to [] (and keeps version)", async () => {
    const res = await request(partialApp).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.projects).toEqual([]);
    expect(res.body.milestones).toEqual([]);
  });

  it("GET /api/agents defaults missing groups + roles to []", async () => {
    const res = await request(partialApp).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.roles).toEqual([]);
  });

  it("GET /api/roadmap defaults missing phases to []", async () => {
    const res = await request(partialApp).get("/api/roadmap");
    expect(res.status).toBe(200);
    expect(res.body.phases).toEqual([]);
  });
});
