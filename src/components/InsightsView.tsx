import { useMemo } from "react";
import type { Job } from "../types";
import {
  ACTIVE_STATUSES,
  STATUS_ACCENT,
  STATUS_LABEL,
  TRACK_ACCENT,
  TRACK_LABEL,
} from "../lib/constants";
import { ATTENTION_TONE_COLOR } from "../lib/statusColors";
import { attentionLabel, computeNeedsAttention, fmtDate, isFollowUpDue, readableOn } from "../lib/utils";

// --- Accessible chart summaries (D8) --------------------------------------
// The bar / funnel / velocity charts below are div-only: their values render
// as visible text but carry no chart semantics, so assistive tech gets loose
// numbers instead of a chart. These pure builders produce the single text
// alternative that each chart container exposes via role="img" + aria-label
// (matching the app's existing role="img" chart pattern in projectsShared).
// Visual output is unchanged; this is additive semantics only.
export function barsSummary(caption: string, rows: { label: string; count: number }[]): string {
  if (rows.length === 0) return `${caption}: no data`;
  return `${caption}: ${rows.map((r) => `${r.label} ${r.count}`).join(", ")}`;
}

// Turn a compact velocity axis label ("this wk", "-3w") into speech-friendly
// text so a screen reader reads "3 weeks ago" rather than "dash 3 w".
export function velocityWeekName(label: string): string {
  if (label === "this wk") return "this week";
  const m = /^-(\d+)w$/.exec(label);
  return m ? `${m[1]} week${m[1] === "1" ? "" : "s"} ago` : label;
}

export function velocitySummary(weeks: { label: string; count: number }[]): string {
  const total = weeks.reduce((sum, w) => sum + w.count, 0);
  const detail = weeks.map((w) => `${velocityWeekName(w.label)} ${w.count}`).join(", ");
  return `Applications per week, last ${weeks.length} weeks, ${total} total: ${detail}`;
}

function Stat({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-[24px] font-semibold leading-none" style={{ color: color || "var(--color-text)" }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

function Bars({ caption, rows }: { caption: string; rows: { label: string; count: number; color: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    // role="img" + a full-data aria-label so a screen reader hears the whole
    // chart as one alternative (the per-bar numerals inside are then a visual
    // detail of that image, not separate loose numbers).
    <div className="space-y-1.5" role="img" aria-label={barsSummary(caption, rows)}>
      {rows.map((r) => {
        // readableOn keeps the count numeral legible on the fill: a saturated
        // color (cyan, yellow) gets darkened so the numeral clears WCAG AA.
        const fill = readableOn(r.color);
        return (
          // Stacked (label above bar) below sm so a fixed label column can't
          // squeeze the bars to half-width at 390px; the classic two-column
          // row returns at >= sm (t-1783201097671).
          <div key={r.label} className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <div className="min-w-0 truncate text-[12px] text-[var(--color-muted)] sm:w-[120px] sm:shrink-0" title={r.label}>
              {r.label}
            </div>
            <div className="h-5 w-full overflow-hidden rounded bg-[var(--color-panel-2)] sm:w-auto sm:flex-1">
              <div
                className="flex h-full items-center justify-end rounded pr-1.5 text-[11px] font-semibold"
                style={{
                  width: `${(r.count / max) * 100}%`,
                  minWidth: r.count ? 22 : 0,
                  background: fill.bg,
                  color: fill.fg,
                }}
              >
                {r.count || ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-[var(--color-text)]">{title}</h3>
      {children}
    </div>
  );
}

export function InsightsView({ jobs, weeklyTarget }: { jobs: Job[]; weeklyTarget: number }) {
  const m = useMemo(() => {
    const by = (s: string) => jobs.filter((j) => j.status === s).length;
    const appliedJobs = jobs.filter((j) => j.applied);
    const appliedCount = appliedJobs.length;
    const interviewing = by("interview") + by("offer");
    const offers = by("offer");

    // velocity: last 8 weeks of applied dates
    const now = new Date();
    const weeks = Array.from({ length: 8 }, (_, i) => ({ label: i === 0 ? "this wk" : `-${i}w`, count: 0 }));
    for (const j of appliedJobs) {
      const d = new Date(j.applied + "T00:00:00");
      if (isNaN(d.getTime())) continue;
      const wk = Math.floor((now.getTime() - d.getTime()) / (7 * 864e5));
      if (wk >= 0 && wk < 8) weeks[wk].count++;
    }

    // breakdowns
    const trackCounts = new Map<string, number>();
    const sectorCounts = new Map<string, number>();
    for (const j of jobs) {
      if (j.track) trackCounts.set(j.track, (trackCounts.get(j.track) || 0) + 1);
      if (j.sector) sectorCounts.set(j.sector, (sectorCounts.get(j.sector) || 0) + 1);
    }

    // needs attention (shared with the Board strip via computeNeedsAttention)
    const active = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
    const { overdue, dueSoon, followUps, staleDrafts, staleLeads } = computeNeedsAttention(jobs);

    return {
      active: active.length,
      appliedCount,
      interviewing,
      offers,
      weeklyApplied: weeks[0].count,
      weeks: weeks.slice().reverse(),
      trackRows: [...trackCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => ({ label: TRACK_LABEL[k] || k, count: c, color: TRACK_ACCENT[k] || "#818cf8" })),
      sectorRows: [...sectorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        // STATUS_ACCENT.submitted is the vetted indigo tint (UX F7); sector has
        // no vocabulary of its own, so it borrows this one flat AA-safe hue
        // instead of a magic hex (readableOn also picks a legible fill/text
        // pair off of it, same as every other Bars() row).
        .map(([k, c]) => ({ label: k, count: c, color: STATUS_ACCENT.submitted })),
      funnelRows: ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer"].map((s) => ({
        label: STATUS_LABEL[s as keyof typeof STATUS_LABEL],
        count: by(s),
        color: STATUS_ACCENT[s as keyof typeof STATUS_ACCENT],
      })),
      overdue,
      dueSoon,
      followUps,
      staleDrafts,
      staleLeads,
    };
  }, [jobs]);

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

  return (
    <div className="h-full overflow-auto px-5 py-5">
      <h2 className="mb-4 text-[16px] font-semibold text-[var(--color-text)]">Insights</h2>

      {/* stat cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active pipeline" value={m.active} />
        <Stat
          label="Applied this week"
          value={`${m.weeklyApplied}/${weeklyTarget}`}
          color={m.weeklyApplied >= weeklyTarget ? STATUS_ACCENT.offer : undefined}
          sub={`${m.appliedCount} total applied`}
        />
        <Stat label="Interviewing" value={m.interviewing} color={STATUS_ACCENT.interview} sub={`${pct(m.interviewing, m.appliedCount)}% of applied`} />
        <Stat label="Offers" value={m.offers} color={STATUS_ACCENT.offer} sub={`${pct(m.offers, m.appliedCount)}% of applied`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Pipeline funnel">
          <Bars caption="Pipeline funnel" rows={m.funnelRows} />
        </Card>

        <Card title="Velocity (applications / week)">
          <div className="flex h-[160px] items-end gap-2" role="img" aria-label={velocitySummary(m.weeks)}>
            {m.weeks.map((w) => {
              const max = Math.max(1, ...m.weeks.map((x) => x.count));
              return (
                <div key={w.label} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <div className="text-[11px] text-[var(--color-muted)]">{w.count || ""}</div>
                  <div
                    className="w-full rounded-t bg-[var(--color-accent)]"
                    style={{ height: `${(w.count / max) * 120 + (w.count ? 4 : 0)}px` }}
                  />
                  <div className="text-[10px] text-[var(--color-muted)]">{w.label}</div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="By track">
          <Bars caption="By track" rows={m.trackRows} />
        </Card>
      </div>

      {/* By sector is low-signal for this search, so it is demoted to a
          collapsed secondary breakdown rather than a top-level card. */}
      {m.sectorRows.length > 0 && (
        <details className="mt-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)]">
          <summary className="cursor-pointer px-4 py-3 text-[12px] font-semibold text-[var(--color-muted)] hover:text-[var(--color-text)]">
            More breakdowns: by sector
          </summary>
          <div className="border-t border-[var(--color-edge)] p-4">
            <Bars caption="By sector" rows={m.sectorRows} />
          </div>
        </details>
      )}

      {/* needs attention */}
      <div className="mt-4">
        <Card title={`Needs attention (${m.overdue.length + m.dueSoon.length + m.followUps.length + m.staleDrafts.length + m.staleLeads.length})`}>
          {m.overdue.length + m.dueSoon.length + m.followUps.length + m.staleDrafts.length + m.staleLeads.length === 0 ? (
            <div className="py-2 text-[13px] text-[var(--color-muted)]">Nothing urgent. Nice.</div>
          ) : (
            <div className="space-y-3">
              {/* Tones come from the shared, AA-vetted ATTENTION_TONE_COLOR
                  (statusColors.ts, UX F7) instead of a locally hardcoded hex
                  list that had drifted from NeedsAttentionStrip's identical
                  one - both previously carried the same #f43f5e/#a855f7/#64748b
                  failures independently. */}
              {[
                { title: "Overdue (still active)", items: m.overdue, tone: ATTENTION_TONE_COLOR.overdue },
                { title: "Due within 3 days", items: m.dueSoon, tone: ATTENTION_TONE_COLOR.dueSoon },
                { title: "Applied 7d+, awaiting reply (follow up)", items: m.followUps, tone: ATTENTION_TONE_COLOR.followUp },
                { title: "Drafted with a near deadline", items: m.staleDrafts, tone: ATTENTION_TONE_COLOR.staleDraft },
                { title: "Lead/queued: stale, no deadline (7d+)", items: m.staleLeads, tone: ATTENTION_TONE_COLOR.staleLead },
              ]
                .filter((g) => g.items.length)
                .map((g) => (
                  <div key={g.title}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: g.tone }}>
                      {g.title} ({g.items.length})
                    </div>
                    <div className="space-y-1">
                      {g.items.map((j) => {
                        const info = attentionLabel(j);
                        return (
                          <div key={j.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                            <span className="truncate text-[var(--color-text)]">
                              {j.role} <span className="text-[var(--color-muted)]">- {j.employer}</span>
                            </span>
                            <span className="shrink-0 text-[11px] text-[var(--color-muted)]">
                              {/* Show the deadline date only for deadline-driven rows. A
                                  follow-up job's application deadline is moot (it is already
                                  submitted), so it would read as a misleading stale date next
                                  to "applied Nd ago - follow up"; suppress it. Deadline-less
                                  rows (stale-lead, age-based stale-draft) also skip it since
                                  fmtDate(null) is empty. */}
                              {!isFollowUpDue(j) && j.deadline ? `${fmtDate(j.deadline)} ` : ""}({info.text})
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
