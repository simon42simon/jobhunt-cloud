import { useEffect, useRef } from "react";
import type { Job } from "../types";
import { NotificationBell } from "./NotificationBell";
import { SegmentedControl } from "./SegmentedControl";
import { attentionToneColor, hexA } from "../lib/statusColors";
import { shortcutBlockReason } from "../lib/shortcuts";
import { track } from "../lib/telemetry";

// Top-level pages. Board + Table are no longer separate pages - they are two
// views of the ONE "jobs" page (Airtable-style), switched by the segmented
// control below and persisted by App.
export type ViewMode = "jobs" | "discovery" | "insights" | "product";
export type JobsViewMode = "board" | "table";

// The due-chip's amber - AA-vetted in statusColors (same tone as the
// needs-attention dueSoon band); never a raw hex here.
const DUE_TONE = attentionToneColor("dueSoon");

export function TopBar({
  view,
  setView,
  jobsView,
  setJobsView,
  query,
  setQuery,
  trackFilter,
  setTrackFilter,
  tracks,
  jobs,
  weeklyApplied,
  weeklyTarget,
  onAdd,
  onRunDiscovery,
  dueSourceCount,
  onBatchDraft,
  batchDraftCount,
  onBatchFinalize,
  batchFinalizeCount,
  parkedCount,
  onReviewDecisions,
  demoMode,
}: {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  jobsView: JobsViewMode;
  setJobsView: (v: JobsViewMode) => void;
  query: string;
  setQuery: (q: string) => void;
  trackFilter: string;
  setTrackFilter: (t: string) => void;
  tracks: Record<string, string>;
  jobs: Job[];
  weeklyApplied: number;
  weeklyTarget: number;
  onAdd: () => void;
  onRunDiscovery: () => void;
  dueSourceCount: number;
  onBatchDraft: () => void;
  batchDraftCount: number;
  onBatchFinalize: () => void;
  batchFinalizeCount: number;
  // Parked owner-decisions + the deep-link into the focused Decisions view, both
  // threaded to the always-mounted notification bell (Decisions surface v2).
  parkedCount: number;
  onReviewDecisions: () => void;
  // RC-4 QA BUG-3: the Product tab's whole content is a handoff link to the SSC
  // Product Hub on localhost:5185 - on the PUBLIC demo that is a dead link and
  // an internal-infra leak, so demo mode hides the tab (App also inerts the `p`
  // shortcut and bounces any product-view fallback). Optional: real mode omits
  // it and renders unchanged.
  demoMode?: boolean;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  // Telemetry: record which top-level page and Jobs sub-view the owner opens
  // (events, not content). The keyboard shortcuts (b/t/d/i/p in App) are a
  // separate path and stay untracked here.
  function navTo(v: ViewMode) {
    track("action", "topbar", `nav:${v}`);
    setView(v);
  }
  function switchJobsView(v: JobsViewMode) {
    track("action", "topbar", `jobs-view:${v}`, { journey: "J2" });
    setJobsView(v);
  }

  // "/" focuses search from anywhere. Shared guard (lib/shortcuts): inert while
  // typing, on a Ctrl/Cmd/Alt chord, or behind an open modal dialog - it used
  // to yank focus out of an open dialog's focus trap.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !shortcutBlockReason(e)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const active = jobs.filter((j) => !["rejected", "closed"].includes(j.status)).length;
  const pct = Math.min(100, Math.round((weeklyApplied / Math.max(1, weeklyTarget)) * 100));

  const tabCls = (on: boolean) =>
    `inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition sm:min-h-0 ${
      on ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
    }`;

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-edge)] px-3 py-3 sm:gap-3 md:px-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-[15px] font-bold text-white">
          J
        </div>
        <div>
          <div className="text-[14px] font-semibold leading-none text-[var(--color-text)]">
            Jobhunt Command Center
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
            {jobs.length} jobs · {active} active
          </div>
        </div>
      </div>

      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-[var(--color-panel-2)] p-1">
        <button
          className={tabCls(view === "jobs")}
          aria-pressed={view === "jobs"}
          onClick={() => navTo("jobs")}
          title="Pipeline - board & table views (b/t)"
        >
          Jobs
        </button>
        <button
          className={tabCls(view === "discovery")}
          aria-pressed={view === "discovery"}
          onClick={() => navTo("discovery")}
          title="Find new postings (d)"
        >
          Discovery
        </button>
        <button
          className={tabCls(view === "insights")}
          aria-pressed={view === "insights"}
          onClick={() => navTo("insights")}
          title="Progress & analytics (i)"
        >
          Insights
        </button>
        {!demoMode && (
          <>
            <span className="mx-1 h-4 w-px bg-[var(--color-edge)]" />
            <button
              className={tabCls(view === "product")}
              aria-pressed={view === "product"}
              onClick={() => navTo("product")}
              title="Roadmap, blueprint, changelog (p)"
            >
              Product
            </button>
          </>
        )}
      </div>

      {/* Discovery-cadence visibility (t-1783183576588): how many sources are
          due for a run, surfaced OUTSIDE Discovery->Sources. Rendered on every
          page (hidden at 0); clicking lands on the Discovery console. The
          amber is the vetted dueSoon attention tone from statusColors - the
          same vocabulary as the needs-attention "Due soon" band and the
          source card's "Due" status pill. */}
      {dueSourceCount > 0 && (
        <button
          type="button"
          onClick={() => {
            track("action", "topbar", "due-chip:open-discovery", {
              journey: "J10",
              meta: { count: dueSourceCount },
            });
            setView("discovery");
          }}
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition hover:opacity-80 sm:min-h-0"
          style={{ color: DUE_TONE, background: hexA(DUE_TONE, 0.14) }}
          title={`${dueSourceCount} discovery source${dueSourceCount === 1 ? "" : "s"} due for a run - open Discovery`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: DUE_TONE }} aria-hidden="true" />
          {dueSourceCount} source{dueSourceCount === 1 ? "" : "s"} due
        </button>
      )}

      {view === "jobs" && (
        <SegmentedControl
          ariaLabel="Jobs view"
          size="md"
          className="shrink-0"
          value={jobsView}
          onChange={switchJobsView}
          options={[
            { value: "board", label: "Board", title: "Board view (b)" },
            { value: "table", label: "Table", title: "Table view (t)" },
          ]}
        />
      )}

      {view === "jobs" && (
        <>
          <div className="relative ml-auto w-full sm:w-auto">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search role, employer..."
              className="min-h-[44px] w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1.5 pr-8 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[#7c88a4] focus:border-[var(--color-accent)] sm:min-h-0 sm:w-[240px]"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</kbd>
          </div>

          <select
            value={trackFilter}
            onChange={(e) => setTrackFilter(e.target.value)}
            className="min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-0"
          >
            <option value="">All tracks</option>
            {Object.entries(tracks).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2" title="Applications submitted in the last 7 days">
            <div className="text-right">
              <div className="text-[11px] leading-none text-[var(--color-muted)]">This week</div>
              <div className="text-[13px] font-semibold leading-tight text-[var(--color-text)]">
                {weeklyApplied}/{weeklyTarget}
              </div>
            </div>
            <div className="h-8 w-8 -rotate-90">
              <svg viewBox="0 0 36 36" className="h-8 w-8">
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--color-edge)" strokeWidth="4" />
                <circle
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  stroke={pct >= 100 ? "#10b981" : "#6366f1"}
                  strokeWidth="4"
                  strokeDasharray={`${(pct / 100) * 94.2} 94.2`}
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          {/* Mirrors "Draft queued (N)" exactly: the N is how many sources a
              click will fan out over (countDueSources, derived from the same
              /api/discovery/sources payload as the due-chip), disabled at 0. */}
          <button
            onClick={() => {
              track("run", "topbar", "run-all-due", { journey: "J10", meta: { count: dueSourceCount } });
              onRunDiscovery();
            }}
            disabled={dueSourceCount === 0}
            className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:hover:border-[var(--color-edge)] sm:min-h-0"
            title="Fan out discovery over every due source (per-source scoped agents, max 4 at once; each run stamps its source's health)"
          >
            <span className="text-[var(--color-accent-text)]">▶▶</span> Discover due ({dueSourceCount})
          </button>

          <button
            onClick={() => {
              track("run", "topbar", "batch-draft", { journey: "J3", meta: { count: batchDraftCount } });
              onBatchDraft();
            }}
            disabled={batchDraftCount === 0}
            className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-40 disabled:hover:border-[var(--color-edge)] sm:min-h-0"
            title="Draft all queued jobs (fans out first-draft-job, max 4 agents at once)"
          >
            <span className="text-[var(--color-accent-text)]">▶▶</span> Draft queued ({batchDraftCount})
          </button>

          {/* Mirrors "Draft queued" exactly, but for the finalize-ready set and
              hidden when N=0. Fans out finalize-job (max 4 at once); finalize only
              regenerates materials - it NEVER submits (CC-DATA-2). */}
          {batchFinalizeCount > 0 && (
            <button
              onClick={() => {
                track("run", "topbar", "batch-finalize", { journey: "J3", meta: { count: batchFinalizeCount } });
                onBatchFinalize();
              }}
              className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0"
              title="Finalize all ready jobs (fans out finalize-job, max 4 agents at once; never submits)"
            >
              <span className="text-emerald-400">▶▶</span> Finalize ready ({batchFinalizeCount})
            </button>
          )}

          <button
            onClick={onAdd}
            className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 sm:min-h-0"
            title="Add a lead (n)"
          >
            + Lead <kbd className="border-white/30 text-white/80">n</kbd>
          </button>
        </>
      )}

      {/* Notification bell - always present. On the jobs page the search box's
          ml-auto already pushes the toolbar (and this) to the right edge, so the
          bell trails the Lead button; on the other pages nothing else claims the
          space, so the bell wrapper takes ml-auto to sit at the far right. */}
      <div className={view === "jobs" ? "shrink-0" : "ml-auto shrink-0"}>
        <NotificationBell onNavigate={setView} parkedCount={parkedCount} onReviewDecisions={onReviewDecisions} />
      </div>
    </header>
  );
}
