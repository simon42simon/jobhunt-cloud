import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  anchorSelector,
  calloutFor,
  findHeroes,
  nextStep,
  TOUR_MEMORY_KEY,
  type TourHeroes,
} from "../src/lib/demoTour";
import type { Job, Status } from "../src/types";

// Demo-mode guided tour (RC-4 / SIM-88, the frozen PM spec
// company-os/audit/2026-07-16-rc4-demo-journey-spec.md). The tour's whole state
// machine - hero selection, beat sequencing, anchor selectors, scripted copy -
// is pure (src/lib/demoTour.ts), so it is unit-tested here without a DOM. The
// wiring contracts (demo-mode-only rendering, the non-blocking U1 rule, the
// data-demo-* anchors on the live components) are pinned by static source
// checks at the bottom, the same posture as run-dock.test.ts (no jsdom in this
// project). The live 3-minute click-through is qa-tester's stopwatch script.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let seq = 0;
function mkJob(over: Partial<Job> & { status: Status }): Job {
  seq += 1;
  return {
    id: over.id ?? `Job ${seq} - Employer ${seq}`,
    folder: "f",
    folderPath: "/f",
    jobFile: "j.md",
    jobFileName: "j.md",
    role: `Role ${seq}`,
    employer: `Employer ${seq}`,
    track: "b2b_gtm_focused",
    trackLabel: "B2B GTM",
    fit: "strong",
    rawStatus: over.status,
    sector: "private",
    tailoring: "light",
    deadline: null,
    applied: null,
    link: "",
    nextAction: "",
    nextActionDate: null,
    tags: [],
    leadWith: "",
    files: [],
    hasCV: false,
    hasCoverLetter: false,
    gapsAnswered: false,
    finalizeReady: false,
    draftDone: false,
    finalizeDone: false,
    interviewPrepDone: false,
    offerPrepDone: false,
    followUpDone: false,
    mergePdfReady: false,
    mergedPdfDone: false,
    mtime: 0,
    ...over,
  };
}

// --- findHeroes ---------------------------------------------------------------

describe("findHeroes (spec 3.2: heroes from the loaded jobs state)", () => {
  it("Hero A prefers the interview job with the fullest artifact set", () => {
    const bare = mkJob({ status: "interview" });
    const full = mkJob({ status: "interview", hasCV: true, hasCoverLetter: true });
    const cvOnly = mkJob({ status: "interview", hasCV: true });
    expect(findHeroes([bare, cvOnly, full]).heroA?.id).toBe(full.id);
    expect(findHeroes([bare, cvOnly]).heroA?.id).toBe(cvOnly.id);
    expect(findHeroes([bare]).heroA?.id).toBe(bare.id);
  });

  it("Hero B prefers a queued job whose Draft has not run (plain launch, not the Regenerate confirm)", () => {
    const done = mkJob({ status: "queued", draftDone: true });
    const fresh = mkJob({ status: "queued" });
    const h = findHeroes([done, fresh]).heroB;
    expect(h?.job.id).toBe(fresh.id);
    expect(h?.action).toBe("draft");
  });

  it("falls back to a drafted job's Finalize, finalizeReady first", () => {
    const drafted = mkJob({ status: "drafted", hasCV: true });
    const ready = mkJob({ status: "drafted", hasCV: true, finalizeReady: true });
    const h = findHeroes([drafted, ready]).heroB;
    expect(h?.job.id).toBe(ready.id);
    expect(h?.action).toBe("finalize");
  });

  it("yields nulls when no candidate exists (absence handled, never a crash)", () => {
    const heroes = findHeroes([mkJob({ status: "lead" }), mkJob({ status: "offer" })]);
    expect(heroes.heroA).toBeNull();
    expect(heroes.heroB).toBeNull();
  });
});

// --- nextStep (exactly 3 beats, absent heroes skipped) --------------------------

describe("nextStep", () => {
  const full: TourHeroes = {
    heroA: mkJob({ status: "interview", hasCV: true }),
    heroB: { job: mkJob({ status: "queued" }), action: "draft" },
  };
  const none: TourHeroes = { heroA: null, heroB: null };

  it("walks choice -> beat1 -> beat2 -> beat3 -> close when both heroes exist", () => {
    expect(nextStep("choice", full)).toBe("beat1");
    expect(nextStep("beat1", full)).toBe("beat2");
    expect(nextStep("beat2", full)).toBe("beat3");
    expect(nextStep("beat3", full)).toBe("close");
  });

  it("skips a beat whose hero is missing (spec: skip to next beat)", () => {
    expect(nextStep("beat1", { ...full, heroA: null })).toBe("beat3");
    expect(nextStep("beat1", none)).toBe("close");
    expect(nextStep("beat2", none)).toBe("close");
  });

  it("close is terminal", () => {
    expect(nextStep("close", full)).toBe("close");
  });
});

// --- anchorSelector -------------------------------------------------------------

describe("anchorSelector (points at LIVE elements, re-anchoring when the drawer opens)", () => {
  const heroA = mkJob({ status: "interview", hasCV: true, id: 'Analyst - Corp "North"' });
  const heroB = mkJob({ status: "queued", id: "Writer - Studio West" });
  const heroes: TourHeroes = { heroA, heroB: { job: heroB, action: "draft" } };

  it("beat 1 anchors the board", () => {
    expect(anchorSelector("beat1", heroes, null)).toBe('[data-demo-anchor="board"]');
  });

  it("beat 2 anchors Hero A's card, then the materials section once its drawer is open", () => {
    expect(anchorSelector("beat2", heroes, null)).toBe(
      '[data-demo-job="Analyst - Corp \\"North\\""]',
    );
    expect(anchorSelector("beat2", heroes, heroA.id)).toBe('[data-demo-anchor="materials"]');
    // Some OTHER job's drawer being open still invites the Hero A click.
    expect(anchorSelector("beat2", heroes, heroB.id)).toContain("data-demo-job");
  });

  it("beat 3 anchors Hero B's card, then its action row once the drawer is open", () => {
    expect(anchorSelector("beat3", heroes, null)).toBe('[data-demo-job="Writer - Studio West"]');
    expect(anchorSelector("beat3", heroes, heroB.id)).toBe('[data-demo-anchor="draft-action"]');
    const fin: TourHeroes = { heroA, heroB: { job: heroB, action: "finalize" } };
    expect(anchorSelector("beat3", fin, heroB.id)).toBe('[data-demo-anchor="finalize-action"]');
  });

  it("returns null when the beat's hero is absent", () => {
    expect(anchorSelector("beat2", { heroA: null, heroB: null }, null)).toBeNull();
    expect(anchorSelector("beat3", { heroA: null, heroB: null }, null)).toBeNull();
  });
});

// --- calloutFor (the scripted copy) ----------------------------------------------

describe("calloutFor", () => {
  const heroA = mkJob({ status: "interview", hasCV: true });
  const heroB = mkJob({ status: "queued" });
  const heroes: TourHeroes = { heroA, heroB: { job: heroB, action: "draft" } };

  it("numbers exactly 3 beats in the mono readout voice", () => {
    expect(calloutFor("beat1", heroes, null).tag).toBe("TOUR · 1/3");
    expect(calloutFor("beat2", heroes, null).tag).toBe("TOUR · 2/3");
    expect(calloutFor("beat3", heroes, null).tag).toBe("TOUR · 3/3");
  });

  it("beat 1 states the spec's one-line point", () => {
    expect(calloutFor("beat1", heroes, null).body).toContain(
      "A real pipeline, lead to offer, in daily use",
    );
  });

  it("beats 2/3 switch from invite to narration when the hero drawer opens", () => {
    expect(calloutFor("beat2", heroes, null).body).toContain("Click the card");
    expect(calloutFor("beat2", heroes, heroA.id).body).toContain("gaps page");
    expect(calloutFor("beat3", heroes, null).body).toContain("queued");
    expect(calloutFor("beat3", heroes, heroB.id).body).toContain("A real run, replayed");
  });

  it("beat 3 quotes the REAL action button label (src/lib/agentActions.ts)", () => {
    expect(calloutFor("beat3", heroes, heroB.id).body).toContain("Draft CV + cover letter");
    const fin: TourHeroes = { heroA, heroB: { job: heroB, action: "finalize" } };
    expect(calloutFor("beat3", fin, heroB.id).body).toContain("Finalize (after gaps)");
    expect(calloutFor("beat3", fin, heroB.id).next).toBe("Finish tour");
  });
});

// --- wiring contracts (static source pins, run-dock posture) ---------------------

describe("demo chrome wiring contracts", () => {
  const app = read("../src/App.tsx");
  const tour = read("../src/components/DemoTour.tsx");
  const banner = read("../src/components/DemoBanner.tsx");
  const css = read("../src/index.css");

  it("ALL demo chrome is gated on appMode === 'demo' (zero change in real mode)", () => {
    expect(app).toContain('config?.appMode === "demo"');
    expect(app).toContain("{demoMode && <DemoBanner");
    expect(app).toMatch(/\{demoMode && \(\s*<ErrorBoundary fallback=\{null\}>\s*<DemoTour/);
  });

  it("the tour is non-blocking (U1): no modal semantics, no backdrop, spotlight is pointer-events:none", () => {
    expect(tour).not.toContain("aria-modal="); // attribute form - prose comments don't count
    expect(tour).not.toContain("inset-0"); // no full-screen layer of any kind
    expect(css).toMatch(/\.demo-spotlight\s*\{[^}]*pointer-events:\s*none/);
  });

  it("every beat carries a visible Skip tour, and dismissal/completion persist per session", () => {
    expect(tour).toContain("Skip tour");
    expect(TOUR_MEMORY_KEY).toBe("jobhunt.demoTour");
    expect(tour).toContain("sessionStorage");
  });

  it("the banner reads as an honest system label and carries the v1 CTA (GitHub only) + Replay tour", () => {
    expect(banner).toContain("Demo · Fictional seed data · Resets nightly");
    expect(banner).toContain("https://github.com/simon42simon");
    expect(banner).toContain("Replay tour");
    // v1 CTA is GitHub ONLY (owner decision): no LinkedIn/CV links rendered.
    expect(banner).not.toMatch(/href="[^"]*linkedin/i);
  });

  it("the live anchors exist on the real components", () => {
    expect(read("../src/components/KanbanBoard.tsx")).toContain('data-demo-anchor="board"');
    expect(read("../src/components/JobCard.tsx")).toContain("data-demo-job={job.id}");
    const detail = read("../src/components/JobDetail.tsx");
    expect(detail).toContain('data-demo-anchor="materials"');
    expect(detail).toContain('"draft-action"');
    expect(detail).toContain('"finalize-action"');
  });
});
