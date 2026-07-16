import { useMemo, useState } from "react";
import type { ActivityRecord, JobDetail } from "../types";
import { deriveJobActivity, type JobActivityEntry, type JobActivityKind } from "../lib/jobActivity";
import { relativeFuture, relativeTime } from "../lib/time";
import { fmtDate } from "../lib/utils";
import { statusColor } from "../lib/statusColors";

// The READ-ONLY per-job Activity timeline section in the job detail drawer (US-7,
// journey J3). Renders the pure lib/jobActivity derivation - routine runs + the
// applied/deadline milestones, merged newest-first - as a vertical timeline. It
// consumes the `activity` the drawer ALREADY fetched for its Last-run badges (no
// second fetch) and WRITES NOTHING (CC-DATA-4). Mirrors the derived/read-only
// posture of US-1 (Decisions) and US-3 (next-action suggestion): meaning is
// carried by the entry's text label, never by dot color alone, and the empty
// state is friendly rather than blank.

// A decorative (aria-hidden) dot color per milestone kind. NOT load-bearing - the
// text label carries the meaning - so this only adds visual rhythm. Every hue is
// a pre-vetted statusColors token (no raw hex): applied reuses the "done" emerald
// (a positive, completed step), deadline the in-progress amber (time-sensitive),
// a run the accent-adjacent planned indigo.
const KIND_DOT: Record<JobActivityKind, string> = {
  run: statusColor("planned"),
  applied: statusColor("done"),
  deadline: statusColor("in_progress"),
};

// A small decorative glyph per kind (aria-hidden; the label text is the real
// signal, so a screen reader hears "Applied", not "check Applied").
const KIND_GLYPH: Record<JobActivityKind, string> = {
  run: "▸",
  applied: "✓",
  deadline: "⚑",
};

// Relative-time text: forward-looking for a future milestone (a not-yet deadline),
// backward for everything already past. Both formatters take an ISO string; a
// date-only milestone is widened to its local-midnight ISO so the same helpers
// apply.
function whenText(e: JobActivityEntry): string {
  const iso = e.dateOnly ? new Date(e.sortMs).toISOString() : e.ts;
  return e.sortMs > Date.now() ? relativeFuture(iso) : relativeTime(iso);
}

// Absolute time for the hover/title: a bare date for the date milestones, a full
// local datetime for a run (which carries a precise clock).
function whenTitle(e: JobActivityEntry): string {
  if (e.dateOnly) return fmtDate(e.ts);
  const d = new Date(e.ts);
  return Number.isNaN(d.getTime()) ? e.ts : d.toLocaleString();
}

export function JobActivityTimeline({
  job,
  activity,
}: {
  job: JobDetail;
  // The drawer's activity slice: null while it is still loading (or if the
  // best-effort fetch failed), an array once resolved. Runs fill in when it
  // resolves; the date milestones render immediately regardless.
  activity: ActivityRecord[] | null;
}) {
  const entries = useMemo(() => deriveJobActivity(job, activity ?? []), [job, activity]);

  // Which collapsed "xN" rows are expanded (by entry id). Keyed by the stable
  // run id, so it survives re-renders; when the job changes the ids change and
  // stale entries simply stop matching (harmless).
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="shrink-0 border-b border-[var(--color-edge)] px-5 py-4">
      <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Activity
      </div>

      {entries.length === 0 ? (
        activity === null ? (
          <p className="text-[12px] text-[#7a869d]" role="status">
            Loading activity...
          </p>
        ) : (
          <p className="text-[12px] text-[#7a869d]">No recorded activity yet.</p>
        )
      ) : (
        <ol className="flex flex-col">
          {entries.map((e, i) => {
            const isLast = i === entries.length - 1;
            const color = KIND_DOT[e.kind];
            // A collapsed "xN" group is an expandable disclosure; everything else
            // is a static row.
            const group =
              e.runCount && e.runCount > 1 && e.runs && e.runs.length ? e.runs : null;
            const open = group ? openIds.has(e.id) : false;
            return (
              <li key={e.id} className="flex gap-3">
                {/* Rail: a colored dot with a connecting line down to the next
                    entry. Both are decorative (aria-hidden). */}
                <div className="relative flex w-3 flex-none justify-center">
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute top-3 bottom-0 w-px bg-[var(--color-edge)]"
                    />
                  )}
                  <span
                    aria-hidden
                    className="relative z-10 mt-1.5 h-2.5 w-2.5 flex-none rounded-full"
                    style={{ background: color }}
                  />
                </div>

                {/* Content: a collapsed "xN" group is an expandable disclosure
                    (click to reveal each run with its own time); any other entry
                    is a static label + relative time (absolute on hover/title). */}
                <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-3.5"}`}>
                  {group ? (
                    <>
                      <button
                        type="button"
                        onClick={() => toggle(e.id)}
                        aria-expanded={open}
                        title={open ? "Hide the individual runs" : `Show all ${e.runCount} runs`}
                        className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded text-left hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-muted)]"
                      >
                        <span className="text-[13px] leading-snug text-[var(--color-text)]">
                          {/* The run glyph is a triangle; for a group it doubles as
                              the disclosure caret - it points down when open. */}
                          <span aria-hidden style={{ color }}>
                            {open ? "▾" : "▸"}
                          </span>{" "}
                          {e.label}
                          {/* "xN" is real text (not color) so a screen reader keeps
                              the meaning (CC-A11Y). */}
                          <span className="ml-1.5 inline-block rounded-full bg-[var(--color-edge)] px-1.5 py-px align-middle text-[10px] font-semibold text-[var(--color-muted)]">
                            ×{e.runCount}
                          </span>
                        </span>
                        <time
                          dateTime={e.ts}
                          title={whenTitle(e)}
                          className="text-[11px] text-[var(--color-muted)]"
                        >
                          {whenText(e)}
                        </time>
                      </button>
                      {open && (
                        <ul className="mt-1.5 flex flex-col gap-1 border-l border-[var(--color-edge)] pl-3">
                          {group.map((m) => (
                            <li
                              key={m.id}
                              className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-[var(--color-muted)]"
                            >
                              <span>{m.label}</span>
                              <time dateTime={m.ts} title={whenTitle(m)} className="text-[11px]">
                                {whenText(m)}
                              </time>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[13px] leading-snug text-[var(--color-text)]">
                        <span aria-hidden style={{ color }}>
                          {KIND_GLYPH[e.kind]}
                        </span>{" "}
                        {e.label}
                      </span>
                      <time
                        dateTime={e.ts}
                        title={whenTitle(e)}
                        className="text-[11px] text-[var(--color-muted)]"
                      >
                        {whenText(e)}
                      </time>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
