import { useMemo, useState } from "react";
import { api } from "../api";
import type { DerivedSource, Discovery, SourceCadence, SourceStatus, SourcesData } from "../types";
import { SourceCard } from "./SourceCard";
import { SourceDetailDrawer, type TabId } from "./SourceDetailDrawer";
import { SourceFormDrawer } from "./SourceFormDrawer";
import { FreshnessBar } from "./sourcesShared";
import { groupSources, partitionSourcesByActive, type SourceGroupBy } from "../lib/sources";
import { track } from "../lib/telemetry";

const GROUP_BY_KEY = "jobhunt.sources.groupBy";
const GROUP_BY_VALUES: SourceGroupBy[] = ["none", "track", "sector", "type"];

// Grouping defaults to "none" (design spec §2): `tracks` is a brand-new field
// with zero adoption on day one, so defaulting to "grouped by Track" would dump
// nearly everything into one "All tracks" bucket and look broken.
function loadGroupBy(): SourceGroupBy {
  try {
    const v = window.localStorage.getItem(GROUP_BY_KEY);
    if (v && (GROUP_BY_VALUES as string[]).includes(v)) return v as SourceGroupBy;
  } catch {
    /* storage unavailable */
  }
  return "none";
}

// The grid defaults to ACTIVE sources; dormant stubs collapse under an
// "Inactive (N)" disclosure (ops F10, t-1783183576759). The expanded state
// survives reloads - same best-effort idiom as GROUP_BY_KEY above.
const SHOW_INACTIVE_KEY = "jobhunt.sources.showInactive";

function loadShowInactive(): boolean {
  try {
    return window.localStorage.getItem(SHOW_INACTIVE_KEY) === "true";
  } catch {
    return false; // collapsed by default - the active cards are the scan target
  }
}

const GROUP_BY_LABEL: Record<SourceGroupBy, string> = {
  none: "None",
  track: "Track",
  sector: "Sector",
  type: "Type",
};

// A quick-filter status the freshness bar's segments narrow the grid to (a
// subset of SourceStatus - "running"/"failed"/"paused" have no bar segment).
type FreshnessFilter = "due" | "stale" | "never-run" | "healthy";

// The Sources console (Discovery Sources v1, view A): a responsive card grid of
// managed employer/board sources with computed health, lead yield, run
// sparklines, and per-source Run-now + edit/pause/delete. Data is owned by the
// parent DiscoveryView (which also polls while a run is in progress); this view
// renders it and drives the mutations.
export function SourcesConsole({
  data,
  loading,
  err,
  reload,
  finds,
  findsLoading,
  findsErr,
  onRunStarted,
  onViewFinds,
  onPursued,
}: {
  data: SourcesData | null;
  loading: boolean;
  err: string | null;
  reload: () => void;
  // The shared discovery workbook (UX F3), owned by DiscoveryView - passed
  // straight through to the detail drawer's Leads tab so it never re-pulls it.
  finds: Discovery[] | null;
  findsLoading: boolean;
  findsErr: string | null;
  onRunStarted: (run: { runId: string; label: string }) => void;
  onViewFinds: (sourceId: string) => void;
  onPursued: (jobId: string) => void;
}) {
  // null = closed; "new" = create; a source = edit.
  const [drawer, setDrawer] = useState<DerivedSource | "new" | null>(null);
  // The per-source detail drawer (opened by clicking a card). Stored by id so it
  // tracks the live source across reloads and unmounts if the source is deleted.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<TabId | undefined>(undefined);
  const [busyRun, setBusyRun] = useState<Record<string, boolean>>({});
  const [runNote, setRunNote] = useState<Record<string, string>>({});
  const [groupBy, setGroupByState] = useState<SourceGroupBy>(loadGroupBy);
  const [statusFilter, setStatusFilter] = useState<FreshnessFilter | null>(null);
  const [showInactive, setShowInactiveState] = useState<boolean>(loadShowInactive);

  function setGroupBy(g: SourceGroupBy) {
    track("action", "discovery-sources", "group-by", { journey: "J10", meta: { groupBy: g } });
    setGroupByState(g);
    try {
      window.localStorage.setItem(GROUP_BY_KEY, g);
    } catch {
      /* best-effort */
    }
  }

  function setShowInactive(next: boolean) {
    track("action", "discovery-sources", "toggle-inactive", { journey: "J10", meta: { show: next } });
    setShowInactiveState(next);
    try {
      window.localStorage.setItem(SHOW_INACTIVE_KEY, String(next));
    } catch {
      /* best-effort */
    }
  }

  function handleOpenSource(source: DerivedSource, opts?: { tab?: TabId }) {
    setDetailId(source.id);
    setDetailTab(opts?.tab);
  }

  async function handleRun(id: string) {
    // Single choke point for per-source Run-now (card + detail drawer). No
    // source name/url leaves the page - just the run trigger (J10).
    track("run", "discovery-sources", "run-now", { journey: "J10" });
    const source = data?.sources.find((s) => s.id === id);
    setBusyRun((b) => ({ ...b, [id]: true }));
    setRunNote((n) => ({ ...n, [id]: "" }));
    try {
      const { runId } = await api.runSource(id);
      onRunStarted({ runId, label: `Run: ${source?.name ?? id}` });
      reload(); // pull the optimistic running record + let the parent poll to completion
    } catch (e) {
      // 409 (already running) / 429 (too many routines) / locked - a soft note,
      // never an error crash.
      setRunNote((n) => ({ ...n, [id]: String((e as Error).message || e) }));
    } finally {
      setBusyRun((b) => ({ ...b, [id]: false }));
    }
  }

  async function handleToggleActive(source: DerivedSource) {
    try {
      await api.updateSource(source.id, { active: source.active === "no" ? "yes" : "no" });
      reload();
    } catch (e) {
      setRunNote((n) => ({ ...n, [source.id]: String((e as Error).message || e) }));
    }
  }

  async function handleDelete(source: DerivedSource) {
    track("action", "discovery-sources", "source-delete", { journey: "J10" });
    try {
      await api.deleteSource(source.id);
      reload();
    } catch (e) {
      setRunNote((n) => ({ ...n, [source.id]: String((e as Error).message || e) }));
    }
  }

  async function handleCadenceChange(id: string, cadence: SourceCadence) {
    track("action", "discovery-sources", "cadence-change", { journey: "J10", meta: { cadence } });
    try {
      await api.updateSource(id, { cadence });
      reload();
    } catch (e) {
      setRunNote((n) => ({ ...n, [id]: String((e as Error).message || e) }));
    }
  }

  async function handleTracksChange(id: string, tracks: string[]) {
    track("action", "discovery-sources", "tracks-change", { journey: "J10" });
    try {
      await api.updateSource(id, { tracks });
      reload();
    } catch (e) {
      setRunNote((n) => ({ ...n, [id]: String((e as Error).message || e) }));
    }
  }

  // One-click "Add missing field(s)" from the Instructions-tab contract callout
  // (design spec §6.3) - appends the missing tag name(s) into outputFields.
  async function handleAddContractFields(source: DerivedSource) {
    const additions = source.contractGaps.map((g) => (g === "direct-link" ? "link" : "deadline"));
    const have = new Set(source.outputFields.map((f) => f.toLowerCase()));
    const next = [...source.outputFields, ...additions.filter((a) => !have.has(a))];
    try {
      await api.updateSource(source.id, { outputFields: next });
      reload();
    } catch (e) {
      setRunNote((n) => ({ ...n, [source.id]: String((e as Error).message || e) }));
    }
  }

  const sources = data?.sources ?? [];
  const detailSource = detailId ? sources.find((s) => s.id === detailId) ?? null : null;

  const filteredSources = statusFilter ? sources.filter((s) => s.status === statusFilter) : sources;
  // Active cards are the default grid; dormant stubs ("maybe"/"no") collapse
  // under the Inactive disclosure below. Partitioned AFTER the freshness filter
  // so a segment click still finds inactive matches - in the collapsed group.
  const { active: activeSources, inactive: inactiveSources } = useMemo(
    () => partitionSourcesByActive(filteredSources),
    [filteredSources],
  );
  const groups = useMemo(() => groupSources(activeSources, groupBy), [activeSources, groupBy]);

  const groupBtn = (mode: SourceGroupBy) => (
    <button
      key={mode}
      type="button"
      onClick={() => setGroupBy(mode)}
      aria-pressed={groupBy === mode}
      className={`rounded px-2.5 py-1 text-[12px] font-medium transition ${
        groupBy === mode
          ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm"
          : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {GROUP_BY_LABEL[mode]}
    </button>
  );

  function renderGrid(list: DerivedSource[]) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((s) => (
          <SourceCard
            key={s.id}
            source={s}
            busyRun={!!busyRun[s.id]}
            runNote={runNote[s.id] || null}
            onOpen={handleOpenSource}
            onRun={handleRun}
            onEdit={(src) => setDrawer(src)}
            onToggleActive={handleToggleActive}
            onDelete={handleDelete}
            onViewFinds={onViewFinds}
            onCadenceChange={handleCadenceChange}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-6">
      {/* Sub-header: count + group-by + add */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-[12.5px] text-[var(--color-muted)]">
          {data ? `${sources.length} ${sources.length === 1 ? "source" : "sources"}` : "loading sources…"}
          {data && data.unassignedCount > 0 ? ` · ${data.unassignedCount} unassigned finds` : ""}
        </p>
        <div
          role="group"
          aria-label="Group sources by"
          className="flex items-center gap-0.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-0.5"
        >
          {GROUP_BY_VALUES.map((m) => groupBtn(m))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={reload}
            className="min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[13px] text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[36px]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setDrawer("new")}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 sm:min-h-[36px]"
          >
            <span aria-hidden="true">+</span> Add source
          </button>
        </div>
      </div>

      {/* Freshness bar: rollup + clickable quick filters (design spec §4) */}
      <FreshnessBar
        sources={sources}
        statusFilter={statusFilter}
        onFilterChange={setStatusFilter}
        onOpenSource={(s) => handleOpenSource(s)}
      />

      {/* Workbook-locked soft note (finds counts may be stale) */}
      {data?.locked && data.message && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
          {data.message}
        </div>
      )}

      {/* Unassigned finds prompt */}
      {data && data.unassignedCount > 0 && (
        <div className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold text-[var(--color-text)]">
              {data.unassignedCount} unassigned {data.unassignedCount === 1 ? "find" : "finds"}
            </span>
            <span className="text-[12px] text-[var(--color-muted)]">
              match no managed source. Add a source or an alias so they join.
            </span>
          </div>
          {data.unassignedSources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.unassignedSources.slice(0, 8).map((u) => (
                <span
                  key={u.label}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] py-0.5 pl-2.5 pr-2 text-[12px] text-[var(--color-muted)]"
                >
                  {u.label}
                  <span className="rounded-full bg-[var(--color-panel-2)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--color-text)]">
                    {u.count}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* States: error > loading > empty > filtered-empty > grid */}
      {err ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-[13px] text-rose-300">{err}</div>
      ) : loading && !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-52 animate-pulse rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)]" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-edge)] py-16 text-center">
          <p className="text-[14px] font-semibold text-[var(--color-text)]">No sources yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-[var(--color-muted)]">
            Add your first employer site or job board. Each source gets its own crawl instructions, cadence, and health.
          </p>
          <button
            type="button"
            onClick={() => setDrawer("new")}
            className="mt-4 inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 sm:min-h-[36px]"
          >
            <span aria-hidden="true">+</span> Add source
          </button>
        </div>
      ) : filteredSources.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-edge)] py-12 text-center">
          <p className="text-[13px] text-[var(--color-muted)]">No sources match this filter.</p>
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className="mt-3 min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[36px]"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <>
          {/* Default grid: ACTIVE sources only (ops F10). */}
          {activeSources.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--color-edge)] py-8 text-center text-[12.5px] text-[var(--color-muted)]">
              No active sources{statusFilter ? " match this filter" : ""} - the{" "}
              {inactiveSources.length === 1 ? "match is" : "matches are"} under Inactive below.
            </div>
          ) : groupBy === "none" ? (
            renderGrid(groups[0]?.sources ?? [])
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((g) => (
                <section key={g.key} aria-labelledby={`source-group-${g.key}`}>
                  <div className="mb-2.5 flex flex-wrap items-center gap-2 border-b border-[var(--color-edge)] pb-1.5">
                    {g.accent && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.accent }} aria-hidden="true" />}
                    <h3 id={`source-group-${g.key}`} className="text-[14px] font-semibold text-[var(--color-text)]">
                      {g.label}
                    </h3>
                    <span className="rounded-full bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                      {g.sources.length}
                    </span>
                  </div>
                  {renderGrid(g.sources)}
                </section>
              ))}
            </div>
          )}

          {/* Dormant stubs (trial seeds / paused) stay listed - honest alias
              anchors - but collapsed so they never dilute the health scan.
              Rendered flat (no group-by fan-out): a dormant stub needs finding,
              not track membership. */}
          {inactiveSources.length > 0 && (
            <section aria-label="Inactive sources" className="mt-5">
              <button
                type="button"
                onClick={() => setShowInactive(!showInactive)}
                aria-expanded={showInactive}
                aria-controls="sources-inactive-grid"
                className="flex min-h-[44px] w-full flex-wrap items-center gap-2 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-left hover:bg-[var(--color-panel-2)]"
              >
                <span aria-hidden="true" className="shrink-0 font-mono text-[11px] text-[#7c88a4]">
                  {showInactive ? "▾" : "▸"}
                </span>
                <span className="text-[13px] font-semibold text-[var(--color-text)]">
                  Inactive ({inactiveSources.length})
                </span>
                <span className="text-[11.5px] text-[var(--color-muted)]">
                  trial seeds and paused stubs, kept as alias anchors
                </span>
              </button>
              {showInactive && (
                <div id="sources-inactive-grid" className="mt-3">
                  {renderGrid(inactiveSources)}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {detailSource && (
        <SourceDetailDrawer
          key={detailSource.id} // remount per source so a deep-linked initialTab always lands
          source={detailSource}
          sources={sources}
          finds={finds}
          findsLoading={findsLoading}
          findsErr={findsErr}
          active={!drawer}
          busyRun={!!busyRun[detailSource.id]}
          initialTab={detailTab}
          onClose={() => {
            setDetailId(null);
            setDetailTab(undefined);
          }}
          onEdit={(src) => setDrawer(src)}
          onRun={handleRun}
          onToggleActive={handleToggleActive}
          onDelete={async (src) => {
            await handleDelete(src);
            setDetailId(null);
          }}
          onViewFinds={(id) => {
            setDetailId(null);
            onViewFinds(id);
          }}
          onPursued={onPursued}
          onRunStarted={onRunStarted}
          onCadenceChange={handleCadenceChange}
          onTracksChange={handleTracksChange}
          onAddContractFields={handleAddContractFields}
          onRefresh={reload}
        />
      )}
      {drawer && (
        <SourceFormDrawer
          source={drawer === "new" ? null : drawer}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
