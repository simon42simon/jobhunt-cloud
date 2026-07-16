#!/usr/bin/env node
// delegation-append - PostToolUse(Task) hook -> docs/activity-log.jsonl.
//
// The S5 / ADR-002 Phase 5 (F7) repair, 2026-07-10 (Company OS v2, SIM-9).
// Delegation records used to be piped MANUALLY by the CTO session into
// ops/activity-log-append.mjs; that wiring silently stopped on 2026-07-02 (the
// hook registration was lost and nothing noticed). This hook makes delegation
// logging IN-PROCESS and automatic: Claude Code fires it after every Task tool
// call in a session run from this repo, so a subagent delegation appends its
// own terminal record with zero human discipline required. The other half of
// the fix is the delegation-freshness check in ops/activity-log-lint.mjs
// (wired into `npm run check`), which goes red if delegations flatline while
// runs keep flowing - so this wiring can never silently stop AGAIN without the
// gate saying so.
//
// Contract (mirrors ops/activity-log-append.mjs, which stays for manual notes):
// - Reads the PostToolUse hook payload (JSON) from stdin.
// - Only the subagent-dispatch tool is logged; anything else is a no-op
//   (exit 0). Empirically (2026-07-10, instrumented probe) the dispatch tool is
//   named "Agent" in the current harness ("Task" in earlier versions); both are
//   accepted here and the settings matcher is "Task|Agent".
// - TERMINAL-ONLY protocol (activity-log-lint header): exactly one record per
//   delegation, written when the subagent finishes, status done|failed.
// - `routine` must be an agents.yaml role id (lint's unknown-routine check), so
//   harness utility agents (general-purpose, Explore, Plan, claude, fork, ...)
//   are SKIPPED: delegation telemetry tracks the ORG's roster, not scaffolding.
//   "manager" is kept: the lint aliases it to "cto".
// - Best-effort by contract: bad/empty stdin, an unknown role, or a missing
//   roster file is a silent no-op (exit 0) - a telemetry hiccup must never fail
//   the Task call it observes. Only a real write error exits non-zero.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, resolveDataDir } from "../../server/lib.js";
import { loadRoleIds } from "../activity-log-lint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
// Live activity log = data zone (ADR-023); agents.yaml stays repo content.
const ACTIVITY_FILE = path.join(resolveDataDir(REPO), "activity-log.jsonl");
const AGENTS_YAML = path.join(REPO, "docs", "agents.yaml");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const raw = (await readStdin()).trim();
if (!raw) process.exit(0);

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0); // not JSON -> never fail the hook
}
if (!payload || typeof payload !== "object") process.exit(0);
if (payload.tool_name !== "Task" && payload.tool_name !== "Agent") process.exit(0);

const input = payload.tool_input || {};
const agent = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : "";
if (!agent) process.exit(0);

// Roster gate: log only org roles (+ "manager", the lint's cto alias).
const roles = new Set(loadRoleIds(AGENTS_YAML));
roles.add("manager");
if (!roles.has(agent)) process.exit(0);

// Terminal status: a Task tool_response that reports an error closes as failed.
const resp = payload.tool_response;
const failed = !!(resp && typeof resp === "object" && (resp.is_error === true || resp.isError === true));

const label = typeof input.description === "string" && input.description.trim() ? input.description.trim() : "(no description)";

try {
  appendJsonl(ACTIVITY_FILE, {
    kind: "delegation",
    routine: agent,
    label,
    status: failed ? "failed" : "done",
    via: "hook", // distinguishes automatic appends from manual activity-log-append.mjs notes
  });
} catch (e) {
  process.stderr.write(`delegation-append: ${e.message}\n`);
  process.exit(1);
}
