import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isRunning } from "../lib/sources";
import type { SourcesData } from "../types";
import { useEventSubscription } from "./useEventStream";

// One shared, live view of the Discovery Sources registry (due-visibility,
// t-1783183576588). App instantiates this ONCE and passes it down, so the
// TopBar's due-chip / "Discover due (N)" count and the Discovery console are
// reading the SAME payload - they can never disagree about what is due.
//
// Freshness follows the SSE-consolidation pattern (UX F1) - no new poll loop:
//   - `source-run-finished` on the shared event stream triggers a soft reload
//     (a finished run changes status/due/newSinceVisit).
//   - Mutations that change the registry synchronously (a visit stamp, a
//     launched fan-out stamping lastRunAt) call reload(true) at their call
//     sites, exactly as DiscoveryView already did.
//   - The 10s while-running safety net (moved here from DiscoveryView) covers
//     a dropped stream mid-run; it stops the moment nothing is running.
export function useDiscoverySources() {
  const [data, setData] = useState<SourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // `soft` reloads (post-mutation refresh, SSE-driven refresh) never blank the
  // screen - same contract as DiscoveryView's original reloadSources.
  const reload = useCallback(async (soft = false) => {
    if (!soft) setLoading(true);
    try {
      const d = await api.getDiscoverySources();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      if (!soft) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // A finished source run updates the run history, the derived status/due, and
  // possibly newSinceVisit - refresh softly on the server's signal.
  useEventSubscription("source-run-finished", () => reload(true));

  // Instruction-proposal loop (DISC-W3), same no-new-poll pattern:
  //   - source-proposals-changed = a proposal was filed / approved / rejected
  //     (instructionProposals + provenance changed on one source);
  //   - run-finished with routine "propose-instructions" = a propose run closed,
  //     so the served proposeRunId clears - INCLUDING a run that died before
  //     filing anything, which the proposals event alone would never report.
  useEventSubscription("source-proposals-changed", () => reload(true));
  useEventSubscription("run-finished", (e) => {
    if (e.routine === "propose-instructions") reload(true);
  });

  // Safety net while a run is live: if the source-run-finished event is ever
  // missed (dropped connection during the run), one slow 10s tick still flips
  // the source to its terminal outcome. Stops when nothing is running.
  const anyRunning = data?.sources.some(isRunning);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => reloadRef.current(true), 10000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  return { data, loading, err, reload };
}

// The hook's return shape, for components that receive it as a prop.
export type DiscoverySourcesState = ReturnType<typeof useDiscoverySources>;
