import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// t-1783192842197 (QA regression sweep, v0.18.0): a malformed JSON request body
// used to throw inside express.json() and fall through to EXPRESS'S OWN
// default error handler - a full HTML page with a raw stack trace, including
// absolute local filesystem paths (…\node_modules\body-parser\lib\types\
// json.js:92:19). That is a clean disclosure bug even though the loopback-only
// bind bounds the blast radius today (DATA_CONTRACT.md), and it breaks the
// "every endpoint answers a clean JSON {error}" contract every other route in
// server/index.js already follows. This proves the fix: a bad body now gets a
// small, clean 400 JSON error, with no stack trace and no path disclosure, on
// a representative POST endpoint (/api/tasks - the exact repro from the
// ticket) AND on a second, unrelated POST endpoint, to prove the middleware is
// global (registered once, catches every route) rather than route-specific.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
// ADR-023: live board files left docs/ for the data zone; suites overlay the
// committed synthetic fixtures so the server boots against tracked test data.
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

let app;
let tmpRoot;
let docsDir;
let jobsDir;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-json-err-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
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

// A local filesystem path disclosure looks like a Windows drive letter
// ("C:\") or a node_modules segment anywhere in the body - either is a leak.
function leaksFilesystemPaths(text) {
  return /node_modules/i.test(text) || /[A-Za-z]:[\\/]/.test(text);
}

describe("malformed JSON body -> clean 400 JSON error (not an HTML stack trace)", () => {
  it("POST /api/tasks with a malformed body: 400, application/json, no stack trace, no paths", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");

    const raw = res.text || JSON.stringify(res.body);
    expect(leaksFilesystemPaths(raw)).toBe(false);
    expect(raw).not.toMatch(/<!DOCTYPE/i);
    expect(raw).not.toMatch(/<pre>/i);
    expect(raw).not.toMatch(/SyntaxError/);
  });

  it("is a GLOBAL error handler, not one route's fix: a second POST endpoint is covered too", async () => {
    const res = await request(app)
      .post("/api/discovery/pursue")
      .set("Content-Type", "application/json")
      .send("{ this is not json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "invalid JSON body" });
    expect(leaksFilesystemPaths(res.text || "")).toBe(false);
  });

  it("does not disturb a WELL-FORMED body (no false positives)", async () => {
    const res = await request(app).post("/api/tasks").send({ title: "A well-formed ticket" });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("A well-formed ticket");
  });
});
