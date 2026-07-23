import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job } from "../types";
import { useEventSubscription } from "./useEventStream";

// Loads all jobs and keeps them live: the shared SSE stream fires a `jobs-changed`
// event whenever a Markdown file changes (from the dashboard, Obsidian, or the
// Python pipeline), so the board always reflects the files on disk. This hook now
// rides the app-wide EventSource (src/hooks/useEventStream) instead of opening its
// own, keeping the SAME 200ms debounce that collapses a burst of file events into
// one reload.
export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);
  // Bumped every time a reload runs, regardless of what triggered it (the
  // jobs-changed SSE debounce below, or a poll-detected run finish via
  // RunPanel/RunDock's onFinished=reload wiring in App). SIM-441: on
  // instances with no working SSE (sse:false, e.g. the pg-backed demo) this
  // is the ONLY live signal that "something changed" - the open job detail
  // drawer rides it to refresh its FILES panel after a completing run.
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    try {
      const data = await api.getJobs();
      setJobs(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setVersion((v) => v + 1);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Debounce bursts of file events into a single reload (unchanged semantics).
  useEventSubscription("jobs-changed", () => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(reload, 200);
  });

  // Clear any pending debounced reload on unmount so it can never fire late.
  useEffect(
    () => () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    },
    [],
  );

  // Optimistic local patch so drag/drop feels instant before the file write returns.
  const patchLocal = useCallback((id: string, updates: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...updates } : j)));
  }, []);

  return { jobs, loading, error, reload, patchLocal, version };
}
