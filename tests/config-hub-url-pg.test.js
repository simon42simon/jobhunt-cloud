// SIM-611 - pg-backed instances honor JOBHUNT_SSC_HUB_URL for the Product link.
//
// SIM-426 hardcoded sscHubUrl to null on pg (correct when no remote hub existed);
// SIM-550 then staged a REAL cloud hub URL per Railway environment, but the code
// never read it - the qf-close QA walk caught the Product tab still rendering the
// "runs on Simon's own machine" fallback after the env var was set. Contract now:
//   pg + JOBHUNT_SSC_HUB_URL set -> that URL (the cloud hub link renders)
//   pg + unset                   -> null (the honest SIM-426 fallback, unchanged)
// The local/file path keeps SSC_HUB_URL / the localhost default (existing tests).
// Boots the REAL app on embedded Postgres per the SIM-547 harness; skips cleanly
// when the cluster cannot boot, hard-fails under REQUIRE_EMBEDDED_PG=1.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCluster } from "./helpers/embedded-pg.mjs";

const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  // eslint-disable-next-line no-console
  console.warn(`[config-hub-url-pg] PgStore leg SKIPPED: ${cluster.reason}`);
}

const HUB = "https://hub-production-example.up.railway.app";

suite("GET /api/config sscHubUrl on STORE_BACKEND=pg (SIM-611)", () => {
  let app, store, tmpRoot;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-huburl-pg-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.STORE_BACKEND = "pg";
    process.env.DATABASE_URL = cluster.url;
    process.env.JOBHUNT_SSC_HUB_URL = HUB;
    delete process.env.APP_MODE;
    const mod = await import("../server/index.js");
    app = mod.app;
    store = mod.store;
  });

  afterAll(async () => {
    for (const k of ["STORE_BACKEND", "DATABASE_URL", "JOBHUNT_SSC_HUB_URL"]) delete process.env[k];
    try {
      if (store) store.close();
    } catch {}
    if (cluster.available) await cluster.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("returns JOBHUNT_SSC_HUB_URL (the SIM-550 cloud-hub case; was hardcoded null)", async () => {
    const cfg = await request(app).get("/api/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.sscHubUrl).toBe(HUB);
  });
});
