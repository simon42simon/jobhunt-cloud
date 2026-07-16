// Concurrent run tracking + the bottom run dock (t-1783119823228). App.tsx
// used to hold ONE `activeRun` object that every new launch OVERWROTE - so
// starting a second action hid the first panel even though its agent kept
// running server-side. The backend was already parallel (MAX_CONCURRENT_RUNS=4
// + queue + the per-(routine,scopeId) 409 lock); this module is the pure state
// vocabulary that lets the frontend honor it: a LIST of tracked runs, each
// either expanded (a RunPanel in the bottom-right stack) or minimized (a chip
// in the bottom dock). All transitions are pure and unit-tested; App owns the
// useState, components own zero dock logic.
//
// Close vs Minimize stays distinct (the ticket's contract): Minimize keeps the
// run tracked + polling in the dock; Close/dismiss drops UI tracking only -
// the agent keeps running server-side, exactly as before.

export type TrackedRun = {
  runId: string;
  label: string;
  minimized: boolean;
};

// Append a newly launched run, expanded. Launch order is preserved (oldest
// first) and a runId is never tracked twice - re-reporting an already-tracked
// run (e.g. a double-fired onRunStarted) is a no-op that keeps its current
// minimized/expanded state rather than duplicating a panel or chip.
export function addRun(runs: TrackedRun[], run: { runId: string; label: string }): TrackedRun[] {
  if (runs.some((r) => r.runId === run.runId)) return runs;
  return [...runs, { runId: run.runId, label: run.label, minimized: false }];
}

// Collapse one run into the dock. Unknown ids are a no-op; order is unchanged.
export function minimizeRun(runs: TrackedRun[], runId: string): TrackedRun[] {
  return runs.map((r) => (r.runId === runId ? { ...r, minimized: true } : r));
}

// Expand a docked run back into its full panel. Unknown ids are a no-op;
// launch order is unchanged (a restored run returns to its original slot, so
// the stack/dock never reshuffle underfoot).
export function restoreRun(runs: TrackedRun[], runId: string): TrackedRun[] {
  return runs.map((r) => (r.runId === runId ? { ...r, minimized: false } : r));
}

// Drop UI tracking for one run (panel Close / dock chip dismiss). The agent
// keeps running server-side - this only removes the local panel/chip.
export function dismissRun(runs: TrackedRun[], runId: string): TrackedRun[] {
  return runs.filter((r) => r.runId !== runId);
}

// The two render partitions, both in launch order.
export function expandedRuns(runs: TrackedRun[]): TrackedRun[] {
  return runs.filter((r) => !r.minimized);
}

export function minimizedRuns(runs: TrackedRun[]): TrackedRun[] {
  return runs.filter((r) => r.minimized);
}

// Escape's run-panel behavior: minimize the NEWEST expanded panel (one per
// press, the same one-overlay-per-Esc idiom as the dialogs) - non-destructive,
// the run keeps polling from the dock. No-op when nothing is expanded.
export function minimizeNewestExpanded(runs: TrackedRun[]): TrackedRun[] {
  const newest = [...runs].reverse().find((r) => !r.minimized);
  return newest ? minimizeRun(runs, newest.runId) : runs;
}

// ---------------------------------------------------------------------------
// Shared run-title vocabulary. Friendly gerund per routine so the panel AND
// the dock chip say what is actually happening (was a private map inside
// RunPanel; the dock must never keep a second drifted copy).
// ---------------------------------------------------------------------------
export const ROUTINE_TITLE: Record<string, string> = {
  "first-draft-job": "Drafting CV + cover letter",
  "finalize-job": "Finalizing application",
  "discover-jobs": "Discovering new jobs",
  "interview-prep": "Prepping interview",
  "offer-prep": "Prepping offer",
  "draft-follow-up": "Drafting follow-up",
};

export function runTitle(routine: string | undefined, label: string): string {
  return (routine && ROUTINE_TITLE[routine]) || label;
}

// ---------------------------------------------------------------------------
// Launch-failure classification (the honest 409/429 path). The API client
// throws plain Errors carrying the server's message text, so the classifier
// keys on the two launch-refusal messages /api/routines/run emits:
//   409 duplicate-scope - "a <routine> run is already in progress or queued
//       for this <job|ticket>" (the per-(routine,scopeId) lock)
//   429 capacity        - "too many routines running (max N); ..."
// Both are the server WORKING AS DESIGNED, not failures - they surface as an
// informational note, never the rose error toast. The patterns are pinned
// against server/index.js's literal messages in run-dock.test.ts so they
// cannot silently drift apart.
// ---------------------------------------------------------------------------
export type LaunchErrorKind = "duplicate" | "capacity" | "other";

export function classifyLaunchError(message: string): LaunchErrorKind {
  if (/already in progress or queued/i.test(message)) return "duplicate";
  if (/too many routines running/i.test(message)) return "capacity";
  return "other";
}

export type RunNote = { kind: "info" | "error"; text: string };

// Compose the user-facing note for a failed launch. Duplicate/capacity are
// honest "nothing new was started" info notes; anything else keeps the
// existing "Could not start routine" error framing.
export function launchNoteFor(message: string): RunNote {
  const kind = classifyLaunchError(message);
  if (kind === "duplicate") {
    return { kind: "info", text: `${message} - nothing new was started; the existing run keeps working.` };
  }
  if (kind === "capacity") {
    return { kind: "info", text: `At capacity: ${message} - nothing new was started.` };
  }
  return { kind: "error", text: `Could not start routine: ${message}` };
}
