import { describe, it, expect } from "vitest";
import {
  lintAuditFreshness,
  auditMeta,
  parseVersion,
  MAX_MINORS_BEHIND,
  MAX_AGE_DAYS,
} from "../ops/audit-freshness-lint.mjs";
import { lintCloseoutGate, ENFORCED_SINCE } from "../ops/closeout-gate-lint.mjs";
import {
  lintReleaseGate,
  lintChangelogHasVersion,
  lintTagExists,
  lintTreeCleanVsOrigin,
  normalizeVersion,
} from "../ops/release-gate-lint.mjs";

// S6 / SIM-10 enforcement lints (2026-07-10). Determinism rules match
// activity-log-lint.test.js: frozen `now`, inline fixtures, exported defaults
// pinned (not copied). Each suite includes the DELIBERATELY-STALE / MISSING
// case proving the check actually fails - the whole point of the wiring.
const FROZEN_NOW = Date.parse("2026-07-10T12:00:00.000Z");
const audit = (name, version, date) => ({
  name,
  content: `---\ntype: governance-audit\naudited_version: ${version}\ndate: ${date}\n---\n\n# audit\n`,
});

describe("audit-freshness-lint", () => {
  it("PASSES when the newest audit covers the current release window", () => {
    const { ok } = lintAuditFreshness(
      [audit("2026-07-10-v0.35.0-release-audit.md", "0.35.0", "2026-07-10")],
      "0.35.0",
      { now: FROZEN_NOW }
    );
    expect(ok).toBe(true);
  });

  it("FAILS on the deliberately-stale case: audit at v0.16.0 while the product is at v0.35.0 (the real 19-behind gap)", () => {
    const { ok, detail } = lintAuditFreshness(
      [audit("2026-07-03-v0.16.0-release-audit.md", "0.16.0", "2026-07-03")],
      "0.35.0",
      { now: FROZEN_NOW }
    );
    expect(ok).toBe(false);
    expect(detail).toContain("19 releases behind");
  });

  it("FAILS when no audit report exists at all", () => {
    const { ok, detail } = lintAuditFreshness([], "0.35.0", { now: FROZEN_NOW });
    expect(ok).toBe(false);
    expect(detail).toContain("no governance audit report");
  });

  it("FAILS when the newest audit is too old by date even if the version is close", () => {
    const { ok, detail } = lintAuditFreshness(
      [audit("2026-05-01-v0.34.0-release-audit.md", "0.34.0", "2026-05-01")],
      "0.35.0",
      { now: FROZEN_NOW }
    );
    expect(ok).toBe(false);
    expect(detail).toContain("days old");
  });

  it("tolerates being within the release window (defaults pinned)", () => {
    expect(MAX_MINORS_BEHIND).toBe(2);
    expect(MAX_AGE_DAYS).toBe(21);
    const { ok } = lintAuditFreshness(
      [audit("2026-07-08-v0.33.0-release-audit.md", "0.33.0", "2026-07-08")],
      "0.35.0",
      { now: FROZEN_NOW }
    );
    expect(ok).toBe(true); // 2 minors behind = at the tolerance edge, allowed
  });

  it("reads the version from the filename when frontmatter lacks it", () => {
    expect(auditMeta("2026-07-03-v0.16.0-release-audit.md", "# no frontmatter")).toEqual({
      version: "0.16.0",
      date: "2026-07-03",
    });
    expect(parseVersion("v0.35.0")).toEqual([0, 35, 0]);
  });
});

describe("closeout-gate-lint", () => {
  const file = (dir, name, content) => ({ dir, name, content });

  it("PASSES when every enforced dated output carries a Closeout block", () => {
    const { ok, checked } = lintCloseoutGate(
      [file("docs/usage-reviews", "2026-07-12.md", "# report\n\n### Closeout\n- Goal: x\n")],
      { enforcedSince: "2026-07-11" }
    );
    expect(ok).toBe(true);
    expect(checked).toBe(1);
  });

  it("FAILS on the missing-Closeout case: an enforced dated output with no Closeout block", () => {
    const { ok, findings } = lintCloseoutGate(
      [file("docs/usage-reviews", "2026-07-12.md", "# report with no closeout\n")],
      { enforcedSince: "2026-07-11" }
    );
    expect(ok).toBe(false);
    expect(findings[0].file).toBe("docs/usage-reviews/2026-07-12.md");
  });

  it("grandfathers outputs dated before the enforcement cutoff instead of failing them", () => {
    const { ok, checked, grandfathered } = lintCloseoutGate(
      [
        file("docs/session-debriefs", "2026-07-02.md", "# old, no closeout\n"),
        file("docs/enablement-reviews", "2026-07-12.md", "## Closeout\nok\n"),
      ],
      { enforcedSince: "2026-07-11" }
    );
    expect(ok).toBe(true);
    expect(checked).toBe(1);
    expect(grandfathered).toBe(1);
  });

  it("skips undated files (not routine-run outputs) and pins the real cutoff", () => {
    expect(ENFORCED_SINCE).toBe("2026-07-11");
    const { ok, checked } = lintCloseoutGate([file("docs/audits", "README.md", "no closeout")], {});
    expect(ok).toBe(true);
    expect(checked).toBe(0);
  });
});

// SIM-65 part 3 (2026-07-14). Release-gate lint - the promote/release lane's
// release-readiness assertions (audit R6): a shipped version must be recorded
// (changelog entry), reversible (git tag), and reproducible (clean vs origin).
// All three checks are pure over injected inputs, so every case here runs on
// fixtures with no real git. Same determinism discipline as the suites above,
// and each check has its DELIBERATE FAIL case proving the gate actually blocks.
describe("release-gate-lint", () => {
  const CHANGELOG = `# Changelog

## [Unreleased]

_Nothing awaiting a version cut._

## [0.38.1] - 2026-07-14 04:35 ET

### Fixed
- something

## [0.38.0] - 2026-07-14 03:43 ET

### Added
- something else
`;
  const TAGS = ["v0.38.1", "v0.38.0", "v0.37.0"];
  const CLEAN = { dirty: [], ahead: 0, behind: 0, upstream: "origin/main", onOrigin: true };

  it("PASSES when the version has a changelog entry + a tag + a clean tree in sync with origin", () => {
    const { ok, findings } = lintReleaseGate({
      version: "0.38.1",
      changelog: CHANGELOG,
      tags: TAGS,
      gitStatus: CLEAN,
    });
    expect(ok).toBe(true);
    expect(findings).toHaveLength(0);
  });

  // (a) changelog ---------------------------------------------------------------
  it("FAILS when the changelog has no entry for the current version (still only in [Unreleased])", () => {
    const { ok, findings } = lintReleaseGate({
      version: "0.39.0",
      changelog: CHANGELOG,
      tags: ["v0.39.0", ...TAGS],
      gitStatus: CLEAN,
    });
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toContain("changelog");
    expect(findings.find((f) => f.check === "changelog").detail).toContain('"## [0.39.0]"');
  });

  it("does not accept an [Unreleased] section as the version's entry", () => {
    // The version exists only under [Unreleased] -> changelog check must fail.
    const { ok } = lintChangelogHasVersion(CHANGELOG, "0.99.0");
    expect(ok).toBe(false);
  });

  it("matches the released heading form and tolerates a leading v", () => {
    expect(lintChangelogHasVersion(CHANGELOG, "0.38.0").ok).toBe(true);
    expect(lintChangelogHasVersion("## [v0.38.1] - x\n", "0.38.1").ok).toBe(true);
  });

  // (b) tag ---------------------------------------------------------------------
  it("FAILS when no git tag exists for the current version", () => {
    const { ok, findings } = lintReleaseGate({
      version: "0.39.0",
      changelog: CHANGELOG + "\n## [0.39.0] - 2026-07-15 10:00 ET\n",
      tags: TAGS, // no v0.39.0
      gitStatus: CLEAN,
    });
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toContain("tag");
    expect(findings.find((f) => f.check === "tag").detail).toContain("v0.39.0");
  });

  it("accepts the tag list as a raw newline-joined string and a bare X.Y.Z tag", () => {
    expect(lintTagExists("v0.38.1\nv0.38.0\n", "0.38.1").ok).toBe(true);
    expect(lintTagExists(["0.38.1"], "0.38.1").ok).toBe(true);
  });

  // (c) clean tree vs origin ----------------------------------------------------
  it("FAILS on a dirty working tree (uncommitted changes) even with changelog + tag present", () => {
    const { ok, findings } = lintReleaseGate({
      version: "0.38.1",
      changelog: CHANGELOG,
      tags: TAGS,
      gitStatus: { ...CLEAN, dirty: [" M src/App.tsx", "?? scratch.txt"] },
    });
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toContain("clean-tree");
    expect(findings.find((f) => f.check === "clean-tree").detail).toContain("2 uncommitted");
  });

  it("FAILS when HEAD is ahead of origin (release commit not pushed)", () => {
    const { ok } = lintTreeCleanVsOrigin({ dirty: [], ahead: 1, behind: 0, upstream: "origin/main", onOrigin: true });
    expect(ok).toBe(false);
  });

  it("FAILS a detached checkout whose HEAD commit is not on origin", () => {
    const { ok, detail } = lintTreeCleanVsOrigin({ dirty: [], ahead: 0, behind: 0, upstream: null, onOrigin: false });
    expect(ok).toBe(false);
    expect(detail).toContain("not present on origin");
  });

  it("PASSES a detached release checkout whose HEAD commit IS on origin (no upstream branch)", () => {
    const { ok } = lintTreeCleanVsOrigin({ dirty: [], ahead: 0, behind: 0, upstream: null, onOrigin: true });
    expect(ok).toBe(true);
  });

  it("FAILS fail-honest when it cannot prove the tree matches origin (no upstream, no onOrigin proof)", () => {
    const { ok } = lintTreeCleanVsOrigin({ dirty: [], ahead: 0, behind: 0, upstream: null });
    expect(ok).toBe(false);
  });

  // composition + parsing -------------------------------------------------------
  it("reports ALL failing checks at once, not just the first", () => {
    const { ok, findings } = lintReleaseGate({
      version: "0.40.0",
      changelog: CHANGELOG, // no 0.40.0 entry
      tags: TAGS, // no v0.40.0
      gitStatus: { dirty: [" M x"], ahead: 0, behind: 0, upstream: "origin/main" },
    });
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check).sort()).toEqual(["changelog", "clean-tree", "tag"]);
  });

  it("normalizeVersion strips a leading v and rejects non-X.Y.Z", () => {
    expect(normalizeVersion("v0.38.1")).toBe("0.38.1");
    expect(normalizeVersion(" 0.38.1 ")).toBe("0.38.1");
    expect(normalizeVersion("0.38")).toBe(null);
    expect(normalizeVersion("garbage")).toBe(null);
  });
});
