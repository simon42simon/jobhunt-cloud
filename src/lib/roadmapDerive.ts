// Roadmap status derivation (ADR-012). A phase's status and the header product
// version/updated are DERIVED from the source-of-truth files - the phase's
// linked portfolio milestones (roadmap_phase === phase.id) and the changelog
// releases - never the hand-typed roadmap.yaml status/version, so the Roadmap
// view cannot drift from what actually shipped. This is the same derive-not-
// store discipline as ADR-010's raci.responsible (from task owners) and
// ADR-011's risk severity (from likelihood x impact).
//
// Pure: no React, no fetch, no DOM. Callers (RoadmapBoard) pass in the already-
// fetched roadmap + portfolio + raw changelog text, so this stays trivially
// unit-testable in isolation, exactly like projectStats.ts / involvement.ts /
// changelog.ts. Tolerant by construction: a missing portfolio, an empty
// changelog, or a phase with no linked milestones never throws and never blanks
// the board - it falls back to the authored value.

import { parseChangelog } from "./changelog";
import type {
  DerivedPhase,
  DerivedRoadmap,
  PhaseStatus,
  PhaseStatusBasis,
  Portfolio,
  Roadmap,
  RoadmapPhase,
} from "../types";

// Milestone-status vocabulary buckets (aligned with lib/statusColors). Only the
// two the portfolio actually uses today (done / in_progress) matter, but the
// sets are complete so a future milestone status classifies sensibly. Anything
// not in either set (not_started / planned / proposed / todo / backlog / paused)
// is treated as "not started".
const DONE_STATUSES = new Set(["done", "shipped", "complete"]);
const ACTIVE_STATUSES = new Set(["in_progress", "active", "in_review", "blocked"]);

// Normalize a version for comparison: trim + drop a leading "v" so a phase's
// "0.13.0" matches the changelog's parsed "0.13.0" (and a hand-typed "v0.13.0"
// still matches). Not a semver parse - an exact normalized-string compare.
export function normVersion(v: string | undefined | null): string {
  return (v ?? "").trim().replace(/^v/i, "");
}

// Everything the phase derivation needs from the changelog, parsed once.
export interface ReleaseInfo {
  latestVersion: string | null; // newest released version (the header product version)
  latestDate: string | null; // the newest release's date string (the header "updated")
  released: Set<string>; // every released version, normalized (no leading "v")
  dateByVersion: Map<string, string>; // normalized version -> YYYY-MM-DD (a phase's derived shipped date)
}

// Parse the Keep-a-Changelog markdown into release facts. Tolerant: an empty or
// unparseable changelog yields empty structures (latestVersion null), never a
// throw. Ignores an "[Unreleased]" header. Trusts the doc's own newest-first
// order (parseChangelog preserves it), so the FIRST released entry is latest.
export function parseReleases(changelogRaw: string): ReleaseInfo {
  let entries: ReturnType<typeof parseChangelog>;
  try {
    entries = parseChangelog(changelogRaw || "");
  } catch {
    entries = [];
  }
  const released = new Set<string>();
  const dateByVersion = new Map<string, string>();
  let latestVersion: string | null = null;
  let latestDate: string | null = null;
  for (const e of entries) {
    if (/unreleased/i.test(e.version)) continue;
    const v = normVersion(e.version);
    if (!v) continue;
    released.add(v);
    const ymd = (e.date.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    if (ymd && !dateByVersion.has(v)) dateByVersion.set(v, ymd);
    if (latestVersion === null) {
      latestVersion = v;
      latestDate = e.date; // keep the full "YYYY-MM-DD HH:MM ET" for the header
    }
  }
  return { latestVersion, latestDate, released, dateByVersion };
}

// Derive a project's completed date (ADR-012 reuse). A project whose `target`
// version is a released changelog version completes ON that release's date;
// otherwise it falls back to its authored `created`. Meaningful for done
// projects (which all ship a released target version). Pure + tolerant: an
// absent target/created, or a target with no matching release, degrades to
// `created` (or null), never a throw. Structural param so it stays decoupled
// from the full Project type.
export function projectCompletedDate(
  project: { target?: string; created?: string },
  releases: ReleaseInfo
): string | null {
  return releases.dateByVersion.get(normVersion(project.target)) ?? project.created ?? null;
}

// Does the phase still list open (unchecked) authored scope? Used only as a
// completeness guard on the "all linked milestones done" branch: milestones are
// an INCOMPLETE charting of a phase (not every phase item is a portfolio
// milestone), so "every linked milestone done" must not falsely mark a phase
// shipped while its own checklist still shows open work (the phase-3 case).
function hasOpenItems(phase: RoadmapPhase): boolean {
  return (phase.items || []).some((i) => !i.done);
}

// Derive ONE phase's status from its linked milestones + the releases. Priority:
//   1. Release-anchored: phase.version is a released changelog version -> shipped
//      (a cut release is an immutable historical fact; it cannot un-ship, even
//      if a later milestone was pinned under the phase and is still in flight).
//   2. Milestone rollup (only when the phase has linked milestones):
//        - any linked milestone in flight        -> in_progress
//        - all linked milestones done + open item -> in_progress (completeness guard)
//        - all linked milestones done, no open item -> shipped
//        - some done, some not started            -> in_progress (work has begun)
//        - none started (all queued)              -> later if authored "later", else planned
//   3. Authored fallback: no release evidence AND no linked milestones -> the
//      stored status, unchanged (tolerant - never blanks an un-charted phase).
export function derivePhaseStatus(
  phase: RoadmapPhase,
  linkedMilestones: { status: string }[],
  releases: ReleaseInfo
): { status: PhaseStatus; basis: PhaseStatusBasis } {
  const authored = phase.status;

  // 1. Release-anchored.
  const v = normVersion(phase.version);
  if (v && releases.released.has(v)) return { status: "shipped", basis: "release" };

  // 2. Milestone rollup.
  if (linkedMilestones.length > 0) {
    const total = linkedMilestones.length;
    const done = linkedMilestones.filter((m) => DONE_STATUSES.has(m.status)).length;
    const active = linkedMilestones.filter((m) => ACTIVE_STATUSES.has(m.status)).length;

    if (active > 0) return { status: "in_progress", basis: "milestones" };
    if (done === total) {
      return { status: hasOpenItems(phase) ? "in_progress" : "shipped", basis: "milestones" };
    }
    if (done > 0) return { status: "in_progress", basis: "milestones" };
    return { status: authored === "later" ? "later" : "planned", basis: "milestones" };
  }

  // 3. Authored fallback.
  return { status: authored, basis: "authored" };
}

// Derive the whole roadmap: each phase's status (via derivePhaseStatus), each
// phase's shipped date (from the changelog when the phase maps to a released
// version, else the authored value), and the header product version/updated
// (the latest released changelog entry, else the authored roadmap.version). Pure
// + tolerant: an empty portfolio or changelog degrades to authored fallbacks.
export function deriveRoadmap(
  roadmap: Roadmap,
  portfolio: Portfolio | null | undefined,
  changelogRaw: string
): DerivedRoadmap {
  const releases = parseReleases(changelogRaw);
  const milestones = portfolio?.milestones || [];

  const phases: DerivedPhase[] = (roadmap.phases || []).map((phase) => {
    const linked = milestones.filter((m) => m.roadmap_phase === phase.id);
    const { status, basis } = derivePhaseStatus(phase, linked, releases);
    const v = normVersion(phase.version);
    // A phase that maps to a released version derives its shipped date FROM the
    // changelog (so the hand-typed phase.shipped can no longer drift); an
    // in-progress / un-versioned phase keeps whatever it authored (usually none).
    const shippedFromRelease = v ? releases.dateByVersion.get(v) : undefined;
    return {
      ...phase,
      status,
      authoredStatus: phase.status,
      basis,
      linkedMilestones: linked.length,
      shipped: shippedFromRelease || phase.shipped,
    };
  });

  return {
    product: roadmap.product,
    version: releases.latestVersion || roadmap.version,
    updated: releases.latestDate || roadmap.updated,
    authoredVersion: roadmap.version,
    phases,
  };
}

// The Roadmap progress meter's aria-valuetext (D8 charts-a11y): "N of M items
// done (P%)", pluralized, zero-safe. Relocated here from the retired in-app
// RoadmapBoard (SIM-59) - the helper (and its charts-a11y.test.ts contract)
// outlives the component as the canonical progress phrasing.
export function progressValueText(done: number, total: number): string {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `${done} of ${total} item${total === 1 ? "" : "s"} done (${pct}%)`;
}
