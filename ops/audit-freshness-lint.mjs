#!/usr/bin/env node
// audit-freshness-lint - the release gate's independent-audit staleness check.
//
// S6 / SIM-10 (Company OS v2, 2026-07-10). The failure class this enforces
// against: the governance audit is chartered to piggyback the release gate
// (per RELEASE), but nothing mechanical held that cadence - it last ran at
// v0.16.0 while releases reached v0.35.0 (19 behind) and nothing went red.
// This lint runs inside `npm run check` (the gate every release cut must pass),
// so a stale audit now FAILS the cut instead of drifting silently.
//
// Mechanism: the newest report under docs/audits/ carries its audited version
// (frontmatter `audited_version:` preferred, else a vX.Y.Z in the filename)
// and its date (frontmatter `date:` preferred, else the filename's leading
// YYYY-MM-DD). STALE - and the gate fails - when any of:
//   - no audit report exists at all;
//   - the newest audited version is more than MAX_MINORS_BEHIND minor
//     releases behind package.json's current version (pre-1.0 scheme: the
//     minor is the release counter);
//   - the newest audit is older than MAX_AGE_DAYS.
// Tolerances (2 releases / 21 days) exist so the gate does not demand an
// audit inside every single cut; they are exported so tests pin the real
// defaults. `now` is injectable (frozen-clock tests).
//
// Run standalone: node ops/audit-freshness-lint.mjs [audits-dir] [current-version]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_MINORS_BEHIND = 2;
export const MAX_AGE_DAYS = 21;

// Parse "0.35.0" -> [0,35,0]; null when unparseable.
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Extract { version, date } from one audit file's name + content (both best-
// effort; frontmatter wins over filename).
export function auditMeta(name, content) {
  const text = String(content || "");
  const fmVer = /^audited_version:\s*["']?v?(\d+\.\d+\.\d+)/m.exec(text);
  const fnVer = /v(\d+\.\d+\.\d+)/.exec(String(name || ""));
  const fmDate = /^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(text);
  const fnDate = /^(\d{4}-\d{2}-\d{2})/.exec(String(name || ""));
  return {
    version: fmVer ? fmVer[1] : fnVer ? fnVer[1] : null,
    date: fmDate ? fmDate[1] : fnDate ? fnDate[1] : null,
  };
}

// Pure check over the parsed audit set. `audits` = [{ name, content }].
// Returns { ok, detail } - detail explains the verdict either way.
export function lintAuditFreshness(
  audits,
  currentVersion,
  { now = Date.now(), maxMinorsBehind = MAX_MINORS_BEHIND, maxAgeDays = MAX_AGE_DAYS } = {}
) {
  const cur = parseVersion(currentVersion);
  if (!cur) return { ok: false, detail: `current version ${JSON.stringify(currentVersion)} is unparseable` };

  let best = null; // { name, ver:[..], date }
  for (const a of audits || []) {
    const meta = auditMeta(a.name, a.content);
    const ver = parseVersion(meta.version);
    if (!ver) continue;
    if (!best || ver[0] > best.ver[0] || (ver[0] === best.ver[0] && ver[1] > best.ver[1]) ||
        (ver[0] === best.ver[0] && ver[1] === best.ver[1] && ver[2] > best.ver[2])) {
      best = { name: a.name, ver, date: meta.date };
    }
  }
  if (!best) {
    return { ok: false, detail: "no governance audit report found (docs/audits/ has no file with an audited version) - the release gate requires one" };
  }
  const minorsBehind = cur[0] === best.ver[0] ? cur[1] - best.ver[1] : Infinity;
  if (minorsBehind > maxMinorsBehind) {
    return {
      ok: false,
      detail: `newest audit (${best.name}) covers v${best.ver.join(".")} but the current version is v${cur.join(".")} - ${Number.isFinite(minorsBehind) ? minorsBehind + " releases" : "a major version"} behind (max ${maxMinorsBehind}); dispatch governance-auditor before cutting`,
    };
  }
  const ageMs = best.date ? now - Date.parse(best.date) : NaN;
  if (!Number.isFinite(ageMs) || ageMs > maxAgeDays * 86400000) {
    return {
      ok: false,
      detail: Number.isFinite(ageMs)
        ? `newest audit (${best.name}) is ${(ageMs / 86400000).toFixed(1)} days old (max ${maxAgeDays}); dispatch governance-auditor before cutting`
        : `newest audit (${best.name}) has no parseable date - cannot prove freshness`,
    };
  }
  return { ok: true, detail: `newest audit ${best.name} covers v${best.ver.join(".")} (${minorsBehind} release(s) behind, within ${maxMinorsBehind}) and is current` };
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const auditsDir = argv[2] ? path.resolve(argv[2]) : path.join(repoRoot, "docs", "audits");
  let currentVersion = argv[3];
  if (!currentVersion) {
    try {
      currentVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    } catch {
      currentVersion = "";
    }
  }
  // Clean-repo hermeticity (I9): the governance audit ledger is deliberately
  // absent from the public extraction (docs/audits/ is not carried at all).
  // An ABSENT directory is that posture and passes with a note; a PRESENT but
  // empty/stale ledger is the real drift this lint exists to catch and fails.
  if (!fs.existsSync(auditsDir)) {
    console.log(`[audit-freshness-lint] ${auditsDir} vs v${currentVersion}`);
    console.log("  PASS - docs/audits/ absent (clean public extraction carries no audit ledger); the private repo enforces freshness");
    process.exit(0);
  }
  let audits = [];
  try {
    audits = fs
      .readdirSync(auditsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, content: fs.readFileSync(path.join(auditsDir, f), "utf8") }));
  } catch {
    /* unreadable dir -> audits stays [] -> fails with the no-audit detail */
  }
  const { ok, detail } = lintAuditFreshness(audits, currentVersion);
  console.log(`[audit-freshness-lint] ${auditsDir} vs v${currentVersion}`);
  console.log(`  ${ok ? "PASS" : "FAIL"} - ${detail}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
