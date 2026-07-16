import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DiscoveryData } from "../types";
import { SourcesConsole } from "./SourcesConsole";
import { TriageInbox } from "./TriageInbox";
import { NewBadge } from "./sourcesShared";
import { totalNewSinceVisit } from "../lib/sources";
import { track } from "../lib/telemetry";
import { useEventSubscription } from "../hooks/useEventStream";
import type { DiscoverySourcesState } from "../hooks/useDiscoverySources";

// Discovery Sources v1: the Discovery page is now a Sources <-> Finds console.
// Sources (the managed-channel grid) is the default; Finds is the upgraded
// triage inbox for the leads those sources produce. This container owns the
// mode toggle (persisted), the shared discovery-workbook payload (so both
// subviews and the find->source join stay consistent), and the cross-view
// deep-link (source card -> finds filtered to that source).
//
// The SOURCES payload no longer lives here: App owns the one shared
// useDiscoverySources instance (due-visibility, t-1783183576588) so the
// TopBar's due-chip / "Discover due (N)" and this console read the SAME data
// and can never disagree; it arrives via the `sources` prop.

type Mode = "sources" | "finds";
const MODE_KEY = "jobhunt.discovery.mode";

function loadMode(): Mode {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    if (v === "sources" || v === "finds") return v;
  } catch {
    /* storage unavailable */
  }
  return "sources";
}

export function DiscoveryView({
  sources,
  onRunStarted,
  onPursued,
}: {
  sources: DiscoverySourcesState;
  onRunStarted: (run: { runId: string; label: string }) => void;
  onPursued: (jobId: string) => void;
}) {
  const [mode, setModeState] = useState<Mode>(loadMode);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  const { data: sourcesData, loading: sourcesLoading, err: sourcesErr, reload: reloadSources } = sources;

  // The full discovery workbook, lifted here (UX F3) so the Finds inbox AND every
  // source's Leads tab share ONE fetch instead of each pulling the whole workbook
  // (the old double full-workbook pull). Both subviews consume it via props and
  // refresh through the same reload.
  const [discoveryData, setDiscoveryData] = useState<DiscoveryData | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryErr, setDiscoveryErr] = useState<string | null>(null);

  function setMode(m: Mode) {
    // The single choke point for the Sources<->Finds toggle (buttons + the
    // source-card deep-link both route here). Finds is the triage journey (J4),
    // Sources is channel management (J10).
    track("action", m === "sources" ? "discovery-sources" : "discovery-finds", `mode:${m}`, {
      journey: m === "sources" ? "J10" : "J4",
    });
    setModeState(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      /* best-effort */
    }
  }

  // `soft` reloads (post-mutation refresh, SSE-driven refresh) never blank the screen.
  const reloadDiscovery = useCallback(async (soft = false) => {
    if (!soft) setDiscoveryLoading(true);
    try {
      const d = await api.getDiscovery();
      setDiscoveryData(d);
      setDiscoveryErr(null);
    } catch (e) {
      setDiscoveryErr(String((e as Error).message || e));
    } finally {
      if (!soft) setDiscoveryLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadDiscovery();
  }, [reloadDiscovery]);

  // A finished source run may have produced new finds - refresh the workbook
  // softly (UX F1: was a 3s-while-running poll). The SOURCES side of the same
  // signal (run history, status, the 10s while-running safety net) lives in
  // App's shared useDiscoverySources hook.
  useEventSubscription("source-run-finished", () => {
    reloadDiscovery(true);
  });

  // Deep-link from a source card into the finds filtered to that source.
  const handleViewFinds = useCallback((id: string) => {
    setSourceFilter(id);
    setMode("finds");
  }, []);

  // Stamp a visit whenever the Finds view is actually filtered to one source -
  // covers EVERY entry point (the source-card deep-link above, a find row's
  // source chip, and the detail pane's source chip - see TriageInbox's two
  // setSourceFilter call sites), not just the deep-link (audit F1a: triaging in
  // the Finds tab via a chip click never reset "+N new" because only the
  // deep-link stamped lastVisitedAt). Centralizing on sourceFilter itself is the
  // ONE signal that can never miss a call site: any future way of landing on a
  // source-filtered Finds view gets the stamp for free. Re-fires on every
  // (mode, sourceFilter) change, including switching back to an already-filtered
  // Finds tab - which is correct: the owner is looking at it again right now.
  useEffect(() => {
    if (mode !== "finds" || !sourceFilter) return;
    api
      .updateSource(sourceFilter, { lastVisitedAt: new Date().toISOString() })
      .then(() => reloadSources(true))
      .catch(() => {});
  }, [mode, sourceFilter, reloadSources]);

  const tabCls = (on: boolean) =>
    `inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3.5 py-1.5 text-[13px] font-medium transition sm:min-h-[36px] ${
      on ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
    }`;

  // Finds/New visibility (t-1783183576588): the daily "new finds" total used to
  // be invisible until a mode flip - surface it as a badge ON the Finds toggle.
  // Sum of each source's server-derived newSinceVisit; visiting a
  // source-filtered Finds view (the effect above) drains that source's share.
  const newFindsCount = totalNewSinceVisit(sourcesData?.sources ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--color-edge)] px-4 py-3 md:px-6">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight text-[var(--color-text)]">Discovery</h2>
          <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
            {mode === "sources"
              ? "Managed employer & board sources - each with its own instructions, cadence, and health."
              : "Triage the leads your sources produced."}
          </p>
        </div>
        <div
          role="group"
          aria-label="Discovery view"
          className="ml-auto flex shrink-0 items-center gap-1 rounded-lg bg-[var(--color-panel-2)] p-1"
        >
          <button
            type="button"
            className={tabCls(mode === "sources")}
            aria-pressed={mode === "sources"}
            onClick={() => setMode("sources")}
          >
            Sources
          </button>
          <button
            type="button"
            className={`${tabCls(mode === "finds")} gap-1.5`}
            aria-pressed={mode === "finds"}
            aria-label={newFindsCount > 0 ? `Finds, ${newFindsCount} new since your last visit` : "Finds"}
            onClick={() => setMode("finds")}
          >
            Finds
            {newFindsCount > 0 && <NewBadge n={newFindsCount} />}
          </button>
        </div>
      </header>

      {mode === "sources" ? (
        <SourcesConsole
          data={sourcesData}
          loading={sourcesLoading}
          err={sourcesErr}
          reload={() => reloadSources(true)}
          finds={discoveryData?.discoveries ?? null}
          findsLoading={discoveryLoading}
          findsErr={discoveryErr}
          onRunStarted={onRunStarted}
          onViewFinds={handleViewFinds}
          onPursued={onPursued}
        />
      ) : (
        <TriageInbox
          data={discoveryData}
          loading={discoveryLoading}
          err={discoveryErr}
          reload={() => reloadDiscovery(true)}
          sources={sourcesData?.sources ?? []}
          sourceFilter={sourceFilter}
          setSourceFilter={setSourceFilter}
          onPursued={onPursued}
          onRunStarted={onRunStarted}
        />
      )}
    </div>
  );
}
