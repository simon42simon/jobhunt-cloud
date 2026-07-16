#!/usr/bin/env node
// activity-log-lint - reconcile / integrity lint for docs/activity-log.jsonl.
//
// ============================================================================
// TERMINAL-ONLY LOGGING PROTOCOL (the durable fix for activity-log drift)
// ============================================================================
// The activity log is append-only telemetry, and it drifted: the 2026-07-01
// ULTRACODE audit found dangling "running" records with no terminal state, a
// shipped deliverable never closed, and a phantom entry contradicted later.
// Root cause: a hand/hook-maintained "running" record for work that has NO
// reliable close key can never be reconciled. The protocol that prevents this:
//
//   1. RUNNER RUNS (kind:"run") are keyed by `runId`. The server logs a "running"
//      start and, on process close, a terminal record (done|failed|stopped) with
//      the SAME runId (server/index.js startRun). That runId pair is the ONLY
//      place a "running" status is legal, because it is the only record with a
//      mechanical close key.
//   2. EVERYTHING ELSE (delegations, notes; piped in via
//      ops/activity-log-append.mjs) is logged TERMINAL-ONLY: exactly one record,
//      written when the work finishes, carrying its final status (done|failed).
//      There is NO "running" line for idless work - nothing could close it,
//      which is precisely how the log drifted.
//
// This lint enforces that protocol. It REPORTS and exits non-zero on any
// finding so it can gate, and it is best-effort / tolerant of a missing log
// file. It belongs in the governance-auditor's per-release check (the audit's
// section 4 lists "Activity-log integrity" - no dangling running entries, every
// routine resolves to a known agents.yaml role - as a standing per-release
// check). As of the t-audit-p2 activity-log honesty pass it IS wired into
// `npm run check` (via the "lint:activity-log" script): the one abandoned
// "running" run was reconciled with a terminal record, and the run-vs-role
// category error was fixed (kind:"run" `routine` is a runner ROUTINE name, not
// a role id, so runs are skipped by the unknown-routine check), so the committed
// log now passes and the gate stays green on real data. Run it standalone with:
//
//   node ops/activity-log-lint.mjs [path-to-activity-log.jsonl]
//
// ----------------------------------------------------------------------------
// GATE POLICY - BOUNDED IN-FLIGHT TOLERANCE (t-1783139260257)
// ----------------------------------------------------------------------------
// `npm run check` lints the LIVE log, and runner routines are legitimately
// mid-flight while the gate runs: their {status:"running"} record has no
// terminal YET. That is correct telemetry, not drift - but the naive
// dangling-run check flagged it, so the gate went red for a non-defect (three
// agents independently mistook it for a defect on 2026-07-04, and it happened
// again on 2026-07-05 during this very ticket's own work-ticket run). Policy
// chosen: a dangling run is TOLERATED iff its "running" ts parses AND is
// younger than INFLIGHT_TOLERANCE_MS. Why this shape and not the alternatives:
//   - NOT "tolerate only the single most-recent running record": the runner
//     spawns CONCURRENT runs (the real 2026-07-05 log has three simultaneous
//     first-draft runs), so most-recent-only still false-reds.
//   - NOT "document check-only-when-idle": unenforceable in a multi-agent org
//     where gate runs and routine runs overlap by design.
//   - Window = 6h: an order of magnitude longer than the longest legitimate
//     run observed (~1h work-ticket), and shorter than the typical gap between
//     gate runs, so a REAL orphan still surfaces at the next gate. Age >= the
//     window, or an unparseable ts, stays a dangling-run finding (fail-honest).
//     A future ts (clock skew) counts as recent.
//   - Tolerated runs are still PRINTED by the CLI, so the gate output never
//     hides them; they are returned in a separate `tolerated` side-channel,
//     never mixed into `findings`.
//   - Tolerance applies ONLY to runId-keyed kind:"run" records. An idless
//     "running" record (unclosable-running) is a protocol violation regardless
//     of age - nothing can ever close it.
// `now` and the window are injectable parameters so tests run on a frozen
// clock against committed fixtures (no wall-clock nondeterminism).
//
// Checks:
//   shape              - each line is a JSON object with a string ts + kind; any
//                        status is one of running|done|failed|stopped; runId,
//                        if present, is a string. Malformed lines are reported,
//                        never thrown on.
//   dangling-run       - (a) a kind:"run" runId that has a "running" record but
//                        no later done|failed|stopped for the same runId, UNLESS
//                        the running ts is younger than the in-flight window
//                        (see gate policy above), in which case it is reported
//                        as tolerated, not a finding.
//   unclosable-running - (a', terminal-only) a "running" record with no runId
//                        (delegation / note / idless): unclosable by
//                        construction, so it must be logged terminal-only.
//   unknown-routine    - (b) on a NON-run record, a `routine` (the acting role)
//                        that does not resolve to an agents.yaml role id after
//                        the manager->cto alias. kind:"run" records are skipped:
//                        their `routine` is a runner routine name, not a role.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { resolveDataDir } from "../server/lib.js";

const KNOWN_STATUSES = ["running", "done", "failed", "stopped"];
const TERMINAL_STATUSES = ["done", "failed", "stopped"];
// Default in-flight tolerance window (gate policy above): a dangling "running"
// run younger than this is treated as legitimately mid-flight. Exported so the
// tests pin the gate's actual default, not a copy of it.
export const INFLIGHT_TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6 hours
// Mirrors src/lib/involvement.ts normalizeRoutine: the log writes routine:
// "manager" for CTO-level orchestration (the template name), whose org role id
// is "cto". Every other routine already equals its agents.yaml role id.
const ROUTINE_ALIASES = { manager: "cto" };

// Parse .jsonl text into { records, malformed }. Each record keeps its 1-based
// line number (__line) for actionable reporting. Blank lines are skipped; a
// torn / non-JSON / non-object line is collected in `malformed` rather than
// throwing, so a single bad line never breaks the whole lint.
export function parseJsonl(raw) {
  const records = [];
  const malformed = [];
  const lines = String(raw ?? "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed.push({ line: lineNo, reason: "not valid JSON" });
      return;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      malformed.push({ line: lineNo, reason: "not a JSON object" });
      return;
    }
    records.push({ ...obj, __line: lineNo });
  });
  return { records, malformed };
}

function resolveRoutine(routine) {
  return ROUTINE_ALIASES[routine] || routine;
}

// Human age for lint output ("started 20m ago" / "started 3.2h ago").
function fmtAge(ageMs) {
  if (ageMs < 0) return `starts ${Math.round(-ageMs / 60000)}m in the future (clock skew)`;
  if (ageMs < 90 * 60000) return `started ${Math.round(ageMs / 60000)}m ago`;
  return `started ${(ageMs / 3600000).toFixed(1)}h ago`;
}

// Pure lint over already-parsed records. `roleIds` is the list of valid
// agents.yaml role ids (injected, so tests need no committed file); `malformed`
// is the parseJsonl side-channel; `now` (epoch ms) and `inflightToleranceMs`
// parameterize the in-flight window (injected so tests run on a frozen clock).
// Returns { ok, findings, tolerated }: each finding is { check, line, detail };
// `tolerated` lists in-flight runs excused by the window ({ line, runId, ageMs,
// detail }) - surfaced so the CLI can print them, but never counted against ok.
export function lintActivityLog(
  records,
  { roleIds = [], malformed = [], now = Date.now(), inflightToleranceMs = INFLIGHT_TOLERANCE_MS } = {}
) {
  const findings = [];
  const tolerated = [];
  const roles = new Set(roleIds);

  // shape: malformed lines surfaced by parseJsonl.
  for (const m of malformed) findings.push({ check: "shape", line: m.line, detail: m.reason });

  // shape: per-record field vocabulary.
  for (const r of records) {
    const line = r.__line;
    if (typeof r.ts !== "string" || !r.ts.trim()) {
      findings.push({ check: "shape", line, detail: "missing or non-string ts" });
    }
    if (typeof r.kind !== "string" || !r.kind.trim()) {
      findings.push({ check: "shape", line, detail: "missing or non-string kind" });
    }
    if ("status" in r && !KNOWN_STATUSES.includes(r.status)) {
      findings.push({ check: "shape", line, detail: `unknown status ${JSON.stringify(r.status)}` });
    }
    if ("runId" in r && typeof r.runId !== "string") {
      findings.push({ check: "shape", line, detail: "runId must be a string" });
    }
  }

  // dangling-run: group kind:"run" by runId; a runId with a "running" record and
  // no later terminal record is dangling (the runner's own telemetry integrity).
  const runsById = new Map();
  for (const r of records) {
    if (r.kind !== "run" || typeof r.runId !== "string") continue;
    if (!runsById.has(r.runId)) runsById.set(r.runId, []);
    runsById.get(r.runId).push(r);
  }
  for (const [runId, recs] of runsById) {
    const running = recs.find((x) => x.status === "running");
    const hasTerminal = recs.some((x) => TERMINAL_STATUSES.includes(x.status));
    if (!running || hasTerminal) continue;
    // In-flight tolerance (gate policy in the header): a running record younger
    // than the window is legitimately mid-flight, not drift. Strictly-younger
    // (age < window) so the window edge itself is already a finding; an
    // unparseable ts yields NaN, NaN < window is false -> never tolerated.
    const ageMs = now - Date.parse(running.ts);
    if (Number.isFinite(ageMs) && ageMs < inflightToleranceMs) {
      tolerated.push({
        line: running.__line,
        runId,
        ageMs,
        detail: `run ${runId} "running" (${fmtAge(ageMs)}) with no terminal yet - tolerated as in-flight (window ${inflightToleranceMs / 3600000}h)`,
      });
      continue;
    }
    findings.push({
      check: "dangling-run",
      line: running.__line,
      detail: Number.isFinite(ageMs)
        ? `run ${runId} is "running" with no later done/failed/stopped record (${fmtAge(ageMs)}, beyond the ${inflightToleranceMs / 3600000}h in-flight window)`
        : `run ${runId} is "running" with no later done/failed/stopped record (unparseable ts ${JSON.stringify(running.ts)} - never tolerated)`,
    });
  }

  // unclosable-running: any "running" record with no runId can never be
  // reconciled -> violates the terminal-only protocol.
  for (const r of records) {
    if (r.status === "running" && typeof r.runId !== "string") {
      findings.push({
        check: "unclosable-running",
        line: r.__line,
        detail: `${r.kind || "record"} logged "running" without a runId (terminal-only: log idless work once, with its final status)`,
      });
    }
  }

  // unknown-routine: for NON-run records (delegation / note), `routine` is the
  // acting ROLE, so it must resolve to an agents.yaml role id (after the
  // manager->cto alias). For kind:"run" records, `routine` is a runner ROUTINE
  // name (server ROUTINES whitelist: discover-jobs, first-draft-job,
  // finalize-job, work-ticket, assess-ticket) - a different vocabulary entirely,
  // already validated at run time and anchored by runId. Validating a routine
  // name against role ids is a category error, so runs are skipped here.
  for (const r of records) {
    if (r.kind === "run") continue;
    if (typeof r.routine !== "string" || !r.routine.trim()) continue;
    const resolved = resolveRoutine(r.routine);
    if (!roles.has(resolved)) {
      const via = resolved !== r.routine ? ` (alias -> "${resolved}")` : "";
      findings.push({
        check: "unknown-routine",
        line: r.__line,
        detail: `routine "${r.routine}"${via} is not an agents.yaml role id`,
      });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  tolerated.sort((a, b) => a.line - b.line);
  return { ok: findings.length === 0, findings, tolerated };
}

// ----------------------------------------------------------------------------
// DELEGATION FRESHNESS (S5 / ADR-002 Phase 5 F7, 2026-07-10)
// ----------------------------------------------------------------------------
// The silent-stop signature this catches: kind:"run" records keep flowing (the
// server logs them in-process, they never stop) while kind:"delegation" records
// flatline because the session-side wiring (the PostToolUse Task hook,
// ops/hooks/delegation-append.mjs) got lost - exactly what happened on
// 2026-07-02 and went unnoticed for 8 days. Rule: if the newest run is recent
// (younger than the window) and the newest delegation is more than the window
// OLDER than that run (or absent entirely), the wiring is presumed dead and the
// gate goes red. A fully quiet log (no recent runs) never false-reds a vacation
// week. Window default 7 days; `now` and the window are injectable for tests.
export const DELEGATION_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function lintDelegationFreshness(
  records,
  { now = Date.now(), windowMs = DELEGATION_FRESHNESS_MS } = {}
) {
  let newestRun = NaN;
  let newestDelegation = NaN;
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    if (r.kind === "run" && !(t <= newestRun)) newestRun = t;
    if (r.kind === "delegation" && !(t <= newestDelegation)) newestDelegation = t;
  }
  // No parseable runs, or runs are themselves stale -> the org is quiet; the
  // delegation wiring cannot be judged dead. Pass.
  if (!Number.isFinite(newestRun) || now - newestRun >= windowMs) {
    return { ok: true, finding: null };
  }
  const lag = Number.isFinite(newestDelegation) ? newestRun - newestDelegation : Infinity;
  if (lag <= windowMs) return { ok: true, finding: null };
  const days = (ms) => (ms / 86400000).toFixed(1);
  return {
    ok: false,
    finding: {
      check: "delegation-freshness",
      detail: Number.isFinite(newestDelegation)
        ? `runs are current but the newest delegation is ${days(lag)}d older than the newest run (window ${days(windowMs)}d) - the delegation hook (ops/hooks/delegation-append.mjs, PostToolUse Task in .claude/settings.json) is presumed dead; re-wire it or, if this window genuinely had zero roster delegations, log one terminal delegation note via ops/activity-log-append.mjs`
        : `runs are current but the log contains NO delegation record - the delegation hook (ops/hooks/delegation-append.mjs) is not wired`,
    },
  };
}

// Load agents.yaml role ids (best-effort: a missing / unparseable file yields
// [], which makes the unknown-routine check a no-op rather than a crash).
export function loadRoleIds(agentsPath) {
  try {
    const data = yaml.load(fs.readFileSync(agentsPath, "utf8"), { schema: yaml.JSON_SCHEMA });
    const roles = data && Array.isArray(data.roles) ? data.roles : [];
    return roles.map((r) => r && r.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  // Live log = data zone (ADR-023); agents.yaml stays repo content.
  const logPath = argv[2] ? path.resolve(argv[2]) : path.join(resolveDataDir(repoRoot), "activity-log.jsonl");
  const agentsPath = path.join(repoRoot, "docs", "agents.yaml");

  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    console.log(`[activity-log-lint] no log at ${logPath} - nothing to check (ok)`);
    process.exit(0);
  }

  const { records, malformed } = parseJsonl(raw);
  const roleIds = loadRoleIds(agentsPath);
  const { ok: integrityOk, findings, tolerated } = lintActivityLog(records, { roleIds, malformed });
  // Delegation freshness rides the same gate (S5 / ADR-002 Phase 5 F7).
  const fresh = lintDelegationFreshness(records);
  if (!fresh.ok) findings.push({ line: 0, ...fresh.finding });
  const ok = integrityOk && fresh.ok;

  console.log(`[activity-log-lint] ${logPath}`);
  console.log(`  records: ${records.length}  malformed lines: ${malformed.length}  known roles: ${roleIds.length}`);
  // Honesty: tolerated in-flight runs are excused from the gate, never hidden.
  if (tolerated.length) {
    console.log(`  tolerated in-flight run(s): ${tolerated.length} (running, younger than the ${INFLIGHT_TOLERANCE_MS / 3600000}h window - not findings)`);
    for (const t of tolerated) console.log(`     line ${t.line}: ${t.detail}`);
  }
  if (ok) {
    console.log("  PASS - no integrity findings (delegation freshness ok)");
    process.exit(0);
  }

  const byCheck = {};
  for (const f of findings) (byCheck[f.check] ||= []).push(f);
  console.log(`  FAIL - ${findings.length} finding(s):`);
  for (const [check, list] of Object.entries(byCheck)) {
    console.log(`   [${check}] ${list.length}`);
    for (const f of list) console.log(`     line ${f.line}: ${f.detail}`);
  }
  process.exit(1);
}

// CLI only when invoked directly (node ops/activity-log-lint.mjs), never when
// imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
