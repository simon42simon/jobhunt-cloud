import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Server SSE consolidation (ticket t-1783183576563): every broadcast now carries
// a discriminant `type`, and task WRITES - which live in docs/tasks.yaml, OUTSIDE
// the JOBS_DIR file watcher - emit a typed `tasks-changed` frame so the client can
// refresh off a real signal instead of a poll. This proves the frame is actually
// pushed on the /api/stream wire. Uses the same throwaway-docs seam as
// tests/tasks.test.js (JOBHUNT_DOCS_DIR) so the committed tasks.yaml is untouched.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

let app;
let tmpRoot;
let docsDir;
let jobsDir;

function restoreDocs() {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-sse-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  restoreDocs();
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

beforeEach(() => restoreDocs());

// Open an SSE client against a real ephemeral listener, wait until it is
// registered (the ": connected" preamble arrives), run `action`, and resolve with
// the concatenated `data:` payloads seen in the window.
async function captureBroadcast(action) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();

  let received = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      received += chunk;
    });
  });

  const waitFor = async (pred, timeout = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timeout waiting; received: ${JSON.stringify(received)}`);
  };

  try {
    await waitFor(() => received.includes(": connected")); // client is registered
    await action();
    await waitFor(() => received.includes("data:")); // a broadcast frame landed
    await new Promise((r) => setTimeout(r, 30)); // let any trailing frame flush
    return received;
  } finally {
    req.destroy();
    await new Promise((r) => server.close(r));
  }
}

describe("typed SSE broadcasts on task writes", () => {
  it("POST /api/tasks pushes a tasks-changed frame", async () => {
    const frames = await captureBroadcast(() =>
      request(app).post("/api/tasks").send({ title: "sse ping" }).expect(201),
    );
    expect(frames).toContain('"type":"tasks-changed"');
  });

  it("PATCH /api/tasks/:id pushes a tasks-changed frame", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "to patch" }).expect(201);
    const frames = await captureBroadcast(() =>
      request(app).patch(`/api/tasks/${created.body.id}`).send({ status: "todo" }).expect(200),
    );
    expect(frames).toContain('"type":"tasks-changed"');
  });

  it("DELETE /api/tasks/:id pushes a tasks-changed frame", async () => {
    const created = await request(app).post("/api/tasks").send({ title: "to delete" }).expect(201);
    const frames = await captureBroadcast(() =>
      request(app).delete(`/api/tasks/${created.body.id}`).expect(200),
    );
    expect(frames).toContain('"type":"tasks-changed"');
  });

  it("every pushed frame is a JSON object carrying a string `type`", async () => {
    const frames = await captureBroadcast(() =>
      request(app).post("/api/tasks").send({ title: "shape check" }).expect(201),
    );
    // Parse each `data:` line the same way the client (parseEvent) does.
    const payloads = frames
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length).trim()));
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(typeof p).toBe("object");
      expect(typeof p.type).toBe("string");
    }
  });
});
