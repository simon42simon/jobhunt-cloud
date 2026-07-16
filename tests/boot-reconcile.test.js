import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonl, lintActivityLog } from "../ops/activity-log-lint.mjs";
import { findOrphanedRuns, reconcileOrphanedRuns } from "../ops/reconcile-core.mjs";

// SIM-70: boot-time orphaned-run reconcile. A server restart mid-run leaves the
// old process's kind:"run" "running" record with no terminal (the in-memory
// `runs` Map that would close it is never rehydrated). On boot the fresh process
// owns NO runs, so reconcileOrphanedRuns closes every dangling running record
// with a single appended "stopped" terminal. This suite exercises the exported
// function against a TEMP activity-log fixture - never the live data zone.
//
// Determinism: every fixture ts is authored relative to one FROZEN_NOW, and the
// clock/window are injected into both the reconcile and the lint. The reconcile
// APPENDS (real wall-clock ts on the terminal), so the untouched-prefix proof
// asserts byte-identical HEAD, and the lint proofs never depend on the terminal's
// own ts (a present terminal short-circuits the dangling-run check).
const roleIds = ["cto", "software-architect", "test-engineer"];
const line = (o) => JSON.stringify(o);
const FROZEN_NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOURS = 3600 * 1000;
const WINDOW = 6 * HOURS; // the lint / CLI in-flight window

// A seeded log with (1) a healthy paired run, (2) a healthy terminal-only
// delegation, (3) one ORPHANED running run whose ts is ~4 days old (well beyond
// the in-flight window, so the lint would flag it as a real dangling run).
const HEALTHY_RUN_RUNNING = { ts: "2026-07-05T09:00:00.000Z", kind: "run", runId: "r_ok", routine: "software-architect", label: "Draft", jobId: "job-a", batchId: null, status: "running" };
const HEALTHY_RUN_DONE = { ts: "2026-07-05T09:05:00.000Z", kind: "run", runId: "r_ok", status: "done", exitCode: 0, batchId: null };
const HEALTHY_DELEGATION = { ts: "2026-07-05T09:06:00.000Z", kind: "delegation", routine: "test-engineer", label: "review", status: "done" };
const ORPHAN_RUNNING = { ts: "2026-07-01T00:00:00.000Z", kind: "run", runId: "r_orphan", routine: "software-architect", label: "Draft", jobId: "job-b", batchId: "batch-9", status: "running" };

const SEED = [line(HEALTHY_RUN_RUNNING), line(HEALTHY_RUN_DONE), line(HEALTHY_DELEGATION), line(ORPHAN_RUNNING)].join("\n") + "\n";

let dir;
let logPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-reconcile-"));
  logPath = path.join(dir, "activity-log.jsonl");
  fs.writeFileSync(logPath, SEED, "utf8");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("boot-reconcile (reconcileOrphanedRuns, inflightToleranceMs:0)", () => {
  it("PRE-CONDITION: the seeded log FAILS the lint on the dangling orphan (proves the reconcile is what fixes it)", () => {
    const { records, malformed } = parseJsonl(fs.readFileSync(logPath, "utf8"));
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });

    expect(ok).toBe(false);
    const dangling = findings.filter((f) => f.check === "dangling-run");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].detail).toContain("r_orphan");
  });

  it("(a) appends exactly one stopped terminal for the orphan, mirroring startRun's abort close", () => {
    const { closed } = reconcileOrphanedRuns(logPath, { inflightToleranceMs: 0 });

    expect(closed).toEqual(["r_orphan"]);

    const { records } = parseJsonl(fs.readFileSync(logPath, "utf8"));
    const terminals = records.filter((r) => r.runId === "r_orphan" && r.status === "stopped");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      kind: "run",
      runId: "r_orphan",
      status: "stopped",
      exitCode: null,
      batchId: "batch-9", // carried from the orphan's own running record
    });
    expect(typeof terminals[0].note).toBe("string");
    expect(terminals[0].ts).toBeTruthy(); // appendJsonl stamped a terminal ts
  });

  it("(b) leaves every healthy / already-terminated record untouched (append-only: byte-identical head)", () => {
    reconcileOrphanedRuns(logPath, { inflightToleranceMs: 0 });

    const after = fs.readFileSync(logPath, "utf8");
    // Nothing was rewritten: the entire seed is still the verbatim head of the file.
    expect(after.startsWith(SEED)).toBe(true);
    // The healthy paired run got NO extra terminal (only its original done).
    const { records } = parseJsonl(after);
    const okTerminals = records.filter((r) => r.runId === "r_ok" && r.status === "stopped");
    expect(okTerminals).toHaveLength(0);
    const okRuns = records.filter((r) => r.runId === "r_ok");
    expect(okRuns).toHaveLength(2); // the original running + done, unchanged
  });

  it("(c) the reconciled log then PASSES activity-log-lint (no dangling-run finding remains)", () => {
    reconcileOrphanedRuns(logPath, { inflightToleranceMs: 0 });

    const { records, malformed } = parseJsonl(fs.readFileSync(logPath, "utf8"));
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });

    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it("is idempotent: a second reconcile finds nothing to close (the terminal now exists)", () => {
    reconcileOrphanedRuns(logPath, { inflightToleranceMs: 0 });
    const afterFirst = fs.readFileSync(logPath, "utf8");

    const { closed } = reconcileOrphanedRuns(logPath, { inflightToleranceMs: 0 });

    expect(closed).toEqual([]);
    expect(fs.readFileSync(logPath, "utf8")).toBe(afterFirst); // no second append
  });

  it("a missing log file is a no-op (nothing to reconcile), never a throw", () => {
    const missing = path.join(dir, "does-not-exist.jsonl");
    const result = reconcileOrphanedRuns(missing, { inflightToleranceMs: 0 });
    expect(result).toEqual({ orphans: [], closed: [] });
    expect(fs.existsSync(missing)).toBe(false); // did not create the file
  });
});

describe("boot vs CLI window (findOrphanedRuns detection, frozen clock)", () => {
  // The one behavioral difference between the boot reconcile and the standalone
  // CLI: boot (window 0) closes EVERY dangling run; the CLI (6h window) spares a
  // genuinely in-flight one. A run that started 20m before FROZEN_NOW.
  const recentRunning = { ts: new Date(FROZEN_NOW - 20 * 60 * 1000).toISOString(), kind: "run", runId: "r_live", routine: "software-architect", status: "running" };

  it("boot (inflightToleranceMs:0) treats even a 20-minutes-old dangling run as an orphan", () => {
    const { records } = parseJsonl(line(recentRunning) + "\n");
    const orphans = findOrphanedRuns(records, { now: FROZEN_NOW, inflightToleranceMs: 0 });
    expect(orphans.map((o) => o.runId)).toEqual(["r_live"]);
  });

  it("the CLI (6h window) spares that same in-flight run - never closes a live run out from under the server", () => {
    const { records } = parseJsonl(line(recentRunning) + "\n");
    const orphans = findOrphanedRuns(records, { now: FROZEN_NOW, inflightToleranceMs: WINDOW });
    expect(orphans).toEqual([]);
  });

  it("an unparseable running ts is ALWAYS an orphan, even inside the CLI window (fail-honest, matches the lint)", () => {
    const { records } = parseJsonl(line({ ts: "not-a-date", kind: "run", runId: "r_bad", routine: "software-architect", status: "running" }) + "\n");
    const orphans = findOrphanedRuns(records, { now: FROZEN_NOW, inflightToleranceMs: WINDOW });
    expect(orphans.map((o) => o.runId)).toEqual(["r_bad"]);
  });
});
