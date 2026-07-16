import { useEffect, useState } from "react";
import { useRunPolling } from "../hooks/useRunPolling";
import { runTitle, type TrackedRun } from "../lib/runDock";
import { hexA, runStatusMeta } from "../lib/statusColors";
import { mmss } from "../lib/time";
import type { RunStatus } from "../types";
import { Badge } from "ssc-ui";

// The bottom run dock (t-1783119823228): one chip per MINIMIZED run, in the
// browser-download-bar idiom - routine name + target + live status + elapsed,
// click to restore the full panel, an x to dismiss a finished chip. Each chip
// rides the SAME useRunPolling loop as the expanded RunPanel (a run is either
// a panel or a chip, never both, so there is exactly one poll per run) and the
// SAME runStatusMeta vocabulary, so panel and chip can never disagree about a
// run's state.
//
// Deliberately NOT a dialog and NOT aria-modal: the dock is ambient chrome, so
// the shared shortcut guard (lib/shortcuts MODAL_DIALOG_SELECTOR) keeps every
// global key working while runs sit minimized - same posture as the docked
// Run/Batch panels.

function DockChip({
  run,
  onRestore,
  onDismiss,
  onFinished,
}: {
  run: TrackedRun;
  onRestore: () => void;
  onDismiss: () => void;
  onFinished: () => void;
}) {
  const record = useRunPolling(run.runId, onFinished);
  const status: RunStatus = record?.status || "running";
  const running = status === "running";
  const tone = runStatusMeta(status);
  const title = runTitle(record?.routine, run.label);
  // The scope target ("Role - Employer" folder, ticket id, source id) rides on
  // the polled record; global routines carry none.
  const target = record?.jobId || "";

  // Elapsed timer, same freeze-on-finish semantics as RunPanel.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);
  const startMs = record?.startedAt ? new Date(record.startedAt).getTime() : null;

  return (
    <div
      className="flex shrink-0 items-center overflow-hidden rounded-lg border bg-[var(--color-panel-2)]"
      style={{ borderColor: hexA(tone.color, 0.33) }}
    >
      <button
        type="button"
        onClick={onRestore}
        title={`Restore: ${title}${target ? ` - ${target}` : ""}${
          running && record?.currentActivity ? `\n${record.currentActivity}` : ""
        }`}
        className="flex min-h-[44px] items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--color-edge)] sm:min-h-0"
      >
        {running ? (
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
          />
        ) : (
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone.color }} />
        )}
        <span className="max-w-[150px] truncate text-[12px] font-medium text-[var(--color-text)]">{title}</span>
        {target && <span className="max-w-[130px] truncate text-[11px] text-[var(--color-muted)]">{target}</span>}
        <Badge
          tone={tone.color}
          aria-live="polite"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        >
          {tone.label}
        </Badge>
        {startMs !== null && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-muted)]" aria-label="Elapsed time">
            {mmss(now - startMs)}
          </span>
        )}
      </button>
      {!running && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${title}${target ? ` - ${target}` : ""}`}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center self-stretch border-l border-[var(--color-edge)] px-2 text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function RunDock({
  runs,
  onRestore,
  onDismiss,
  onFinished,
}: {
  // The minimized partition only (lib/runDock minimizedRuns), launch order.
  runs: TrackedRun[];
  onRestore: (runId: string) => void;
  onDismiss: (runId: string) => void;
  onFinished: () => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Running actions"
      className="fixed bottom-0 left-1/2 z-[65] flex max-w-[min(760px,calc(100vw-1rem))] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-t-xl border border-b-0 border-[var(--color-edge)] bg-[var(--color-panel)] px-2 pb-1.5 pt-1.5 shadow-2xl"
    >
      {runs.map((r) => (
        <DockChip
          key={r.runId}
          run={r}
          onRestore={() => onRestore(r.runId)}
          onDismiss={() => onDismiss(r.runId)}
          onFinished={onFinished}
        />
      ))}
    </div>
  );
}
