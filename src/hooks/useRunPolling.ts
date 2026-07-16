import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RoutineRun } from "../types";

// The ONE per-run poll loop (t-1783119823228). Lifted verbatim out of
// RunPanel when the run dock landed, so the expanded panel and the minimized
// dock chip track a run the exact same way instead of keeping two drifted
// copies: 1.2s cadence while running, 2s retry after a fetch error, and ONE
// onFinished notification when the run first reaches a terminal status on
// this mount. A run is tracked by exactly one consumer at a time (it is
// either expanded or minimized, never both), so there is never a duplicate
// poll for the same runId; across a minimize/restore remount the notification
// can re-fire, which is safe - every caller passes an idempotent reload.
export function useRunPolling(runId: string, onFinished: () => void): RoutineRun | null {
  const [run, setRun] = useState<RoutineRun | null>(null);
  const finishedNotified = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const poll = async () => {
      try {
        const r = await api.getRun(runId);
        if (!alive) return;
        setRun(r);
        if (r.status === "running") {
          timer = window.setTimeout(poll, 1200);
        } else if (!finishedNotified.current) {
          finishedNotified.current = true;
          onFinished();
        }
      } catch {
        if (alive) timer = window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, onFinished]);

  return run;
}
