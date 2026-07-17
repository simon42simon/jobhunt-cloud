// Demo-mode guided tour (RC-4 / SIM-88): the state machine, hero selection, and
// callout copy for the recruiter's 3-beat journey, per the frozen PM spec
// (company-os/audit/2026-07-16-rc4-demo-journey-spec.md section 4 + UX note U1).
// Pure functions, no DOM - the DemoTour component owns one useState over
// TourStep and maps over these (the lib/runDock posture), so beat sequencing,
// hero choice, and the exact scripted copy are unit-testable in node.

import type { Job } from "../types";

// The guided path: a non-blocking first-run choice, EXACTLY 3 spotlight beats,
// then a close panel (not a gate). The component holds `null` when inactive.
export type TourStep = "choice" | "beat1" | "beat2" | "beat3" | "close";

// Session memory (spec AC3): a dismissed or completed tour never re-prompts in
// the same browser session; the header banner's "Replay tour" is the way back
// in. sessionStorage (not localStorage) - a visitor's choice lasts their visit,
// it does not follow the browser forever.
export const TOUR_MEMORY_KEY = "jobhunt.demoTour";
export type TourMemory = "dismissed" | "completed";

export interface HeroB {
  job: Job;
  // Which agent action beat 3 points at: a queued job's Draft (primary per the
  // spec) or a drafted job's Finalize (the sanctioned fallback).
  action: "draft" | "finalize";
}

export interface TourHeroes {
  heroA: Job | null; // beat 2: the interview job whose drawer shows real materials
  heroB: HeroB | null; // beat 3: the job whose action click fires the canned replay
}

// Heroes come from the ALREADY-LOADED jobs state (spec 3.2) - never a second
// fetch. Hero A prefers the interview job with the fullest artifact set (the
// drawer must show CV + cover letter + gaps + activity, AC5). Hero B prefers a
// queued job whose Draft has not run yet, so the visitor's click fires a plain
// launch instead of the guarded Regenerate confirm; fallback is a drafted job's
// Finalize (finalizeReady first - its hint line reads "ready to finalize").
// Absence of either hero is handled by nextStep skipping the beat.
export function findHeroes(jobs: Job[]): TourHeroes {
  const interview = jobs.filter((j) => j.status === "interview");
  const heroA =
    interview.find((j) => j.hasCV && j.hasCoverLetter) ??
    interview.find((j) => j.hasCV) ??
    interview[0] ??
    null;

  const queued = jobs.filter((j) => j.status === "queued");
  const drafted = jobs.filter((j) => j.status === "drafted");
  const draftHero = queued.find((j) => !j.draftDone) ?? queued[0] ?? null;
  const finalizeHero =
    drafted.find((j) => j.finalizeReady && !j.finalizeDone) ??
    drafted.find((j) => !j.finalizeDone) ??
    null;
  const heroB: HeroB | null = draftHero
    ? { job: draftHero, action: "draft" }
    : finalizeHero
      ? { job: finalizeHero, action: "finalize" }
      : null;
  return { heroA, heroB };
}

// Advance one step, skipping any beat whose hero does not exist in the loaded
// jobs (spec: handle absence gracefully - skip to the next beat). "close" is
// terminal; its own buttons dismiss or replay, never advance.
export function nextStep(step: TourStep, heroes: TourHeroes): TourStep {
  switch (step) {
    case "choice":
      return "beat1";
    case "beat1":
      return heroes.heroA ? "beat2" : heroes.heroB ? "beat3" : "close";
    case "beat2":
      return heroes.heroB ? "beat3" : "close";
    case "beat3":
    case "close":
      return "close";
  }
}

// Quote-and-escape an attribute value for a CSS attribute selector by hand
// (no CSS.escape - this module also runs in node tests). Job ids are folder
// names, so spaces and quotes are live possibilities.
function attr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The live element a beat's spotlight anchors to, as a querySelector string.
// The data-demo-* attributes are tiny additions on the REAL components
// (KanbanBoard's column scroller, JobCard's root, JobDetail's files section and
// pipeline action rows) - the tour points at what is already on screen (U1),
// it never renders a copy. Beats 2 and 3 re-anchor when the hero's drawer is
// open (selectedJob), moving from the card to the thing inside the drawer.
export function anchorSelector(
  step: TourStep,
  heroes: TourHeroes,
  selectedJob: string | null,
): string | null {
  switch (step) {
    case "beat1":
      return '[data-demo-anchor="board"]';
    case "beat2":
      if (!heroes.heroA) return null;
      return selectedJob === heroes.heroA.id
        ? '[data-demo-anchor="materials"]'
        : `[data-demo-job=${attr(heroes.heroA.id)}]`;
    case "beat3":
      if (!heroes.heroB) return null;
      return selectedJob === heroes.heroB.job.id
        ? `[data-demo-anchor=${attr(`${heroes.heroB.action}-action`)}]`
        : `[data-demo-job=${attr(heroes.heroB.job.id)}]`;
    default:
      return null;
  }
}

export interface Callout {
  tag: string; // the mono step readout, e.g. "TOUR · 1/3"
  title: string;
  body: string;
  next: string; // Next-button label ("Finish tour" on the last beat)
}

// The whole scripted voice lives here: terse system-readout lines (spec section
// 4's one-line points verbatim where given), sized to fit the 3:00 stopwatch
// budget. Beats 2/3 switch copy when the hero's drawer opens - the invite line
// asks for the REAL click; the open line narrates what that click revealed.
// The button labels quoted in beat 3 mirror src/lib/agentActions.ts exactly.
export function calloutFor(
  step: "beat1" | "beat2" | "beat3",
  heroes: TourHeroes,
  selectedJob: string | null,
): Callout {
  if (step === "beat1") {
    return {
      tag: "TOUR · 1/3",
      title: "The pipeline",
      body: "A real pipeline, lead to offer, in daily use. Nine stages; every card is a tracked application with its track, fit, and deadline.",
      next: "Next",
    };
  }
  if (step === "beat2") {
    const open = !!heroes.heroA && selectedJob === heroes.heroA.id;
    return {
      tag: "TOUR · 2/3",
      title: "The materials",
      body: open
        ? "This isn't a form - the system produces the work: a generated CV, a cover letter, the gaps page, and the activity log below."
        : "This one reached interview. Click the card to open it and see what the system produced along the way.",
      next: "Next",
    };
  }
  const action = heroes.heroB?.action ?? "draft";
  const open = !!heroes.heroB && selectedJob === heroes.heroB.job.id;
  const button = action === "draft" ? "Draft CV + cover letter" : "Finalize (after gaps)";
  return {
    tag: "TOUR · 3/3",
    title: "The agent",
    body: open
      ? `Click "${button}" and watch the agent work - stages, activity, cost. A real run, replayed.`
      : `One more. Click this ${action === "draft" ? "queued" : "drafted"} job to open it.`,
    next: "Finish tour",
  };
}
