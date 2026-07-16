import type { Job } from "../types";
import { ATTENTION_TONE_COLOR } from "../lib/statusColors";
import { attentionLabel, computeNeedsAttention, isUndraftedDueSoon } from "../lib/utils";

// Compact "what do I act on today" strip pinned to the top of the Board.
// Shares computeNeedsAttention with the Insights panel so the two never diverge.
// Renders nothing when there is nothing urgent, so it does not clutter the board.
export function NeedsAttentionStrip({
  jobs,
  onOpen,
  onDraftNow,
}: {
  jobs: Job[];
  onOpen: (id: string) => void;
  // Fires the SAME batch-draft fan-out as TopBar's "Draft queued" button
  // (App.batchDraft), scoped to just the jobs flagged below - the fast path
  // for the "about to auto-close un-drafted" window (ops audit F6,
  // t-1783183576640).
  onDraftNow: (jobIds: string[]) => void;
}) {
  const na = computeNeedsAttention(jobs);
  if (na.total === 0) return null;

  // Tones come from the shared, AA-vetted ATTENTION_TONE_COLOR (statusColors.ts,
  // UX F7) instead of a locally hardcoded hex list - the prior #a855f7/#64748b
  // failed AA as this exact 12px text (3.48:1 / 2.98:1).
  // Queued, no CV yet, due inside the same 0-3 day horizon as dueSoon - the
  // set the inline CTA below offers to draft right now, before the deadline
  // auto-close sweep silently closes them un-drafted.
  const undraftedDueSoon = na.dueSoon.filter(isUndraftedDueSoon);

  const groups = [
    { label: "Overdue", items: na.overdue, tone: ATTENTION_TONE_COLOR.overdue },
    { label: "Due soon", items: na.dueSoon, tone: ATTENTION_TONE_COLOR.dueSoon },
    { label: "Follow up", items: na.followUps, tone: ATTENTION_TONE_COLOR.followUp },
    { label: "Stale draft", items: na.staleDrafts, tone: ATTENTION_TONE_COLOR.staleDraft },
    { label: "Stale lead", items: na.staleLeads, tone: ATTENTION_TONE_COLOR.staleLead },
  ].filter((g) => g.items.length > 0);

  return (
    <div
      role="region"
      aria-label={`Needs attention: ${na.total}`}
      className="mx-5 mb-2 flex shrink-0 items-center gap-3 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-2"
    >
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Needs attention
      </span>
      {/* Scrolls internally so the "Draft now" CTA below stays pinned and
          visible instead of scrolling out of view with a long chip list. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {groups.map((g) =>
          g.items.map((job) => {
            const info = attentionLabel(job);
            return (
              <button
                key={`${g.label}-${job.id}`}
                type="button"
                onClick={() => onOpen(job.id)}
                title={`${g.label}: ${job.role} - ${job.employer}`}
                className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] hover:opacity-90 sm:min-h-0"
                style={{ borderColor: `${g.tone}55`, background: `${g.tone}14` }}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: g.tone }} aria-hidden />
                <span className="max-w-[160px] truncate font-medium text-[var(--color-text)]">{job.role}</span>
                <span className="shrink-0" style={{ color: g.tone }}>
                  {info.text}
                </span>
              </button>
            );
          }),
        )}
      </div>
      {undraftedDueSoon.length > 0 && (
        <button
          type="button"
          onClick={() => onDraftNow(undraftedDueSoon.map((j) => j.id))}
          title={`Draft the ${undraftedDueSoon.length} queued job(s) due soon with no CV yet, before the deadline auto-close sweep closes them un-drafted`}
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 sm:min-h-[30px]"
        >
          Draft now ({undraftedDueSoon.length})
        </button>
      )}
    </div>
  );
}
