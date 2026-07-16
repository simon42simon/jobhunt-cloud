import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useRunPolling } from "../hooks/useRunPolling";
import {
  isTicketId,
  relatedEntitiesForAssessment,
  type EntityRef,
  type RelatedEntity,
} from "../lib/relatedEntities";
import { runTitle } from "../lib/runDock";
import { hexA, runStatusMeta } from "../lib/statusColors";
import { mmss } from "../lib/time";
import { RelatedChips } from "./RelatedChips";
import type { RunStatus } from "../types";
import { Badge } from "ssc-ui";

// Panel that tracks one routine run (a headless Claude agent). Since
// t-1783650926662 the server streams the agent's own events into the run
// record, so while running the panel shows LIVE progress: the current
// activity ("Reading resume.yaml"), the routine's milestone checklist
// (stages/stageIndex), and a DETERMINATE progress bar driven by the median
// duration of past successful runs (expectedMs) floored by milestone
// progress - falling back to the old indeterminate sweep when neither signal
// exists (first-ever run of a routine with no stages). Finish adds the run's
// real stats (duration / turns / cost) from the CLI's result event.
//
// Since the run dock landed (t-1783119823228) this panel no longer positions
// itself: App owns placement (a bottom-right stack, one panel per expanded
// run), the poll loop lives in the shared useRunPolling hook (the dock chips
// ride the same one), and the status vocabulary comes from lib/statusColors'
// runStatusMeta. Minimize collapses the run into the dock and KEEPS polling;
// Close drops UI tracking only - the agent keeps running server-side.

// Per-status caption under the progress bar (presentation local to this
// panel; label + color come from the shared runStatusMeta).
const CAPTION: Record<RunStatus, string> = {
  running: "Working... routines can take a few minutes",
  done: "Completed",
  failed: "Run failed - see output below",
  stopped: "Stopped before finishing",
};

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === "running") {
    return (
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
      />
    );
  }
  // Dark glyph: the vetted terminal hues are light pastels, so the old white
  // glyph would wash out on them. Decorative (aria-hidden) either way.
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 items-center justify-center rounded-full text-[#0c1220]"
      style={{ background: runStatusMeta(status).color }}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        {status === "done" ? (
          <path d="M4 12.5l5 5L20 6" />
        ) : status === "failed" ? (
          <path d="M6 6l12 12M18 6L6 18" />
        ) : (
          <path d="M7 6v12M17 6v12" />
        )}
      </svg>
    </span>
  );
}

export function RunPanel({
  runId,
  label,
  onClose,
  onMinimize,
  onFinished,
  onOpenEntity,
}: {
  runId: string;
  label: string;
  onClose: () => void;
  onMinimize: () => void;
  onFinished: () => void;
  // Deep-link navigate (t-1783255872307): open the SSC Product Hub at a
  // related entity. Optional so the panel stays usable without the affordance.
  onOpenEntity?: (entity: EntityRef) => void;
}) {
  const run = useRunPolling(runId, onFinished);
  const [now, setNow] = useState(() => Date.now());
  const [showOutput, setShowOutput] = useState(true);
  // The "Related" chips for a FINISHED ticket-scoped run (jobId is a t-* id -
  // assess-ticket / work-ticket scope, never a job-folder run): the assessed
  // ticket, its project, and whatever the output references. null until the
  // one post-finish lookup below resolves.
  const [related, setRelated] = useState<RelatedEntity[] | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const mountedAt = useRef(Date.now());

  const status: RunStatus = run?.status || "running";
  const running = status === "running";
  const tone = runStatusMeta(status);
  const ticketId = run && isTicketId(run.jobId) ? run.jobId : null;

  // One lookup fetch when a ticket-scoped run reaches a terminal status (the
  // output is final then). FAIL-SOFT: the chips are an affordance, never an
  // error state - a failed tasks fetch just leaves the strip off, and a failed
  // portfolio fetch degrades to task-only chips. `run` is deliberately out of
  // the deps: the first non-running render already carries the final output.
  useEffect(() => {
    if (running || !ticketId || !onOpenEntity) return;
    let alive = true;
    Promise.all([api.getTasks(), api.getPortfolio().catch(() => null)])
      .then(([t, p]) => {
        if (!alive) return;
        setRelated(
          relatedEntitiesForAssessment({ ticketId, text: run?.output ?? "", tasks: t.tasks, portfolio: p }),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, ticketId, onOpenEntity]);

  // Elapsed timer: tick every second while running; when the run ends the
  // interval clears and `now` freezes near the completion moment (within ~1s).
  useEffect(() => {
    setNow(Date.now());
    if (status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (showOutput && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [run?.output, showOutput]);

  const startMs = run?.startedAt ? new Date(run.startedAt).getTime() : mountedAt.current;
  const elapsedMs = now - startMs;
  const elapsed = mmss(elapsedMs);
  const title = runTitle(run?.routine, label);
  const subtitle = label && label !== title ? label : "";

  // Live-progress signals (all optional on the wire - absent means the old
  // indeterminate behavior). stageIndex = furthest milestone REACHED.
  const stages = run?.stages ?? [];
  const stageIndex = run?.stageIndex ?? -1;
  const expectedMs = run?.expectedMs ?? null;
  const stats = run?.stats ?? null;

  // Percent-done: the time estimate (elapsed vs the median of past successful
  // runs, capped at 97% so it never claims done early) FLOORED by milestone
  // progress (reaching stage i of n proves at least that fraction). null =
  // no signal at all -> keep the indeterminate sweep.
  const pct: number | null = !running
    ? 1
    : (() => {
        const timePct = expectedMs && expectedMs > 0 ? Math.min(elapsedMs / expectedMs, 0.97) : null;
        const stagePct = stages.length > 0 ? (stageIndex + 1) / (stages.length + 1) : null;
        if (timePct === null && stagePct === null) return null;
        return Math.max(timePct ?? 0, stagePct ?? 0);
      })();

  // Caption: while running prefer the agent's live activity; when done show
  // the run's real stats when the CLI reported them.
  const caption = running
    ? run?.currentActivity || CAPTION.running
    : status === "done" && stats?.durationMs
      ? `Completed in ${mmss(stats.durationMs)}${stats.numTurns ? ` · ${stats.numTurns} turns` : ""}${
          stats.costUsd != null ? ` · $${stats.costUsd.toFixed(2)}` : ""
        }`
      : CAPTION[status];

  return (
    <div
      role="region"
      aria-label={`Run: ${title}`}
      aria-busy={running}
      className="flex w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
      style={{ borderColor: running ? "#5a5df066" : hexA(tone.color, 0.33), background: "var(--color-panel)" }}
    >
      <style>{`@keyframes rp-sweep{0%{left:-42%}100%{left:100%}}`}</style>

      {/* Header: status icon + what is running + status pill, with Minimize/Stop/Close. */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--color-edge)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5">
            <StatusIcon status={status} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-[var(--color-text)]">{title}</span>
              <Badge
                tone={tone.color}
                aria-live="polite"
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              >
                {tone.label}
              </Badge>
            </div>
            {subtitle && <div className="mt-0.5 truncate text-[11px] text-[var(--color-muted)]">{subtitle}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onMinimize}
            title="Minimize to the run dock (keeps running)"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-[var(--color-edge)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
          >
            Minimize
          </button>
          {running && (
            <button
              onClick={() => api.stopRun(runId).catch(() => {})}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-[var(--color-edge)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:border-rose-400/60 hover:text-rose-400 sm:min-h-0 sm:min-w-0"
            >
              Stop
            </button>
          )}
          <button
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-[var(--color-edge)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
          >
            Close
          </button>
        </div>
      </div>

      {/* Progress: determinate when we have a duration estimate or milestone
          signal, else the indeterminate sweep; solid on finish. */}
      <div className="px-4 pt-3">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
          <span className="min-w-0 truncate font-medium" style={{ color: tone.color }} title={caption}>
            {caption}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-[var(--color-muted)]" aria-label="Elapsed time">
            {elapsed}
            {running && expectedMs ? <span className="text-[#7a869d]"> / ~{mmss(expectedMs)}</span> : null}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Run progress"
          aria-valuetext={running ? run?.currentActivity || "Working" : tone.label}
          {...(pct !== null ? { "aria-valuenow": Math.round(pct * 100), "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
          className="relative h-2.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--color-edge)" }}
        >
          {running && pct === null ? (
            <span
              className="absolute top-0 h-full w-[42%] rounded-full"
              style={{
                animation: "rp-sweep 1.15s ease-in-out infinite",
                background: "linear-gradient(90deg, transparent, #5a5df0, #8a8cf7, transparent)",
              }}
            />
          ) : (
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
              style={{
                width: `${Math.round((pct ?? 0) * 100)}%`,
                background: running ? "linear-gradient(90deg, #5a5df0, #8a8cf7)" : tone.color,
              }}
            />
          )}
        </div>

        {/* Milestone checklist (routines that declare stages): what the run
            has provably done and what is next, driven by the agent's own tool
            calls server-side. On success every stage reads done; on a
            failed/stopped run the unreached ones stay dimmed. */}
        {stages.length > 0 && (
          <ol className="mt-2.5 space-y-1" aria-label="Run milestones">
            {stages.map((s, i) => {
              const state =
                status === "done"
                  ? "done"
                  : i < stageIndex || (!running && i <= stageIndex)
                    ? "done"
                    : running && i === stageIndex
                      ? "active"
                      : "pending";
              return (
                <li key={s} className="flex items-center gap-2 text-[11px]">
                  {state === "done" ? (
                    <span
                      aria-hidden
                      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[#0c1220]"
                      style={{ background: status === "done" ? tone.color : "#8a8cf7" }}
                    >
                      <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 12.5l5 5L20 6" />
                      </svg>
                    </span>
                  ) : state === "active" ? (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
                    />
                  ) : (
                    <span aria-hidden className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-[var(--color-edge)]" />
                  )}
                  <span
                    className={
                      state === "pending"
                        ? "text-[var(--color-muted)] opacity-60"
                        : state === "active"
                          ? "font-medium text-[var(--color-text)]"
                          : "text-[var(--color-muted)]"
                    }
                  >
                    {s}
                    {state === "active" && <span className="sr-only"> (in progress)</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Context line. */}
      <div className="px-4 pt-2.5 text-[11px] text-[#7a869d]">
        {run?.prompt && <code className="text-[var(--color-accent-text)]">{run.prompt}</code>}
        {run?.prompt ? " · " : ""}runs as a scoped Claude agent in your vault
      </div>

      {/* Collapsible streaming output. */}
      <div className="px-4 pb-2 pt-2">
        <button
          onClick={() => setShowOutput((v) => !v)}
          aria-expanded={showOutput}
          className="inline-flex min-h-[44px] items-center gap-1 text-[11px] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0"
        >
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-transform"
            style={{ transform: showOutput ? "rotate(90deg)" : "none" }}
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {showOutput ? "Hide output" : "Show output"}
        </button>
      </div>
      {showOutput && (
        <pre
          ref={bodyRef}
          className="mx-3 mb-3 max-h-[300px] min-h-[80px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-edge)] bg-[#0c1220] p-3 text-[12px] leading-relaxed text-[#c6d0e0]"
        >
          {run?.output || (running ? "Starting agent... (routines can take a few minutes)" : "")}
        </pre>
      )}

      {/* Related entities for a finished ticket-scoped run: the assessed
          ticket, its project (the charter surface), and anything the output
          references - each chip deep-links via App's hub-focus primitive.
          Rendered outside the collapsible output so it stays reachable with
          the output hidden. */}
      {!running && onOpenEntity && related && related.length > 0 && (
        <div className="border-t border-[var(--color-edge)] px-4 py-3">
          <RelatedChips entities={related} onOpen={onOpenEntity} />
        </div>
      )}
    </div>
  );
}
