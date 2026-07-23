// SIM-614 (2026-07-23) - the cloud->vault MIRROR lane (SIM-393 I6) retirement
// guardrail. The owner directed that the OneDrive vault be cut out of the
// jobhunt product loop entirely; this repo's mirror code (ops/mirror-vault.mjs,
// the /api/mirror/* routes, MIRROR_TOKEN/MIRROR_TOKEN_HASH) was deleted rather
// than merely disabled. This is a narrow REPLACEMENT for the deleted
// tests/mirror-endpoints.test.js (behavioral cross-auth matrix, now moot - the
// routes it exercised no longer exist) and tests/mirror-client.test.js (whose
// still-relevant shared-code coverage moved to tests/cloud-client.test.js).
//
// What this guards:
//   1. Every former /api/mirror/* route now 404s (no route registered at all -
//      not a 401/501 from a surviving auth gate).
//   2. MIRROR_TOKEN / MIRROR_TOKEN_HASH is never READ by server/index.js or
//      server/app-mode.js, even if an operator leaves the env var set (grep-
//      level: a stray env var can no longer re-enable anything).
//   3. A demo boot with a leftover MIRROR_TOKEN_HASH in the env does not throw
//      (the isolation axis was removed, not just satisfied) - the behavioral
//      counterpart of guard #2, exercised via the real boot gate.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The regex targets actual ENV ACCESS (`env.MIRROR_TOKEN...` / `process.env.MIRROR_TOKEN...` /
// bracket-indexed `env["MIRROR_TOKEN..."]`), not the bare substring "MIRROR_TOKEN" - both files
// legitimately carry it in EXPLANATORY comments narrating the SIM-614 retirement (this codebase's
// own convention: comments say WHY code no longer exists). What must be zero is a live CODE PATH
// that reads the var, which would mean the retirement was incomplete.
const ENV_READ = /(?:\bprocess\.env|\benv)(?:\.MIRROR_TOKEN\b|\[\s*["'`]MIRROR_TOKEN)/;

describe("grep-level: MIRROR_TOKEN(_HASH) is never READ (as code, not prose) in the live server source", () => {
  it("server/index.js contains no MIRROR_TOKEN env access", () => {
    const src = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
    expect(src).not.toMatch(ENV_READ);
  });

  it("server/app-mode.js contains no MIRROR_TOKEN env access (the isolation axis is gone, not disabled)", () => {
    const src = fs.readFileSync(path.join(ROOT, "server", "app-mode.js"), "utf8");
    expect(src).not.toMatch(ENV_READ);
  });

  it("server/index.js registers no /api/mirror route path", () => {
    const src = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
    expect(src).not.toMatch(/["'`]\/api\/mirror\//);
  });
});

describe("HTTP: every former mirror route now 404s (no route registered)", () => {
  let app, tmpRoot;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-retired-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    // Even a would-be MIRROR_TOKEN_HASH in the env must not resurrect the route -
    // there is no auth gate left to configure; the path is simply unmounted.
    process.env.MIRROR_TOKEN_HASH = "leftover-hash-should-do-nothing";
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });

  afterAll(() => {
    delete process.env.MIRROR_TOKEN_HASH;
  });

  it("404s GET /api/mirror/changes, /api/mirror/jobs/:id, /api/mirror/jobs/:id/files/:name, POST /api/mirror/runs", async () => {
    expect((await request(app).get("/api/mirror/changes")).status).toBe(404);
    expect((await request(app).get("/api/mirror/jobs/Analyst%20-%20Acme")).status).toBe(404);
    expect((await request(app).get("/api/mirror/jobs/Analyst%20-%20Acme/files/x.md")).status).toBe(404);
    expect((await request(app).post("/api/mirror/runs").send({})).status).toBe(404);
  });

  it("the sync manifest still works standalone (SYNC_TOKEN-only now, no mirror dual-credential)", async () => {
    delete process.env.SYNC_TOKEN_HASH;
    // not configured on this instance -> 501, never a mirror-token acceptance path
    const r = await request(app).get("/api/sync/manifest");
    expect(r.status).toBe(501);
  });
});
