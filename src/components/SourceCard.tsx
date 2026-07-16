import { useEffect, useRef, useState } from "react";
import type { DerivedSource, SourceCadence } from "../types";
import { SectorBadge, TrackBadge } from "./Badges";
import {
  AllTracksBadge,
  CadenceEditor,
  ContractWarningBadge,
  NewBadge,
  OutcomeIcon,
  ProposalBadge,
  PursuedMeter,
  Sparkline,
  SourceStatusPill,
  SourceTypeBadge,
  SourceTypeIcon,
} from "./sourcesShared";
import {
  SOURCE_STATUS_META,
  isRunning,
  lastTerminalRun,
  relativeTime,
  runCountersPhrase,
  runSignalCaption,
} from "../lib/sources";
import { TRACK_LABEL } from "../lib/constants";
import type { TabId } from "./SourceDetailDrawer";

export function SourceCard({
  source,
  busyRun,
  runNote,
  onOpen,
  onRun,
  onEdit,
  onToggleActive,
  onDelete,
  onViewFinds,
  onCadenceChange,
}: {
  source: DerivedSource;
  busyRun: boolean;
  runNote?: string | null;
  onOpen: (source: DerivedSource, opts?: { tab?: TabId }) => void;
  onRun: (id: string) => void;
  onEdit: (source: DerivedSource) => void;
  onToggleActive: (source: DerivedSource) => void;
  onDelete: (source: DerivedSource) => void;
  onViewFinds: (id: string) => void;
  onCadenceChange: (id: string, cadence: SourceCadence) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);

  const running = isRunning(source);
  const paused = source.status === "paused";
  // apify Run-now gate: a deterministic actor run costs real money and needs an
  // APIFY_TOKEN, so it is disabled until the server confirms Apify is enabled +
  // a token is present (source.apifyConfigured). Absent/false = block (fail
  // safe: never fire a paid run we can't confirm). Non-apify sources unaffected.
  const apifyBlocked = source.type === "apify" && !source.apifyConfigured;
  const meta = SOURCE_STATUS_META[source.status];
  const lastRun = lastTerminalRun(source);
  // v4 run honesty (schema v4 §2.2): the caption + tooltip that make a
  // succeeded zero-lead run legible - both read the SERVER-derived
  // lastRunSignal / reported counters directly, never re-derived here.
  const signalCaption = lastRun ? runSignalCaption(lastRun, source.lastRunSignal) : null;
  const countersTitle = lastRun ? runCountersPhrase(lastRun) : null;
  const headingId = `source-${source.id}-name`;

  // Esc + outside-click close the kebab menu (matches the app's overlay
  // conventions), and Esc returns focus to the trigger.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
        kebabRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  const leadLine =
    source.status === "never-run" && source.jobCount === 0 ? (
      <span className="text-[12px] text-[var(--color-muted)]">Run now to produce your first leads</span>
    ) : (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => onViewFinds(source.id)}
          className="group/leads inline-flex items-center gap-1.5 rounded text-[13px] font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]"
          title={`View this source's ${source.jobCount} finds`}
        >
          <span className="tabular-nums">{source.jobCount}</span>
          <span className="font-normal text-[var(--color-muted)] group-hover/leads:text-[var(--color-accent-text)]">
            {source.jobCount === 1 ? "lead" : "leads"}
          </span>
          <span aria-hidden="true" className="text-[var(--color-muted)] group-hover/leads:text-[var(--color-accent-text)]">
            ↗
          </span>
        </button>
        {source.newSinceVisit > 0 && <NewBadge n={source.newSinceVisit} />}
        {source.jobCount > 0 && <PursuedMeter pct={source.pursuedPct} />}
      </div>
    );

  return (
    <article
      aria-labelledby={headingId}
      style={{ borderLeftColor: meta.dot }}
      className={`flex flex-col gap-3 rounded-lg border border-l-[3px] border-[var(--color-edge)] bg-[var(--color-panel-2)] p-4 transition ${
        paused ? "opacity-60" : ""
      }`}
    >
      {/* Header: type icon + name (opens detail) + status pill */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(source)}
          className="flex min-w-0 items-start gap-2 text-left"
          title={`Open ${source.name}`}
        >
          <span className="mt-0.5 shrink-0 text-[var(--color-muted)]">
            <SourceTypeIcon type={source.type} />
          </span>
          <h3
            id={headingId}
            className="min-w-0 text-[14px] font-semibold leading-snug text-[var(--color-text)] hover:text-[var(--color-accent-text)]"
          >
            {source.name}
          </h3>
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {/* Pending-proposal / reviewing badge (§11.3) - deep-links straight
              to the Instructions tab, where the proposal card lives. */}
          <ProposalBadge source={source} onClick={() => onOpen(source, { tab: "instructions" })} />
          <SourceStatusPill status={source.status} signal={source.lastRunSignal} />
        </div>
      </div>

      {/* Meta row: type + sector + tracks + contract warning */}
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceTypeBadge type={source.type} />
        <SectorBadge sector={source.sector} />
        {source.tracks.length > 0 ? (
          source.tracks.map((t) => <TrackBadge key={t} track={t} label={TRACK_LABEL[t] ?? t} />)
        ) : (
          <AllTracksBadge />
        )}
        <ContractWarningBadge gaps={source.contractGaps} onClick={() => onOpen(source, { tab: "instructions" })} />
      </div>

      {/* Lead yield + sparkline */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">{leadLine}</div>
        <Sparkline runs={source.runs} color={meta.dot} />
      </div>

      {/* Last run + cadence / next run (cadence is a live CadenceEditor trigger) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
        <span
          className="inline-flex items-center gap-1.5"
          title={
            lastRun
              ? [new Date(lastRun.startedAt).toLocaleString(), countersTitle].filter(Boolean).join(" · ")
              : undefined
          }
        >
          {lastRun ? (
            <>
              <OutcomeIcon outcome={lastRun.outcome} />
              <span>
                {lastRun.outcome === "succeeded" ? "Ran" : "Last run"} {relativeTime(lastRun.startedAt)}
                {signalCaption
                  ? ` · ${signalCaption}`
                  : typeof lastRun.leadsFound === "number"
                    ? ` · ${lastRun.leadsFound} found`
                    : ""}
              </span>
            </>
          ) : running ? (
            <span style={{ color: SOURCE_STATUS_META.running.text }}>Running now…</span>
          ) : (
            <span>Not run yet</span>
          )}
        </span>
        <span aria-hidden="true">·</span>
        <CadenceEditor source={source} onChange={(c) => onCadenceChange(source.id, c)} />
      </div>

      {/* Failed banner: reason + retry */}
      {source.status === "failed" && lastRun?.errorReason && (
        <div
          className="rounded-md border px-2.5 py-1.5 text-[12px]"
          style={{ borderColor: "#f43f5e40", background: "#f43f5e14", color: "#fb7185" }}
        >
          <span className="font-medium">Last run failed:</span> {lastRun.errorReason}
        </div>
      )}

      {/* Soft note (run-in-progress / too-many-routines / locked) */}
      {runNote && (
        <div className="rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[12px] text-[var(--color-muted)]">
          {runNote}
        </div>
      )}

      {/* apify Run-now gate (no APIFY_TOKEN / Apify disabled) - the same soft-note
          pattern, never a crash. Run-now stays disabled below. */}
      {apifyBlocked && (
        <div className="rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[12px] text-[var(--color-muted)]">
          Configure APIFY_TOKEN + enable Apify to run
        </div>
      )}

      {/* Actions: Run now / Retry + kebab */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onRun(source.id)}
          disabled={busyRun || running || apifyBlocked}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50 sm:min-h-[36px]"
          title={
            apifyBlocked
              ? "Configure APIFY_TOKEN + enable Apify to run this source"
              : running
                ? "A run is in progress"
                : source.status === "failed"
                  ? "Retry this source"
                  : "Run now"
          }
        >
          {running ? (
            <>
              <span aria-hidden="true">◴</span> Running…
            </>
          ) : busyRun ? (
            "Starting…"
          ) : source.status === "failed" ? (
            <>
              <span aria-hidden="true">↻</span> Retry
            </>
          ) : (
            <>
              <span aria-hidden="true">▶</span> Run now
            </>
          )}
        </button>

        <div className="relative" ref={menuRef}>
          <button
            ref={kebabRef}
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${source.name}`}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-[var(--color-edge)] text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-[36px] sm:min-w-[36px]"
          >
            <span aria-hidden="true" className="text-[16px] leading-none">
              ⋯
            </span>
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label={`Actions for ${source.name}`}
              className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] py-1 shadow-2xl"
            >
              {!confirmDelete ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit(source);
                    }}
                    className="flex min-h-[44px] w-full items-center px-3 py-2 text-left text-[13px] text-[var(--color-text)] hover:bg-[var(--color-panel-2)] sm:min-h-[36px]"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleActive(source);
                    }}
                    className="flex min-h-[44px] w-full items-center px-3 py-2 text-left text-[13px] text-[var(--color-text)] hover:bg-[var(--color-panel-2)] sm:min-h-[36px]"
                  >
                    {source.active === "no" ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setConfirmDelete(true)}
                    className="flex min-h-[44px] w-full items-center px-3 py-2 text-left text-[13px] text-rose-300 hover:bg-[var(--color-panel-2)] sm:min-h-[36px]"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <div className="px-3 py-2">
                  <p className="mb-2 text-[12px] leading-snug text-[var(--color-muted)]">
                    Delete <span className="font-semibold text-[var(--color-text)]">{source.name}</span>? Its finds are
                    kept (they move to unassigned).
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmDelete(false);
                        onDelete(source);
                      }}
                      className="min-h-[44px] flex-1 rounded-md bg-rose-500/90 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-rose-500 sm:min-h-[36px]"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[36px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
