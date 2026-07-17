// RC-3 / SIM-87 I6 - canned replay drives the run panel (design 5.2). Folds a
// transcript through the SAME agentEventToUpdate parser startRun's pump uses, and
// asserts the stages advance, the terminal stats land, and the cost is ZERO.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEventToUpdate } from "../server/lib.js";
import { loadTranscriptLines } from "../demo/replay.mjs";

process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-replay-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;
const { ROUTINES } = await import("../server/index.js");

// Mimic startRun's fold: run each transcript line through agentEventToUpdate,
// threading stageIndex + sawTranscript exactly as the pump does.
function replay(kind) {
  const def = ROUTINES[kind];
  const lines = loadTranscriptLines(kind);
  let stageIndex = -1;
  let saw = false;
  let output = "";
  let stats = null;
  let activity;
  for (const l of lines) {
    const evt = JSON.parse(l);
    const upd = agentEventToUpdate(evt, def.stages || null, stageIndex, saw);
    if (upd.appendText) {
      output += upd.appendText;
      saw = true;
    }
    if (upd.activity !== undefined) activity = upd.activity;
    stageIndex = upd.stageIndex;
    if (upd.stats) stats = upd.stats;
  }
  return { stageIndex, output, stats, activity };
}

describe("demo replay drives the run panel", () => {
  it("first-draft-job advances stages, streams transcript text, and lands zero-cost stats", () => {
    const r = replay("first-draft-job");
    expect(r.stageIndex).toBeGreaterThan(0); // milestones advanced past 'none'
    expect(r.output.length).toBeGreaterThan(0); // transcript streamed
    expect(r.stats).toBeTruthy();
    expect(r.stats.costUsd).toBe(0); // ZERO model spend (design 5.2)
    expect(r.activity).toBeNull(); // cleared by the terminal result event
  });

  it("finalize-job replays with stage progress + zero cost", () => {
    const r = replay("finalize-job");
    expect(r.stageIndex).toBeGreaterThan(0);
    expect(r.stats.costUsd).toBe(0);
  });

  it("discover-jobs replays and terminates with zero cost", () => {
    const r = replay("discover-jobs");
    expect(r.stats).toBeTruthy();
    expect(r.stats.costUsd).toBe(0);
    expect(r.output.length).toBeGreaterThan(0);
  });
});

// The run route's job-scope existence check must probe the job DTO, never the
// desktop folder path: PgStore.jobFolderPath() is null BY DESIGN (cloud has no
// folder to open), which made every job-scoped run - including the demo tour's
// Beat-3 replay - 404 on the pg/demo instances. getJobSummary(id) is
// null-for-missing on BOTH stores, so it is the store-agnostic probe. A source
// pin (red before the fix landed); the pg HTTP behavior itself is exercised by
// the differential suite's store contract.
describe("scopeIdExists is store-agnostic (the Beat-3 404 regression)", () => {
  it("probes store.getJobSummary, not the FileStore-only jobFolderPath", () => {
    const src = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
    const body = /function scopeIdExists\(scope, id\) \{[\s\S]*?\n\}/.exec(src)?.[0] || "";
    expect(body).toContain("store.getJobSummary(id) || store.jobFolderPath(id)");
  });
});
