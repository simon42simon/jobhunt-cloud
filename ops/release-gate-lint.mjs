#!/usr/bin/env node
// release-gate-lint - the promote/release lane's release-readiness assertions.
//
// SIM-65 part 3 (2026-07-14). The failure class this enforces against: audit R6
// asserts that a version the org "ships" must be reproducible, recorded, and
// reversible - concretely, for the CURRENT package.json version, (a) the
// changelog carries an entry for it, (b) a git tag `vX.Y.Z` exists, and (c) the
// working tree is clean and in sync with origin (the release commit is
// committed AND pushed, so the tag is restorable from origin). Nothing
// mechanical held that: a cut could tag off an un-pushed commit, or promote a
// version with no changelog entry, and stay green.
//
// WHY THIS IS *NOT* IN `npm run check`. These are RELEASE-TIME assertions, not
// dev-loop ones. The everyday dev working tree legitimately carries
// app-written uncommitted files (e.g. docs/discovery-sources.yaml, written by
// the running server) and is not tagged until the cut - so a hard
// clean-vs-origin / tag-exists check inside `npm run check` would false-red on
// every ordinary dev run. This lint is therefore its OWN script
// (`npm run lint:release-gate`) intended for the RELEASE lane, run as the final
// mechanical gate on the release commit - on a BRANCH checkout that has an
// upstream (the main checkout or the `mabrain-jobhunt-release` cut lane), AFTER
// the changelog + tag are written and the commit is pushed, and BEFORE
// `ops/scripts/promote-stable.cmd`. See docs/dual-track-sop.md section 1b ("the
// gates, in order"). It is deliberately NOT wired into promote-stable.ps1: that
// runs against the DETACHED stable worktree, which legitimately carries
// deploy-local modifications to tracked files (config.json, .claude/settings.json
// - the SOP's "promote-time known issue"), so a clean-tree check there would
// false-fail.
//
// The three checks are PURE and injectable (version, changelog text, tag list,
// git-status result all passed in) so they unit-test on fixtures without
// touching real git - see tests/release-gate-lints.test.js. `main()` gathers the
// real inputs (package.json, docs/changelog.md, `git tag`, `git status`) and
// prints a PASS/FAIL per check, exiting non-zero on any finding so it can gate.
//
// Run standalone: node ops/release-gate-lint.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Normalize "v0.38.1" / " 0.38.1 " -> "0.38.1"; null when it is not an X.Y.Z.
export function normalizeVersion(v) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(v || "").trim());
  return m ? m[1] : null;
}

// (a) The changelog must carry a released entry for the current version, i.e. a
// heading `## [X.Y.Z]` (the Keep a Changelog form docs/changelog.md uses). The
// "[Unreleased]" section does NOT count - a shipped version must be recorded
// under its own number. A leading `v` in the heading is tolerated.
export function lintChangelogHasVersion(changelogText, version) {
  const v = normalizeVersion(version);
  if (!v) return { ok: false, detail: `current version ${JSON.stringify(version)} is unparseable - cannot check the changelog` };
  const esc = v.replace(/\./g, "\\.");
  const re = new RegExp(`^##\\s*\\[v?${esc}\\]`, "m");
  if (re.test(String(changelogText || ""))) {
    return { ok: true, detail: `changelog has a "## [${v}]" entry` };
  }
  return {
    ok: false,
    detail: `changelog (docs/changelog.md) has no "## [${v}]" entry - every shipped version needs one (move it out of [Unreleased] and stamp it version - YYYY-MM-DD HH:MM ET)`,
  };
}

// (b) A git tag `vX.Y.Z` must exist for the current version so the release is
// reversible (promote/rollback are tag-driven). Accepts the tag list as an
// array or a newline-joined string (raw `git tag` output). A bare `X.Y.Z` tag
// is tolerated as well as the canonical `vX.Y.Z`.
export function lintTagExists(tags, version) {
  const v = normalizeVersion(version);
  if (!v) return { ok: false, detail: `current version ${JSON.stringify(version)} is unparseable - cannot check for a tag` };
  const list = (Array.isArray(tags) ? tags : String(tags || "").split(/\r?\n/))
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (list.includes(`v${v}`) || list.includes(v)) {
    return { ok: true, detail: `git tag v${v} exists` };
  }
  return {
    ok: false,
    detail: `no git tag v${v} for the current version - tag the release commit (git tag v${v}) so the release is restorable`,
  };
}

// (c) The working tree must be clean AND in sync with origin, so the tag points
// at exactly what origin has (reproducible + reversible). `gitStatus` is the
// injected status result:
//   { dirty: string[],   // porcelain change lines; empty = clean tree
//     ahead: number,     // commits ahead of the tracked upstream (branch case)
//     behind: number,    // commits behind it
//     upstream: string|null,  // e.g. "origin/main", or null when detached
//     onOrigin: boolean|undefined } // HEAD commit reachable from an origin/* ref
// Policy (fail-honest): dirty tree fails; ahead/behind fails; a detached HEAD
// (no upstream) passes ONLY when onOrigin === true (the release commit is on
// origin); if neither an upstream nor onOrigin proof exists, it fails rather
// than assume the tree matches origin.
export function lintTreeCleanVsOrigin(gitStatus = {}) {
  const dirty = Array.isArray(gitStatus.dirty) ? gitStatus.dirty : [];
  if (dirty.length) {
    const sample = dirty.slice(0, 3).map((s) => String(s).trim()).join("; ");
    const more = dirty.length > 3 ? ` (+${dirty.length - 3} more)` : "";
    return {
      ok: false,
      detail: `working tree has ${dirty.length} uncommitted/untracked change(s): ${sample}${more} - commit or stash before releasing`,
    };
  }
  const ahead = Number(gitStatus.ahead) || 0;
  const behind = Number(gitStatus.behind) || 0;
  if (ahead || behind) {
    return {
      ok: false,
      detail: `HEAD is ${ahead} ahead / ${behind} behind ${gitStatus.upstream || "origin"} - push (or pull) so the tag matches origin before releasing`,
    };
  }
  if (gitStatus.onOrigin === false) {
    return { ok: false, detail: "the current HEAD commit is not present on origin - push the release commit before tagging/promoting" };
  }
  if (!gitStatus.upstream && gitStatus.onOrigin !== true) {
    return {
      ok: false,
      detail: "cannot confirm the working tree matches origin (no upstream branch, and HEAD was not found on any origin/* ref) - push the release commit first",
    };
  }
  return {
    ok: true,
    detail: `working tree clean and in sync with origin${gitStatus.upstream ? ` (${gitStatus.upstream})` : " (HEAD is on origin)"}`,
  };
}

// Compose the three checks over injected inputs. Returns
// { ok, findings, checks, version }: `checks` is every check's verdict (for
// full PASS/FAIL output), `findings` only the failures (drives the exit code).
export function lintReleaseGate({ version, changelog, tags, gitStatus } = {}) {
  const results = [
    ["changelog", lintChangelogHasVersion(changelog, version)],
    ["tag", lintTagExists(tags, version)],
    ["clean-tree", lintTreeCleanVsOrigin(gitStatus)],
  ];
  const checks = results.map(([check, r]) => ({ check, ...r }));
  const findings = checks.filter((c) => !c.ok).map((c) => ({ check: c.check, detail: c.detail }));
  return { ok: findings.length === 0, findings, checks, version: normalizeVersion(version) };
}

// --- CLI input gathering ------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// Gather the real { dirty, ahead, behind, upstream, onOrigin } from git. Any git
// failure degrades gracefully to a fail-honest status (empty/unknown) rather
// than throwing, so the lint still runs and reports.
function gatherGitStatus(repoRoot) {
  const status = { dirty: [], ahead: 0, behind: 0, upstream: null, onOrigin: undefined };
  // Branch line + porcelain change lines in one call: `-b` prints a "## ..."
  // header, remaining lines are changes (staged/unstaged/untracked).
  try {
    const out = git(["status", "--porcelain=v1", "-b"], repoRoot).split(/\r?\n/);
    for (const line of out) {
      if (!line) continue;
      if (line.startsWith("##")) {
        const up = /\.\.\.(\S+)/.exec(line);
        if (up) status.upstream = up[1];
        const a = /\[.*?ahead (\d+)/.exec(line);
        const b = /\[.*?behind (\d+)/.exec(line);
        if (a) status.ahead = Number(a[1]);
        if (b) status.behind = Number(b[1]);
        continue;
      }
      status.dirty.push(line);
    }
  } catch {
    /* git status unavailable -> dirty stays [] but onOrigin proof below decides */
  }
  // onOrigin: is the current HEAD commit reachable from any origin/* ref? Covers
  // the detached release-checkout case where there is no upstream branch.
  try {
    const refs = git(["branch", "-r", "--contains", "HEAD"], repoRoot)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    status.onOrigin = refs.some((r) => r.startsWith("origin/"));
  } catch {
    status.onOrigin = undefined;
  }
  return status;
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");

  let version = argv[2];
  if (!version) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    } catch {
      version = "";
    }
  }
  let changelog = "";
  try {
    changelog = fs.readFileSync(path.join(repoRoot, "docs", "changelog.md"), "utf8");
  } catch {
    /* missing changelog -> the changelog check fails with a clear detail */
  }
  let tags = [];
  try {
    tags = git(["tag", "--list"], repoRoot).split(/\r?\n/);
  } catch {
    /* no git / no tags -> the tag check fails honestly */
  }
  const gitStatus = gatherGitStatus(repoRoot);

  const { ok, checks } = lintReleaseGate({ version, changelog, tags, gitStatus });

  console.log(`[release-gate-lint] release-readiness for v${normalizeVersion(version) || version} (${repoRoot})`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"} [${c.check}] - ${c.detail}`);
  }
  if (ok) {
    console.log("  OK - the version is recorded (changelog), reversible (tag), and reproducible (clean vs origin)");
    process.exit(0);
  }
  console.log("  BLOCKED - resolve the FAIL line(s) above before promoting; this lint runs in the release lane, not npm run check");
  process.exit(1);
}

// CLI only when invoked directly, never when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
