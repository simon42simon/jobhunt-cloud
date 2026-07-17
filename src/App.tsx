import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useJobs } from "./hooks/useJobs";
import { useTasks } from "./hooks/useTasks";
import { useDiscoverySources } from "./hooks/useDiscoverySources";
import { setStreamAvailability } from "./hooks/useEventStream";
import { countDueSources } from "./lib/sources";
import type { AppConfig, Status } from "./types";
import { TopBar, type JobsViewMode, type ViewMode } from "./components/TopBar";
import { KanbanBoard } from "./components/KanbanBoard";
import { JobTable } from "./components/JobTable";
import { JobDetailDrawer } from "./components/JobDetail";
import { AddJobModal } from "./components/AddJobModal";
import { ProductMoved } from "./components/ProductMoved";
import { DiscoveryView } from "./components/DiscoveryView";
import { InsightsView } from "./components/InsightsView";
import { RunPanel } from "./components/RunPanel";
import { RunDock } from "./components/RunDock";
import { BatchPanel } from "./components/BatchPanel";
import { StatusChangeModal } from "./components/StatusChangeModal";
import { NeedsAttentionStrip } from "./components/NeedsAttentionStrip";
import { JobPresets } from "./components/JobPresets";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ChatCapture } from "./components/ChatCapture";
import { DemoBanner } from "./components/DemoBanner";
import { DemoTour } from "./components/DemoTour";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { UndoToast } from "./components/UndoToast";
import { STATUS_LABEL } from "./lib/constants";
import { filterByPreset, PRESETS } from "./lib/jobPresets";
import { track } from "./lib/telemetry";
import type { EntityRef } from "./lib/relatedEntities";
import { openSscHub } from "./lib/sscHub";
import { clearRoute, jobsHash, navigate, parseRoute, useRoute } from "./lib/router";
import { setAuthStatus, useAuthStatus } from "./lib/authSession";
import { shortcutBlockReason } from "./lib/shortcuts";
import {
  addRun,
  dismissRun,
  expandedRuns,
  launchNoteFor,
  minimizeNewestExpanded,
  minimizeRun,
  minimizedRuns,
  restoreRun,
  type RunNote,
  type TrackedRun,
} from "./lib/runDock";

// Only these high-stakes moves get a confirm popup (submit starts the response
// clock + stamps applied; rejected/closed leave the active pipeline). Every
// other move applies instantly with an Undo affordance.
const CONFIRM_STATUSES: Status[] = ["submitted", "rejected", "closed"];

// The Jobs page's board/table choice survives reloads (Airtable-style view
// memory). localStorage can throw (private mode, blocked storage) - reads and
// writes are best-effort and fall back to the board.
const JOBS_VIEW_KEY = "jobhunt.jobsView";

function loadJobsView(): JobsViewMode {
  try {
    const v = window.localStorage.getItem(JOBS_VIEW_KEY);
    if (v === "board" || v === "table") return v;
  } catch {
    /* storage unavailable - default below */
  }
  return "board";
}

// The Jobs page's preset "quick view" choice also survives reloads (same
// Airtable-style view memory as jobsView above). A stored key that is no longer
// a known preset is ignored - falls back to "all", which can never blank the
// list - so a removed/renamed preset never strands the owner on an empty view.
const JOBS_PRESET_KEY = "jobhunt.jobsPreset";

function loadJobsPreset(): string {
  try {
    const v = window.localStorage.getItem(JOBS_PRESET_KEY);
    if (v && PRESETS.some((p) => p.key === v)) return v;
  } catch {
    /* storage unavailable - default below */
  }
  return "all";
}

// Compact fallback for the TopBar's own ErrorBoundary (t-1783145481687): the
// TopBar hosts the notification bell OUTSIDE <main>'s boundary, so a bell/feed
// render crash used to white-screen the whole app. The default boundary
// message is sized for the main pane; up here a slim strip is enough - App's
// global keyboard shortcuts (b/t/d/i/p, n) keep working underneath it.
const TOP_BAR_FALLBACK = (
  <div
    role="alert"
    className="shrink-0 border-b border-[var(--color-edge)] bg-[var(--color-panel)] px-4 py-2 text-[12px] text-[var(--color-muted)]"
  >
    The top bar failed to render. Keyboard shortcuts still work - reload the page to restore it.
  </div>
);

export default function App() {
  const { jobs, loading, error, reload, patchLocal } = useJobs();
  // The ONE live view of the Discovery Sources registry (due-visibility,
  // t-1783183576588): the TopBar due-chip / "Discover due (N)" and the
  // Discovery console all read this instance, so they can never disagree.
  // Kept fresh by the shared SSE stream (source-run-finished), not a poll.
  const discoverySources = useDiscoverySources();
  // The ONE live source of parked owner-decisions (Decisions surface v2,
  // t-1783336697733). Feeds the always-mounted notification bell (TopBar);
  // resolving decisions now happens in the SSC Product Hub (lib/sscHub), which
  // reads the same live board.
  const tasksState = useTasks();
  const [config, setConfig] = useState<AppConfig | null>(null);
  // On load, a valid detail hash (lib/router) WINS over the default view: a
  // shared/bookmarked task URL (`#/tasks[/<id>]`) opens on the Product tab's
  // handoff panel (t-1783257189986 - never auto-redirects off-app on page
  // load); a job URL (`#/jobs[/<id>]`, t-1783371156974) opens on the Jobs
  // board with that job's drawer. Anything else defaults to Jobs.
  const [view, setView] = useState<ViewMode>(() =>
    parseRoute(window.location.hash)?.page === "tasks" ? "product" : "jobs",
  );
  const route = useRoute();
  const [jobsView, setJobsViewState] = useState<JobsViewMode>(loadJobsView);
  // The selected preset "quick view" (persisted, mirroring jobsView). Applied
  // FIRST in the shared `filtered` memo below, so it narrows board and table
  // identically.
  const [jobsPreset, setJobsPresetState] = useState<string>(loadJobsPreset);

  // hashchange drives state, not just clicks: Back/Forward landing on a detail
  // hash from any view forces the owning surface (tasks -> Product handoff
  // panel, jobs -> Jobs board), so the URL can never point at an item while
  // another view is on screen.
  useEffect(() => {
    if (route?.page === "tasks") setView("product");
    else if (route?.page === "jobs") setView("jobs");
  }, [route]);

  // Every EXPLICIT view switch (TopBar tabs, b/t/p/d/i shortcuts) leaves the
  // tasks deep link: strip the hash first (replaceState - no history entry) so
  // a stale `#/tasks/<id>` never lies about what is on screen and a refresh
  // after leaving lands on the chosen view, not back on the task.
  const switchView = useCallback((v: ViewMode) => {
    clearRoute();
    setView(v);
  }, []);

  function setJobsView(v: JobsViewMode) {
    setJobsViewState(v);
    try {
      window.localStorage.setItem(JOBS_VIEW_KEY, v);
    } catch {
      /* best-effort persistence */
    }
  }

  // Persist the preset choice and fire a usage-telemetry action. The surface enum
  // has no bare "jobs" - the presets straddle board + table - so the event is
  // attributed to whichever sub-view is on screen (jobs-board / jobs-table). meta
  // carries the resulting count (a scalar), never any job content. J2 = the
  // "navigate the Jobs list" journey (the same journey the board/table toggle
  // lives in), and this closes the zero-filter-events gap the research flagged.
  function selectJobsPreset(key: string) {
    setJobsPresetState(key);
    try {
      window.localStorage.setItem(JOBS_PRESET_KEY, key);
    } catch {
      /* best-effort persistence */
    }
    track("action", jobsView === "board" ? "jobs-board" : "jobs-table", `preset:${key}`, {
      journey: "J2",
      meta: { count: filterByPreset(key, jobs).length },
    });
  }
  const [query, setQuery] = useState("");
  const [trackFilter, setTrackFilter] = useState("");
  // The open job side-view drawer is DEEP-LINKED (t-1783371156974): its id lives
  // in the URL hash (`#/jobs/<id>`, mirroring the task deep link), so opening a
  // job reflects in the address bar and a shared/refreshed URL reopens the same
  // drawer. DERIVED from the route (single source of truth) rather than a
  // parallel useState, so Back/Forward drive open/close for free. Open PUSHES
  // the hash (Back closes, Forward reopens); close pushes the bare board hash,
  // matching TaskDetail's close (both leave the surface via clearRoute).
  const selectedJob = route?.page === "jobs" ? route.jobId ?? null : null;
  const openJob = useCallback((id: string) => navigate(jobsHash(id)), []);
  const closeJob = useCallback(() => navigate(jobsHash()), []);
  const [adding, setAdding] = useState(false);
  // ALL tracked runs (t-1783119823228) - the backend was always parallel
  // (MAX_CONCURRENT_RUNS=4 + queue), but this used to be ONE `activeRun` that
  // every launch overwrote, hiding the previous panel while its agent kept
  // running. Now each launch APPENDS; expanded runs stack as panels
  // bottom-right, minimized runs collapse into the bottom RunDock. All state
  // transitions are pure lib/runDock helpers.
  const [runs, setRuns] = useState<TrackedRun[]>([]);
  // Launch feedback: a 409 duplicate-scope / 429 at-capacity refusal is the
  // server working as designed and surfaces as an INFO note; only a real
  // failure gets the rose error styling (lib/runDock launchNoteFor).
  const [runNote, setRunNote] = useState<RunNote | null>(null);

  // Stable append callback shared by every launch surface (Discovery,
  // ChatCapture, runRoutine below) - never overwrites.
  const trackRun = useCallback((run: { runId: string; label: string }) => {
    setRuns((prev) => addRun(prev, run));
  }, []);

  // The deep-link primitive (t-1783255872307, re-targeted for SIM-59): "open
  // the entity's page" from any surface that renders related-entity chips
  // (RunPanel, ChatCapture). The in-app hub is retired, so this now opens the
  // standalone SSC Product Hub in its shared named window (lib/sscHub maps
  // EntityRef -> #/tasks/<id> | #/projects/<id>). The current job-hunt view is
  // left alone - the hub is its own surface, not a view of this app.
  const openEntity = useCallback((entity: EntityRef) => {
    openSscHub(entity);
  }, []);

  // The bell's "Review decisions" (Decisions surface v2): same handoff, fixed
  // page key - the SSC hub's Decisions page.
  const openDecisions = useCallback(() => {
    openSscHub("decisions");
  }, []);

  const [activeBatch, setActiveBatch] = useState<{
    batchId: string;
    label: string;
    verb: "Draft" | "Finalize" | "Discover";
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    jobId: string;
    role: string;
    employer: string;
    from: Status;
    to: Status;
  } | null>(null);
  // Transient toast for instant (non-confirmed) moves so they can be reverted.
  const [undo, setUndo] = useState<{ jobId: string; role: string; from: Status; to: Status } | null>(null);
  // '?' keyboard cheat-sheet overlay.
  const [shortcutHelp, setShortcutHelp] = useState(false);

  // Demo chrome (RC-4 / SIM-88): ALL of it renders only when the server says
  // appMode:"demo" (/api/config) - real mode is byte-identical to pre-demo.
  const demoMode = config?.appMode === "demo";
  // Bumped by the banner's "Replay tour"; DemoTour restarts at beat 1 on every
  // bump (U1: the guidance is re-launchable all session, even after dismissal).
  const [tourReplays, setTourReplays] = useState(0);
  // Beat 1 anchors the kanban board, so starting the tour forces the Jobs page
  // into board view first (a no-op on the cold-open default).
  const ensureBoardForTour = useCallback(() => {
    clearRoute();
    setView("jobs");
    setJobsViewState("board");
  }, []);
  const replayTour = useCallback(() => {
    ensureBoardForTour();
    setTourReplays((n) => n + 1);
  }, [ensureBoardForTour]);

  // QA BUG-3: the Product tab is hidden in demo mode (TopBar), but the view can
  // still be reached sideways - the `p` shortcut (inerted below), a `#/tasks`
  // deep link, ChatCapture's "view tasks". Whatever the path, a demo visitor
  // landing on "product" bounces straight back to Jobs, so the localhost-only
  // Product-Hub handoff panel can never render on the public demo.
  useEffect(() => {
    if (demoMode && view === "product") switchView("jobs");
  }, [demoMode, view, switchView]);

  // App-auth session (SIM-391). authRequired comes from the LoginGate's status
  // probe (lib/authSession) - true only on the walled private instance, so the
  // Log out affordance never appears on the laptop or the demo. Logging out
  // clears the cookie server-side, then flips the store: LoginGate unmounts
  // this whole component (all data hooks torn down) and shows the gate. The
  // flip happens even if the request failed - the gate re-probes on mount, so
  // an already-dead session still lands somewhere honest.
  const authStatus = useAuthStatus();
  const logout = useCallback(() => {
    api.logout()
      .catch(() => {})
      .finally(() => setAuthStatus({ authRequired: true, authenticated: false }));
  }, []);

  async function runRoutine(routine: string, jobId?: string) {
    setRunNote(null);
    try {
      const r = await api.runRoutine(routine, jobId);
      trackRun({ runId: r.runId, label: r.label });
    } catch (e) {
      setRunNote(launchNoteFor(e instanceof Error ? e.message : String(e)));
    }
  }

  // Queued jobs that still need a first draft.
  const queuedDraft = useMemo(() => jobs.filter((j) => j.status === "queued" && !j.hasCV), [jobs]);
  // Drafted jobs whose gaps note has been answered - ready to finalize. The
  // finalizeReady flag is DERIVED server-side (one rule), so the client never
  // re-implements the readiness test; it just counts.
  const finalizeReadyJobs = useMemo(() => jobs.filter((j) => j.finalizeReady), [jobs]);

  // `jobIds` lets a caller scope the fan-out to a specific subset (the
  // NeedsAttentionStrip's "Draft now" CTA, t-1783183576640) instead of every
  // queued-no-CV job; omitted, it falls back to the full queuedDraft set
  // (TopBar's "Draft queued").
  async function batchDraft(jobIds?: string[]) {
    const targets = jobIds ?? queuedDraft.map((j) => j.id);
    if (!targets.length) {
      setRunNote({ kind: "info", text: "No queued jobs without a draft to batch." });
      return;
    }
    setRunNote(null);
    try {
      const b = await api.batchRun("first-draft-job", targets);
      setActiveBatch({ batchId: b.batchId, label: `Draft x${b.total}`, verb: "Draft" });
    } catch (e) {
      setRunNote(launchNoteFor(e instanceof Error ? e.message : String(e)));
    }
  }

  // Fan out finalize-job over the finalize-ready set (mirrors batchDraft). The
  // server re-checks finalizeReady per job (defense in depth) and NEVER submits.
  async function batchFinalize() {
    if (!finalizeReadyJobs.length) {
      setRunNote({ kind: "info", text: "No jobs are ready to finalize yet." });
      return;
    }
    setRunNote(null);
    try {
      const b = await api.batchRun("finalize-job", finalizeReadyJobs.map((j) => j.id));
      setActiveBatch({ batchId: b.batchId, label: `Finalize x${b.total}`, verb: "Finalize" });
    } catch (e) {
      setRunNote(launchNoteFor(e instanceof Error ? e.message : String(e)));
    }
  }

  // How many sources a "Discover due" click would fan out over - the N on the
  // TopBar button and due-chip. Derived by the same pure rule the server's
  // run-all-due target selection uses (see countDueSources).
  const dueSourceCount = useMemo(
    () => countDueSources(discoverySources.data?.sources ?? []),
    [discoverySources.data],
  );

  // Fan out discovery over every due source (the global discover-jobs sweep is
  // retired - per-source runs are the one honest path, stamping each source's
  // health at launch). Surfaces in the BatchPanel like the other fan-outs.
  async function discoverAllDue() {
    setRunNote(null);
    try {
      const b = await api.runAllDue();
      if (!b.batchId) {
        setRunNote({ kind: "info", text: "No sources are due right now." });
        // The count that invited the click was stale - resync it.
        discoverySources.reload(true);
        return;
      }
      setActiveBatch({ batchId: b.batchId, label: `Discover x${b.total}`, verb: "Discover" });
      // Each launch stamped its source's lastRunAt server-side, so the due
      // count just dropped - refresh the registry now rather than waiting for
      // the first source-run-finished event.
      discoverySources.reload(true);
    } catch (e) {
      setRunNote(launchNoteFor(e instanceof Error ? e.message : String(e)));
    }
  }

  useEffect(() => {
    // The config answer also resolves the SSE capability gate (SIM-390 item 3):
    // the shared EventSource stays DEFERRED until the server states whether
    // /api/stream exists on this instance (`sse: false` on the pg-backed cloud,
    // where the request would only 503 and burn a reconnect loop). An older
    // server that omits the field, or a failed config fetch, fails OPEN to the
    // historical connect-immediately behavior.
    api
      .getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setStreamAvailability(cfg.sse !== false);
      })
      .catch(() => setStreamAvailability(true));
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (shortcutHelp) setShortcutHelp(false);
        else if (pendingMove) setPendingMove(null);
        else if (adding) setAdding(false);
        else if (selectedJob) closeJob();
        else if (undo) setUndo(null);
        else if (runNote) setRunNote(null);
        // Non-destructive: Esc MINIMIZES the newest expanded run panel to the
        // dock (one per press) instead of dropping its tracking - the run
        // keeps polling as a chip.
        else if (runs.some((r) => !r.minimized)) setRuns((prev) => minimizeNewestExpanded(prev));
        else if (activeBatch) setActiveBatch(null);
        return;
      }
      // Shared guard (lib/shortcuts): no-op while typing in a field, on a
      // Ctrl/Cmd/Alt chord (Ctrl+P must print, not navigate), or while any
      // role=dialog aria-modal overlay is open - d/i/p used to switch the view
      // BEHIND an open StatusChangeModal (t-1783163892019).
      if (shortcutBlockReason(e)) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutHelp(true);
      } else if (e.key === "n") {
        e.preventDefault();
        setAdding(true);
      } else if (e.key === "b") {
        // b/t land on the ONE Jobs page in the named view (and persist it).
        // All five view keys go through switchView, which also strips a live
        // tasks deep-link hash (p included - it targets the hub's last tab).
        switchView("jobs");
        setJobsView("board");
      } else if (e.key === "t") {
        switchView("jobs");
        setJobsView("table");
      } else if (e.key === "p") {
        // Inert on the public demo (QA BUG-3) - the Product tab is hidden
        // there, so its shortcut must not open the view either.
        if (!demoMode) switchView("product");
      } else if (e.key === "d") {
        switchView("discovery");
      } else if (e.key === "i") {
        switchView("insights");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [adding, selectedJob, closeJob, pendingMove, undo, runNote, runs, activeBatch, shortcutHelp, switchView, demoMode]);

  // Auto-dismiss the undo toast after a few seconds.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Preset narrows FIRST (the coarse quick-view layer), then the existing
    // track filter + text query narrow inside it. Board and table both receive
    // this shared set; the table's advanced JobFilterBar narrows it further still.
    return filterByPreset(jobsPreset, jobs).filter((j) => {
      if (trackFilter && j.track !== trackFilter) return false;
      if (!q) return true;
      return (
        j.role.toLowerCase().includes(q) ||
        j.employer.toLowerCase().includes(q) ||
        j.trackLabel.toLowerCase().includes(q)
      );
    });
  }, [jobs, query, trackFilter, jobsPreset]);

  const weeklyApplied = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    return jobs.filter((j) => j.applied && new Date(j.applied + "T00:00:00") >= cutoff).length;
  }, [jobs]);

  // High-stakes moves (submit/reject/close) open the confirm popup; everything
  // else applies instantly and offers an Undo.
  function requestMove(id: string, to: Status) {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status === to) return;
    if (CONFIRM_STATUSES.includes(to)) {
      setPendingMove({ jobId: id, role: job.role, employer: job.employer, from: job.status, to });
    } else {
      move(id, to);
      setUndo({ jobId: id, role: job.role, from: job.status, to });
    }
  }

  async function move(id: string, status: Status) {
    patchLocal(id, { status }); // optimistic
    try {
      await api.updateJob(id, { status });
    } catch {
      reload(); // revert to truth on failure
    }
  }

  function undoMove() {
    if (!undo) return;
    move(undo.jobId, undo.from);
    setUndo(null);
  }

  function confirmMove() {
    if (pendingMove) move(pendingMove.jobId, pendingMove.to);
    setPendingMove(null);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Per-surface boundary (t-1783145481687): TopBar + bell mount outside
          <main>'s boundary, so they get their own - a bell crash degrades to
          a slim strip, never a white screen. */}
      <ErrorBoundary fallback={TOP_BAR_FALLBACK}>
        <TopBar
          view={view}
          setView={switchView}
          jobsView={jobsView}
          setJobsView={setJobsView}
          query={query}
          setQuery={setQuery}
          trackFilter={trackFilter}
          setTrackFilter={setTrackFilter}
          tracks={config?.tracks || {}}
          jobs={jobs}
          weeklyApplied={weeklyApplied}
          weeklyTarget={config?.weeklyTarget || 5}
          onAdd={() => setAdding(true)}
          onRunDiscovery={discoverAllDue}
          dueSourceCount={dueSourceCount}
          onBatchDraft={batchDraft}
          batchDraftCount={queuedDraft.length}
          onBatchFinalize={batchFinalize}
          batchFinalizeCount={finalizeReadyJobs.length}
          parkedCount={tasksState.parkedCount}
          onReviewDecisions={openDecisions}
          demoMode={demoMode}
          authRequired={!!authStatus?.authRequired}
          onLogout={logout}
        />
      </ErrorBoundary>

      {/* Demo chrome (RC-4 / SIM-88): the honest banner rides under the TopBar
          on EVERY view (AC2) and carries the CTA + "Replay tour" so both stay
          reachable from anywhere (AC7). Demo mode only - never in real mode. */}
      {demoMode && <DemoBanner onReplayTour={replayTour} />}

      <main className="min-h-0 flex-1 pt-4">
        <ErrorBoundary>
          {loading ? (
            <div className="flex h-full items-center justify-center text-[var(--color-muted)]">Loading jobs...</div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <div className="text-rose-400">Could not reach the file bridge.</div>
              <div className="max-w-md text-[13px] text-[var(--color-muted)]">{error}</div>
              <div className="text-[12px] text-[var(--color-muted)]">
                Is the server running? Start everything with <code className="text-[var(--color-accent-text)]">npm run dev</code>.
              </div>
            </div>
          ) : view === "product" ? (
            <ProductMoved />
          ) : view === "discovery" ? (
            <DiscoveryView
              sources={discoverySources}
              onRunStarted={trackRun}
              onPursued={(id) => {
                reload();
                openJob(id);
              }}
            />
          ) : view === "insights" ? (
            <InsightsView jobs={jobs} weeklyTarget={config?.weeklyTarget || 5} />
          ) : (
            // Board and Table are the two Jobs sub-views (TopBar's segmented
            // control) - the strip lives ABOVE the switch so both share it
            // (audit F12: it used to render only in the board branch).
            <div className="flex h-full flex-col">
              <NeedsAttentionStrip jobs={jobs} onOpen={openJob} onDraftNow={batchDraft} />
              {/* Preset quick-view tabs (ENG-M3-T1): below the strip, above the
                  board/table switch, so both sub-views share the one narrowing. */}
              <JobPresets jobs={jobs} value={jobsPreset} onChange={selectJobsPreset} />
              <div className="min-h-0 flex-1">
                {jobsView === "board" ? (
                  <KanbanBoard jobs={filtered} onOpen={openJob} onMove={requestMove} />
                ) : (
                  <JobTable jobs={filtered} onOpen={openJob} onMove={requestMove} />
                )}
              </div>
            </div>
          )}
        </ErrorBoundary>
      </main>

      {selectedJob && (
        <JobDetailDrawer
          jobId={selectedJob}
          config={config}
          onClose={closeJob}
          onChanged={reload}
          onRun={runRoutine}
        />
      )}
      {/* Expanded run panels: one per non-minimized tracked run, stacked
          bottom-right in launch order (they can no longer overlap-hide each
          other). The stack lifts to clear the dock when chips are showing, and
          scrolls if many panels are open at once. */}
      {expandedRuns(runs).length > 0 && (
        <div
          data-demo-anchor="run-panel"
          className={`fixed right-4 z-[70] flex max-h-[calc(100vh-5rem)] w-[min(560px,92vw)] flex-col justify-end gap-3 overflow-y-auto ${
            minimizedRuns(runs).length > 0 ? "bottom-16" : "bottom-4"
          }`}
        >
          {expandedRuns(runs).map((r) => (
            <RunPanel
              key={r.runId}
              runId={r.runId}
              label={r.label}
              onMinimize={() => setRuns((prev) => minimizeRun(prev, r.runId))}
              onClose={() => setRuns((prev) => dismissRun(prev, r.runId))}
              onFinished={reload}
              onOpenEntity={openEntity}
            />
          ))}
        </div>
      )}
      {/* The bottom run dock: minimized runs as live chips (t-1783119823228).
          Ambient chrome - NOT aria-modal, so global shortcuts keep working. */}
      <RunDock
        runs={minimizedRuns(runs)}
        onRestore={(id) => setRuns((prev) => restoreRun(prev, id))}
        onDismiss={(id) => setRuns((prev) => dismissRun(prev, id))}
        onFinished={reload}
      />
      {activeBatch && (
        <BatchPanel
          batchId={activeBatch.batchId}
          label={activeBatch.label}
          verb={activeBatch.verb}
          onClose={() => setActiveBatch(null)}
          onProgress={reload}
        />
      )}
      {/* Launch feedback. kind:"info" = the server declined by design (409
          duplicate-scope, 429 at-capacity, nothing-to-do) - neutral styling,
          honest text. kind:"error" = a real failure - the rose error toast. */}
      {runNote && (
        <div
          role="status"
          className={`fixed bottom-4 right-4 z-[70] max-w-[min(24rem,calc(100vw-2rem))] rounded-lg border bg-[var(--color-panel)] p-3 text-[12px] shadow-2xl ${
            runNote.kind === "error"
              ? "border-rose-500/40 text-rose-300"
              : "border-[var(--color-edge)] text-[var(--color-text)]"
          }`}
          onClick={() => setRunNote(null)}
        >
          {runNote.text}
        </div>
      )}
      {undo && (
        <UndoToast onUndo={undoMove}>
          Moved <span className="font-semibold">{undo.role}</span> to {STATUS_LABEL[undo.to]}
        </UndoToast>
      )}
      {pendingMove && (
        <StatusChangeModal
          role={pendingMove.role}
          employer={pendingMove.employer}
          from={pendingMove.from}
          to={pendingMove.to}
          onConfirm={confirmMove}
          onCancel={() => setPendingMove(null)}
        />
      )}
      {shortcutHelp && <ShortcutHelp onClose={() => setShortcutHelp(false)} />}
      {adding && (
        <AddJobModal
          config={config}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            reload();
            openJob(id);
          }}
        />
      )}

      {/* Global chat-capture surface (docs/chatbot-scoping.md v1): reachable
          from any view. Reuses the SAME run-tracking (trackRun -> the shared
          panel stack + dock above) as every other routine trigger in the app -
          each launch appends, never overwrites. */}
      {/* onViewTasks goes through switchView so a stale #/tasks/<id> route is
          stripped - it lands on the Product tab's handoff panel, not a
          leftover detail URL. */}
      {/* Its own boundary (t-1783145481687): the FAB/panel also mount outside
          <main>. On a crash the surface just disappears (fallback null, still
          logged) - the rest of the app stays fully usable. */}
      <ErrorBoundary fallback={null}>
        <ChatCapture onRunStarted={trackRun} onViewTasks={() => switchView("product")} onOpenEntity={openEntity} />
      </ErrorBoundary>

      {/* The demo's guided tour (RC-4 / SIM-88): first-run choice + 3 spotlight
          beats + close panel, all non-blocking ambient chrome anchored to the
          live board/drawer. Its own null-fallback boundary (the ChatCapture
          posture): a tour crash silently removes the tour, never the demo. */}
      {demoMode && (
        <ErrorBoundary fallback={null}>
          <DemoTour
            jobs={jobs}
            selectedJob={selectedJob}
            replaySignal={tourReplays}
            runPanelOpen={expandedRuns(runs).length > 0}
            onEnsureBoard={ensureBoardForTour}
            onCloseDrawer={closeJob}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
