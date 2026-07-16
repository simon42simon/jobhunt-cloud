import { useEffect, useRef, useState } from "react";
import type {
  ContractGap,
  DerivedSource,
  LastRunSignal,
  RunRecord,
  SourceCadence,
  SourceStatus,
  SourceType,
} from "../types";
import {
  CADENCE_HINT,
  CADENCE_LABEL,
  RUN_OUTCOME_META,
  SOURCE_CADENCES,
  SOURCE_STATUS_META,
  SOURCE_TYPE_LABEL,
  cadencePhrase,
  computeFreshnessSummary,
  hexA,
  nextRunPhrase,
  relativeFuture,
  type LeadGap,
} from "../lib/sources";
import { TRACK_ACCENT, TRACK_LABEL } from "../lib/constants";
import {
  PROPOSAL_BADGE_BUSY_LABEL,
  PROPOSAL_BADGE_READY_LABEL,
  proposalBadgeState,
} from "../lib/proposals";
import { LAST_RUN_SIGNAL_META, PROPOSAL_STATUS_META } from "../lib/statusColors";
import { TrackBadge } from "./Badges";
import { Badge } from "ssc-ui";

// ---------------------------------------------------------------------------
// Shared, pure presentational primitives for the Sources console + triage
// inbox. Colors route through lib/sources' AA-vetted status/outcome maps or the
// CSS tokens - never a raw hex here. Every status/outcome glyph is paired with
// its text label (state is never carried by color alone), and decorative glyphs
// are aria-hidden.
// ---------------------------------------------------------------------------

// The computed status pill - the most load-bearing pixel on a source card. The
// colored dot is decorative; the visible text label carries the meaning.
// `signal` (v4, schema v4 §2.2) is the SERVER-derived lastRunSignal, read
// directly - never re-derived here: a "healthy" source whose newest succeeded
// run is 'unverified' (zero leads, no review counters) is numerically identical
// to a broken scrape, so it must NOT read plain "Healthy" - it gets the amber
// "cannot tell" treatment (LAST_RUN_SIGNAL_META, AA-vetted in statusColors).
// 'dedup'/'quiet' zeros are genuinely healthy and keep the normal pill; any
// non-healthy status (due/stale/failed/...) always outranks the signal.
export function SourceStatusPill({
  status,
  signal,
  size = "sm",
}: {
  status: SourceStatus;
  signal?: LastRunSignal | null;
  size?: "sm" | "md";
}) {
  const meta = SOURCE_STATUS_META[status];
  const unverified = status === "healthy" && signal === "unverified";
  const color = unverified ? LAST_RUN_SIGNAL_META.unverified.color : meta.text;
  const label = unverified ? LAST_RUN_SIGNAL_META.unverified.label : meta.label;
  const dim = size === "md" ? "px-2.5 py-1 text-[11.5px]" : "px-2 py-0.5 text-[11px]";
  return (
    <Badge
      tone={color}
      className={`shrink-0 gap-1.5 rounded-full font-semibold ${dim}`}
      title={
        unverified
          ? "Last run succeeded but reported 0 leads and no review counters - can't confirm the scrape actually worked. Re-run to verify."
          : undefined
      }
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: unverified ? color : meta.dot }}
        aria-hidden="true"
      />
      {label}
    </Badge>
  );
}

// A run's outcome as a glyph + accessible label. The glyph alone is aria-hidden;
// callers that need the word render {meta.label} alongside.
export function OutcomeIcon({ outcome }: { outcome: RunRecord["outcome"] }) {
  const meta = RUN_OUTCOME_META[outcome];
  return (
    <span className="inline-flex items-center" style={{ color: meta.color }} title={meta.label}>
      <span aria-hidden="true" className="text-[12px] leading-none">
        {meta.symbol}
      </span>
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

// The employer/board type glyph (decorative - the type is always also a text
// badge). Shared by the card header and the detail header so they never drift.
export function SourceTypeIcon({ type }: { type: SourceType }) {
  if (type === "employer") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path
          d="M2.5 14V3.5A1 1 0 0 1 3.5 2.5h6a1 1 0 0 1 1 1V14M10.5 6.5h2a1 1 0 0 1 1 1V14M2 14h12M5 5h1.5M5 7.5h1.5M5 10h1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// employer | board type badge.
export function SourceTypeBadge({ type }: { type: SourceType }) {
  return (
    <span className="inline-flex items-center rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
      {SOURCE_TYPE_LABEL[type]}
    </span>
  );
}

// A tiny inline SVG sparkline of recent runs' leadsFound (chronological). A
// smooth polyline over a translucent area fill, with an endpoint dot at the
// latest run - the managed-source "run trend at a glance" idiom. Falls back to a
// muted dash when there are fewer than two numeric points to plot.
export function Sparkline({
  runs,
  color = "#5a5df0",
  width = 72,
  height = 22,
}: {
  runs: RunRecord[];
  color?: string;
  width?: number;
  height?: number;
}) {
  // runs arrive newest-first; plot chronologically (oldest -> newest, left ->
  // right) using only runs that produced a numeric leadsFound.
  const values = runs
    .filter((r) => typeof r.leadsFound === "number")
    .map((r) => r.leadsFound as number)
    .reverse();

  if (values.length < 2) {
    return (
      <span className="text-[11px] text-[var(--color-muted)]" aria-hidden="true">
        —
      </span>
    );
  }

  const pad = 2;
  const w = width;
  const h = height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    // Invert Y (SVG y grows downward); a flat series sits on the mid-line.
    const y = max === min ? h / 2 : pad + (h - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
  const last = pts[pts.length - 1];
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={`Recent runs: ${values.join(", ")} leads (${total} total across last ${values.length})`}
    >
      <polygon points={area} fill={hexA(color, 0.14)} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}

// The pursued-share meter shown on a card's lead count (a thin track + label).
export function PursuedMeter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="inline-flex items-center gap-1.5" title={`${clamped}% of leads pursued`}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-[var(--color-edge)]" aria-hidden="true">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(clamped, 2)}%`, background: "var(--color-accent)" }}
        />
      </span>
      <span className="text-[11px] tabular-nums text-[var(--color-muted)]">{clamped}% pursued</span>
    </span>
  );
}

// A small "+N new" badge (leads found since the last visit). Rendered only by
// callers that already checked n > 0.
export function NewBadge({ n }: { n: number }) {
  return (
    <Badge
      tone="var(--color-accent-text)"
      className="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      title={`${n} new since your last visit`}
    >
      +{n} new
    </Badge>
  );
}

// Instruction-proposal badge (design spec §11.3), rendered near the status
// pill on the card and only when there is something to say (the NewBadge
// convention). Two states, live-run first: a propose run in flight shows
// "Reviewing note…" in the SAME busy family as "Running…" (pending sky - the
// user already reads that color as "the agent is working"), else a pending
// proposal shows "Proposal ready" in the accent "new thing to review" tint
// NewBadge already owns (good news, not an alarm). Clicking deep-links to the
// drawer's Instructions tab via the caller's onOpen(source, { tab }).
export function ProposalBadge({ source, onClick }: { source: DerivedSource; onClick?: () => void }) {
  const state = proposalBadgeState(source);
  if (!state) return null;
  const busy = state.kind === "reviewing";
  // Same 14%-currentColor-tint recipe ssc-ui's Badge `tone` uses (DS-6a) -
  // applied directly (not via <Badge>) so the ready/reviewing chip can still
  // be a clickable <button> when onClick is provided.
  const tone = busy ? PROPOSAL_STATUS_META.pending.color : "var(--color-accent-text)";
  const style = { color: tone, background: "color-mix(in srgb, currentColor 14%, transparent)" };
  const label = busy ? PROPOSAL_BADGE_BUSY_LABEL : PROPOSAL_BADGE_READY_LABEL;
  const title = busy
    ? "The scout is reviewing your note and drafting new instructions"
    : "A proposed instruction change is waiting for your review - click to open it";
  const content = (
    <>
      <span aria-hidden="true">◐</span> {label}
    </>
  );
  const cls = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold";
  if (!onClick) {
    return (
      <Badge tone={tone} className="shrink-0 gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" title={title}>
        {content}
      </Badge>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${cls} min-h-[44px] hover:opacity-80 sm:min-h-[24px]`}
      style={style}
      title={title}
    >
      {content}
    </button>
  );
}

// Shared Esc/outside-click dismiss contract for a small anchored popover - the
// EXACT SAME shape as SourceCard's own kebab-menu contract (Esc stopPropagation +
// refocus the trigger, outside-mousedown closes), reused here rather than
// reimplemented so CadenceEditor / TracksEditor add no second focus-management
// pattern (design spec §5.1, §8).
function usePopoverDismiss(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// One popover, two mount points (SourceCard's cadence line + the drawer
// Settings tab's Cadence row) - selecting a row commits immediately via the
// caller's onChange (design spec §5.1). Reuses cadencePhrase/CADENCE_LABEL, no
// new copy; renders the same absolute-time `title=` the design spec's §4.2 asks
// for on both the cadence phrase and the next-run phrase.
export function CadenceEditor({
  source,
  onChange,
  align = "left",
}: {
  source: DerivedSource;
  onChange: (cadence: SourceCadence) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(open, ref, triggerRef, () => setOpen(false));

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="rounded text-left hover:underline"
        title={`Cadence: ${cadencePhrase(source.cadence)} - click to change`}
      >
        {cadencePhrase(source.cadence)}
        {source.cadence !== "manual" && (
          <span
            className="text-[var(--color-text)]"
            title={source.nextRunAt ? new Date(source.nextRunAt).toLocaleString() : undefined}
          >
            {" "}
            · {nextRunPhrase(source)}
          </span>
        )}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={`Cadence for ${source.name}`}
          className={`absolute ${
            align === "right" ? "right-0" : "left-0"
          } top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] py-1 shadow-2xl`}
        >
          {SOURCE_CADENCES.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={source.cadence === c}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                if (c !== source.cadence) onChange(c);
              }}
              className={`flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] sm:min-h-[36px] ${
                source.cadence === c
                  ? "bg-[var(--color-panel-2)] text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              }`}
            >
              <span className="font-medium">{CADENCE_LABEL[c]}</span>
              <span className="text-[11px] text-[var(--color-muted)]">{CADENCE_HINT[c]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A row of 7 toggle-chip buttons, one per canonical track (design spec §5.2) -
// not a native <select multiple> (this app never uses one; Badges are always
// custom-styled). Shared by SourceFormDrawer (rendered raw, inline in the form)
// and TracksEditor (wrapped in a popover) so there is exactly one chip
// implementation, not two.
export function TrackToggleChips({ selected, onToggle }: { selected: string[]; onToggle: (track: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tracks">
      {Object.keys(TRACK_LABEL).map((t) => {
        const on = selected.includes(t);
        const color = TRACK_ACCENT[t] || "#94a3b8";
        return (
          <button
            key={t}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(t)}
            className="inline-flex min-h-[44px] items-center rounded-full border px-2.5 py-1 text-[12px] font-medium transition sm:min-h-[36px]"
            style={
              on
                ? { color, background: hexA(color, 0.16), borderColor: hexA(color, 0.4) }
                : { color: "var(--color-muted)", background: "transparent", borderColor: "var(--color-edge)" }
            }
          >
            {TRACK_LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}

// A source with `tracks` absent/empty feeds every track (design spec §5.2) -
// visually a SIBLING of SourceTypeBadge (bordered, muted), not a colored
// TrackBadge: it doesn't own an accent color, it isn't one track.
export function AllTracksBadge() {
  return (
    <span
      className="inline-flex items-center rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]"
      style={{ background: hexA("#94a3b8", 0.12) }}
      title="No track set - included in every track's group and every track's Finds."
    >
      All tracks
    </span>
  );
}

// The drawer Settings tab's "Tracks" quick-toggle (design spec §5.2) - mirrors
// CadenceEditor's popover shape (same component family): the trigger IS the
// current display value (TrackBadge chips, or AllTracksBadge when none set),
// clicking it opens the same TrackToggleChips row inline.
export function TracksEditor({
  source,
  onChange,
  align = "right",
}: {
  source: DerivedSource;
  onChange: (tracks: string[]) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(open, ref, triggerRef, () => setOpen(false));

  function toggle(t: string) {
    const next = source.tracks.includes(t) ? source.tracks.filter((x) => x !== t) : [...source.tracks, t];
    onChange(next);
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Edit tracks for ${source.name}`}
        className="flex flex-wrap items-center justify-end gap-1 rounded hover:opacity-80"
        title="Click to edit tracks"
      >
        {source.tracks.length > 0 ? (
          source.tracks.map((t) => <TrackBadge key={t} track={t} label={TRACK_LABEL[t] ?? t} />)
        ) : (
          <AllTracksBadge />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Edit tracks for ${source.name}`}
          className={`absolute ${
            align === "right" ? "right-0" : "left-0"
          } top-full z-30 mt-1 w-64 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 shadow-2xl`}
        >
          <TrackToggleChips selected={source.tracks} onToggle={toggle} />
          <p className="mt-2 text-[11px] text-[#7a869d]">
            Leave none selected if this source feeds every track (e.g. a generic board like LinkedIn or Indeed).
          </p>
        </div>
      )}
    </div>
  );
}

const CONTRACT_GAP_LABEL: Record<ContractGap, string> = {
  "direct-link": "direct link",
  deadline: "deadline",
};

// Card-level scrape-contract warning (design spec §6.2) - rendered ONLY when
// `gaps.length > 0` (this file's own "only render on n > 0" convention, see
// NewBadge/PursuedMeter). `gaps` is always the SERVER-DERIVED
// DerivedSource.contractGaps - never re-computed client-side (docs/data-schema.md
// §5 Decision 3a).
export function ContractWarningBadge({ gaps, onClick }: { gaps: ContractGap[]; onClick?: () => void }) {
  if (gaps.length === 0) return null;
  const label = gaps.map((g) => CONTRACT_GAP_LABEL[g]).join(", ");
  const color = SOURCE_STATUS_META.stale.text; // the app's existing amber/orange "warning" tint
  const cls = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium";
  const content = (
    <>
      <span aria-hidden="true">⚠</span> Missing: {label}
    </>
  );
  if (!onClick) {
    return (
      <Badge tone={color} className="gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
        {content}
      </Badge>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${cls} hover:opacity-80`}
      style={{ color, background: "color-mix(in srgb, currentColor 14%, transparent)" }}
      title="This source's declared output fields are missing a Job-required field - click for details"
    >
      {content}
    </button>
  );
}

const LEAD_GAP_LABEL: Record<LeadGap, string> = {
  link: "no direct link",
  deadline: "no deadline",
};

// Lead-level scrape-contract flag (design spec §6.4) - a find missing a real
// direct link or a real deadline is FLAGGED, never silently omitted (the defect
// this closes in TriageInbox.tsx / SourceDetailDrawer.tsx's Leads tab).
export function LeadGapWarning({ gaps }: { gaps: LeadGap[] }) {
  if (gaps.length === 0) return null;
  const color = SOURCE_STATUS_META.stale.text;
  return (
    <>
      {gaps.map((g) => (
        <Badge key={g} tone={color} className="gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium">
          <span aria-hidden="true">⚠</span> {LEAD_GAP_LABEL[g]}
        </Badge>
      ))}
    </>
  );
}

// Console-level freshness bar (design spec §4.1), inserted directly under
// SourcesConsole's sub-header row. Each health segment is a real <button> that
// quick-filters the grid (works underneath whatever groupBy is active - filter
// first, group second, same order TaskBoard.tsx already uses); clicking the
// active filter again clears it. Counts come from computeFreshnessSummary (the
// discrete `status` enum, never the raw `due` boolean - §4.3).
export function FreshnessBar({
  sources,
  statusFilter,
  onFilterChange,
  onOpenSource,
}: {
  sources: DerivedSource[];
  statusFilter: "due" | "stale" | "never-run" | "healthy" | null;
  onFilterChange: (status: "due" | "stale" | "never-run" | "healthy" | null) => void;
  onOpenSource: (source: DerivedSource) => void;
}) {
  if (sources.length === 0) return null;
  const summary = computeFreshnessSummary(sources);
  const activeSources = sources.filter((s) => s.status !== "paused");
  const nothingScheduled = activeSources.length > 0 && activeSources.every((s) => s.cadence === "manual");
  const allCaughtUp = !nothingScheduled && summary.dueCount === 0 && summary.staleCount === 0 && summary.neverRunCount === 0;

  const nextUp = summary.soonest ? (
    <button
      type="button"
      onClick={() => onOpenSource(summary.soonest!.source)}
      className="inline-flex items-center gap-1 rounded text-[12.5px] text-[var(--color-accent-text)] hover:underline"
    >
      <span aria-hidden="true">→</span> next up: {summary.soonest.source.name} {relativeFuture(summary.soonest.nextRunAt)}
    </button>
  ) : null;

  function segBtn(key: "due" | "stale" | "never-run" | "healthy", icon: string, count: number, label: string, filterWord: string) {
    const meta = SOURCE_STATUS_META[key];
    const on = statusFilter === key;
    const color = count === 0 ? "var(--color-muted)" : meta.text;
    return (
      <button
        type="button"
        onClick={() => onFilterChange(on ? null : key)}
        aria-pressed={on}
        aria-label={`${count} sources ${label} - filter to ${filterWord} sources`}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px] font-medium transition ${
          on ? "bg-[var(--color-panel)] ring-1 ring-[var(--color-accent)]" : "hover:bg-[var(--color-panel)]"
        }`}
        style={{ color }}
      >
        <span aria-hidden="true">{icon}</span>
        <span className="tabular-nums">{count}</span> {label}
      </button>
    );
  }

  return (
    <div className="mb-3 flex flex-col gap-1 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3.5 py-2.5">
      {nothingScheduled ? (
        <p className="text-[12.5px] text-[var(--color-muted)]">No sources scheduled - every active source is manual</p>
      ) : allCaughtUp ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="inline-flex items-center gap-1 text-[12.5px] font-medium"
            style={{ color: SOURCE_STATUS_META.healthy.text }}
          >
            <span aria-hidden="true">✓</span> All caught up
          </span>
          {nextUp && (
            <>
              <span aria-hidden="true" className="text-[var(--color-muted)]">
                ·
              </span>
              {nextUp}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {segBtn("due", "⏱", summary.dueCount, "due now", "due")}
            {segBtn("stale", "⚠", summary.staleCount, "overdue", "overdue")}
            {segBtn("healthy", "✓", summary.healthyCount, "healthy", "healthy")}
            {segBtn("never-run", "●", summary.neverRunCount, "never run", "never-run")}
          </div>
          {nextUp && <div>{nextUp}</div>}
        </>
      )}
    </div>
  );
}

// Shared type export so the card + console agree on the source shape.
export type { DerivedSource };
