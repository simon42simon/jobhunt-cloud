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

  // SIM-390 item 1: the run panel opens at z-70 OVER the action-row callout,
  // burying "Finish tour". Beat 3 re-anchors onto the panel itself.
  it("beat 3 re-anchors onto the run panel once the invited click opened it", () => {
    expect(anchorSelector("beat3", heroes, heroB.id, true)).toBe('[data-demo-anchor="run-panel"]');
    // Drawer closed mid-run: still the panel (it is what the beat narrates).
    expect(anchorSelector("beat3", heroes, null, true)).toBe('[data-demo-anchor="run-panel"]');
  });

  it("an open run panel never re-anchors beats 1/2 (a background run must not hijack them)", () => {
    expect(anchorSelector("beat1", heroes, null, true)).toBe('[data-demo-anchor="board"]');
    expect(anchorSelector("beat2", heroes, heroA.id, true)).toBe('[data-demo-anchor="materials"]');
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

  it("beat 3 drops the stale invite once the run panel is open, and Finish tour stays the exit (SIM-390 item 1)", () => {
    const c = calloutFor("beat3", heroes, heroB.id, true);
    expect(c.tag).toBe("TOUR · 3/3");
    expect(c.body).not.toContain("Click"); // the invited click already happened
    expect(c.body).toContain("stages, live activity, cost");
    expect(c.next).toBe("Finish tour");
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

  // --- RC-4 QA fixes (BUG-1/2/3 + the idle finding) --------------------------

  it("BUG-1: a card-anchored advance PARKS until the stale drawer unmounts, and navigate() self-heals a same-hash no-op", () => {
    // The tour side: advance() parks the target step (setPending) instead of
    // rendering a beat under a still-mounted drawer, and the pending effect
    // re-issues the close + force-advances so it can never hang.
    expect(tour).toContain("setPending(to)");
    expect(tour).toMatch(/window\.setTimeout\(onCloseDrawer, \d+\)/);
    // The router side: assigning the CURRENT hash fires no hashchange, so
    // navigate must emit manually - otherwise a drifted drawer's X/Escape/
    // backdrop close are all silent no-ops (QA's zombie drawer).
    const router = read("../src/lib/router.ts");
    expect(router).toMatch(/if \(window\.location\.hash === before\) emit\(\);/);
  });

  it("BUG-2: anchors scroll into view deterministically (instant, centered), never a cancellable smooth scroll", () => {
    expect(tour).toContain('el.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" })');
    expect(tour).not.toContain('"smooth"');
  });

  it("BUG-3: the Product tab (a localhost-only hub handoff) never renders on the demo", () => {
    const topbar = read("../src/components/TopBar.tsx");
    expect(topbar).toMatch(/\{!demoMode && \(/);
    // App: the p shortcut is inert and any sideways landing on the product
    // view bounces back to Jobs in demo mode.
    expect(app).toContain('if (!demoMode) switchView("product")');
    expect(app).toMatch(/if \(demoMode && view === "product"\) switchView\("jobs"\)/);
  });

  it("idle finding: the tour layer is event-driven - no polling interval, no rAF loop", () => {
    expect(tour).not.toContain("setInterval");
    expect(tour).not.toContain("requestAnimationFrame");
    expect(tour).toContain("MutationObserver");
  });

  // --- SIM-390 item 1 (the run panel buried "Finish tour") --------------------
  // The pure re-anchor logic is unit-tested above; these pin the WIRING (this
  // project has no jsdom - the live overlap geometry is verified by the manual
  // QA walk: beat 3, click the action button, confirm "Finish tour" clickable
  // while the replay animates).

  it("item 1 wiring: the expanded-run stack is an anchor, and App feeds its state to the tour", () => {
    expect(app).toContain('data-demo-anchor="run-panel"');
    expect(app).toMatch(/runPanelOpen=\{expandedRuns\(runs\)\.length > 0\}/);
  });

  it("item 1 wiring: the run-panel anchor gets the 'beside' placement, lifted over the panel's z-70", () => {
    // The re-anchored callout must never sit UNDER the z-70 panel: the beside
    // branch places it left/above, and every branch carries zIndex 80 so even
    // the clamped phone geometry leaves the buttons clickable.
    expect(tour).toMatch(/anchoredToRunPanel \? "beside" : "auto"/);
    const beside = /if \(place === "beside"\) \{([\s\S]*?)\n  \}/.exec(tour)?.[1] || "";
    expect(beside.match(/zIndex: 80/g)?.length).toBe(3);
  });
});
