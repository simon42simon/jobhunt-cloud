#!/usr/bin/env node
// One-shot builder for tests/fixtures/board/ (R1 fix, external audit 2026-07-13).
// The server test suites used to copy docs/ and silently depended on the LIVE
// board files living there; ADR-023 moved those to the data zone and the gate
// went red. This script derives a SMALL, COMMITTED, synthetic-ish fixture set:
// the two backfill-source tasks the requests suite pins (t-1783097277925,
// t-1783042256172 - long in git history, org tickets not personal data) plus
// the earliest generic setup tasks, and a minimal requests ledger. Re-run only
// if the fixture contract needs new records; fixtures are committed, never live.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveDataDir } from "../../server/lib.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = resolveDataDir(repo);
const outDir = path.join(repo, "tests", "fixtures", "board");
fs.mkdirSync(outDir, { recursive: true });

const live = yaml.load(fs.readFileSync(path.join(dataDir, "tasks.yaml"), "utf8"));
const PINNED = new Set(["t-1783097277925", "t-1783042256172"]);
const generic = live.tasks.filter((t) => /^t-0\d\d$/.test(t.id)).slice(0, 4);
const pinned = live.tasks.filter((t) => PINNED.has(t.id));
if (pinned.length !== PINNED.size) throw new Error("pinned backfill tasks not found in live data");
const tasks = { columns: live.columns, tasks: [...generic, ...pinned] };
fs.writeFileSync(
  path.join(outDir, "tasks.yaml"),
  "# SYNTHETIC TEST FIXTURE (tests/fixtures/board) - committed, never live data.\n" +
    "# Built by ops/scripts/build-test-fixtures.mjs; the suites overlay this onto\n" +
    "# their throwaway docs copy. Do not point the app here.\n" + yaml.dump(tasks),
);

const liveReq = yaml.load(fs.readFileSync(path.join(dataDir, "requests.yaml"), "utf8"));
// The backfill suite pins these two stored ledger records (session + chatbot).
const PINNED_R = new Set(["r-1783097277925", "r-1783042256172"]);
const pinnedReqs = (liveReq.requests || []).filter((r) => PINNED_R.has(r.id));
if (pinnedReqs.length !== PINNED_R.size) throw new Error("pinned requests not found in live ledger");
const reqs = { requests: [(liveReq.requests || [])[0], ...pinnedReqs].filter(Boolean) };
fs.writeFileSync(
  path.join(outDir, "requests.yaml"),
  "# SYNTHETIC TEST FIXTURE - see tasks.yaml header.\n" + yaml.dump(reqs),
);

fs.writeFileSync(path.join(outDir, "notify-state.json"), "{}\n");
fs.writeFileSync(path.join(outDir, "job-chats.json"), "{}\n");
fs.writeFileSync(path.join(outDir, "activity-log.jsonl"), "");
fs.writeFileSync(path.join(outDir, "usage-telemetry.jsonl"), "");
console.log(`fixtures written: ${tasks.tasks.length} tasks, ${reqs.requests.length} requests -> ${outDir}`);
