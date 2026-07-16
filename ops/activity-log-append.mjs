#!/usr/bin/env node
// Tiny stdin -> activity-log.jsonl appender.
//
// The CTO wires a Claude Code hook to pipe subagent-delegation records into this
// so delegations show on the Activity feed next to routine-runner runs. It reads
// ONE JSON object from stdin, defaults its `kind` to "delegation", and appends a
// single line to docs/activity-log.jsonl using the SAME writer the server uses
// (appendJsonl in server/lib.js) - so the on-disk format can never drift.
//
// Resolved log path (ADR-023): the live data zone - C:\Usersyou\ssc-brain\data\jobhunt\activity-log.jsonl
// Record shape (matches the server): { ts: ISO8601, kind: string, ... }.
//
// Best-effort by contract: bad / empty stdin is a no-op (exit 0), never a hook
// failure. Only a genuine filesystem write error exits non-zero.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, resolveDataDir } from "../server/lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Live data lives in the data zone (JOBHUNT_DATA_DIR > config dataDir > <repo>/docs).
const ACTIVITY_FILE = path.join(resolveDataDir(path.resolve(__dirname, "..")), "activity-log.jsonl");

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
if (!raw) process.exit(0); // nothing piped in -> no-op

let record;
try {
  record = JSON.parse(raw);
} catch {
  process.stderr.write("activity-log-append: stdin was not valid JSON; ignored\n");
  process.exit(0); // never fail a hook on bad input
}
if (record === null || typeof record !== "object" || Array.isArray(record)) {
  process.stderr.write("activity-log-append: expected a JSON object; ignored\n");
  process.exit(0);
}

try {
  // `ts` is stamped by appendJsonl; `kind` defaults to "delegation" but a supplied
  // kind wins (spread after the default).
  appendJsonl(ACTIVITY_FILE, { kind: "delegation", ...record });
} catch (e) {
  process.stderr.write(`activity-log-append: ${e.message}\n`);
  process.exit(1);
}
