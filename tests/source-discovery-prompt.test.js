// SIM-530 - the invented-deadline prevention pin. The old scrape contract
// opened with "Deadline MUST be set", which pushed the scout to invent literal
// YYYY-MM-DD dates for postings that stated none - the root cause of the
// ~70-job mass auto-close (SIM-529). The rule is now stated-date-or-rolling,
// held in ONE exported constant (DEADLINE_CONTRACT_RULE, runner-lib.js) used
// verbatim by BOTH discovery prompts: the cloud's local-spawn
// buildSourceDiscoveryPrompt and the SIM-535 runner-path template. These tests
// pin the constant's substance AND its presence in both prompts, and pin the
// absence of any "must be set" phrasing - they FAIL against the old wording.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { DEADLINE_CONTRACT_RULE, buildRunnerPrompt, validateSourceRunResult, SOURCE_RUN_MAX_FINDS } from "../server/runner-lib.js";

let pure;
let tmpRoot;

const SOURCE = {
  id: "test-board",
  name: "Test Board",
  type: "employer",
  sector: "public",
  urls: ["https://example.org/careers"],
  instructions: "Scan the example board listing page.",
  cadence: "weekly",
  active: "yes",
  runs: [],
  outputFields: ["Title", "Link", "Deadline"],
};

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-prompt-"));
  const docsDir = path.join(tmpRoot, "docs");
  const jobsDir = path.join(tmpRoot, "Jobs");
  const findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  fs.writeFileSync(path.join(docsDir, "discovery-sources.yaml"), yaml.dump({ version: 1, sources: [SOURCE] }), "utf8");
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  const { vi } = await import("vitest");
  vi.resetModules();
  pure = await import("../server/index.js");
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("DEADLINE_CONTRACT_RULE (the shared stated-date-or-rolling rule)", () => {
  it("states that a literal date comes ONLY from the posting", () => {
    expect(DEADLINE_CONTRACT_RULE).toContain("ONLY when the posting itself states");
    expect(DEADLINE_CONTRACT_RULE).toContain('"rolling"');
    expect(DEADLINE_CONTRACT_RULE).toContain("never invent");
  });

  it('carries no "must be set" phrasing (the SIM-529 root cause)', () => {
    expect(DEADLINE_CONTRACT_RULE).not.toMatch(/must be set/i);
  });
});

describe("buildSourceDiscoveryPrompt (cloud local-spawn path)", () => {
  it("embeds the shared deadline rule verbatim", () => {
    const p = pure.buildSourceDiscoveryPrompt("test-board");
    expect(p).toContain(DEADLINE_CONTRACT_RULE);
  });

  it('regression: no "Deadline MUST be set" anywhere in the prompt', () => {
    const p = pure.buildSourceDiscoveryPrompt("test-board");
    expect(p).not.toMatch(/deadline must be set/i);
  });

  it("still carries the source's own crawl instruction and direct-link rule", () => {
    const p = pure.buildSourceDiscoveryPrompt("test-board");
    expect(p).toContain("Scan the example board listing page.");
    expect(p).toContain("direct posting page");
  });
});

describe("buildRunnerPrompt discover-jobs-source (SIM-535 runner path)", () => {
  const payload = { sourceId: "test-board", source: SOURCE, trackedLinks: [] };
  const opts = { findsFile: "X:/work/finds.json", trackedLinksFile: "X:/work/tracked-links.json" };

  it("embeds the SAME shared deadline rule verbatim", () => {
    const p = buildRunnerPrompt("discover-jobs-source", null, payload, opts);
    expect(p).toContain(DEADLINE_CONTRACT_RULE);
    expect(p).not.toMatch(/deadline must be set/i);
  });

  it("frames the source record as data and points at the runner-chosen work files", () => {
    const p = buildRunnerPrompt("discover-jobs-source", null, payload, opts);
    expect(p).toContain('"test-board"');
    expect(p).toContain("Scan the example board listing page.");
    expect(p).toContain("X:/work/finds.json");
    expect(p).toContain("X:/work/tracked-links.json");
    expect(p).toContain("HARD LIMITS");
    expect(p).toContain("never auto-submit");
  });

  it("fail-safes to an explicit no-op when the source vanished", () => {
    const p = buildRunnerPrompt("discover-jobs-source", null, { sourceId: "gone" }, opts);
    expect(p).toContain("no longer exists");
    expect(p).toContain('{"counters":{},"finds":[]}');
    expect(p).not.toContain("Crawl / extraction instruction");
  });

  it("leaves the other kinds' fixed templates untouched", () => {
    expect(buildRunnerPrompt("discover-jobs", null, {})).toBe("run discover-jobs");
    expect(buildRunnerPrompt("first-draft-job", "Analyst - OCI", {})).toBe('run first-draft-job for "Analyst - OCI"');
  });
});

describe("validateSourceRunResult (the bounded result-lane validator)", () => {
  it("refuses non-object shapes and a non-array finds", () => {
    expect(validateSourceRunResult(null).ok).toBe(false);
    expect(validateSourceRunResult([]).ok).toBe(false);
    expect(validateSourceRunResult({ counters: {} }).ok).toBe(false);
  });

  it("refuses an over-cap finds payload", () => {
    const finds = Array.from({ length: SOURCE_RUN_MAX_FINDS + 1 }, (_, i) => ({ title: `t${i}`, link: `https://x/${i}` }));
    expect(validateSourceRunResult({ counters: {}, finds }).ok).toBe(false);
  });

  it("drops finds without a title AND link, trims + caps fields, defaults status to lead", () => {
    const v = validateSourceRunResult({
      counters: { candidatesReviewed: 3.9, alreadyTracked: -1, filteredOut: "x" },
      finds: [
        { title: "  Analyst  ", employer: "OCI", link: " https://x/1 ", deadline: "rolling", status: "queued" },
        { title: "no link" },
        { link: "https://x/2" },
        { title: "T".repeat(500), link: "https://x/3", notes: "n".repeat(5000), status: "submitted" },
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.counters).toEqual({ candidatesReviewed: 3 }); // negatives/non-numbers dropped, floats floored
    expect(v.finds).toHaveLength(2);
    expect(v.finds[0]).toMatchObject({ title: "Analyst", link: "https://x/1", status: "queued" });
    expect(v.finds[1].title).toHaveLength(300);
    expect(v.finds[1].notes).toHaveLength(2000);
    expect(v.finds[1].status).toBe("lead"); // closed enum: anything but "queued" -> lead
  });
});
