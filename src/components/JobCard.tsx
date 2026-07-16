import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Job } from "../types";
import { DeadlinePill, FitBadge, TrackBadge } from "./Badges";
import { STATUS_ACCENT } from "../lib/constants";
import { isUndraftedDueSoon } from "../lib/utils";

export function JobCard({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: job.id,
    data: { status: job.status },
    // Overrides dnd-kit's default aria-roledescription ("draggable") so a screen
    // reader announces the element as a "job card".
    attributes: { roleDescription: "job card" },
  });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    borderLeftColor: STATUS_ACCENT[job.status],
  };

  // dnd-kit's KeyboardSensor activator (Space to pick up; arrows/Space/Enter/Escape
  // while dragging) rides on listeners.onKeyDown. Our own onKeyDown prop below
  // OVERRIDES that spread handler, so we grab dnd-kit's and invoke it FIRST, then
  // layer Enter-to-open on top - Enter is not a drag start key (see KanbanBoard),
  // so it never fires a drag, and while dragging dnd-kit consumes it (drop) before
  // our open check runs.
  const dndOnKeyDown = listeners?.onKeyDown as unknown as
    | ((e: React.KeyboardEvent) => void)
    | undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(job.id)}
      onKeyDown={(e) => {
        dndOnKeyDown?.(e);
        if (!isDragging && e.key === "Enter" && !e.defaultPrevented) {
          e.preventDefault();
          onOpen(job.id);
        }
      }}
      aria-label={`${job.role} at ${job.employer}`}
      className="group cursor-grab rounded-lg border border-[var(--color-edge)] border-l-[3px] bg-[var(--color-panel-2)] p-3 transition hover:border-[#33405f] hover:bg-[#19223399] active:cursor-grabbing"
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <h4 className="text-[13px] font-semibold leading-snug text-[var(--color-text)]">
          {job.role}
        </h4>
      </div>
      <div className="mb-2 text-[12px] text-[var(--color-muted)]">{job.employer}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <FitBadge fit={job.fit} />
        <TrackBadge track={job.track} label={job.trackLabel} />
        <DeadlinePill deadline={job.deadline} undrafted={isUndraftedDueSoon(job)} />
      </div>
      {(job.hasCV || job.hasCoverLetter) && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--color-muted)]">
          {job.hasCV && <span className="rounded bg-[#1c2740] px-1.5 py-0.5">CV</span>}
          {job.hasCoverLetter && <span className="rounded bg-[#1c2740] px-1.5 py-0.5">Cover</span>}
          {job.finalizeReady && (
            <span
              className="rounded bg-emerald-400/10 px-1.5 py-0.5 font-medium text-emerald-400"
              title="Gaps note updated after the draft - ready to finalize"
            >
              ready to finalize
            </span>
          )}
        </div>
      )}
    </div>
  );
}
