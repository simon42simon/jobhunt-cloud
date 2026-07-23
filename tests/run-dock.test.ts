import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addRun,
  classifyLaunchError,
  dismissRun,
  expandedRuns,
  launchNoteFor,
  minimizeNewestExpanded,
  minimizeRun,
  minimizedRuns,
  restoreRun,
  runTitle,
  ROUTINE_TITLE,
  type TrackedRun,
} from "../src/lib/runDock";
import { RUN_STATUS_META, runStatusMeta } from "../src/lib/statusColors";

// Concurrent runs + the bottom run dock (t-1783119823228). The dock's whole
// state machine is pure (src/lib/runDock.ts) - App owns one useState over it -
// so the transitions are unit-tested here without a DOM. The wiring (which
// component renders what, the not-a-modal contract, the honest 409 path) is
// pinned by static source checks at the bottom, the same posture as
// ui-consistency.test.ts / jobs-hierarchy-pack.test.ts (no jsdom in this
// project). A live multi-run click-through is the MAIN session's job.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const mk = (runId: string, minimized = false): TrackedRun => ({ runId, label: `L-${runId}`, minimized });

// --- addRun -------------------------------------------------------------------

describe("addRun (append, never overwrite - the activeRun fix)", () => {
  it("appends a new run expanded, preserving launch order", () => {
    const one = addRun([], { runId: "r1", label: "Draft" });
    const two = addRun(one, { runId: "r2", label: "Finalize" });
    expect(two.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(two.every((r) => !r.minimized)).toBe(true);
  });

  it("keeps earlier runs when a second action starts (no overwrite)", () => {
    const runs = addRun(addRun([], { runId: "r1", label: "A" }), { runId: "r2", label: "B" });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ runId: "r1", label: "A" });
  });

  it("never tracks the same runId twice - a re-fired onRunStarted is a no-op that keeps state", () => {
    const start = [mk("r1", true)];
    const next = addRun(start, { runId: "r1", label: "L-r1" });
    expect(next).toBe(start); // unchanged, still minimized
  });
});

// --- minimize / restore / dismiss ----------------------------------------------

describe("minimize / restore / dismiss transitions", () => {
  const runs = [mk("r1"), mk("r2"), mk("r3")];

  it("minimizeRun collapses exactly one run; order unchanged", () => {
    const next = minimizeRun(runs, "r2");
    expect(next.map((r) => r.minimized)).toEqual([false, true, false]);
    expect(next.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
  });

  it("restoreRun expands a docked run back into its ORIGINAL slot (no reshuffle)", () => {
    const next = restoreRun(minimizeRun(runs, "r1"), "r1");
    expect(next.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    expect(next[0].minimized).toBe(false);
  });

  it("dismissRun drops UI tracking only for that run", () => {
    const next = dismissRun(runs, "r2");
    expect(next.map((r) => r.runId)).toEqual(["r1", "r3"]);
  });

  it("unknown runIds are no-ops", () => {
    expect(minimizeRun(runs, "nope").map((r) => r.minimized)).toEqual([false, false, false]);
    expect(dismissRun(runs, "nope")).toHaveLength(3);
  });
});

describe("expandedRuns / minimizedRuns partition (panel stack vs dock)", () => {
  const runs = [mk("r1", true), mk("r2"), mk("r3", true), mk("r4")];

  it("partitions completely, both sides in launch order", () => {
    expect(expandedRuns(runs).map((r) => r.runId)).toEqual(["r2", "r4"]);
    expect(minimizedRuns(runs).map((r) => r.runId)).toEqual(["r1", "r3"]);
    expect(expandedRuns(runs).length + minimizedRuns(runs).length).toBe(runs.length);
  });
});

describe("minimizeNewestExpanded (Escape's one-per-press behavior)", () => {
  it("minimizes only the NEWEST expanded run", () => {
    const runs = [mk("r1"), mk("r2", true), mk("r3")];
    const next = minimizeNewestExpanded(runs);
    expect(next.map((r) => r.minimized)).toEqual([false, true, true]);
  });

  it("is a no-op when everything is already minimized", () => {
    const runs = [mk("r1", true), mk("r2", true)];
    expect(minimizeNewestExpanded(runs)).toBe(runs);
  });

  it("is a no-op on an empty list", () => {
    const empty: TrackedRun[] = [];
    expect(minimizeNewestExpanded(empty)).toBe(empty);
  });
});

// --- launch-error classification (the honest 409/429 path) ---------------------

// The server's LITERAL refusal messages (server/index.js POST /api/routines/run).
const DUPLICATE_MSG = "a first-draft-job run is already in progress or queued for this job";
const CAPACITY_MSG = "too many routines running (max 4); wait for one to finish or stop it";

describe("classifyLaunchError / launchNoteFor", () => {
  it("classifies the per-scope 409 duplicate lock as 'duplicate'", () => {
    expect(classifyLaunchError(DUPLICATE_MSG)).toBe("duplicate");
  });

  it("classifies the 429 capacity refusal as 'capacity'", () => {
    expect(classifyLaunchError(CAPACITY_MSG)).toBe("capacity");
  });

  it("anything else stays 'other'", () => {
    expect(classifyLaunchError("job folder not found")).toBe("other");
    expect(classifyLaunchError("Failed to fetch")).toBe("other");
  });

  it("duplicate -> INFO note (honest, not an error), carrying the server's message", () => {
    const note = launchNoteFor(DUPLICATE_MSG);
    expect(note.kind).toBe("info");
    expect(note.text).toContain(DUPLICATE_MSG);
    expect(note.text).toContain("nothing new was started");
    expect(note.text).not.toContain("Could not start");
  });

  it("capacity -> INFO note", () => {
    const note = launchNoteFor(CAPACITY_MSG);
    expect(note.kind).toBe("info");
    expect(note.text).toContain("At capacity");
  });

  it("a real failure keeps the error framing", () => {
    const note = launchNoteFor("job folder not found");
    expect(note.kind).toBe("error");
    expect(note.text).toBe("Could not start routine: job folder not found");
  });

  it("the classifier patterns still match the server's LITERAL messages (drift guard)", () => {
    // classifyLaunchError keys on message text (the API client throws plain
    // Errors), so pin the server source: if these literals change, this test
    // fails and the classifier must be updated with them.
    const server = read("../server/index.js");
    expect(server).toContain("already in progress or queued for this");
    expect(server).toContain("too many routines running (max");
  });
});

// --- shared run vocabulary ------------------------------------------------------

describe("runTitle / RUN_STATUS_META (one vocabulary for panel + chip)", () => {
  it("maps each known job routine to a friendly gerund, else falls back to the label", () => {
    expect(runTitle("first-draft-job", "x")).toBe(ROUTINE_TITLE["first-draft-job"]);
    // US-4/US-5 late-stage prep routines got their own gerunds too.
    expect(runTitle("interview-prep", "Interview prep (STAR)")).toBe("Prepping interview");
    expect(runTitle("offer-prep", "Prep offer / negotiation")).toBe("Prepping offer");
    // US-6 follow-up draft: its own gerund so the panel/dock say what runs.
    expect(runTitle("draft-follow-up", "Draft follow-up email")).toBe("Drafting follow-up");
    expect(ROUTINE_TITLE["draft-follow-up"]).toBe("Drafting follow-up");
    // A routine with no gerund still falls back to its label.
    expect(runTitle("work-ticket", "Work ticket")).toBe("Work ticket");
    expect(runTitle(undefined, "Fallback")).toBe("Fallback");
  });

  it("covers every RunStatus with a label + vetted color", () => {
    // waiting-for-runner / stalled (SIM-562): the honest queued substates.
    for (const status of ["running", "waiting-for-runner", "stalled", "done", "failed", "stopped"] as const) {
      const meta = runStatusMeta(status);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(RUN_STATUS_META[status]).toEqual(meta);
    }
  });
});

// --- static source contracts (wiring) -------------------------------------------

describe("RunDock is ambient chrome, never a modal (source contract)", () => {
  const src = read("../src/components/RunDock.tsx");

  it("is NOT a dialog and NOT aria-modal, so lib/shortcuts' modal guard ignores it", () => {
    // Attribute forms only (the header comment NAMES aria-modal to explain
    // why it is absent - that must not trip this check).
    expect(src).not.toContain("aria-modal=");
    expect(src).not.toContain('role="dialog"');
    expect(src).toContain('role="region"');
    expect(src).toContain('aria-label="Running actions"');
  });

  it("chips carry the 44px-on-touch idiom and a dismiss control for finished runs", () => {
    expect(src).toContain("min-h-[44px]");
    expect(src).toContain("sm:min-h-0");
    // SIM-562: gated on `pending` (not `running`) - waiting-for-runner/stalled
    // are pending too and must not surface the finished-only dismiss-X either.
    expect(src).toContain("{!pending && (");
    expect(src).toContain("aria-label={`Dismiss: ");
  });

  it("reads status from the shared vocabulary + the shared poll loop (no private copies)", () => {
    expect(src).toContain('from "../hooks/useRunPolling"');
    expect(src).toContain("runStatusMeta");
    expect(src).toContain('from "../lib/time"');
    expect(src).not.toMatch(/const TONE\s*[:=]/);
  });
});

describe("one poll loop, shared by panel and chip (source contract)", () => {
  it("RunPanel and RunDock both ride useRunPolling", () => {
    for (const rel of ["../src/components/RunPanel.tsx", "../src/components/RunDock.tsx"]) {
      expect(read(rel)).toContain("useRunPolling(");
    }
  });

  it("api.getRun is called ONLY inside the hook (and declared in the client)", () => {
    for (const rel of ["../src/components/RunPanel.tsx", "../src/components/RunDock.tsx", "../src/App.tsx"]) {
      expect(read(rel), `${rel} must not poll on its own`).not.toContain("api.getRun");
    }
    expect(read("../src/hooks/useRunPolling.ts")).toContain("api.getRun(");
  });
});

describe("RunPanel gained Minimize and lost self-positioning (source contract)", () => {
  const src = read("../src/components/RunPanel.tsx");

  it("exposes a Minimize control alongside Stop/Close", () => {
    expect(src).toContain("onMinimize");
    expect(src).toMatch(/>\s*Minimize\s*</);
    expect(src).toMatch(/>\s*Stop\s*</);
    expect(src).toMatch(/>\s*Close\s*</);
  });

  it("no longer fixes its own position - App owns the stack placement", () => {
    expect(src).not.toContain("fixed bottom-4 right-4");
  });

  it("status colors come from runStatusMeta, not a private TONE map (the old #ef4444 failed AA)", () => {
    expect(src).toContain("runStatusMeta");
    expect(src).not.toContain("#ef4444");
    expect(src).not.toContain("#10b981");
  });
});

describe("App tracks a LIST of runs and mounts the dock (source contract)", () => {
  const src = read("../src/App.tsx");

  it("the single activeRun object is gone; run+batch state comes from the shared useRunDock store", () => {
    expect(src).not.toContain("setActiveRun"); // the old overwrite path
    expect(src).not.toMatch(/const \[activeRun/);
    // SIM-103: App no longer owns `runs`/`batch` as local useState - both live
    // in hooks/useRunDock (a module-level store, so a non-App surface can
    // register into the SAME state App renders from).
    expect(src).not.toContain("useState<TrackedRun[]>");
    expect(src).toContain("useRunDockState()");
    expect(src).toMatch(/from "\.\/hooks\/useRunDock"/);
  });

  it("every launch surface appends through the shared registerRun writer", () => {
    // The in-app ProductHub retired with SIM-59; Discovery + ChatCapture remain
    // the in-app launch surfaces and both ride the same registerRun writer
    // (hooks/useRunDock), which itself calls lib/runDock's pure addRun.
    expect(src).toContain("onRunStarted={registerRun}");
    expect(src).toContain("<ChatCapture onRunStarted={registerRun}");
  });

  it("renders one RunPanel per expanded run and the RunDock for minimized ones", () => {
    expect(src).toContain("expandedRuns(runs).map((r) => (");
    expect(src).toContain("<RunDock");
    expect(src).toContain("minimizedRuns(runs)");
  });

  it("launch failures flow through launchNoteFor; the info kind is NOT the rose error toast", () => {
    expect(src).toContain("launchNoteFor(");
    expect(src).toMatch(/runNote\.kind === "error"\s*\?\s*"border-rose-500\/40 text-rose-300"/);
  });

  it("Escape minimizes the newest expanded panel (non-destructive) instead of dropping tracking", () => {
    expect(src).toContain("minimizeNewestExpandedRun()");
  });

  it("the TopBar fan-outs (Draft/Finalize/Discover queued) register through the shared registerBatch writer", () => {
    expect(src).toContain('registerBatch({ batchId: b.batchId, label: `Draft x${b.total}`, verb: "Draft" });');
    expect(src).toContain('registerBatch({ batchId: b.batchId, label: `Finalize x${b.total}`, verb: "Finalize" });');
    expect(src).toContain('registerBatch({ batchId: b.batchId, label: `Discover x${b.total}`, verb: "Discover" });');
  });
});

// --- SIM-103: useRunDock (the shared registerRun/registerBatch store) --------

describe("useRunDock store (registerRun/registerBatch, no prop threaded from App)", () => {
  it("registerRun appends via the same pure addRun lib/runDock already used", async () => {
    const { registerRun, snapshotForTests, resetRunDockForTests } = await import("../src/hooks/useRunDock");
    resetRunDockForTests();
    registerRun({ runId: "r1", label: "Draft" });
    expect(snapshotForTests().runs).toEqual([{ runId: "r1", label: "Draft", minimized: false }]);
  });

  it("registerBatch sets the one live batch, matching the existing single-batch-panel contract", async () => {
    const { registerBatch, snapshotForTests, resetRunDockForTests } = await import("../src/hooks/useRunDock");
    resetRunDockForTests();
    expect(snapshotForTests().batch).toBeNull();
    registerBatch({ batchId: "b1", label: "Discover x3", verb: "Discover" });
    expect(snapshotForTests().batch).toEqual({ batchId: "b1", label: "Discover x3", verb: "Discover" });
    // A second registration (e.g. the Finds empty-state fan-out while a TopBar
    // batch is showing) replaces the panel - same behavior every existing
    // single-slot call site already had.
    registerBatch({ batchId: "b2", label: "Draft x1", verb: "Draft" });
    expect(snapshotForTests().batch).toEqual({ batchId: "b2", label: "Draft x1", verb: "Draft" });
  });

  it("useRunDock() exposes exactly registerRun/registerBatch - the write-only surface any component can call", async () => {
    const src = read("../src/hooks/useRunDock.ts");
    expect(src).toContain("export function useRunDock()");
    expect(src).toContain("registerRun");
    expect(src).toContain("registerBatch");
  });
});

describe("TriageInbox's empty-state 'run all due' fan-out (source contract)", () => {
  const src = read("../src/components/TriageInbox.tsx");

  it("registers the fan-out as a first-class BatchPanel via useRunDock, not just an inline note", () => {
    expect(src).toContain('from "../hooks/useRunDock"');
    expect(src).toContain("const { registerBatch } = useRunDock();");
    expect(src).toContain('registerBatch({ batchId: b.batchId, label: `Discover x${b.total}`, verb: "Discover" });');
  });
});
