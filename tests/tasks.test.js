import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Execution-pillar task WRITES (POST / PATCH /api/tasks). These persist to
// tasks.yaml, so the app is pointed at a THROWAWAY copy of docs/ via the new
// JOBHUNT_DOCS_DIR seam - the committed docs/tasks.yaml is never mutated. Each
// test re-copies the committed docs (beforeEach) so the real tasks are fresh and
// no test can bleed into another (FIRST: Isolated, Repeatable).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
// ADR-023: live board files left docs/ for the data zone; suites overlay the
// committed synthetic fixtures so the server boots against tracked test data.
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

let app;
let tmpRoot; // parent of the throwaway docs + jobs dirs
let docsDir; // throwaway copy of docs/ (the JOBHUNT_DOCS_DIR target)
let jobsDir; // throwaway (empty) Jobs fixture - app boot resolves a jobs dir

function restoreDocs() {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-docs-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  restoreDocs();
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir; // the seam under test - never the real docs/
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
  expect(fs.existsSync(path.join(docsDir, "tasks.yaml"))).toBe(true);
});

describe("POST /api/tasks (Execution-pillar fields)", () => {
  it("requires a title", async () => {
    const res = await request(app).post("/api/tasks").send({ detail: "no title here" });
    expect(res.status).toBe(400);
  });

  it("accepts the new fields, sanitizes the id-typed ones, keeps text verbatim, and survives a GET round-trip", async () => {
    const body = {
      title: "[ENG-M1-T1] Add portfolio endpoint (so the execution layer is readable)",
      project: "PRJ-Eng-PM-Layer", // uppercase -> sanitized
      milestone: "prj-eng-pm-layer-m1", // already clean -> passthrough
      owner: "Software Architect", // spaces removed, lowercased
      delegated_by: "CTO!", // special char stripped
      wbs: "1.2.3", // dotted id -> passthrough
      acceptance: "npm run check green; changelog updated; headline path documented",
      user_story: "As a developer, I want the portfolio served, so projects render in the app",
    };

    const res = await request(app).post("/api/tasks").send(body);
    expect(res.status).toBe(201);

    // id-typed fields run through sanitizeId.
    expect(res.body.project).toBe("prj-eng-pm-layer");
    expect(res.body.milestone).toBe("prj-eng-pm-layer-m1");
    expect(res.body.owner).toBe("softwarearchitect");
    expect(res.body.delegated_by).toBe("cto");
    expect(res.body.wbs).toBe("1.2.3");

    // text fields are written verbatim.
    expect(res.body.title).toBe(body.title);
    expect(res.body.acceptance).toBe(body.acceptance);
    expect(res.body.user_story).toBe(body.user_story);

    // and they survive a reload from disk (not just echoed by the handler).
    const list = await request(app).get("/api/tasks");
    const saved = list.body.tasks.find((t) => t.id === res.body.id);
    expect(saved).toBeDefined();
    expect(saved).toMatchObject({
      project: "prj-eng-pm-layer",
      milestone: "prj-eng-pm-layer-m1",
      owner: "softwarearchitect",
      delegated_by: "cto",
      wbs: "1.2.3",
      acceptance: body.acceptance,
      user_story: body.user_story,
    });
  });
});

describe("PATCH /api/tasks/:id (whitelist + sanitize parity with create)", () => {
  it("adds and then changes milestone + owner, sanitizing and persisting both", async () => {
    const list = await request(app).get("/api/tasks");
    const target = list.body.tasks[0];
    expect(target).toBeDefined();

    // add the refs (uppercase / spaced -> sanitized).
    const added = await request(app)
      .patch(`/api/tasks/${target.id}`)
      .send({ owner: "Software Architect", milestone: "PRJ-Eng-PM-Layer-M1" });
    expect(added.status).toBe(200);
    expect(added.body.owner).toBe("softwarearchitect");
    expect(added.body.milestone).toBe("prj-eng-pm-layer-m1");

    // persisted to disk.
    const afterAdd = await request(app).get("/api/tasks");
    const savedAdd = afterAdd.body.tasks.find((t) => t.id === target.id);
    expect(savedAdd.owner).toBe("softwarearchitect");
    expect(savedAdd.milestone).toBe("prj-eng-pm-layer-m1");

    // change one of them (still sanitized).
    const changed = await request(app).patch(`/api/tasks/${target.id}`).send({ owner: "CTO" });
    expect(changed.status).toBe(200);
    expect(changed.body.owner).toBe("cto");

    const afterChange = await request(app).get("/api/tasks");
    expect(afterChange.body.tasks.find((t) => t.id === target.id).owner).toBe("cto");
  });
});

describe("write tolerance + isolation", () => {
  it("accepts a task whose project ref does not resolve (integrity is a read invariant, not a write 400)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "ghost-ref task", project: "no-such-project-xyz" });
    expect(res.status).toBe(201);
    expect(res.body.project).toBe("no-such-project-xyz");
  });

  it("leaves every other task byte-for-value identical after a write (no collateral edits)", async () => {
    const before = (await request(app).get("/api/tasks")).body.tasks;
    expect(before.length).toBeGreaterThan(0);

    const created = await request(app).post("/api/tasks").send({ title: "isolated new task" });
    expect(created.status).toBe(201);

    const after = (await request(app).get("/api/tasks")).body.tasks;

    // exactly one task was added.
    expect(after.length).toBe(before.length + 1);

    // every pre-existing task is unchanged, field for field.
    for (const t of before) {
      const match = after.find((a) => a.id === t.id);
      expect(match).toEqual(t);
    }
  });
});

// GET /api/activity reads docs/activity-log.jsonl (the DOCS_DIR seam already
// points at the throwaway copy). The feed is telemetry: a missing file is a
// 200 empty array, malformed lines are silently skipped, and the result is
// newest-first with a 200-record cap. Tests write their own fixture directly.
describe("GET /api/activity", () => {
  // Derive the path at call-time; docsDir is set by beforeAll.
  function actFile() {
    return path.join(docsDir, "activity-log.jsonl");
  }

  it("returns 200 with [] when activity-log.jsonl does not exist (never a 500)", async () => {
    // Don't assume the real docs/ lacks this file - it now accrues genuine
    // agent-activity records, so restoreDocs() may well copy a populated one
    // into the throwaway dir. Force the "missing file" precondition explicitly
    // so this case stays true regardless of the real docs/ state.
    fs.rmSync(actFile(), { force: true });
    expect(fs.existsSync(actFile())).toBe(false);

    const res = await request(app).get("/api/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns records in newest-first order", async () => {
    const lines = [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "run", status: "done" }),
      JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", kind: "run", status: "running" }),
      JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", kind: "delegation", label: "draft-cv" }),
    ];
    fs.writeFileSync(actFile(), lines.join("\n") + "\n", "utf8");

    const res = await request(app).get("/api/activity");

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    // file is oldest-first; response must be newest-first
    expect(res.body[0].ts).toBe("2026-01-03T00:00:00.000Z");
    expect(res.body[1].ts).toBe("2026-01-02T00:00:00.000Z");
    expect(res.body[2].ts).toBe("2026-01-01T00:00:00.000Z");
  });

  it("caps the feed at 200 records and drops the oldest (beyond 200) entries", async () => {
    const totalLines = 210;
    const lines = [];
    for (let i = 1; i <= totalLines; i++) {
      // timestamps spaced 1 minute apart so the ordering is clear
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      lines.push(JSON.stringify({ ts, kind: "run", seq: i }));
    }
    fs.writeFileSync(actFile(), lines.join("\n") + "\n", "utf8");

    const res = await request(app).get("/api/activity");

    expect(res.status).toBe(200);
    // only the last 200 lines are served
    expect(res.body.length).toBe(200);
    // newest-first: seq 210 (last written) is the first record returned
    expect(res.body[0].seq).toBe(210);
    // oldest kept: seq 11 (line 11 of 210); seq 1-10 were dropped
    expect(res.body[199].seq).toBe(11);
  });

  it("skips malformed lines without failing the whole read", async () => {
    const content = [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "run", status: "done" }),
      "not-json-at-all",
      '{"broken":',
      JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", kind: "delegation" }),
    ].join("\n") + "\n";
    fs.writeFileSync(actFile(), content, "utf8");

    const res = await request(app).get("/api/activity");

    expect(res.status).toBe(200);
    // the 2 valid JSON lines survive; the 2 malformed lines are silently dropped
    expect(res.body.length).toBe(2);
    // newest-first: delegation (Jan 2) before run (Jan 1)
    expect(res.body[0].kind).toBe("delegation");
    expect(res.body[1].kind).toBe("run");
  });
});

// Ticket fields added to the task schema: type (text), labels (string[]),
// estimate (finite number), assignee (id-typed), checklist ({text,done}[]).
// Each must round-trip through POST -> GET. Coercion rules: empty arrays and
// non-finite numbers DELETE the key rather than writing a broken shape;
// id-typed fields run through sanitizeId; absent fields are untouched (legacy
// tasks stay byte-identical). Extended statuses (triage/in_review/canceled)
// are valid on both POST and PATCH; invalid statuses on PATCH are ignored.
describe("POST /api/tasks - ticket fields (type / labels / estimate / assignee / checklist)", () => {
  it("type and assignee round-trip through POST and persist through a GET", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "typed task", type: "bug", assignee: "Software Architect" });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("bug");
    // assignee is id-typed: lowercased, whitespace stripped (not hyphenated)
    expect(res.body.assignee).toBe("softwarearchitect");

    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === res.body.id);
    expect(saved.type).toBe("bug");
    expect(saved.assignee).toBe("softwarearchitect");
  });

  it("labels coerces to a clean string[], filtering out empty and null entries", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "labeled task", labels: ["ux", "", "backend", null] });

    expect(res.status).toBe(201);
    expect(res.body.labels).toEqual(["ux", "backend"]);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).labels).toEqual(["ux", "backend"]);
  });

  it("estimate accepts a finite number and persists it", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "estimated task", estimate: 3 });

    expect(res.status).toBe(201);
    expect(res.body.estimate).toBe(3);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).estimate).toBe(3);
  });

  it("checklist coerces to {text,done}[], dropping null, non-object, and empty-text entries", async () => {
    const checklist = [
      { text: "Write tests", done: false },
      { text: "", done: false },   // dropped: blank text
      null,                         // dropped: not an object
      "a string",                   // dropped: not an object
      { text: "Ship it", done: true },
    ];
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "checklist task", checklist });

    expect(res.status).toBe(201);
    expect(res.body.checklist).toEqual([
      { text: "Write tests", done: false },
      { text: "Ship it", done: true },
    ]);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).checklist).toEqual([
      { text: "Write tests", done: false },
      { text: "Ship it", done: true },
    ]);
  });

  it("present-but-empty labels on PATCH deletes the key (no broken shape written)", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "labels to clear", labels: ["old-tag"] });
    expect(created.status).toBe(201);
    expect(created.body.labels).toEqual(["old-tag"]);

    // an empty array coerces to null -> key deleted
    const patched = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ labels: [] });
    expect(patched.status).toBe(200);
    expect(patched.body.labels).toBeUndefined();

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).labels).toBeUndefined();
  });

  it("non-finite estimate on PATCH deletes the key (no broken shape written)", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "estimate to clear", estimate: 5 });
    expect(created.status).toBe(201);
    expect(created.body.estimate).toBe(5);

    // "not-a-number" -> NaN -> !isFinite -> null -> key deleted
    const patched = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ estimate: "not-a-number" });
    expect(patched.status).toBe(200);
    expect(patched.body.estimate).toBeUndefined();

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).estimate).toBeUndefined();
  });

  it("a legacy task created without ticket fields has none of them written (no null/empty keys)", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "plain legacy task", detail: "no fancy fields" });
    expect(created.status).toBe(201);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === created.body.id);
    // none of the new optional keys must appear - not even as null or []
    expect(saved.labels).toBeUndefined();
    expect(saved.estimate).toBeUndefined();
    expect(saved.checklist).toBeUndefined();
    expect(saved.type).toBeUndefined();
    expect(saved.assignee).toBeUndefined();
  });
});

// `source` is the addressed-via-tickets join (docs/product-hub-ia-v2.md
// section 6): a ticket that resolves a review/log finding carries
// `source: "review:<doc-id>"`. It must survive verbatim - it carries ":" and
// "/", which sanitizeId (used for project/milestone/owner/etc.) would strip.
describe("POST /api/tasks and PATCH /api/tasks/:id - source field (addressed-via-tickets join)", () => {
  it("persists `source` verbatim on POST (NOT id-sanitized: keeps ':' and '/')", async () => {
    const source = "review:enablement-reviews/2026-07-01";
    const res = await request(app).post("/api/tasks").send({ title: "ticketed finding", source });

    expect(res.status).toBe(201);
    expect(res.body.source).toBe(source);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).source).toBe(source);
  });

  it("persists `source` verbatim on PATCH, and can change it", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "retarget finding" });
    expect(created.status).toBe(201);

    const first = "review:agent-roster-audit";
    const patched = await request(app).patch(`/api/tasks/${created.body.id}`).send({ source: first });
    expect(patched.status).toBe(200);
    expect(patched.body.source).toBe(first);

    const second = "review:build-log-2026-07-01";
    const repatched = await request(app).patch(`/api/tasks/${created.body.id}`).send({ source: second });
    expect(repatched.status).toBe(200);
    expect(repatched.body.source).toBe(second);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).source).toBe(second);
  });

  it("a legacy task created without `source` has no source key written (no null/empty noise)", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "plain task, no source" });
    expect(created.status).toBe(201);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).source).toBeUndefined();
  });
});

describe("Extended and invalid task status", () => {
  it("accepts 'triage' on POST (extended status, not in board columns)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "triage task", status: "triage" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("triage");

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).status).toBe("triage");
  });

  it("accepts 'in_review' and 'canceled' on PATCH (extended statuses)", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "status target" });
    expect(created.status).toBe(201);

    const reviewed = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: "in_review" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe("in_review");

    const canceled = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: "canceled" });
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe("canceled");
  });

  it("ignores an invalid status on PATCH, leaving the existing status unchanged", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "status guard", status: "todo" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("todo");

    // "nonsense" is not a board column nor an extended status -> ignored
    const patched = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: "nonsense_status" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("todo");

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).status).toBe("todo");
  });
});

// priority + type are closed enums (src/types.ts: priority = high|medium|low,
// TaskType = bug|feature|chore|spike), validated on write the SAME way status is.
// A bad value can never persist and desync from the TS unions. Invalid values are
// IGNORED (like an invalid status); POST re-applies the "medium" priority default.
describe("Task priority + type enum validation", () => {
  it("persists a valid priority and type verbatim (POST + GET round-trip)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "valid enums", priority: "high", type: "feature" });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("high");
    expect(res.body.type).toBe("feature");

    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === res.body.id);
    expect(saved.priority).toBe("high");
    expect(saved.type).toBe("feature");
  });

  it("coerces an invalid priority on POST to the 'medium' default (bad value never persists)", async () => {
    const res = await request(app).post("/api/tasks").send({ title: "bad priority", priority: "urgent" });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("medium"); // 'urgent' is outside the closed union -> default

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).priority).toBe("medium");
  });

  it("drops an invalid type on POST (no bad value written)", async () => {
    const res = await request(app).post("/api/tasks").send({ title: "bad type", type: "epic" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBeUndefined();

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === res.body.id).type).toBeUndefined();
  });

  it("ignores an invalid priority on PATCH, leaving the existing value unchanged", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "priority guard", priority: "low" });
    expect(created.body.priority).toBe("low");

    const patched = await request(app).patch(`/api/tasks/${created.body.id}`).send({ priority: "critical" });
    expect(patched.status).toBe(200);
    expect(patched.body.priority).toBe("low"); // 'critical' rejected -> unchanged

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === created.body.id).priority).toBe("low");
  });

  it("ignores an invalid type on PATCH, leaving the existing value unchanged", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "type guard", type: "bug" });
    expect(created.body.type).toBe("bug");

    const patched = await request(app).patch(`/api/tasks/${created.body.id}`).send({ type: "nonsense" });
    expect(patched.status).toBe(200);
    expect(patched.body.type).toBe("bug");
  });
});
