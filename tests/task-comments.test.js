import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Task comments: an append-only { author, ts, body } log on a ticket, written
// by the assess-ticket routine (and any future thread) through the task API.
// Contract under test (server/index.js):
//   - loadTasks normalizes a missing / non-array `comments` to [] on READ, and
//     saveTasks strips the empty ones on WRITE, so the API always serves an
//     array while tasks.yaml never gains `comments: []` noise.
//   - POST /api/tasks accepts a whole `comments` array at CREATION only
//     (coerceComments: invalid entries dropped, ts kept when supplied, else
//     server-stamped).
//   - PATCH /api/tasks/:id accepts `comment: { author, body }` - the ONLY way
//     to grow the log after creation. The server stamps ts. A malformed
//     payload is a loud 400 and persists nothing. There is deliberately NO
//     whole-array `comments` replace on PATCH, so history is append-only by
//     construction.
//
// Hermetic: own fixture tasks.yaml in a temp docs dir (JOBHUNT_DOCS_DIR seam),
// same pattern as tests/work-ticket.test.js - the committed docs/ is never
// read or written.

let app;
let tmpRoot;
let docsDir;
let jobsDir;

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEGACY_ID = "t-legacy-no-comments";
const MANGLED_ID = "t-hand-edited-comments";

function tasksFile() {
  return path.join(docsDir, "tasks.yaml");
}

function writeTasksFixture() {
  const yaml = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${LEGACY_ID}`,
    "    title: Legacy task with no comments key",
    "    detail: Exists to prove read-side normalization and disk-side keylessness.",
    "    epic: testing",
    "    priority: medium",
    "    status: todo",
    "    created: '2026-07-01'",
    `  - id: ${MANGLED_ID}`,
    "    title: Task whose comments value was hand-edited into a non-array",
    "    epic: testing",
    "    priority: low",
    "    status: backlog",
    "    created: '2026-07-01'",
    "    comments: oops-not-an-array",
    "",
  ].join("\n");
  fs.writeFileSync(tasksFile(), yaml, "utf8");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-task-comments-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  writeTasksFixture();

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => writeTasksFixture());

describe("comments normalization (read [] / keyless disk)", () => {
  it("serves comments: [] for a legacy task with no comments key", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const legacy = res.body.tasks.find((t) => t.id === LEGACY_ID);
    expect(legacy).toBeDefined();
    expect(legacy.comments).toEqual([]);
  });

  it("serves comments: [] for a hand-edited non-array comments value", async () => {
    const res = await request(app).get("/api/tasks");
    const mangled = res.body.tasks.find((t) => t.id === MANGLED_ID);
    expect(mangled).toBeDefined();
    expect(mangled.comments).toEqual([]);
  });

  it("never writes `comments: []` noise into tasks.yaml on an unrelated save", async () => {
    // POST triggers a full loadTasks -> saveTasks round-trip of every task.
    const created = await request(app).post("/api/tasks").send({ title: "unrelated write" });
    expect(created.status).toBe(201);
    // API response shape: even a comment-less new task serves comments: [].
    expect(created.body.comments).toEqual([]);

    const raw = fs.readFileSync(tasksFile(), "utf8");
    // The read-side normalization must not leak to disk - for the legacy task,
    // the new task, or anything else.
    expect(raw).not.toMatch(/comments:\s*\[\]/);
    // The legacy task's record stays keyless (match the YAML key, not the
    // substring - the fixture id/title themselves contain "comments").
    const legacyBlock = raw.slice(raw.indexOf(LEGACY_ID), raw.indexOf(MANGLED_ID));
    expect(legacyBlock).not.toMatch(/^\s*comments:/m);
  });
});

describe("POST /api/tasks - comments accepted at creation", () => {
  it("persists valid entries; server-stamps a missing ts; keeps a supplied ts", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({
        title: "ticket with initial comments",
        comments: [
          { author: "owner", body: "please look at this" }, // no ts -> stamped
          { author: "cto", ts: "2026-07-01T10:00:00.000Z", body: "noted" }, // kept
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.comments).toHaveLength(2);
    expect(res.body.comments[0].author).toBe("owner");
    expect(res.body.comments[0].body).toBe("please look at this");
    expect(res.body.comments[0].ts).toMatch(ISO_TS);
    expect(res.body.comments[1]).toEqual({
      author: "cto",
      ts: "2026-07-01T10:00:00.000Z",
      body: "noted",
    });

    // survives a reload from disk, not just the handler echo.
    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === res.body.id);
    expect(saved.comments).toHaveLength(2);
    expect(saved.comments[1].body).toBe("noted");
  });

  it("drops invalid entries (missing author, blank body, non-object) instead of writing a broken shape", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({
        title: "mostly invalid comments",
        comments: [
          { body: "no author" },
          { author: "cto", body: "   " },
          "just a string",
          null,
          { author: "cto", body: "the one valid entry" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].author).toBe("cto");
    expect(res.body.comments[0].body).toBe("the one valid entry");
  });

  it("an all-invalid comments array leaves the task comment-less ([] served, keyless on disk)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "nothing valid", comments: ["nope", { author: "" }] });

    expect(res.status).toBe(201);
    expect(res.body.comments).toEqual([]);
    const raw = fs.readFileSync(tasksFile(), "utf8");
    const block = raw.slice(raw.indexOf(res.body.id));
    expect(block).not.toContain("comments");
  });
});

describe("PATCH /api/tasks/:id - append-comment operation", () => {
  it("appends with a server-set ts (a client-supplied ts is ignored, never forged into history)", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({ comment: { author: "cto", body: "assessment: valid", ts: "1999-01-01T00:00:00.000Z" } });

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(1);
    const c = res.body.comments[0];
    expect(c.author).toBe("cto");
    expect(c.body).toBe("assessment: valid");
    expect(c.ts).toMatch(ISO_TS);
    expect(c.ts).not.toBe("1999-01-01T00:00:00.000Z"); // server clock, not the caller's
  });

  it("appends, never replaces: a second comment keeps the first, in order, persisted to disk", async () => {
    await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({ comment: { author: "cto", body: "first: assessment + plan" } });
    const second = await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({ comment: { author: "owner", body: "second: thanks" } });

    expect(second.status).toBe(200);
    expect(second.body.comments).toHaveLength(2);
    expect(second.body.comments[0].body).toBe("first: assessment + plan");
    expect(second.body.comments[1].body).toBe("second: thanks");

    // reload from disk
    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === LEGACY_ID);
    expect(saved.comments.map((c) => c.body)).toEqual(["first: assessment + plan", "second: thanks"]);
  });

  it.each([
    ["a bare string", "not an object"],
    ["an array", [{ author: "cto", body: "smuggled" }]],
    ["an empty object", {}],
    ["a missing body", { author: "cto" }],
    ["a blank author", { author: "   ", body: "content" }],
    ["a non-string body", { author: "cto", body: 42 }],
  ])("400s %s and persists nothing", async (_label, comment) => {
    const before = fs.readFileSync(tasksFile(), "utf8");
    const res = await request(app).patch(`/api/tasks/${LEGACY_ID}`).send({ comment });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comment/i);
    // fail-safe: the rejection fired before any save - the SoT is untouched.
    expect(fs.readFileSync(tasksFile(), "utf8")).toBe(before);
  });

  it("ignores a whole-array `comments` key on PATCH (append-only by construction)", async () => {
    await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({ comment: { author: "cto", body: "the history to protect" } });

    // attempt 1: clear the log. attempt 2: replace it wholesale.
    const cleared = await request(app).patch(`/api/tasks/${LEGACY_ID}`).send({ comments: [] });
    expect(cleared.status).toBe(200);
    const replaced = await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({ comments: [{ author: "mallory", ts: "2020-01-01T00:00:00.000Z", body: "rewritten" }] });
    expect(replaced.status).toBe(200);

    const list = (await request(app).get("/api/tasks")).body.tasks;
    const saved = list.find((t) => t.id === LEGACY_ID);
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0].body).toBe("the history to protect");
  });

  it("still applies the other whitelisted fields sent alongside a valid comment (one PATCH, as assess-ticket does)", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${LEGACY_ID}`)
      .send({
        comment: { author: "cto", body: "valid; plan below; - [ ] subtask" },
        owner: "software-architect",
        priority: "high",
        status: "todo",
      });

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.owner).toBe("software-architect");
    expect(res.body.priority).toBe("high");
    expect(res.body.status).toBe("todo");
  });
});
