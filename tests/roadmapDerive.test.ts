import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/lib/changelog";
import {
  deriveRoadmap,
  derivePhaseStatus,
  normVersion,
  parseReleases,
  projectCompletedDate,
} from "../src/lib/roadmapDerive";
import type { Milestone, Portfolio, Roadmap, RoadmapPhase } from "../src/types";

// Unit tests for the pure roadmap-status derivation (ADR-012): a phase's status
// and the header product version are DERIVED from the linked portfolio
// milestones + the changelog releases, never the stored roadmap.yaml value, so
// the Roadmap view cannot drift. Hand-built fixtures, no fetch, no DOM - same
// posture as projectStats / involvement / changelog tests. Layer: unit, plus one
// real-data sanity guard at the end. Without the derive logic (a naive
// milestone-only rollup) the release-anchored and item-guard cases below fail.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function phase(over: Partial<RoadmapPhase> & { id: string }): RoadmapPhase {
  return { title: over.id, status: "planned", items: [], ...over };
}

function ms(status: string, roadmap_phase: string, id = `m-${Math.random()}`): Milestone {
  return { id, project: "prj-x", name: id, definition_of_done: "", status, roadmap_phase };
}

function portfolio(milestones: Milestone[]): Portfolio {
  return { version: 1, updated: "", projects: [], milestones };
}

// Two released versions, newest first (the doc's own convention).
const CHANGELOG = `# Changelog

Intro paragraph before any version.

---

## [0.15.0] - 2026-07-03 18:45 ET

Operational management wave.

### Added
- The intake ledger.

## [0.13.0] - 2026-07-02 03:10 ET

Execution views wave.

### Added
- The chatbot.
`;

const RELEASES = parseReleases(CHANGELOG);

describe("normVersion", () => {
  it("drops a leading v and trims, so a phase '0.13.0' matches a changelog '0.13.0'", () => {
    expect(normVersion("v0.13.0")).toBe("0.13.0");
    expect(normVersion(" 0.13.0 ")).toBe("0.13.0");
    expect(normVersion("V0.1.0")).toBe("0.1.0");
    expect(normVersion(undefined)).toBe("");
    expect(normVersion(null)).toBe("");
  });
});

describe("parseReleases", () => {
  it("reads the latest released version + its date, the released set, and per-version dates", () => {
    expect(RELEASES.latestVersion).toBe("0.15.0");
    expect(RELEASES.latestDate).toBe("2026-07-03 18:45 ET"); // full string for the header
    expect(RELEASES.released.has("0.15.0")).toBe(true);
    expect(RELEASES.released.has("0.13.0")).toBe(true);
    expect(RELEASES.dateByVersion.get("0.15.0")).toBe("2026-07-03"); // YYYY-MM-DD for a phase shipped date
    expect(RELEASES.dateByVersion.get("0.13.0")).toBe("2026-07-02");
  });

  it("tolerates an empty / unparseable changelog without throwing (no releases)", () => {
    const empty = parseReleases("");
    expect(empty.latestVersion).toBeNull();
    expect(empty.latestDate).toBeNull();
    expect(empty.released.size).toBe(0);
    expect(() => parseReleases("not a changelog at all")).not.toThrow();
  });

  it("ignores an [Unreleased] header", () => {
    const r = parseReleases("## [Unreleased] - TBD\n\n### Added\n- wip\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- real\n");
    expect(r.released.has("1.0.0")).toBe(true);
    expect(r.latestVersion).toBe("1.0.0"); // skipped the Unreleased entry
    expect([...r.released]).not.toContain("Unreleased");
  });
});

describe("projectCompletedDate", () => {
  it("resolves the release date of the project's target version (YYYY-MM-DD)", () => {
    expect(projectCompletedDate({ target: "0.15.0", created: "2026-01-01" }, RELEASES)).toBe("2026-07-03");
  });

  it("normalizes a v-prefixed target so it still matches the changelog", () => {
    expect(projectCompletedDate({ target: "v0.13.0" }, RELEASES)).toBe("2026-07-02");
  });

  it("falls back to created when the target maps to no released version", () => {
    expect(projectCompletedDate({ target: "9.9.9", created: "2026-05-05" }, RELEASES)).toBe("2026-05-05");
  });

  it("falls back to created when there is no target at all", () => {
    expect(projectCompletedDate({ created: "2026-05-05" }, RELEASES)).toBe("2026-05-05");
  });

  it("returns null when neither a released target nor a created date resolves", () => {
    expect(projectCompletedDate({}, RELEASES)).toBeNull();
    expect(projectCompletedDate({ target: "9.9.9" }, RELEASES)).toBeNull();
  });
});

describe("derivePhaseStatus", () => {
  it("RULE 1 - a released version wins: shipped even if a linked milestone is still in progress", () => {
    // The phase-ops-management case: version 0.15.0 shipped, yet a later
    // milestone (this wave) is pinned under it and still in_progress. A cut
    // release cannot un-ship, so the release signal must override the rollup.
    const p = phase({ id: "wave", status: "shipped", version: "0.15.0" });
    const got = derivePhaseStatus(p, [ms("in_progress", "wave")], RELEASES);
    expect(got).toEqual({ status: "shipped", basis: "release" });
  });

  it("RULE 2a - all linked milestones done AND no open items -> shipped", () => {
    const p = phase({ id: "p", status: "in_progress", items: [{ text: "a", done: true }] });
    const got = derivePhaseStatus(p, [ms("done", "p"), ms("done", "p")], RELEASES);
    expect(got).toEqual({ status: "shipped", basis: "milestones" });
  });

  it("RULE 2a guard - all linked milestones done BUT an authored item is still open -> in_progress", () => {
    // The phase-3 case: its 3 charted milestones are all done, but the phase
    // still lists un-charted open scope (Apify/Ingest/Evaluate...). Milestones
    // are an INCOMPLETE charting, so all-done must not falsely claim shipped.
    const p = phase({
      id: "p3",
      status: "in_progress",
      items: [{ text: "shipped bit", done: true }, { text: "open bit", done: false }],
    });
    const got = derivePhaseStatus(p, [ms("done", "p3"), ms("done", "p3")], RELEASES);
    expect(got).toEqual({ status: "in_progress", basis: "milestones" });
  });

  it("RULE 2b - any linked milestone in flight -> in_progress", () => {
    const p = phase({ id: "p", status: "planned" });
    expect(derivePhaseStatus(p, [ms("done", "p"), ms("in_progress", "p")], RELEASES).status).toBe("in_progress");
    expect(derivePhaseStatus(p, [ms("blocked", "p")], RELEASES).status).toBe("in_progress");
  });

  it("RULE 2c - some done, some not started -> in_progress (work has begun)", () => {
    const p = phase({ id: "p", status: "planned" });
    const got = derivePhaseStatus(p, [ms("done", "p"), ms("not_started", "p")], RELEASES);
    expect(got).toEqual({ status: "in_progress", basis: "milestones" });
  });

  it("RULE 2d - none started -> planned, but preserves an explicit 'later' intent", () => {
    const planned = phase({ id: "p", status: "planned" });
    expect(derivePhaseStatus(planned, [ms("not_started", "p"), ms("proposed", "p")], RELEASES).status).toBe("planned");

    const later = phase({ id: "p", status: "later" });
    expect(derivePhaseStatus(later, [ms("not_started", "p")], RELEASES).status).toBe("later");
  });

  it("RULE 3 - no released version AND no linked milestones -> the authored status, unchanged", () => {
    for (const s of ["shipped", "in_progress", "planned", "later"] as const) {
      const got = derivePhaseStatus(phase({ id: "x", status: s }), [], RELEASES);
      expect(got).toEqual({ status: s, basis: "authored" });
    }
  });

  it("a version NOT in the changelog does not anchor shipped - the milestone rollup drives instead", () => {
    // Forward-looking: a phase authored for an unreleased version derives from
    // its milestones until the release is actually cut, then RULE 1 flips it.
    const p = phase({ id: "future", status: "planned", version: "0.99.0" });
    expect(derivePhaseStatus(p, [ms("in_progress", "future")], RELEASES).status).toBe("in_progress");
    expect(derivePhaseStatus(p, [], RELEASES)).toEqual({ status: "planned", basis: "authored" });
  });
});

describe("deriveRoadmap", () => {
  const roadmap: Roadmap = {
    product: "Test Product",
    version: "0.0.1", // deliberately stale authored header - must be overridden
    updated: "1999-01-01",
    phases: [
      phase({ id: "shipped-wave", status: "planned", version: "0.13.0", shipped: "typed-wrong", items: [{ text: "a", done: true }] }),
      phase({ id: "active-theme", status: "shipped", items: [{ text: "open", done: false }] }), // authored shipped, derives in_progress
      phase({ id: "uncharted", status: "later" }), // no version, no milestones -> authored fallback
    ],
  };
  const pf = portfolio([ms("done", "shipped-wave"), ms("in_progress", "active-theme"), ms("done", "active-theme")]);
  const derived = deriveRoadmap(roadmap, pf, CHANGELOG);

  it("derives the header product version + updated from the latest changelog release, not the stored value", () => {
    expect(derived.version).toBe("0.15.0");
    expect(derived.updated).toBe("2026-07-03 18:45 ET");
    expect(derived.authoredVersion).toBe("0.0.1"); // stored value preserved for reference
    expect(derived.product).toBe("Test Product");
  });

  it("overrides each phase status with the derived value and preserves the authored one", () => {
    const byId = Object.fromEntries(derived.phases.map((p) => [p.id, p]));
    expect(byId["shipped-wave"].status).toBe("shipped"); // release-anchored
    expect(byId["shipped-wave"].basis).toBe("release");
    expect(byId["active-theme"].status).toBe("in_progress"); // rollup wins over authored 'shipped'
    expect(byId["active-theme"].authoredStatus).toBe("shipped");
    expect(byId["active-theme"].basis).toBe("milestones");
    expect(byId["active-theme"].linkedMilestones).toBe(2);
    expect(byId["uncharted"].status).toBe("later"); // authored fallback
    expect(byId["uncharted"].basis).toBe("authored");
    expect(byId["uncharted"].linkedMilestones).toBe(0);
  });

  it("derives a released phase's shipped date from the changelog (overriding a hand-typed one)", () => {
    const byId = Object.fromEntries(derived.phases.map((p) => [p.id, p]));
    expect(byId["shipped-wave"].shipped).toBe("2026-07-02"); // from changelog [0.13.0], not "typed-wrong"
  });

  it("is tolerant: an empty changelog falls back to the stored header, a null portfolio does not throw", () => {
    const noChangelog = deriveRoadmap(roadmap, pf, "");
    expect(noChangelog.version).toBe("0.0.1"); // fell back to stored roadmap.version
    expect(noChangelog.updated).toBe("1999-01-01");

    expect(() => deriveRoadmap(roadmap, null, CHANGELOG)).not.toThrow();
    const noPortfolio = deriveRoadmap(roadmap, null, CHANGELOG);
    // With no milestones, the un-released 'active-theme' phase falls back to authored.
    const byId = Object.fromEntries(noPortfolio.phases.map((p) => [p.id, p]));
    expect(byId["active-theme"].basis).toBe("authored");
    expect(byId["active-theme"].status).toBe("shipped");
    // The released 'shipped-wave' still derives shipped from the changelog release.
    expect(byId["shipped-wave"].status).toBe("shipped");
  });

  it("tolerates a roadmap with no phases", () => {
    const empty = deriveRoadmap({ product: "P", version: "1.0.0", updated: "x", phases: [] }, pf, CHANGELOG);
    expect(empty.phases).toEqual([]);
  });
});

// Sanity guard over the REAL committed docs: proves the derivation runs on the
// live data and demonstrates the two load-bearing signals (release-anchored +
// changelog header). Robust to legitimate roadmap edits - it asserts stable
// truths (a cut release is shipped; the header equals the latest changelog),
// not a frozen snapshot of every phase.
describe("deriveRoadmap over the real docs", () => {
  const roadmap = yaml.load(fs.readFileSync(path.join(ROOT, "docs/roadmap.yaml"), "utf8"), {
    schema: yaml.JSON_SCHEMA,
  }) as Roadmap;
  const portfolioData = yaml.load(fs.readFileSync(path.join(ROOT, "docs/portfolio.yaml"), "utf8"), {
    schema: yaml.JSON_SCHEMA,
  }) as Portfolio;
  const changelogRaw = fs.readFileSync(path.join(ROOT, "docs/changelog.md"), "utf8");

  it("runs without throwing and yields a valid PhaseStatus for every phase", () => {
    const derived = deriveRoadmap(roadmap, portfolioData, changelogRaw);
    const valid = new Set(["shipped", "in_progress", "planned", "later"]);
    for (const p of derived.phases) expect(valid.has(p.status)).toBe(true);
  });

  it("derives the header version from the latest changelog release", () => {
    const derived = deriveRoadmap(roadmap, portfolioData, changelogRaw);
    const latest = normVersion(parseChangelog(changelogRaw)[0].version);
    expect(derived.version).toBe(latest);
  });

  it("puts every phase whose version is a released changelog version in Shipped", () => {
    const derived = deriveRoadmap(roadmap, portfolioData, changelogRaw);
    const released = parseReleases(changelogRaw).released;
    const releaseVersioned = derived.phases.filter((p) => p.version && released.has(normVersion(p.version)));
    expect(releaseVersioned.length).toBeGreaterThan(0); // there ARE release-wave phases
    for (const p of releaseVersioned) {
      expect(p.status).toBe("shipped");
      expect(p.basis).toBe("release");
    }
  });
});
