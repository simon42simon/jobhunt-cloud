// reconcile-core - the ONE implementation of "close orphaned running runner
// records" (SIM-70). A kind:"run" runId whose latest state is "running" with no
// terminal (done|failed|stopped) record is an orphan: the server process that
// launched it died before writing a terminal, and the in-memory `runs` Map that
// held its live process handle is never rehydrated on boot, so nothing in the
// app will ever close it. It fails lint:activity-log once it ages past the 6h
// in-flight window.
//
// TWO callers share this core so the detection + write logic never drifts:
//   1. ops/activity-log-reconcile.mjs - the standalone CLI, run against the LIVE
//      log WHILE the server serves. It passes the 6h in-flight window so a
//      genuinely mid-flight run (a live process still owns it) is NEVER closed.
//   2. server boot (server/index.js) - runs ONCE before the server accepts runs.
//      The fresh process owns NO runs, so EVERY dangling "running" record is an
//      orphan regardless of age: boot passes inflightToleranceMs:0.
//
// SAFETY (root CLAUDE.md rule 3): this never hand-edits the log. It reuses the
// app's ONE writer, appendJsonl (server/lib.js) = a single fs.appendFileSync with
// flag 'a' (O_APPEND): one atomic append at end-of-file that never touches
// existing bytes and never rewinds. Appending is not editing; it cannot race the
// server's concurrent appends. Orphan runIds are from a dead process, so the live
// server never emits its own terminal for them (no double-close), and new runs
// get fresh runIds (no collision).

import fs from "node:fs";
import { appendJsonl } from "../server/lib.js";
import { parseJsonl, INFLIGHT_TOLERANCE_MS } from "./activity-log-lint.mjs";

const TERMINAL = new Set(["done", "failed", "stopped"]);

// The note stamped on every reconciled terminal, so the audit trail records that
// the close came from reconciliation, not from a normal run completion.
export const RECONCILE_NOTE =
  "reconciled: orphaned running record (owning server process exited before recording a terminal state); closed by reconcileOrphanedRuns";

// Pure detection: given already-parsed records, return the orphaned runs to
// close. An orphan is a kind:"run" runId with a "running" record and NO terminal
// record for the same runId, whose "running" ts is at least `inflightToleranceMs`
// old. `now` and `inflightToleranceMs` are injectable so tests run on a frozen
// clock. Semantics match ops/activity-log-lint's dangling-run check exactly:
//   - a parseable ts YOUNGER than the window is a live in-flight run -> skipped
//     (the CLI never closes a run the live server may still own);
//   - an unparseable ts yields NaN, which is never < window, so it is ALWAYS an
//     orphan (fail-honest, same as the lint);
//   - inflightToleranceMs:0 (boot) closes every dangling running record: age >= 0
//     is always true, so the window excuses nothing.
// Each orphan keeps its `running` record so a caller can print run details and
// mirror its batchId onto the terminal.
export function findOrphanedRuns(
  records,
  { now = Date.now(), inflightToleranceMs = INFLIGHT_TOLERANCE_MS } = {}
) {
  const byId = new Map();
  for (const r of records) {
    if (r.kind !== "run" || typeof r.runId !== "string") continue;
    if (!byId.has(r.runId)) byId.set(r.runId, []);
    byId.get(r.runId).push(r);
  }
  const orphans = [];
  for (const [runId, recs] of byId) {
    const running = recs.find((x) => x.status === "running");
    const hasTerminal = recs.some((x) => TERMINAL.has(x.status));
    if (!running || hasTerminal) continue;
    const ageMs = now - Date.parse(running.ts);
    if (Number.isFinite(ageMs) && ageMs < inflightToleranceMs) continue;
    orphans.push({ runId, running, ageMs });
  }
  return orphans;
}

// Read `logPath`, find orphaned runs, and (unless dryRun) append exactly one
// terminal record per orphan via the sanctioned appendJsonl (single O_APPEND,
// never a rewrite). The terminal mirrors startRun's abort close line:
//   { ts, kind:"run", runId, status:"stopped", exitCode:null, batchId, note }
// status:"stopped" (not "done") is honest - the owning process died before
// recording an outcome - and never feeds runDurationHistory (which pairs
// running+done), so duration estimates stay clean. A missing log file yields
// zero orphans (nothing to reconcile), never a throw. Returns { orphans, closed }
// where `closed` is the runIds that got a terminal appended.
export function reconcileOrphanedRuns(
  logPath,
  {
    now = Date.now(),
    inflightToleranceMs = INFLIGHT_TOLERANCE_MS,
    dryRun = false,
    note = RECONCILE_NOTE,
  } = {}
) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return { orphans: [], closed: [] };
  }
  const { records } = parseJsonl(raw);
  const orphans = findOrphanedRuns(records, { now, inflightToleranceMs });
  if (dryRun) return { orphans, closed: [] };
  const closed = [];
  for (const o of orphans) {
    appendJsonl(logPath, {
      kind: "run",
      runId: o.runId,
      status: "stopped",
      exitCode: null,
      batchId: o.running.batchId ?? null,
      note,
    });
    closed.push(o.runId);
  }
  return { orphans, closed };
}
