import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lintModule from "../ops/activity-log-lint.mjs";
import { parseJsonl, lintActivityLog, loadRoleIds } from "../ops/activity-log-lint.mjs";

// Pure lint over the activity log's TERMINAL-ONLY logging protocol (see the
// header of ops/activity-log-lint.mjs). Determinism rules for this suite:
//   - roleIds is INJECTED so tests never depend on the committed docs/agents.yaml
//     (one wiring test below is the sole, deliberate exception - agents.yaml is
//     committed, so it is deterministic per checkout).
//   - `now` is INJECTED (frozen clock) in every test that involves a "running"
//     record with no terminal, because the in-flight tolerance window is
//     age-relative. No test reads the real wall clock.
//   - Log content comes from inline literals or COMMITTED fixtures under
//     tests/fixtures/activity-log/. The live, gitignored, ever-growing
//     docs/activity-log.jsonl is deliberately NOT read here (t-1783139260257):
//     a unit test over mutable runtime state is non-deterministic. The live
//     file's gate coverage lives in `npm run lint:activity-log` (the script's
//     CLI path), which `npm run check` already runs - a vitest duplicate would
//     add flake, not confidence.
const roleIds = ["cto", "software-architect", "test-engineer", "people-enablement"];
const line = (o) => JSON.stringify(o);

// Frozen clock all age-relative tests share. Fixture timestamps are authored
// relative to this instant (e.g. "20m before frozen now" in in-flight.jsonl).
const FROZEN_NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOURS = 3600 * 1000;
const WINDOW = 6 * HOURS;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", "activity-log", name), "utf8");

describe("activity-log-lint", () => {
  it("a clean terminal-only log passes (idless work terminal-only; runs paired by runId)", () => {
    const raw =
      [
        line({ ts: "2026-07-01T00:00:00.000Z", kind: "delegation", routine: "test-engineer", label: "x", status: "done" }),
        line({ ts: "2026-07-01T00:01:00.000Z", kind: "note", routine: "manager", label: "y", status: "done" }), // manager -> cto
        // a runner run correctly paired by runId (running start + terminal close)
        line({ ts: "2026-07-01T00:02:00.000Z", kind: "run", runId: "r1", routine: "software-architect", status: "running" }),
        line({ ts: "2026-07-01T00:03:00.000Z", kind: "run", runId: "r1", status: "done", exitCode: 0 }),
      ].join("\n") + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it("FAILS on a stale dangling run (a runId still \"running\" beyond the in-flight window)", () => {
    // 2026-07-01 start vs 2026-07-05 frozen now = ~4 days old: a real orphan.
    const raw =
      line({ ts: "2026-07-01T00:00:00.000Z", kind: "run", runId: "r9", routine: "software-architect", status: "running" }) + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
    expect(ok).toBe(false);
    expect(findings.some((f) => f.check === "dangling-run")).toBe(true);
  });

  it("FAILS on an idless running delegation (terminal-only protocol violation)", () => {
    const raw = line({ ts: "2026-07-01T00:00:00.000Z", kind: "delegation", routine: "test-engineer", status: "running" }) + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(ok).toBe(false);
    expect(findings.some((f) => f.check === "unclosable-running")).toBe(true);
  });

  it("FAILS on a routine that resolves to no agents.yaml role id (after the manager->cto alias)", () => {
    const raw = line({ ts: "2026-07-01T00:00:00.000Z", kind: "delegation", routine: "chief-operating-officer", label: "coo", status: "done" }) + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(ok).toBe(false);
    expect(findings.some((f) => f.check === "unknown-routine")).toBe(true);
  });

  // (b) A kind:"run" record's `routine` is a runner ROUTINE name (server ROUTINES
  // whitelist), not a role id, so it must NOT be validated against agents.yaml
  // role ids. A properly paired finalize-job run is clean telemetry.
  it("does NOT flag a kind:\"run\" record whose routine is a runner routine (finalize-job)", () => {
    const raw =
      [
        line({ ts: "2026-07-03T01:00:00.000Z", kind: "run", runId: "rf1", routine: "finalize-job", label: "Finalize application", status: "running" }),
        line({ ts: "2026-07-03T01:05:00.000Z", kind: "run", runId: "rf1", status: "done", exitCode: 0 }),
      ].join("\n") + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(findings.some((f) => f.check === "unknown-routine")).toBe(false);
    expect(ok).toBe(true);
  });

  // (c) The run-vs-role distinction is by KIND, not by value: the exact same
  // string "finalize-job" is honest on a run (routine name) but bogus on a
  // delegation (where routine is the acting role) - so the delegation IS flagged.
  it("STILL flags the same routine value on a NON-run (delegation) record - run-vs-role is by kind", () => {
    const raw =
      [
        line({ ts: "2026-07-03T01:00:00.000Z", kind: "run", runId: "rf2", routine: "finalize-job", status: "running" }),
        line({ ts: "2026-07-03T01:05:00.000Z", kind: "run", runId: "rf2", status: "done", exitCode: 0 }),
        line({ ts: "2026-07-03T02:00:00.000Z", kind: "delegation", routine: "finalize-job", label: "bogus role", status: "done" }),
      ].join("\n") + "\n";
    const { records, malformed } = parseJsonl(raw);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(ok).toBe(false);
    const unknown = findings.filter((f) => f.check === "unknown-routine");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].line).toBe(3); // only the delegation, not either run line
  });

  // (d) REGRESSION GUARDS, fixture-based (t-1783139260257). These replace the
  // old test that read the REAL docs/activity-log.jsonl: that file is runtime
  // telemetry - gitignored, ever-growing, and legitimately mid-mutation while a
  // runner is in flight - so a unit test over it could red for reasons
  // unrelated to the code. The committed fixtures freeze one representative
  // known-good log and one log with exactly one violation per check class.
  it("(d) known-good fixture lints clean end-to-end (parse -> lint, zero findings)", () => {
    const { records, malformed } = parseJsonl(fixture("known-good.jsonl"));
    expect(malformed).toEqual([]);
    expect(records.length).toBeGreaterThan(0); // the fixture actually loaded
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
    expect(findings).toEqual([]);
    expect(ok).toBe(true);
  });

  it("(d) known-bad fixture reports exactly one finding per violation class, on the right lines", () => {
    const { records, malformed } = parseJsonl(fixture("known-bad.jsonl"));
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
    expect(ok).toBe(false);
    // Assert check+line only (not message text) so wording can evolve freely.
    expect(findings.map(({ check, line: l }) => ({ check, line: l }))).toEqual([
      { check: "dangling-run", line: 1 }, // 36h-old orphan: beyond the window
      { check: "unclosable-running", line: 2 }, // idless running, age-irrelevant
      { check: "unknown-routine", line: 3 },
      { check: "shape", line: 4 }, // torn / non-JSON line
      { check: "shape", line: 5 }, // missing ts
    ]);
  });

  // Wiring guard kept from the old (d): the gate loads role ids from the
  // COMMITTED docs/agents.yaml (deterministic per checkout, unlike the log).
  // If that file stops parsing, the unknown-routine check silently no-ops.
  it("(d) loadRoleIds loads role ids from the committed docs/agents.yaml", () => {
    const repoRoot = path.resolve(here, "..");
    const realRoleIds = loadRoleIds(path.join(repoRoot, "docs", "agents.yaml"));
    expect(realRoleIds.length).toBeGreaterThan(0);
    expect(realRoleIds.every((id) => typeof id === "string" && id.trim())).toBe(true);
  });

  // ==========================================================================
  // In-flight tolerance (t-1783139260257): `npm run check` runs while runner
  // routines are legitimately mid-flight; their {status:"running"} record has
  // no terminal YET. Policy: a dangling run younger than the bounded window is
  // tolerated (reported in the `tolerated` side-channel, not a finding);
  // anything at/over the window, or with an unparseable ts, is still a real
  // dangling-run finding. Tolerance applies ONLY to runId-keyed runs.
  // ==========================================================================
  describe("in-flight tolerance (bounded window)", () => {
    const runningAt = (ts, runId = "rLive") =>
      parseJsonl(line({ ts, kind: "run", runId, routine: "work-ticket", label: "in flight", status: "running" }) + "\n");

    it("tolerates a recent in-flight run: running newer than the window with no terminal is NOT a finding", () => {
      const { records, malformed } = runningAt("2026-07-05T11:45:00.000Z"); // 15m before frozen now
      const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
      expect(findings).toEqual([]);
      expect(ok).toBe(true);
    });

    it("reports tolerated in-flight runs in the `tolerated` side-channel (the gate prints them - never hidden)", () => {
      const { records, malformed } = runningAt("2026-07-05T11:45:00.000Z");
      const res = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
      expect(res.tolerated).toHaveLength(1);
      expect(res.tolerated[0]).toMatchObject({ runId: "rLive", line: 1 });
    });

    it("window boundary: age exactly == window is a finding; one ms inside is tolerated", () => {
      const startMs = Date.parse("2026-07-05T05:00:00.000Z");
      const { records, malformed } = runningAt("2026-07-05T05:00:00.000Z");

      const atEdge = lintActivityLog(records, { roleIds, malformed, now: startMs + WINDOW, inflightToleranceMs: WINDOW });
      expect(atEdge.ok).toBe(false);
      expect(atEdge.findings.some((f) => f.check === "dangling-run")).toBe(true);

      const inside = lintActivityLog(records, { roleIds, malformed, now: startMs + WINDOW - 1, inflightToleranceMs: WINDOW });
      expect(inside.findings).toEqual([]);
      expect(inside.ok).toBe(true);
    });

    it("an unparseable ts on a dangling running run is NEVER tolerated (fail-honest)", () => {
      const { records, malformed } = runningAt("not-a-timestamp");
      const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
      expect(ok).toBe(false);
      expect(findings.some((f) => f.check === "dangling-run")).toBe(true);
    });

    it("tolerance is dangling-run-only: a RECENT idless running delegation is still unclosable-running", () => {
      const raw = line({ ts: "2026-07-05T11:55:00.000Z", kind: "delegation", routine: "test-engineer", status: "running" }) + "\n";
      const { records, malformed } = parseJsonl(raw);
      const { ok, findings } = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
      expect(ok).toBe(false);
      expect(findings.some((f) => f.check === "unclosable-running")).toBe(true);
    });

    // CONCURRENT runs are why the window beats "tolerate the single most-recent
    // running record": the runner spawns parallel runs (three simultaneous
    // first-draft runs in the real 2026-07-05 log), so most-recent-only would
    // still false-red. Both fresh runs must be tolerated; the stale orphan must
    // still be caught.
    it("(fixture) in-flight.jsonl: BOTH concurrent recent runs tolerated, the stale orphan still flagged", () => {
      const { records, malformed } = parseJsonl(fixture("in-flight.jsonl"));
      const res = lintActivityLog(records, { roleIds, malformed, now: FROZEN_NOW, inflightToleranceMs: WINDOW });
      expect(res.findings.map(({ check, line: l }) => ({ check, line: l }))).toEqual([
        { check: "dangling-run", line: 1 }, // fx-orphan, 27h old
      ]);
      expect(res.ok).toBe(false);
      expect(res.tolerated.map((t) => t.runId).sort()).toEqual(["fx-live-1", "fx-live-2"]);
    });

    it("the default tolerance window is exported and is 6 hours", () => {
      expect(lintModule.INFLIGHT_TOLERANCE_MS).toBe(6 * HOURS);
    });
  });

  it("tolerates an empty / missing log (parseJsonl('') -> no records; lint ok)", () => {
    const { records, malformed } = parseJsonl("");
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(records).toEqual([]);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it("collects a malformed (non-JSON) line as a shape finding without throwing", () => {
    const raw =
      ["not-json-at-all", line({ ts: "2026-07-01T00:00:00.000Z", kind: "note", routine: "manager", status: "done" })].join("\n") + "\n";
    const { records, malformed } = parseJsonl(raw);
    expect(malformed.length).toBe(1);
    const { ok, findings } = lintActivityLog(records, { roleIds, malformed });
    expect(ok).toBe(false);
    expect(findings.some((f) => f.check === "shape")).toBe(true);
  });
});

// Delegation freshness (S5 / ADR-002 Phase 5 F7, 2026-07-10): the silent-stop
// signature is runs flowing while delegations flatline. Same determinism rules:
// frozen `now`, injected window, inline literals. The check is a separate pure
// export so the integrity lint's contract (and the tests above) are untouched.
describe("lintDelegationFreshness", () => {
  const { lintDelegationFreshness } = lintModule;
  const DAY = 24 * 3600 * 1000;
  const iso = (msBeforeNow) => new Date(FROZEN_NOW - msBeforeNow).toISOString();

  it("passes when runs and delegations are both current", () => {
    const raw =
      [
        line({ ts: iso(2 * DAY), kind: "delegation", routine: "test-engineer", label: "x", status: "done" }),
        line({ ts: iso(1 * DAY), kind: "run", runId: "r1", routine: "software-architect", status: "running" }),
        line({ ts: iso(1 * DAY - 60000), kind: "run", runId: "r1", status: "done", exitCode: 0 }),
      ].join("\n") + "\n";
    const { records } = parseJsonl(raw);
    const { ok, finding } = lintDelegationFreshness(records, { now: FROZEN_NOW, windowMs: 7 * DAY });
    expect(ok).toBe(true);
    expect(finding).toBe(null);
  });

  it("FAILS when runs are current but the newest delegation lags beyond the window (the 2026-07-02 signature)", () => {
    const raw =
      [
        line({ ts: iso(9 * DAY), kind: "delegation", routine: "test-engineer", label: "old", status: "done" }),
        line({ ts: iso(1 * DAY), kind: "run", runId: "r2", routine: "software-architect", status: "running" }),
        line({ ts: iso(1 * DAY - 60000), kind: "run", runId: "r2", status: "done", exitCode: 0 }),
      ].join("\n") + "\n";
    const { records } = parseJsonl(raw);
    const { ok, finding } = lintDelegationFreshness(records, { now: FROZEN_NOW, windowMs: 7 * DAY });
    expect(ok).toBe(false);
    expect(finding.check).toBe("delegation-freshness");
  });

  it("FAILS when runs are current and NO delegation record exists at all", () => {
    const raw = line({ ts: iso(1 * DAY), kind: "run", runId: "r3", routine: "software-architect", status: "running" }) + "\n";
    const { records } = parseJsonl(raw);
    const { ok, finding } = lintDelegationFreshness(records, { now: FROZEN_NOW, windowMs: 7 * DAY });
    expect(ok).toBe(false);
    expect(finding.check).toBe("delegation-freshness");
  });

  it("passes on a quiet log (no run younger than the window) - a vacation week never false-reds", () => {
    const raw =
      [
        line({ ts: iso(30 * DAY), kind: "delegation", routine: "test-engineer", label: "old", status: "done" }),
        line({ ts: iso(20 * DAY), kind: "run", runId: "r4", status: "done", exitCode: 0 }),
      ].join("\n") + "\n";
    const { records } = parseJsonl(raw);
    const { ok } = lintDelegationFreshness(records, { now: FROZEN_NOW, windowMs: 7 * DAY });
    expect(ok).toBe(true);
  });

  it("passes on an empty / run-free log", () => {
    const { records } = parseJsonl("");
    expect(lintDelegationFreshness(records, { now: FROZEN_NOW }).ok).toBe(true);
  });
});
