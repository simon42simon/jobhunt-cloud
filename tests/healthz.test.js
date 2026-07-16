// RC-3 / SIM-87 I8 - the container liveness probe.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app, tmp;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "healthz-"));
  const jobsDir = path.join(tmp, "Jobs");
  const docsDir = path.join(tmp, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("GET /healthz", () => {
  it("returns 200 with mode + store, and bypasses the /api auth gate (no /api prefix)", async () => {
    const r = await request(app).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.mode).toBe("real");
    expect(r.body.store).toBe("file");
  });
});
