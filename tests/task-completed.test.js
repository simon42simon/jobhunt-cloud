import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDateISO } from "../server/lib.js";

// Server-stamped task completion date (ADR-013). Contract under test
// (server/index.js applyTaskFields):
//   - `completed` (YYYY-MM-DD, LOCAL date) is present IFF the task is currently
//     in the board's terminal "done" column.
//   - It is stamped ONLY on the TRANSITION into done (comparing the PRIOR
//     status), so an unrelated PATCH on an already-done task - even one that
//     re-sends status:"done" - never re-stamps or fabricates a date.
//   - It is cleared on any move OUT of done (including to the terminal-but-not-
//     done "canceled" status).
//   - It is server-managed + UNFORGEABLE: `completed` is not in the write
//     whitelist, so a client-supplied value in the body is never trusted.
//   - A task that never touches done is byte-preserved (no `completed` key).
//
// Hermetic: own fixture tasks.yaml in a temp docs dir (JOBHUNT_DOCS_DIR seam),
// same pattern as tests/task-comments.test.js - the committed docs/ is never
// read or written.

let app;
let tmpRoot;
let docsDir;
let jobsDir;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TODO_ID = "t-todo-target"; // starts non-done; the stamp/clear subject
const LEGACY_DONE_ID = "t-legacy-done"; // already done, NO completed key (legacy)
const PLAIN_ID = "t-never-done"; // never touches done; byte-preservation subject

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
    `  - id: ${TODO_ID}`,
    "    title: Task that will move in and out of done",
    "    epic: testing",
    "    priority: medium",
    "    status: todo",
    "    created: '2026-07-01'",
    `  - id: ${LEGACY_DONE_ID}`,
    "    title: Legacy task already done with no completed key",
    "    epic: testing",
    "    priority: medium",
    "    status: done",
    "    created: '2026-06-20'",
    `  - id: ${PLAIN_ID}`,
    "    title: Task that never touches done",
    "    epic: testing",
    "    priority: low",
    "    status: backlog",
    "    created: '2026-07-01'",
    "",
  ].join("\n");
  fs.writeFileSync(tasksFile(), yaml, "utf8");
}

// Read the raw tasks.yaml block for one task id (from its id line to the next
// task's id line, or EOF) so a test can assert on-disk key presence/absence.
function rawBlockFor(id, ...otherIds) {
  const raw = fs.readFileSync(tasksFile(), "utf8");
  const start = raw.indexOf(`id: ${id}`);
  if (start === -1) return "";
  let end = raw.length;
  for (const other of otherIds) {
    const at = raw.indexOf(`id: ${other}`);
    if (at > start && at < end) end = at;
  }
  return raw.slice(start, end);
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-task-completed-"));
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

describe("PATCH into done stamps completed (local date)", () => {
  it("stamps completed = today's LOCAL date on the transition into done, persisted to disk", async () => {
    const today = localDateISO();
    const res = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.completed).toBe(today);
    expect(res.body.completed).toMatch(ISO_DATE);

    // survives a reload from disk, not just the handler echo.
    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === TODO_ID);
    expect(saved.completed).toBe(today);
    expect(rawBlockFor(TODO_ID, LEGACY_DONE_ID, PLAIN_ID)).toMatch(/completed:/);
  });

  it("stamps completed when a task is CREATED directly as done (POST)", async () => {
    const today = localDateISO();
    const res = await request(app).post("/api/tasks").send({ title: "born done", status: "done" });
    expect(res.status).toBe(201);
    expect(res.body.completed).toBe(today);

    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === res.body.id);
    expect(saved.completed).toBe(today);
  });
});

describe("PATCH out of done clears completed", () => {
  it("deletes completed when a done task moves to a non-done status", async () => {
    const done = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });
    expect(done.body.completed).toBe(localDateISO());

    const reopened = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "todo" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.completed).toBeUndefined();

    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === TODO_ID);
    expect(saved.completed).toBeUndefined();
    // and the key is gone from disk, not written as `completed: null`.
    expect(rawBlockFor(TODO_ID, LEGACY_DONE_ID, PLAIN_ID)).not.toMatch(/completed:/);
  });

  it("clears completed on a move to 'canceled' (terminal but NOT done)", async () => {
    await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });
    const canceled = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "canceled" });

    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe("canceled");
    expect(canceled.body.completed).toBeUndefined();
  });

  it("re-opening then re-closing re-stamps completed fresh (present <=> currently done)", async () => {
    await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" }); // done: stamped
    const reopened = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "todo" }); // cleared
    expect(reopened.body.completed).toBeUndefined();

    const reclosed = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" }); // re-stamped
    expect(reclosed.status).toBe(200);
    expect(reclosed.body.completed).toBe(localDateISO());
  });
});

describe("PATCH that does not change status leaves completed untouched", () => {
  it("an unrelated field PATCH on a freshly-done task keeps completed unchanged", async () => {
    const done = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });
    const stamped = done.body.completed;
    expect(stamped).toBe(localDateISO());

    const patched = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ priority: "high" });
    expect(patched.status).toBe(200);
    expect(patched.body.priority).toBe("high");
    expect(patched.body.completed).toBe(stamped); // unchanged
  });
});

describe("an already-done task is not re-stamped / fabricated on an unrelated PATCH", () => {
  it("does NOT fabricate completed for a legacy already-done task on an unrelated field PATCH", async () => {
    // t-legacy-done starts done with NO completed key. Changing only priority
    // must not back-date a completion we never observed.
    const res = await request(app).patch(`/api/tasks/${LEGACY_DONE_ID}`).send({ priority: "high" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.completed).toBeUndefined();

    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === LEGACY_DONE_ID);
    expect(saved.completed).toBeUndefined();
    expect(rawBlockFor(LEGACY_DONE_ID, PLAIN_ID)).not.toMatch(/completed:/);
  });

  it("re-sending status:'done' to an already-done task does NOT stamp (prior status was already done)", async () => {
    // The transition guard compares the PRIOR status: done -> done is not a
    // transition into done, so no fabrication even when status is in the body.
    const res = await request(app)
      .patch(`/api/tasks/${LEGACY_DONE_ID}`)
      .send({ status: "done", priority: "low" });
    expect(res.status).toBe(200);
    expect(res.body.completed).toBeUndefined();
  });
});

describe("completed is server-managed and unforgeable", () => {
  it("ignores a client-supplied completed in the body on the transition into done (uses the server clock)", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TODO_ID}`)
      .send({ status: "done", completed: "2000-01-01" });

    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(localDateISO());
    expect(res.body.completed).not.toBe("2000-01-01");
  });

  it("ignores a client-supplied completed with no status change (cannot be set directly)", async () => {
    const done = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });
    const stamped = done.body.completed;

    const forged = await request(app).patch(`/api/tasks/${TODO_ID}`).send({ completed: "1999-12-31" });
    expect(forged.status).toBe(200);
    expect(forged.body.completed).toBe(stamped); // unchanged, not the forged value
    expect(forged.body.completed).not.toBe("1999-12-31");
  });

  it("cannot set completed at CREATION via the POST body (server ignores it on a non-done create)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "forged create", status: "todo", completed: "1990-01-01" });
    expect(res.status).toBe(201);
    expect(res.body.completed).toBeUndefined(); // not done -> no completed, forged value ignored
  });
});

describe("byte-preservation: a task that never touches done stays clean", () => {
  it("never writes a completed key for a task moved only among non-done statuses", async () => {
    // backlog -> todo -> in_progress: no `done` ever, so no `completed` ever.
    await request(app).patch(`/api/tasks/${PLAIN_ID}`).send({ status: "todo" });
    const res = await request(app).patch(`/api/tasks/${PLAIN_ID}`).send({ status: "in_progress", priority: "high" });
    expect(res.status).toBe(200);
    expect(res.body.completed).toBeUndefined();

    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === PLAIN_ID);
    expect(saved.completed).toBeUndefined();
    expect(rawBlockFor(PLAIN_ID)).not.toMatch(/completed:/);
  });

  it("leaves the other tasks untouched when one task is stamped (no collateral completed keys)", async () => {
    await request(app).patch(`/api/tasks/${TODO_ID}`).send({ status: "done" });

    const list = (await request(app).get("/api/tasks")).body.tasks;
    expect(list.find((t) => t.id === LEGACY_DONE_ID).completed).toBeUndefined();
    expect(list.find((t) => t.id === PLAIN_ID).completed).toBeUndefined();
  });
});
