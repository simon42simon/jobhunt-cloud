import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BatchStatus } from "../types";

// Tracks a batch of routine runs (e.g. "draft all queued"). Polls the aggregate
// status; the server drains the queue up to the concurrency cap. Unlike a single
// run, a batch HAS a known percentage (done/total), so the bar is DETERMINATE.

const CONCURRENCY_CAP = 4;

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Per-run dot colour. Server run statuses: queued / running / done / failed.
const DOT: Record<string, string> = {
  done: "#10b981",
  running: "#5a5df0",
  failed: "#ef4444",
  queued: "#243049",
};

export function BatchPanel({
  batchId,
  label,
  verb = "Draft",
  onClose,
  onProgress,
}: {
  batchId: string;
  label: string;
  // Drives the caption wording only (the header uses `label`). Default "Draft"
  // keeps the existing draft-batch copy byte-identical; a finalize batch passes
  // "Finalize" and the discovery run-all-due fan-out passes "Discover" so the
  // shared panel reads accurately for all three.
  verb?: "Draft" | "Finalize" | "Discover";
  onClose: () => void;
  onProgress: () => void;
}) {
  const [s, setS] = useState<BatchStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mountedAt = useRef(Date.now());
  // The last terminal-count snapshot we told the parent about. The batch poll
  // ticks every ~1.5s, but onProgress reloads ALL jobs - so fire it ONLY when the
  // done/failed counts changed since the last tick, not on every tick (SSE
  // consolidation, UX F2). The `-1` sentinel makes the first observed status
  // report once (establishing the baseline); after that only real progress fires it.
  const lastReported = useRef({ done: -1, failed: -1 });

  useEffect(() => {
    let alive = true;
    let timer: number;
    const poll = async () => {
      try {
        const next = await api.getBatch(batchId);
        if (!alive) return;
        setS(next);
        if (next.done !== lastReported.current.done || next.failed !== lastReported.current.failed) {
          lastReported.current = { done: next.done, failed: next.failed };
          onProgress();
        }
        if (next.running > 0 || next.queued > 0) timer = window.setTimeout(poll, 1500);
      } catch {
        if (alive) timer = window.setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [batchId, onProgress]);

  const total = s?.total || 0;
  const failed = s?.failed || 0;
  const finished = (s?.done || 0) + failed;
  const pct = total ? Math.round((finished / total) * 100) : 0;
  const active = s ? s.running > 0 || s.queued > 0 : true;

  // Elapsed ticks while the batch is draining, then freezes on completion.
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const doneColor = failed > 0 ? "#f59e0b" : "#10b981";
  // barColor drives FILLS (progress bar, border) where the raw accent is fine.
  // barTextColor drives the caption TEXT, which needs the lighter
  // --color-accent-text tint (#a5b4fc) - the raw accent fails AA as text.
  const barColor = active ? "#5a5df0" : doneColor;
  const barTextColor = active ? "#a5b4fc" : doneColor;
  const gerund = verb === "Finalize" ? "Finalizing" : verb === "Discover" ? "Discovering" : "Drafting";
  const nounPl = verb === "Finalize" ? "finalize runs" : verb === "Discover" ? "source runs" : "drafts";
  const caption = active
    ? `${gerund} ${finished} of ${total}`
    : failed > 0
    ? `Finished with ${failed} failed`
    : `All ${nounPl} complete`;

  return (
    <div
      role="region"
      aria-label={`Batch: ${label}`}
      aria-busy={active}
      className="fixed bottom-4 right-4 z-[70] w-[min(440px,92vw)] overflow-hidden rounded-xl border shadow-2xl"
      style={{ borderColor: active ? "#5a5df066" : doneColor + "55", background: "var(--color-panel)" }}
    >
      <style>{`@keyframes bp-stripes{0%{background-position:0 0}100%{background-position:1.4rem 0}}`}</style>

      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-edge)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {active ? (
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-4 w-4 items-center justify-center rounded-full text-white"
              style={{ background: doneColor }}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                {failed > 0 ? <path d="M12 7v6M12 16.5v.5" /> : <path d="M4 12.5l5 5L20 6" />}
              </svg>
            </span>
          )}
          <span className="truncate text-[14px] font-semibold text-[var(--color-text)]">Batch: {label}</span>
        </div>
        <button
          onClick={onClose}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-[var(--color-edge)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
        >
          Close
        </button>
      </div>

      <div className="p-4">
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="font-medium" style={{ color: barTextColor }}>
            {caption}
          </span>
          <span className="flex items-center gap-2">
            <span className="font-mono tabular-nums text-[var(--color-muted)]" aria-label="Elapsed time">
              {mmss(now - mountedAt.current)}
            </span>
            <span className="font-semibold text-[var(--color-text)]">
              {finished}/{total}
            </span>
          </span>
        </div>

        <div
          role="progressbar"
          aria-label="Batch progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="relative h-2.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--color-edge)" }}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${pct}%`,
              background: barColor,
              backgroundImage: active
                ? "linear-gradient(45deg, rgba(255,255,255,.18) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.18) 50%, rgba(255,255,255,.18) 75%, transparent 75%)"
                : undefined,
              backgroundSize: "1.4rem 1.4rem",
              animation: active ? "bp-stripes 0.8s linear infinite" : undefined,
            }}
          />
        </div>

        {/* Aggregate counts. */}
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span className="text-amber-400">{s?.running || 0} running</span>
          <span className="text-[var(--color-muted)]">{s?.queued || 0} queued</span>
          <span className="text-emerald-400">{s?.done || 0} done</span>
          {failed > 0 && <span className="text-rose-400">{failed} failed</span>}
        </div>

        {/* Per-run status dots (one per job). */}
        {s?.runs && s.runs.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5" aria-hidden>
            {s.runs.map((r, i) => (
              <span
                key={r.jobId + i}
                title={`${r.jobId}: ${r.status}`}
                className="h-2.5 w-2.5 rounded-full ring-1 ring-black/20"
                style={{ background: DOT[r.status] || "#243049" }}
              />
            ))}
          </div>
        )}

        <div className="mt-3 text-[11px] text-[#7a869d]">
          Each run is a scoped Claude agent (max {CONCURRENCY_CAP} at once). Nothing is submitted.
        </div>
      </div>
    </div>
  );
}
