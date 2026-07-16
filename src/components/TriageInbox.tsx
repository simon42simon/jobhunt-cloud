import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Discovery, DerivedSource, DiscoveryData, DiscoveryDecision } from "../types";
import { DeadlinePill, FitBadge, SectorBadge, TrackBadge } from "./Badges";
import { SegmentedControl } from "./SegmentedControl";
import { LeadGapWarning } from "./sourcesShared";
import { UndoToast } from "./UndoToast";
import { TRACK_LABEL } from "../lib/constants";
import { fmtDate } from "../lib/utils";
import { shortcutBlockReason } from "../lib/shortcuts";
import { buildAliasIndex, findKey, isRealUrl, leadContractGaps, resolveFindSourceId } from "../lib/sources";
import { pursueFind } from "../lib/pursue";
import { track } from "../lib/telemetry";

// How a triage decision was made - the signal that measures whether the
// keyboard-first flow (J/K/S/M/P) actually pays vs the on-screen buttons.
type TriageVia = "key" | "button";

// The decisions a row action can MAKE. "clear" is excluded: it is only ever
// sent by undoDecision (reverting to undecided), never chosen directly - and
// unlike the others it is not a valid optimistic override value.
type ActiveDecision = Exclude<DiscoveryDecision, "clear">;

// ---------------------------------------------------------------------------
// Triage inbox (Discovery Sources v1, view B): a three-pane master-detail over
// the finds a source produces - saved-views rail | finds list | detail - with
// keyboard-first triage (J/K move, S/M/P decide + auto-advance), undo-not-
// confirm on Skip/Maybe, bulk-select with a pinned action bar, and clickable
// provenance that filters the list to one source (bidirectional with the
// Sources console). Collapses to single-pane list-then-detail below lg.
// ---------------------------------------------------------------------------

// The effective (stored/optimistic) state of a find (undecided shows as "").
// Exported (with the triage helpers below) for the node-env unit tests - the
// same posture as pursueLabel.
export type EffDecision = "" | "skip" | "maybe" | "pursue";
export type SavedView = "new" | "maybe" | "pursued" | "all" | "hidden";

// Each saved view carries a one-line `hint` explaining what it contains - the
// single source of truth for the chip tooltip AND the in-place explainer strip.
// "Hidden" in particular was opaque (t-1783422377158: "what is Hidden status?"):
// it is the finds already pursued into tracked jobs, kept OUT of the New queue so
// a lead already in the pipeline is never re-triaged (matchesView "hidden" =
// find.tracked). Naming it in place beats a bare label.
export const SAVED_VIEWS: { id: SavedView; label: string; hint: string }[] = [
  { id: "new", label: "New", hint: "Fresh finds you have not triaged yet." },
  { id: "maybe", label: "Maybe", hint: "Finds you flagged to revisit before deciding." },
  { id: "pursued", label: "Pursued", hint: "Finds you pursued - now tracked as a job in the pipeline." },
  { id: "all", label: "All", hint: "Every find from this source, whatever its triage state." },
  {
    id: "hidden",
    label: "Hidden",
    hint: "Finds already pursued into tracked jobs. They are kept out of the New queue so you never re-triage a lead that is already in your pipeline.",
  },
];

const SAVED_VIEW_KEY = "jobhunt.discovery.savedView";

function loadSavedView(): SavedView {
  try {
    const v = window.localStorage.getItem(SAVED_VIEW_KEY);
    if (v && SAVED_VIEWS.some((x) => x.id === v)) return v as SavedView;
  } catch {
    /* storage unavailable */
  }
  return "new";
}

// User-controllable list order (t-1783163892053 #4). "newest" is the v1
// behavior and stays the default; the choice persists like the saved view.
export type FindsSort = "newest" | "fit" | "deadline";
export const FIND_SORTS: { id: FindsSort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "fit", label: "Fit" },
  { id: "deadline", label: "Deadline" },
];

const FINDS_SORT_KEY = "jobhunt.discovery.findsSort";

function loadFindsSort(): FindsSort {
  try {
    const v = window.localStorage.getItem(FINDS_SORT_KEY);
    if (v && FIND_SORTS.some((x) => x.id === v)) return v as FindsSort;
  } catch {
    /* storage unavailable */
  }
  return "newest";
}

function normDecision(raw: string | undefined): EffDecision {
  const d = (raw || "").trim().toLowerCase();
  if (d === "skip" || d === "maybe" || d === "pursue") return d;
  return "";
}

// A find's effective decision = the optimistic override if present, else the
// stored Decision cell.
export function effDecision(find: Discovery, overrides: Record<string, EffDecision>): EffDecision {
  const k = findKey(find);
  return k in overrides ? overrides[k] : normDecision(find.Decision);
}

export function matchesView(find: Discovery, view: SavedView, eff: EffDecision): boolean {
  switch (view) {
    case "new":
      return !find.tracked && eff === "";
    case "maybe":
      return eff === "maybe";
    case "pursued":
      return eff === "pursue" || find.tracked;
    case "hidden":
      return find.tracked;
    case "all":
    default:
      return true;
  }
}

function foundTime(find: Discovery): number {
  const t = Date.parse(find["Date Found"] || "");
  return Number.isFinite(t) ? t : 0;
}

// Fit ranks for the "Fit" sort: strong first, unknown/blank values last (the
// same closed vocabulary FitBadge renders; matched tolerantly like everywhere
// else fit is read).
const FIT_RANK: Record<string, number> = { strong: 0, moderate: 1, stretch: 2 };
function fitRank(fit: string): number {
  const r = FIT_RANK[(fit || "").trim().toLowerCase()];
  return r === undefined ? 3 : r;
}

// Deadline sort key: a REAL YYYY-MM-DD date sorts soonest-first; free-text
// ("rolling", "1-yr contract") and blank deadlines sink to the end - they are
// accepted-but-low-confidence (data-schema §5), never comparable dates.
function deadlineKey(deadline: string): string {
  const d = (deadline || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "9999-99-99";
}

// The one list ordering (t-1783163892053 #4), exported for tests. Every sort
// tie-breaks by newest-then-title so the order stays total and stable.
export function sortFinds(finds: Discovery[], sort: FindsSort): Discovery[] {
  const arr = [...finds];
  const newest = (a: Discovery, b: Discovery) =>
    foundTime(b) - foundTime(a) || a.Title.localeCompare(b.Title);
  if (sort === "fit") arr.sort((a, b) => fitRank(a.Fit) - fitRank(b.Fit) || newest(a, b));
  else if (sort === "deadline")
    arr.sort((a, b) => deadlineKey(a.Deadline).localeCompare(deadlineKey(b.Deadline)) || newest(a, b));
  else arr.sort(newest);
  return arr;
}

// Facet filters (#4): fit matches its closed vocabulary case-insensitively;
// track matches the raw Track key exactly. "" = facet off. Applied to the
// SHARED scoped array (with the source filter), so the rail badges keep the
// t-1783255697392 contract: a badge always equals what its view will show.
export function filterFindsByFacets(
  finds: Discovery[],
  facets: { fit?: string; track?: string },
): Discovery[] {
  const fit = (facets.fit || "").trim().toLowerCase();
  const track = (facets.track || "").trim();
  if (!fit && !track) return finds;
  return finds.filter((f) => {
    if (fit && (f.Fit || "").trim().toLowerCase() !== fit) return false;
    if (track && (f.Track || "").trim() !== track) return false;
    return true;
  });
}

// Refresh-button busy wrapper (#3), exported for tests: normalizes a void-or-
// promise reload and guarantees the busy flag clears even when the reload
// rejects (reloadDiscovery reports errors through its own err state, but this
// wrapper must never strand a disabled button either way).
export async function refreshWithBusy(
  reload: () => void | Promise<void>,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  setBusy(true);
  try {
    await reload();
  } finally {
    setBusy(false);
  }
}

// The ONE source-scoping the rail counts AND the visible list both derive from
// (t-1783255697392). Before this, the counts memo ran over ALL finds while the
// list applied the source chip, so with a filter active every rail badge
// promised finds the list would not show. When no filter is set this returns
// the input array untouched.
export function scopeFindsToSource(
  finds: Discovery[],
  sourceFilter: string | null,
  aliasIdx: Map<string, string>,
): Discovery[] {
  if (!sourceFilter) return finds;
  return finds.filter((f) => resolveFindSourceId(f, aliasIdx) === sourceFilter);
}

// Saved-view rail badge counts over an (already source-scoped) finds array.
// Pure so the unit test can prove each badge equals the length of the list
// that view would render (tests/triage-counts.test.ts).
export function triageCounts(
  scoped: Discovery[],
  overrides: Record<string, EffDecision>,
): Record<SavedView, number> {
  const c: Record<SavedView, number> = { new: 0, maybe: 0, pursued: 0, all: scoped.length, hidden: 0 };
  for (const f of scoped) {
    const eff = effDecision(f, overrides);
    if (f.tracked) c.hidden++;
    if (!f.tracked && eff === "") c.new++;
    if (eff === "maybe") c.maybe++;
    if (eff === "pursue" || f.tracked) c.pursued++;
  }
  return c;
}

// Pursue = queue + draft (t-1783655444456): every pursued find lands straight in
// Queued AND kicks off its first agent action (first-draft-job) - the shared
// pursueFind() in lib/pursue owns that behavior. This retired the old strong-fit-
// only fast path (ops audit F5): the owner was re-deciding leads into queued by
// hand anyway, so Pursue now always starts the application. The button copy
// discloses the draft the click launches rather than a per-fit status split.
export function pursueLabel(): string {
  return "Pursue → Draft";
}

function pursueTitle(): string {
  return "Queues the job and starts the CV + cover letter draft";
}

// aria-label variant of pursueLabel: same disclosure, without the "→" glyph
// (some screen readers announce it as "right arrow", which is noise ahead of
// the job title read right after it).
function pursueAriaLabel(title: string): string {
  return `Pursue ${title}: queue and start the draft`;
}

// Secondary row actions behind one compact "⋯" control (t-1783163892053 #2):
// Pursue stays the row's single primary action; Skip / Maybe (recoverable,
// undo-backed) move into this overflow so an untracked row carries two
// controls instead of three. The detail pane keeps the full-size buttons and
// the S / M keys still work - this trims row density, not capability.
// Click-outside and Esc both close; Esc stops propagation so it never bubbles
// into a parent dialog's close handler.
function RowActionMenu({
  title,
  disabled,
  onSkip,
  onMaybe,
}: {
  title: string;
  disabled: boolean;
  onSkip: () => void;
  onMaybe: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const itemCls =
    "block w-full min-h-[44px] px-3 py-2 text-left text-[12px] hover:bg-[var(--color-panel-2)] sm:min-h-[36px]";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${title}`}
        title="Skip / Maybe"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="min-h-[44px] min-w-[44px] rounded-md border border-[var(--color-edge)] px-2 py-1 text-[13px] leading-none text-[var(--color-muted)] hover:border-[var(--color-text)]/30 hover:text-[var(--color-text)] disabled:opacity-50 sm:min-h-[30px] sm:min-w-[30px]"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${title}`}
          className="absolute left-0 top-full z-10 mt-1 w-36 overflow-hidden rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSkip();
            }}
            className={`${itemCls} text-[var(--color-muted)] hover:text-[var(--color-text)]`}
          >
            Skip
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onMaybe();
            }}
            className={`${itemCls} text-amber-400`}
          >
            Maybe
          </button>
        </div>
      )}
    </div>
  );
}

// A small decision chip (used in list rows + the detail pane).
function DecisionChip({ decision }: { decision: EffDecision }) {
  if (decision === "skip")
    return (
      <span className="rounded bg-[var(--color-panel)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">skipped</span>
    );
  if (decision === "maybe")
    return <span className="rounded bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">maybe</span>;
  if (decision === "pursue")
    return (
      <span className="rounded bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">pursued</span>
    );
  return null;
}

export function TriageInbox({
  data,
  loading,
  err,
  reload,
  sources,
  sourceFilter,
  setSourceFilter,
  onPursued,
  onRunStarted,
}: {
  // The discovery workbook is owned by DiscoveryView and shared with the source
  // Leads tabs (UX F3) - this inbox no longer pulls it itself; it renders the
  // shared copy and refreshes through `reload`. The promise (reloadDiscovery is
  // async) feeds the Refresh button's busy state (#3).
  data: DiscoveryData | null;
  loading: boolean;
  err: string | null;
  reload: () => void | Promise<void>;
  sources: DerivedSource[];
  sourceFilter: string | null;
  setSourceFilter: (id: string | null) => void;
  onPursued: (jobId: string) => void;
  // Registers a run in App's dock, same contract as SourcesConsole - used by
  // the empty-state Run affordance (#5) when a single source is filtered.
  onRunStarted: (run: { runId: string; label: string }) => void;
}) {
  const [view, setView] = useState<SavedView>(loadSavedView);
  const [overrides, setOverrides] = useState<Record<string, EffDecision>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ key: string; prior: EffDecision; title: string } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  // Sort + facet filters (#4): sort persists like the saved view; facets are
  // per-visit. Refresh/run busy state (#3 / #5).
  const [sort, setSort] = useState<FindsSort>(loadFindsSort);
  const [fitFilter, setFitFilter] = useState("");
  const [trackFilter, setTrackFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  const finds = useMemo(() => data?.discoveries ?? [], [data]);
  const aliasIdx = useMemo(() => buildAliasIndex(sources), [sources]);
  const sourcesById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  function persistView(v: SavedView) {
    track("action", "discovery-finds", "saved-view", { journey: "J4", meta: { view: v } });
    setView(v);
    try {
      window.localStorage.setItem(SAVED_VIEW_KEY, v);
    } catch {
      /* best-effort */
    }
  }

  function persistSort(s: FindsSort) {
    track("action", "discovery-finds", "sort", { journey: "J4", meta: { sort: s } });
    setSort(s);
    try {
      window.localStorage.setItem(FINDS_SORT_KEY, s);
    } catch {
      /* best-effort */
    }
  }

  // The shared source-scoped finds array (t-1783255697392): counts and the
  // visible list BOTH derive from this one memo (sourceFilter + aliasIdx are
  // in its deps), so a rail badge can never disagree with the list it opens.
  // The fit/track facets (#4) fold in HERE for the same reason - a badge under
  // an active facet still equals what clicking that view shows.
  const scopedFinds = useMemo(
    () =>
      filterFindsByFacets(scopeFindsToSource(finds, sourceFilter, aliasIdx), {
        fit: fitFilter,
        track: trackFilter,
      }),
    [finds, sourceFilter, aliasIdx, fitFilter, trackFilter],
  );

  const counts = useMemo(() => triageCounts(scopedFinds, overrides), [scopedFinds, overrides]);

  const filtered = useMemo(() => {
    const arr = scopedFinds.filter((f) => matchesView(f, view, effDecision(f, overrides)));
    return sortFinds(arr, sort);
  }, [scopedFinds, view, overrides, sort]);

  // Track facet options: every track present in the workbook (unfiltered, so
  // picking one never removes the others), labeled like the badges.
  const trackOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const f of finds) {
      const t = (f.Track || "").trim();
      if (t) seen.add(t);
    }
    return [...seen].sort((a, b) => (TRACK_LABEL[a] || a).localeCompare(TRACK_LABEL[b] || b));
  }, [finds]);

  // Selection always resolves to a find in the current list (guards a stale key
  // after a filter change), mirroring ProjectsView's effectiveId.
  const effectiveKey =
    selectedKey && filtered.some((f) => findKey(f) === selectedKey)
      ? selectedKey
      : filtered[0]
        ? findKey(filtered[0])
        : null;
  const selectedFind = filtered.find((f) => findKey(f) === effectiveKey) ?? null;

  const nextKeyAfter = useCallback(
    (key: string): string | null => {
      const i = filtered.findIndex((f) => findKey(f) === key);
      if (i === -1) return filtered[0] ? findKey(filtered[0]) : null;
      const next = filtered[i + 1] ?? filtered[i - 1] ?? null;
      return next ? findKey(next) : null;
    },
    [filtered],
  );

  // --- decisions -----------------------------------------------------------
  const applyDecision = useCallback(
    async (find: Discovery, decision: ActiveDecision, advance: boolean, via: TriageVia) => {
      const key = findKey(find);
      // Triage decision event (J4): the decision + how it was made. Ids only,
      // never the find's title/employer/link.
      track("action", "discovery-finds", "triage", { journey: "J4", meta: { decision, via } });
      const prior = effDecision(find, overrides);
      setOverrides((o) => ({ ...o, [key]: decision }));
      setRowMsg((m) => ({ ...m, [key]: "" }));
      if (advance) setSelectedKey(nextKeyAfter(key));
      // Undo-not-confirm for Skip/Maybe (never for pursue - that path creates a job).
      if (decision === "skip" || decision === "maybe") setUndo({ key, prior, title: find.Title });
      setBusyKey(key);
      try {
        const res = await api.decideDiscovery(find.Title, find.Link, decision);
        if (!res.ok) {
          const msg =
            res.message || (res.locked ? "Workbook is open in Excel - close it and retry." : "Could not save decision.");
          setRowMsg((m) => ({ ...m, [key]: msg }));
          setOverrides((o) => ({ ...o, [key]: prior })); // revert optimistic
          setUndo((u) => (u && u.key === key ? null : u));
        }
      } catch (e) {
        setRowMsg((m) => ({ ...m, [key]: String((e as Error).message || e) }));
        setOverrides((o) => ({ ...o, [key]: prior }));
        setUndo((u) => (u && u.key === key ? null : u));
      } finally {
        setBusyKey((b) => (b === key ? null : b));
      }
    },
    [overrides, nextKeyAfter],
  );

  const pursue = useCallback(
    async (find: Discovery, advance: boolean, via: TriageVia) => {
      const key = findKey(find);
      // Pursue event (J4): creates a tracked, queued job AND starts its first
      // draft (pursueFind). Records only how it was triggered, no posting content.
      track("action", "discovery-finds", "pursue", { journey: "J4", meta: { via } });
      setBusyKey(key);
      setRowMsg((m) => ({ ...m, [key]: "" }));
      try {
        const job = await pursueFind(find, onRunStarted);
        setOverrides((o) => ({ ...o, [key]: "pursue" }));
        if (advance) setSelectedKey(nextKeyAfter(key));
        onPursued(job.id);
      } catch (e) {
        setRowMsg((m) => ({ ...m, [key]: String((e as Error).message || e) }));
      } finally {
        setBusyKey((b) => (b === key ? null : b));
      }
    },
    [nextKeyAfter, onPursued, onRunStarted],
  );

  function undoDecision() {
    if (!undo) return;
    const { key, prior } = undo;
    const find = finds.find((f) => findKey(f) === key);
    setOverrides((o) => ({ ...o, [key]: prior }));
    setSelectedKey(key);
    setUndo(null);
    // Persist the revert (t-1783178044080): a real prior decision is re-sent
    // as-is; a prior of undecided ("") is sent as the "clear" verb, which
    // BLANKS the Decision cell so the find is New again after a reload too.
    // Best-effort like the rest of the undo path - the optimistic override
    // already reverted the row, and a locked workbook degrades server-side.
    if (find) {
      api.decideDiscovery(find.Title, find.Link, prior === "" ? "clear" : prior).catch(() => {});
    }
  }

  // Auto-dismiss the undo toast (~6s), matching the app's Undo convention.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(t);
  }, [undo]);

  // --- keyboard triage (capture phase so it wins over App's global b/t/d/i/p/n;
  // p in particular would otherwise navigate to the Product page). Inert while
  // typing in a field, on a Ctrl/Cmd/Alt chord, or while any modal dialog
  // (e.g. the pursued-job drawer) is open - via the shared guard in
  // lib/shortcuts, the same one App's global handler consults.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shortcutBlockReason(e)) return;
      const k = e.key.toLowerCase();
      if (!["j", "k", "s", "m", "p", "arrowdown", "arrowup"].includes(k)) return;
      const list = filtered;
      if (list.length === 0) return;
      const curIdx = effectiveKey ? list.findIndex((f) => findKey(f) === effectiveKey) : -1;
      if (k === "j" || k === "arrowdown") {
        e.preventDefault();
        e.stopPropagation();
        const next = list[Math.min(list.length - 1, (curIdx < 0 ? -1 : curIdx) + 1)];
        if (next) setSelectedKey(findKey(next));
        return;
      }
      if (k === "k" || k === "arrowup") {
        e.preventDefault();
        e.stopPropagation();
        const prev = list[Math.max(0, (curIdx < 0 ? 0 : curIdx) - 1)];
        if (prev) setSelectedKey(findKey(prev));
        return;
      }
      // S / M / P act on the selected find + auto-advance.
      const find = curIdx >= 0 ? list[curIdx] : list[0];
      if (!find || find.tracked) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "s") applyDecision(find, "skip", true, "key");
      else if (k === "m") applyDecision(find, "maybe", true, "key");
      else if (k === "p") pursue(find, true, "key");
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, effectiveKey, applyDecision, pursue]);

  // --- bulk ----------------------------------------------------------------
  const checkedInView = useMemo(
    () => filtered.filter((f) => checked.has(findKey(f))),
    [filtered, checked],
  );
  const allChecked = filtered.length > 0 && checkedInView.length === filtered.length;

  function toggleCheck(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleCheckAll() {
    setChecked((prev) => {
      if (filtered.every((f) => prev.has(findKey(f)))) {
        const next = new Set(prev);
        for (const f of filtered) next.delete(findKey(f));
        return next;
      }
      const next = new Set(prev);
      for (const f of filtered) next.add(findKey(f));
      return next;
    });
  }
  function clearChecked() {
    setChecked(new Set());
    setBulkConfirm(false);
  }

  async function bulkDecide(decision: ActiveDecision) {
    const targets = filtered.filter((f) => checked.has(findKey(f)) && !f.tracked);
    // Bulk triage is a distinct decision path; record the decision + how many,
    // never the finds themselves.
    track("action", "discovery-finds", "triage-bulk", {
      journey: "J4",
      meta: { decision, via: "bulk", count: targets.length },
    });
    setOverrides((o) => {
      const n = { ...o };
      for (const f of targets) n[findKey(f)] = decision;
      return n;
    });
    clearChecked();
    for (const f of targets) {
      try {
        const res = await api.decideDiscovery(f.Title, f.Link, decision);
        if (!res.ok) setRowMsg((m) => ({ ...m, [findKey(f)]: res.message || "Could not save decision." }));
      } catch (e) {
        setRowMsg((m) => ({ ...m, [findKey(f)]: String((e as Error).message || e) }));
      }
    }
  }

  // --- provenance ----------------------------------------------------------
  function sourceChipFor(find: Discovery): { id: string | null; label: string } {
    const id = resolveFindSourceId(find, aliasIdx);
    if (id) return { id, label: sourcesById.get(id)?.name ?? id };
    const raw = (find.Source || "").trim();
    return { id: null, label: raw || "unassigned" };
  }

  const activeSourceName = sourceFilter ? sourcesById.get(sourceFilter)?.name ?? sourceFilter : null;

  // Empty-state Run affordance (t-1783163892053 #5): when the New view has
  // nothing to triage, offer discovery right here instead of routing back to
  // the Sources tab / TopBar. A filtered view runs THAT source (registered in
  // the dock via onRunStarted, exactly like SourcesConsole); unfiltered runs
  // every due source (the same fan-out as the TopBar's "Discover due" - the
  // queued batch surfaces per-source, so feedback here is the inline note and
  // the SSE-driven soft reload when each run finishes). 409/429/locked land as
  // a soft note, never a crash.
  async function runFromEmptyState() {
    setRunBusy(true);
    setRunNote(null);
    try {
      if (sourceFilter) {
        track("run", "discovery-finds", "run-source-empty-state", { journey: "J4" });
        const { runId } = await api.runSource(sourceFilter);
        onRunStarted({ runId, label: `Run: ${activeSourceName ?? sourceFilter}` });
        setRunNote("Run started - new finds land here when it finishes.");
      } else {
        track("run", "discovery-finds", "run-all-due-empty-state", { journey: "J4" });
        const b = await api.runAllDue();
        setRunNote(
          b.batchId
            ? `Started ${b.total} due source ${b.total === 1 ? "run" : "runs"} - new finds land here as they finish.`
            : "No sources are due right now - open Sources to run one manually.",
        );
      }
    } catch (e) {
      setRunNote(String((e as Error).message || e));
    } finally {
      setRunBusy(false);
    }
  }

  // Saved-view chips, rendered vertically in the lg rail and horizontally on
  // narrow screens. Plain render functions (not nested components) so the panes
  // never remount on a parent re-render.
  function viewChips(orientation: "row" | "col") {
    return (
      <div
        role="tablist"
        aria-label="Saved views"
        className={
          orientation === "col"
            ? "flex flex-col gap-1"
            : "flex items-center gap-1.5 overflow-x-auto pb-0.5"
        }
      >
        {SAVED_VIEWS.map((v) => {
          const on = view === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => persistView(v.id)}
              title={v.hint}
              className={`inline-flex min-h-[44px] shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1 text-[13px] font-medium transition sm:min-h-[36px] ${
                orientation === "col" ? "w-full" : ""
              } ${on ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"}`}
            >
              <span>{v.label}</span>
              <span
                className={`rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums ${
                  on ? "bg-white/20 text-white" : "bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                }`}
              >
                {counts[v.id]}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function sourceFilterChip() {
    if (!activeSourceName) return null;
    // Robust layout (t-1783422377158: "text overflow and cannot clear the
    // filter"): the chip FILLS its container (`flex w-full min-w-0`) and only the
    // NAME truncates (`min-w-0 flex-1 truncate`); the "source:" label and the
    // clear button are `shrink-0`, so the X can never be pushed off the 208px rail
    // by a long source name (the old `inline-flex` + fixed 140px name overflowed
    // the rail and clipped the clear button). Full name stays available on hover.
    return (
      <div className="flex w-full min-w-0 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 py-0.5 pl-2.5 pr-1 text-[12px] text-[var(--color-text)]">
        <span className="shrink-0 text-[var(--color-muted)]">source:</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={activeSourceName}>
          {activeSourceName}
        </span>
        <button
          type="button"
          onClick={() => setSourceFilter(null)}
          aria-label={`Clear source filter ${activeSourceName}`}
          // 44px hit area on touch (the x glyph stays small); compact at >= sm
          // (UI consistency pack 44px sweep). shrink-0 keeps it always visible.
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-edge)] hover:text-[var(--color-text)] sm:h-5 sm:w-5"
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      </div>
    );
  }

  // --- one find row --------------------------------------------------------
  function renderRow(find: Discovery) {
    const key = findKey(find);
    const eff = effDecision(find, overrides);
    const selected = key === effectiveKey;
    const isChecked = checked.has(key);
    const busy = busyKey === key;
    const chip = sourceChipFor(find);
    const msg = rowMsg[key];
    const decided = eff !== "";

    return (
      <li
        key={key}
        className={`relative border-b border-[var(--color-edge)] transition ${
          selected ? "bg-[var(--color-panel-2)]" : "hover:bg-[var(--color-panel-2)]/60"
        } ${find.tracked || (decided && view === "all") ? "opacity-70" : ""}`}
      >
        {selected && (
          <span aria-hidden="true" className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-[var(--color-accent-text)]" />
        )}
        <div className="flex items-start gap-2 px-2.5 py-2.5">
          {/* The label is the tap target (44px effective hit area on touch via
              padding + negative margin, so the row doesn't inflate); the
              checkbox itself stays visually 16px (t-1783201090278). */}
          <label className="-my-2.5 -ml-2.5 flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center sm:my-0 sm:ml-0 sm:mt-1 sm:min-h-0 sm:min-w-0">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => toggleCheck(key)}
              aria-label={`Select ${find.Title}`}
              className="h-4 w-4 shrink-0 cursor-pointer"
            />
          </label>
          {/* Title/employer is the row-select control; the source chip is a
              SIBLING real button (not nested in the select button) so it stays
              valid HTML and keyboard-operable. */}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                setSelectedKey(key);
                setMobilePane("detail");
              }}
              aria-current={selected ? "true" : undefined}
              className="block w-full text-left"
            >
              <span className="block truncate text-[13px] font-medium text-[var(--color-text)]">{find.Title}</span>
              <span className="block truncate text-[12px] text-[var(--color-muted)]">{find.Employer}</span>
            </button>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <FitBadge fit={find.Fit} />
              <LeadGapWarning gaps={leadContractGaps(find)} />
              {chip.id ? (
                <button
                  type="button"
                  onClick={() => setSourceFilter(chip.id)}
                  className="inline-flex items-center rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-accent-text)] hover:border-[var(--color-accent)]"
                  title={`Filter finds to ${chip.label}`}
                >
                  {chip.label}
                </button>
              ) : (
                <span className="inline-flex items-center rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                  {chip.label}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Row actions / decision */}
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pl-8">
          {find.tracked ? (
            <span className="rounded bg-[var(--color-panel)] px-2 py-1 text-[11px] text-[var(--color-muted)]">tracked</span>
          ) : decided ? (
            <>
              <DecisionChip decision={eff} />
            </>
          ) : (
            <>
              {/* Pursue is the row's ONE primary action (#2); Skip/Maybe live in
                  the overflow. The detail pane keeps the full three-button set. */}
              <button
                type="button"
                onClick={() => pursue(find, false, "button")}
                disabled={busy}
                aria-label={pursueAriaLabel(find.Title)}
                title={pursueTitle()}
                className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-[30px]"
              >
                {pursueLabel()}
              </button>
              <RowActionMenu
                title={find.Title}
                disabled={busy}
                onSkip={() => applyDecision(find, "skip", false, "button")}
                onMaybe={() => applyDecision(find, "maybe", false, "button")}
              />
            </>
          )}
          {msg && <span className="text-[11px] text-rose-300">{msg}</span>}
        </div>
      </li>
    );
  }

  // --- detail --------------------------------------------------------------
  function renderDetail() {
    if (!selectedFind) {
      return (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-[12px] text-[var(--color-muted)]">
          Select a find to see its details.
        </div>
      );
    }
    const f = selectedFind;
    const key = findKey(f);
    const eff = effDecision(f, overrides);
    const chip = sourceChipFor(f);
    const busy = busyKey === key;
    const trackLabel = TRACK_LABEL[f.Track] || f.Track;

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => setMobilePane("list")}
              aria-label="Back to finds list"
              className="-ml-1 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)] lg:hidden"
            >
              <span aria-hidden="true" className="text-[18px]">
                ←
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-semibold leading-tight text-[var(--color-text)]">{f.Title}</h2>
              <div className="mt-0.5 text-[14px] text-[var(--color-muted)]">{f.Employer}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FitBadge fit={f.Fit} />
            {trackLabel && <TrackBadge track={f.Track} label={trackLabel} />}
            <DeadlinePill deadline={/^\d{4}-\d{2}-\d{2}$/.test(f.Deadline) ? f.Deadline : null} />
            {/* A free-text deadline ("rolling") is accepted-but-low-confidence
                (docs/data-schema.md §5 Decision 3) - render it honestly instead
                of the old silent DeadlinePill null. */}
            {f.Deadline && !/^\d{4}-\d{2}-\d{2}$/.test(f.Deadline) && (
              <span className="text-[11px] text-[var(--color-muted)]">deadline: {f.Deadline}</span>
            )}
            <SectorBadge sector={f.Sector} />
            {/* A missing real link / blank deadline is FLAGGED, never silently
                omitted (design spec §6.4 - closes the silent-blank defect). */}
            <LeadGapWarning gaps={leadContractGaps(f)} />
            {eff && <DecisionChip decision={eff} />}
          </div>

          {/* provenance + posting link */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--color-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span>Source:</span>
              {chip.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setSourceFilter(chip.id);
                    setMobilePane("list");
                  }}
                  className="inline-flex items-center rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent-text)] hover:border-[var(--color-accent)]"
                  title={`Filter finds to ${chip.label}`}
                >
                  {chip.label}
                </button>
              ) : (
                <span className="text-[var(--color-text)]">{chip.label}</span>
              )}
            </span>
            {/* Only a REAL url becomes an anchor (fixes the "Open ↗" literal-text bug). */}
            {isRealUrl(f.Link) ? (
              <a
                href={f.Link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent-text)] hover:underline"
              >
                Open posting <span aria-hidden="true">↗</span>
              </a>
            ) : f.Link ? (
              <span className="text-[#7a869d]">{f.Link}</span>
            ) : null}
            {f["Date Found"] && <span>Found {fmtDate(f["Date Found"]) || f["Date Found"]}</span>}
            {f.Location && <span>{f.Location}</span>}
          </div>

          {f.Notes && (
            <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3 text-[13px] leading-relaxed text-[var(--color-text)]">
              {f.Notes}
            </div>
          )}

          {rowMsg[key] && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
              {rowMsg[key]}
            </div>
          )}

          {/* Triage actions */}
          {f.tracked ? (
            <div className="rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-2 text-[12px] text-[var(--color-muted)]">
              Already tracked as a job.
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => applyDecision(f, "skip", true, "button")}
                disabled={busy}
                className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3.5 py-1.5 text-[13px] text-[var(--color-muted)] hover:border-[var(--color-text)]/30 hover:text-[var(--color-text)] disabled:opacity-50"
              >
                Skip <kbd className="ml-1">S</kbd>
              </button>
              <button
                type="button"
                onClick={() => applyDecision(f, "maybe", true, "button")}
                disabled={busy}
                className="min-h-[44px] rounded-md border border-amber-500/40 px-3.5 py-1.5 text-[13px] text-amber-400 hover:border-amber-500 disabled:opacity-50"
              >
                Maybe <kbd className="ml-1">M</kbd>
              </button>
              <button
                type="button"
                onClick={() => pursue(f, true, "button")}
                disabled={busy}
                title={pursueTitle()}
                className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {pursueLabel()} <kbd className="ml-1 border-white/30 text-white/80">P</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- render --------------------------------------------------------------
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Saved-views rail (lg only) */}
      <nav
        aria-label="Saved views and source filter"
        className="hidden w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--color-edge)] p-3 lg:flex"
      >
        {viewChips("col")}
        {activeSourceName && (
          <div className="border-t border-[var(--color-edge)] pt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Filtered to source
            </div>
            {sourceFilterChip()}
          </div>
        )}
      </nav>

      {/* List pane */}
      <div
        className={`min-h-0 w-full shrink-0 flex-col lg:flex lg:w-[380px] lg:border-r lg:border-[var(--color-edge)] xl:w-[420px] ${
          mobilePane === "detail" ? "hidden lg:flex" : "flex"
        }`}
      >
        {/* narrow-screen chips + source filter */}
        <div className="shrink-0 border-b border-[var(--color-edge)] p-2.5 lg:hidden">
          {viewChips("row")}
          {activeSourceName && <div className="mt-2">{sourceFilterChip()}</div>}
        </div>

        {/* select-all + bulk bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-edge)] px-2.5 py-2">
          {/* The whole label (checkbox + count) is the tap target - 44px on
              touch, compact at >= sm (t-1783201090278). */}
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-[12px] text-[var(--color-muted)] sm:min-h-0">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleCheckAll}
              aria-label="Select all finds in view"
              className="h-4 w-4 cursor-pointer"
              disabled={filtered.length === 0}
            />
            <span className="tabular-nums">
              {filtered.length} {filtered.length === 1 ? "find" : "finds"}
            </span>
          </label>
          <button
            type="button"
            onClick={() => {
              if (!refreshing) void refreshWithBusy(reload, setRefreshing);
            }}
            disabled={refreshing}
            className="ml-auto inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-50 sm:min-h-[30px]"
          >
            {refreshing && (
              <span
                aria-hidden="true"
                className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
              />
            )}
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* Sort + facet controls (#4) */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-edge)] px-2.5 py-2">
          <SegmentedControl
            value={sort}
            onChange={persistSort}
            options={FIND_SORTS.map((s) => ({ value: s.id, label: s.label }))}
            ariaLabel="Sort finds"
            size="sm"
          />
          <select
            value={fitFilter}
            onChange={(e) => {
              track("action", "discovery-finds", "facet-fit", { journey: "J4", meta: { on: !!e.target.value } });
              setFitFilter(e.target.value);
            }}
            aria-label="Filter by fit"
            className="min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-[36px]"
          >
            <option value="">All fits</option>
            <option value="strong">Strong</option>
            <option value="moderate">Moderate</option>
            <option value="stretch">Stretch</option>
          </select>
          <select
            value={trackFilter}
            onChange={(e) => {
              track("action", "discovery-finds", "facet-track", { journey: "J4", meta: { on: !!e.target.value } });
              setTrackFilter(e.target.value);
            }}
            aria-label="Filter by track"
            className="min-h-[44px] max-w-[180px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-[36px]"
          >
            <option value="">All tracks</option>
            {trackOptions.map((t) => (
              <option key={t} value={t}>
                {TRACK_LABEL[t] || t}
              </option>
            ))}
          </select>
        </div>

        {/* Pinned contextual bulk action bar */}
        {checkedInView.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-2">
            <span className="text-[12px] font-medium text-[var(--color-text)]">
              {checkedInView.length} selected
            </span>
            {bulkConfirm ? (
              <>
                <span className="text-[12px] text-[var(--color-muted)]">Skip all {checkedInView.length}?</span>
                <button
                  type="button"
                  onClick={() => bulkDecide("skip")}
                  className="min-h-[44px] rounded-md bg-rose-500/90 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-rose-500 sm:min-h-[36px]"
                >
                  Confirm skip
                </button>
                <button
                  type="button"
                  onClick={() => setBulkConfirm(false)}
                  className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[36px]"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (checkedInView.length >= 5 ? setBulkConfirm(true) : bulkDecide("skip"))}
                  className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[36px]"
                >
                  Skip all {checkedInView.length}
                </button>
                <button
                  type="button"
                  onClick={() => bulkDecide("maybe")}
                  className="min-h-[44px] rounded-md border border-amber-500/40 px-2.5 py-1 text-[12px] font-medium text-amber-400 hover:border-amber-500 sm:min-h-[36px]"
                >
                  Maybe all {checkedInView.length}
                </button>
                <button
                  type="button"
                  onClick={clearChecked}
                  className="ml-auto min-h-[44px] rounded-md px-2 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[36px]"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}

        {/* In-place explainer for the non-obvious "Hidden" view (t-1783422377158:
            the owner asked "what is Hidden status?"). A hover tooltip alone is not
            discoverable enough - name it right where it is selected. */}
        {view === "hidden" && (
          <p className="shrink-0 border-b border-[var(--color-edge)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            {SAVED_VIEWS.find((v) => v.id === "hidden")?.hint}
          </p>
        )}

        {/* The list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {err ? (
            <div className="m-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[13px] text-rose-300">{err}</div>
          ) : loading && !data ? (
            <div className="p-3" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="mb-2 h-16 animate-pulse rounded-lg bg-[var(--color-panel-2)]" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-8 text-center text-[13px] text-[var(--color-muted)]">
              <p>
                {fitFilter || trackFilter
                  ? "No finds match the current filters."
                  : view === "new"
                    ? "No new finds to triage."
                    : sourceFilter
                      ? "No finds from this source in this view."
                      : "No finds here."}
              </p>
              {/* Inline Run affordance (#5): only on the New view with no facet
                  filter on - running discovery is the honest next step there. */}
              {view === "new" && !fitFilter && !trackFilter && (
                <button
                  type="button"
                  onClick={runFromEmptyState}
                  disabled={runBusy}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-[36px]"
                >
                  {runBusy && (
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
                    />
                  )}
                  {runBusy
                    ? "Starting…"
                    : sourceFilter
                      ? `Run ${activeSourceName ?? "this source"}`
                      : "Run due sources"}
                </button>
              )}
              {runNote && (
                <p role="status" className="text-[12px] text-[var(--color-muted)]">
                  {runNote}
                </p>
              )}
            </div>
          ) : (
            <ul>{filtered.map((f) => renderRow(f))}</ul>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${mobilePane === "detail" ? "flex" : "hidden lg:flex"}`}>
        {renderDetail()}
      </div>

      {/* Undo toast (Skip / Maybe) - the shared toast (t-1783183576693). */}
      {undo && (
        <UndoToast onUndo={undoDecision}>
          Triaged <span className="font-semibold">{undo.title}</span>
        </UndoToast>
      )}
    </div>
  );
}
