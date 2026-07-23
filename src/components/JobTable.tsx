import { useMemo, useState } from "react";
import type { Job } from "../types";
import { DeadlinePill, FitBadge, TrackBadge } from "./Badges";
import { deriveNextAction, fmtDate, isUndraftedDueSoon, jobCompletedDate, jobRecency } from "../lib/utils";
import { STATUS_ACCENT, STATUS_LABEL, STATUS_ORDER } from "../lib/constants";
import type { Status } from "../types";
import { JobFilterBar } from "./JobFilterBar";
import {
  activeConditionCount,
  applyJobFilter,
  EMPTY_FILTER,
  parseFilter,
  serializeFilter,
  type JobFilter,
} from "../lib/jobFilter";
import { track } from "../lib/telemetry";

type SortKey = "role" | "employer" | "status" | "fit" | "deadline" | "track" | "applied" | "recent";
type Dir = "asc" | "desc";

const FIT_RANK: Record<string, number> = { strong: 0, moderate: 1, stretch: 2 };

const COL_COUNT = 9;

// Grouped-mode section order. Deliberately NOT STATUS_ORDER: active work first
// (lead -> offer), then submitted ("waiting on them"), then the terminal
// states sink to the bottom. Must still COVER every live status - grouped mode
// renders only these sections, so a status missing here silently drops its
// jobs from the Table (SIM-599 / t-1784782704635: `ready` was omitted).
// Pinned complete against STATUS_ORDER by tests/jobtable-group-order.test.ts.
const GROUP_ORDER: Status[] = [
  "lead",
  "queued",
  "drafted",
  "ready",
  "interview",
  "offer",
  "submitted",
  "rejected",
  "closed",
];

// Sections that start collapsed: waiting-on-them + terminal states.
const DEFAULT_COLLAPSED: Status[] = ["submitted", "rejected", "closed"];

// Grouping toggle + per-section collapse state survive reloads. localStorage
// can throw (private mode, blocked storage) - reads and writes are
// best-effort and fall back to the defaults.
const GROUPED_KEY = "jobhunt.table.grouped";
const COLLAPSED_KEY = "jobhunt.table.collapsed";
// The advanced filter is persisted here (NOT in the URL - job data stays off
// the address bar per the privacy guideline) so it survives a reload.
const FILTER_KEY = "jobhunt.table.filter";

function loadFilter(): JobFilter {
  try {
    return parseFilter(window.localStorage.getItem(FILTER_KEY));
  } catch {
    return EMPTY_FILTER;
  }
}

function loadGrouped(): boolean {
  try {
    const v = window.localStorage.getItem(GROUPED_KEY);
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}

function loadCollapsed(): Partial<Record<Status, boolean>> {
  const defaults: Partial<Record<Status, boolean>> = {};
  for (const s of DEFAULT_COLLAPSED) defaults[s] = true;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaults;
    // Overlay only known statuses with boolean values; anything the stored
    // blob does not cover keeps its default.
    const out = { ...defaults };
    for (const s of STATUS_ORDER) {
      const v = (parsed as Record<string, unknown>)[s];
      if (typeof v === "boolean") out[s] = v;
    }
    return out;
  } catch {
    return defaults;
  }
}

export function JobTable({
  jobs,
  onOpen,
  onMove,
}: {
  jobs: Job[];
  onOpen: (id: string) => void;
  onMove: (id: string, status: Status) => void;
}) {
  // Default view is newest-first "Recent" (applied date, else folder mtime,
  // DESCENDING) - the completion/recency ordering the Completed column header
  // drives. The other column sorts are preserved and reachable as before.
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [dir, setDir] = useState<Dir>("desc");
  const [grouped, setGrouped] = useState<boolean>(loadGrouped);
  const [collapsed, setCollapsed] = useState<Partial<Record<Status, boolean>>>(loadCollapsed);
  const [filter, setFilter] = useState<JobFilter>(loadFilter);

  // Filter FIRST (advanced multi-condition), THEN sort + group so the composition
  // is always: match -> order -> partition. The active-condition count drives the
  // toolbar badge and the "did the filter empty the table?" branch below.
  const filterCount = activeConditionCount(filter);
  const filtered = useMemo(() => applyJobFilter(jobs, filter), [jobs, filter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "recent":
          // Newest-first key: applied date (ms epoch) when present, else mtime.
          av = jobRecency(a);
          bv = jobRecency(b);
          break;
        case "status":
          av = STATUS_ORDER.indexOf(a.status);
          bv = STATUS_ORDER.indexOf(b.status);
          break;
        case "fit":
          av = FIT_RANK[a.fit] ?? 9;
          bv = FIT_RANK[b.fit] ?? 9;
          break;
        case "deadline":
          av = a.deadline || "9999";
          bv = b.deadline || "9999";
          break;
        case "applied":
          // Unapplied jobs sort to the end either way (sentinel future date).
          av = a.applied || "9999";
          bv = b.applied || "9999";
          break;
        case "track":
          av = a.trackLabel;
          bv = b.trackLabel;
          break;
        default:
          av = (a[sortKey] || "").toLowerCase();
          bv = (b[sortKey] || "").toLowerCase();
      }
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, dir]);

  // Column sorting applies WITHIN each section: partition the already-sorted
  // list by status, in pipeline order. Empty sections are skipped.
  const groups = useMemo(() => {
    if (!grouped) return null;
    return GROUP_ORDER.map((status) => ({
      status,
      jobs: sorted.filter((j) => j.status === status),
    })).filter((g) => g.jobs.length > 0);
  }, [grouped, sorted]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      // Recency reads newest-first by default; the other keys read ascending.
      setDir(key === "recent" ? "desc" : "asc");
    }
  }

  function toggleGrouped() {
    const next = !grouped;
    setGrouped(next);
    try {
      window.localStorage.setItem(GROUPED_KEY, String(next));
    } catch {
      /* best-effort persistence */
    }
  }

  function updateFilter(next: JobFilter) {
    setFilter(next);
    try {
      window.localStorage.setItem(FILTER_KEY, serializeFilter(next));
    } catch {
      /* best-effort persistence */
    }
  }

  function clearFilter() {
    updateFilter({ ...filter, conditions: [] });
  }

  function toggleSection(status: Status) {
    const next = { ...collapsed, [status]: !collapsed[status] };
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      /* best-effort persistence */
    }
  }

  // Sortable headers are real <button>s (keyboard-operable, focus-visible) and
  // the <th> carries aria-sort so assistive tech announces the active sort.
  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => {
    const isActive = sortKey === k;
    const ariaSort: React.AriaAttributes["aria-sort"] = isActive
      ? dir === "asc"
        ? "ascending"
        : "descending"
      : "none";
    return (
      <th
        aria-sort={ariaSort}
        className={`select-none px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)] ${className || ""}`}
      >
        <button
          type="button"
          onClick={() => toggleSort(k)}
          // 44px tap target on touch, compact at >= sm (UI consistency pack
          // 44px sweep - these sat at ~30px on touch).
          className="inline-flex min-h-[44px] items-center gap-1 uppercase tracking-wide hover:text-[var(--color-text)] sm:min-h-0"
        >
          {children}
          {isActive && (
            <span className="text-[9px]" aria-hidden>
              {dir === "asc" ? "▲" : "▼"}
            </span>
          )}
        </button>
      </th>
    );
  };

  const renderRow = (job: Job) => {
    // DERIVED completion date: the applied date, only for submitted+ jobs.
    const completedDate = jobCompletedDate(job);
    // DERIVED next-action suggestion (US-3), DISPLAY-ONLY: computed only when the
    // owner has NOT set a real next_action. A real next_action always wins.
    const suggestedNextAction = job.nextAction ? null : deriveNextAction(job);
    return (
    <tr
      key={job.id}
      role="button"
      tabIndex={0}
      aria-label={`Open ${job.role} at ${job.employer}`}
      onClick={() => onOpen(job.id)}
      // Open on Enter/Space, but only when the row itself is focused -
      // not when focus is on the inner status <select> (target !== row).
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(job.id);
        }
      }}
      className="cursor-pointer border-b border-[var(--color-edge)] hover:bg-[var(--color-panel-2)]"
    >
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5 text-[13px] font-medium text-[var(--color-text)]">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {job.role}
          {job.finalizeReady && (
            <span
              className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400"
              title="Gaps note updated after the draft - ready to finalize (run Finalize to advance it to Ready)"
            >
              to finalize
            </span>
          )}
        </span>
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5 text-[13px] text-[var(--color-muted)]">
        {job.employer}
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        <select
          value={job.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const to = e.target.value as Status;
            // The table select is the keyboard-operable status-change path;
            // `via:"select"` distinguishes it from a board drag. Ids only.
            track("action", "jobs-table", "status-change", { journey: "J2", meta: { to, via: "select" } });
            onMove(job.id, to);
          }}
          className="min-h-[44px] rounded-md border px-2 py-1 text-[12px] font-semibold outline-none sm:min-h-0"
          style={{ color: STATUS_ACCENT[job.status], background: `${STATUS_ACCENT[job.status]}1a`, borderColor: `${STATUS_ACCENT[job.status]}40` }}
          title="Change status"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s} style={{ color: "var(--color-text)", background: "var(--color-panel-2)" }}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        <FitBadge fit={job.fit} />
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        <TrackBadge track={job.track} label={job.trackLabel} />
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        {job.deadline ? (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--color-muted)]">{fmtDate(job.deadline)}</span>
            <DeadlinePill deadline={job.deadline} undrafted={isUndraftedDueSoon(job)} />
          </div>
        ) : (
          <span className="text-[12px] text-[#7c88a4]">-</span>
        )}
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        {job.applied ? (
          <span className="text-[12px] text-emerald-400">{fmtDate(job.applied)}</span>
        ) : (
          <span className="text-[12px] text-[#7c88a4]">-</span>
        )}
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        {completedDate ? (
          <span className="text-[12px] text-[var(--color-muted)]">{fmtDate(completedDate)}</span>
        ) : (
          <span className="text-[12px] text-[#7c88a4]">-</span>
        )}
      </td>
      <td className="border-b border-[var(--color-edge)] px-3 py-2.5">
        {job.nextAction ? (
          <span className="block max-w-[220px] truncate text-[12px] text-[var(--color-muted)]" title={job.nextAction}>
            {job.nextAction}
          </span>
        ) : suggestedNextAction ? (
          // DISPLAY-ONLY suggestion (US-3): distinct from a real next_action on
          // THREE axes so it never reads as user-authored - a text "Suggested:"
          // prefix (conveyed by TEXT, not color alone, CC-A11Y-SR), italic, and
          // a dimmer tone than the real value's --color-muted.
          <span
            className="block max-w-[220px] truncate text-[12px] italic text-[#7c88a4]"
            title={`Suggested next action (you have not set one): ${suggestedNextAction}`}
          >
            <span className="font-medium not-italic">Suggested:</span> {suggestedNextAction}
          </span>
        ) : (
          <span className="text-[12px] text-[#7c88a4]">-</span>
        )}
      </td>
    </tr>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar row: the advanced filter builder on the left, group toggle on
          the right - same control idiom as the rest of the app. */}
      <div className="flex shrink-0 items-start gap-3 px-5 pb-2">
        <JobFilterBar jobs={jobs} filter={filter} onChange={updateFilter} />
        <button
          type="button"
          onClick={toggleGrouped}
          aria-pressed={grouped}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-[36px]"
          title={grouped ? "Show one flat, sortable list" : "Group rows into status sections"}
        >
          Group by status
          <span className="rounded-full bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-muted)]">
            {grouped ? "on" : "off"}
          </span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
        <table className="w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--color-panel)]">
              <Th k="role">Role</Th>
              <Th k="employer">Employer</Th>
              <Th k="status">Status</Th>
              <Th k="fit">Fit</Th>
              <Th k="track">Track</Th>
              <Th k="deadline">Deadline</Th>
              <Th k="applied">Applied</Th>
              <Th k="recent">Completed</Th>
              <th className="select-none px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Next action
              </th>
            </tr>
          </thead>
          {groups ? (
            groups.map((g) => {
              const isCollapsed = !!collapsed[g.status];
              return (
                <tbody key={g.status}>
                  <tr>
                    <td colSpan={COL_COUNT} className="px-1 pb-1 pt-3">
                      <button
                        type="button"
                        onClick={() => toggleSection(g.status)}
                        aria-expanded={!isCollapsed}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 py-1 text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-panel-2)] sm:min-h-[36px]"
                        title={isCollapsed ? `Show ${STATUS_LABEL[g.status]} jobs` : `Hide ${STATUS_LABEL[g.status]} jobs`}
                      >
                        <span className="text-[10px] text-[var(--color-muted)]" aria-hidden>
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: STATUS_ACCENT[g.status] }}
                          aria-hidden
                        />
                        {STATUS_LABEL[g.status]}
                        <span className="rounded-full bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-muted)]">
                          {g.jobs.length}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed && g.jobs.map(renderRow)}
                </tbody>
              );
            })
          ) : (
            <tbody>{sorted.map(renderRow)}</tbody>
          )}
        </table>
        {sorted.length === 0 &&
          (filterCount > 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="text-[13px] text-[var(--color-muted)]">
                No jobs match these filters - clear or adjust {filterCount === 1 ? "the condition" : "the conditions"}.
              </div>
              <button
                type="button"
                onClick={clearFilter}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1 text-[12px] font-semibold text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[36px]"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            <div className="py-16 text-center text-[13px] text-[var(--color-muted)]">No jobs match.</div>
          ))}
      </div>
    </div>
  );
}
