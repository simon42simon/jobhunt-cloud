// SIM-612 - a discovery-source run stuck at outcome:"running" past a stalled
// bound must self-heal to a terminal state, even when it predates the runner
// repoint (SIM-535) and so carries no "aj-" runId reconcileRunnerSourceRuns
// can look up. Reproduces the exact 4-zombie-source repro: a weekly-cadence
// source whose only run record is a 9-day-old "running" row, which the TopBar
// "Discover due (N)" count (src/lib/sources.ts countDueSources -> !isRunning)
// silently zeroed out because the health pill never resolved.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

let app, tmpRoot, docsDir, sourcesFile;

function writeSources(sources) {
  fs.writeFileSync(sourcesFile, yaml.dump({ version: 1, sources }), "utf8");
}

const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString();
const minsAgoISO = (n) => new Date(Date.now() - n * 60000).toISOString();

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-source-stall-"));
  docsDir = path.join(tmpRoot, "docs");
  const jobsDir = path.join(tmpRoot, "Jobs");
  const findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  sourcesFile = path.join(docsDir, "discovery-sources.yaml");
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  delete process.env.RUNNER_TOKEN_HASH; // no runner needed for this reconcile
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("SIM-612 stalled-source-run backstop", () => {
  it("a 9-day-old zombie 'running' record (no 'aj-' runId, predates the runner repoint) resolves to terminal and un-hides the source from due", async () => {
    writeSources([
      {
        id: "university-of-waterloo",
        name: "University of Waterloo",
        type: "employer",
        sector: "public",
        urls: ["https://example.org/uw"],
        instructions: "Scan the board.",
        cadence: "weekly",
        active: "yes",
        lastRunAt: daysAgoISO(9),
        runs: [{ runId: "r-legacy-1784161234567", startedAt: daysAgoISO(9), durationMs: null, outcome: "running", leadsFound: null, leadsNew: null, trigger: "all-due" }],
      },
    ]);

    const r = await request(app).get("/api/discovery/sources");
    expect(r.status).toBe(200);
    const src = r.body.sources.find((s) => s.id === "university-of-waterloo");
    expect(src.status).not.toBe("running");
    expect(src.status).toBe("due"); // weekly cadence, 9 days since last run
    expect(src.due).toBe(true);

    const rec = src.runs.find((x) => x.runId === "r-legacy-1784161234567");
    expect(rec.outcome).not.toBe("running");
    expect(rec.outcome).toBe("incomplete");
    expect(rec.errorReason).toMatch(/stalled/i);

    // Durable: re-reading the raw stored file shows the same flip (not just a
    // response-time overlay) - the exact field the client's isRunning() reads.
    const stored = yaml.load(fs.readFileSync(sourcesFile, "utf8"));
    const storedSrc = stored.sources.find((s) => s.id === "university-of-waterloo");
    expect(storedSrc.runs[0].outcome).toBe("incomplete");
  });

  it("a genuinely-recent running record (started 2 minutes ago) is left alone - the backstop is not 'always block'", async () => {
    writeSources([
      {
        id: "durham-college",
        name: "Durham College",
        type: "employer",
        sector: "bps",
        urls: ["https://example.org/durham"],
        instructions: "Scan the board.",
        cadence: "weekly",
        active: "yes",
        lastRunAt: minsAgoISO(2),
        runs: [{ runId: "r-fresh-1", startedAt: minsAgoISO(2), durationMs: null, outcome: "running", leadsFound: null, leadsNew: null, trigger: "manual" }],
      },
    ]);

    const r = await request(app).get("/api/discovery/sources");
    expect(r.status).toBe(200);
    const src = r.body.sources.find((s) => s.id === "durham-college");
    expect(src.status).toBe("running");
    const rec = src.runs.find((x) => x.runId === "r-fresh-1");
    expect(rec.outcome).toBe("running");
  });

  it("the single-source GET applies the same backstop", async () => {
    writeSources([
      {
        id: "mohawk-college",
        name: "Mohawk College",
        type: "employer",
        sector: "bps",
        urls: ["https://example.org/mohawk"],
        instructions: "Scan the board.",
        cadence: "weekly",
        active: "yes",
        lastRunAt: daysAgoISO(9),
        runs: [{ runId: "r-legacy-2", startedAt: daysAgoISO(9), durationMs: null, outcome: "running", leadsFound: null, leadsNew: null, trigger: "all-due" }],
      },
    ]);
    const r = await request(app).get("/api/discovery/sources/mohawk-college");
    expect(r.status).toBe(200);
    expect(r.body.status).not.toBe("running");
  });
});
