#!/usr/bin/env node
// closeout-gate-lint - mechanical enforcement of the Routine Closeout Gate.
//
// S6 / SIM-10 (Company OS v2, 2026-07-10). The gate pattern (kernel:
// company-os/os/patterns/routine-closeout-gate.md) requires every routine run
// to end by appending a "### Closeout" block (goal / outcome vs goal /
// trajectory / action / lesson) to its output artifact. It was fully specified
// and entirely unenforced - process discipline only. This lint makes it
// mechanical: every dated routine OUTPUT file must carry a Closeout heading,
// and `npm run check` fails when one is missing.
//
// Scope: the dated routine-output directories (enablement-reviews,
// usage-reviews, session-debriefs, audits). Enforcement starts at
// ENFORCED_SINCE (2026-07-11): files whose leading YYYY-MM-DD filename date is
// BEFORE that are grandfathered - the historical outputs predate the gate's
// mechanical enforcement and rewriting point-in-time records to satisfy a new
// lint would falsify them (the roster-audit precedent). Undated files are
// skipped (not routine-run outputs). The cutoff and `dirs` are injectable so
// tests run on fixtures.
//
// Run standalone: node ops/closeout-gate-lint.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENFORCED_SINCE = "2026-07-11";
export const OUTPUT_DIRS = ["docs/enablement-reviews", "docs/usage-reviews", "docs/session-debriefs", "docs/audits"];
const CLOSEOUT_RE = /^#{2,4}\s+Closeout\b/m;

// Pure check. `files` = [{ dir, name, content }]. A file is IN SCOPE when its
// name starts with YYYY-MM-DD and that date >= enforcedSince. Returns
// { ok, findings, checked, grandfathered }.
export function lintCloseoutGate(files, { enforcedSince = ENFORCED_SINCE } = {}) {
  const findings = [];
  let checked = 0;
  let grandfathered = 0;
  const since = Date.parse(enforcedSince);
  for (const f of files || []) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(f.name || ""));
    if (!m) continue; // undated -> not a dated routine output
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    if (t < since) {
      grandfathered++;
      continue;
    }
    checked++;
    if (!CLOSEOUT_RE.test(String(f.content || ""))) {
      findings.push({
        file: `${f.dir}/${f.name}`,
        detail: `dated routine output has no Closeout block (routine-closeout-gate pattern: every run appends "### Closeout" with goal / outcome vs goal / action)`,
      });
    }
  }
  return { ok: findings.length === 0, findings, checked, grandfathered };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const files = [];
  for (const rel of OUTPUT_DIRS) {
    const dir = path.join(repoRoot, rel);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // a missing output dir is fine (routine has not run yet)
    }
    for (const name of names) {
      let content = "";
      try {
        content = fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        /* unreadable file -> content stays "", which fails the check loudly */
      }
      files.push({ dir: rel, name, content });
    }
  }
  const { ok, findings, checked, grandfathered } = lintCloseoutGate(files);
  console.log(`[closeout-gate-lint] ${OUTPUT_DIRS.join(", ")}`);
  console.log(`  checked: ${checked} (enforced since ${ENFORCED_SINCE})  grandfathered: ${grandfathered}`);
  if (ok) {
    console.log("  PASS - every enforced routine output carries its Closeout block");
    process.exit(0);
  }
  console.log(`  FAIL - ${findings.length} finding(s):`);
  for (const f of findings) console.log(`     ${f.file}: ${f.detail}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
