import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Audit F1c (t-1783183576657): GET /api/discovery used to pass through the
// xlsx "Run Log" sheet verbatim as `runLog`, duplicating the per-source run
// history docs/discovery-sources.yaml now owns (ADR-016's `runs[]`, served by
// GET /api/discovery/sources) - a second, unread store of the same fact
// (nothing in src/ ever read `.runLog`; DiscoveryData no longer declares it).
// This proves the retirement: even when the underlying dump still carries a
// non-empty runLog (the JOBHUNT_DISCOVERY_FINDS seam here stands in for
// discovery.py's `dump`, which is untouched), the API response never surfaces
// it, while the fields that ARE still owned by the workbook (config,
// discoveries) pass through unchanged.

let app;
let tmpRoot;
let docsDir;
let jobsDir;
let findsFile;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-disc-get-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    findsFile,
    JSON.stringify({
      config: [["Sources", "OCI"]],
      discoveries: [{ Title: "A", Employer: "Acme", Source: "OCI", "Date Found": "2026-07-01" }],
      runLog: [["2026-06-30", "focus", "OCI", "3", "reasoning", "improve X"]],
    }),
    "utf8",
  );
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("GET /api/discovery (runLog retirement)", () => {
  it("never surfaces runLog, even when the underlying dump still carries one", async () => {
    const res = await request(app).get("/api/discovery");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("runLog");
    // The fields the workbook still owns pass through unchanged.
    expect(res.body.config).toEqual([["Sources", "OCI"]]);
    expect(res.body.discoveries).toHaveLength(1);
    expect(res.body.discoveries[0].Title).toBe("A");
  });
});
