import { useSyncExternalStore } from "react";
import {
  addRun,
  dismissRun as dismissRunPure,
  minimizeNewestExpanded as minimizeNewestExpandedPure,
  minimizeRun as minimizeRunPure,
  restoreRun as restoreRunPure,
  type TrackedRun,
} from "../lib/runDock";

// Shared run-dock store (SIM-103). Pure module state + a hook - no context, no
// new dependency - the same idiom as lib/authSession.ts. App renders from this
// store (the RunPanel stack, the RunDock chips, BatchPanel); any OTHER surface
// can register a run or a BATCH straight into it via useRunDock(), with no
// prop threaded down from App.
//
// The gap this closes (t-1783163892053): a single run could already reach the
// dock through a prop-drilled onRunStarted, but BatchPanel state lived only in
// App's own useState - a non-App surface starting a fan-out (e.g. the Finds
// empty state's "run all due", which has no source to scope a single run to)
// had no way to surface it as a first-class dock panel, only an inline note +
// a wait for the next SSE-driven reload. registerBatch is that missing path.
// Render-layer only: no server contract changes.

export type TrackedBatch = {
  batchId: string;
  label: string;
  verb: "Draft" | "Finalize" | "Discover";
};

export type { TrackedRun };

type State = {
  runs: TrackedRun[];
  batch: TrackedBatch | null;
};

let state: State = { runs: [], batch: null };

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* one bad subscriber must not break the fan-out */
    }
  }
}

function setState(next: State): void {
  state = next;
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): State {
  return state;
}

// --- writers: the register/mutate surface, callable from anywhere ---------

// Append a newly launched run to the dock, expanded (a no-op if this runId is
// already tracked - see lib/runDock.addRun). The shared launch path for every
// single-run surface (Discovery, ChatCapture, the job-detail Agent actions).
export function registerRun(run: { runId: string; label: string }): void {
  setState({ ...state, runs: addRun(state.runs, run) });
}

// Register a fan-out as the one live BatchPanel (SIM-103's new capability).
// Matches the existing single-batch-panel contract App already had for its
// own TopBar fan-outs (Draft queued / Finalize queued / Discover due) -
// registering a second batch while one is showing replaces the panel, same as
// those call sites always did; each batch still runs to completion
// server-side regardless of which one is currently displayed.
export function registerBatch(batch: TrackedBatch): void {
  setState({ ...state, batch });
}

export function minimizeTrackedRun(runId: string): void {
  setState({ ...state, runs: minimizeRunPure(state.runs, runId) });
}

export function restoreTrackedRun(runId: string): void {
  setState({ ...state, runs: restoreRunPure(state.runs, runId) });
}

export function dismissTrackedRun(runId: string): void {
  setState({ ...state, runs: dismissRunPure(state.runs, runId) });
}

export function minimizeNewestExpandedRun(): void {
  setState({ ...state, runs: minimizeNewestExpandedPure(state.runs) });
}

export function closeTrackedBatch(): void {
  setState({ ...state, batch: null });
}

// --- React ergonomics -------------------------------------------------------

// The full store, for the ONE consumer that renders it (App: the RunPanel
// stack, RunDock chips, BatchPanel).
export function useRunDockState(): State {
  return useSyncExternalStore(subscribe, snapshot);
}

// The write-only surface (SIM-103's `useRunDock()`): registerRun/registerBatch,
// stable module-level functions - no prop threaded from App required. Any
// component can call this to start (or report the start of) a single run or a
// batch and have it appear as a first-class dock panel/chip.
export function useRunDock(): { registerRun: typeof registerRun; registerBatch: typeof registerBatch } {
  return { registerRun, registerBatch };
}

// Test seam: reset module state between unit tests. Never called by app code.
export function resetRunDockForTests(): void {
  state = { runs: [], batch: null };
  listeners.clear();
}

// Test seam: read the current state without a React renderer (no jsdom in
// this project - see tests/run-dock.test.ts's header note). Never called by
// app code, which always goes through useRunDockState().
export function snapshotForTests(): State {
  return state;
}
