#!/usr/bin/env node
// activity-log-reconcile - close orphaned "running" runner records SAFELY,
// while the live server keeps writing the same log. Thin CLI over the shared
// reconcile core (ops/reconcile-core.mjs) - the SAME code server boot runs
// (SIM-70), so the CLI and the boot-time reconcile can never drift.
//
// WHY THIS EXISTS
// ---------------
// A "running" run record (kind:"run") is closed by the server process that
// launched it, on proc.close (server/index.js startRun). The `runs` Map that
// holds the live process handle is IN-MEMORY and is never rehydrated on boot,
// so when the server restarts (e.g. a release promote) mid-run, the old
// process's runs are ORPHANED: no terminal record can ever be written for them
// by the app, and there is no /stop for them (POST .../:runId/stop 404s because
// the current process never had that runId). They then fail lint:activity-log
// once they age past the 6h in-flight window. SIM-70 wires the SAME reconcile
// into server boot so a restart self-heals; this CLI stays for reconciling the
// LIVE log WITHOUT a restart (e.g. an orphan noticed mid-session).
//
// WHY IT IS SAFE TO RUN WHILE THE SERVER SERVES (root CLAUDE.md rule 3)
// --------------------------------------------------------------------
// Rule 3 forbids HAND-EDITING the data zone while the server runs, because a
// read-modify-write of the whole file races the server's concurrent append and
// can clobber a line. This script does NOT hand-edit. The core reuses the app's
// ONE writer, appendJsonl (server/lib.js), a single fs.appendFileSync with flag
// 'a' (O_APPEND): every record is one atomic append at end-of-file that never
// touches existing bytes and never rewinds - the exact mechanism the server and
// ops/activity-log-append.mjs already use to append to this same log
// concurrently, by design. Appending is not editing; it cannot race the server.
// The orphaned runIds are from a dead process, so the live server will never
// emit its own terminal for them (no double-close), and new runs get fresh
// runIds (never a collision).
//
// WHAT IT WRITES
// --------------
// For each runId whose LATEST record is status:"running", has NO terminal
// (done|failed|stopped) record, and whose "running" ts is older than the 6h
// in-flight window (so a genuinely in-flight run is never touched), it appends
// exactly one terminal record mirroring startRun's close line:
//   { ts, kind:"run", runId, status:"stopped", exitCode:null, batchId, note }
// (see ops/reconcile-core.mjs for the full rationale on status:"stopped" +
// exitCode:null and why it never skews runDurationHistory).
//
// Usage:
//   node ops/activity-log-reconcile.mjs            # DRY RUN - print, write nothing
//   node ops/activity-log-reconcile.mjs --apply    # append the terminal records

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../server/lib.js";
import { INFLIGHT_TOLERANCE_MS } from "./activity-log-lint.mjs";
import { reconcileOrphanedRuns } from "./reconcile-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const apply = process.argv.includes("--apply");

const logPath = process.argv.find((a) => a.endsWith(".jsonl"))
  ? path.resolve(process.argv.find((a) => a.endsWith(".jsonl")))
  : path.join(resolveDataDir(repoRoot), "activity-log.jsonl");

// dryRun first when NOT applying: same detection, writes nothing. The 6h window
// is the CLI default (the live server may own genuinely in-flight runs), which
// is reconcileOrphanedRuns's own default, so we pass only dryRun here.
const { orphans, closed } = reconcileOrphanedRuns(logPath, { dryRun: !apply });

console.log(`[reconcile] ${logPath}`);
console.log(`[reconcile] ${orphans.length} orphaned running run(s) beyond the ${INFLIGHT_TOLERANCE_MS / 3600000}h window:`);
for (const o of orphans) {
  console.log(
    `  ${o.runId}  ${o.running.routine}  jobId=${JSON.stringify(o.running.jobId)}  batchId=${JSON.stringify(o.running.batchId ?? null)}  started ${(o.ageMs / 3600000).toFixed(1)}h ago`
  );
}

if (!orphans.length) {
  console.log("[reconcile] nothing to do.");
  process.exit(0);
}

if (!apply) {
  console.log("[reconcile] DRY RUN - pass --apply to append the terminal records above.");
  process.exit(0);
}

for (const runId of closed) console.log(`[reconcile] appended terminal (stopped) for ${runId}`);
console.log(`[reconcile] done - appended ${closed.length} terminal record(s).`);
