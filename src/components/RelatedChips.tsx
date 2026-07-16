import type { RelatedEntity } from "../lib/relatedEntities";

// The clickable "Related" chip strip under a CTO assessment - shared by
// RunPanel (finished ticket-scoped runs) and ChatCapture's "My reports" rows,
// so the two surfaces can never drift apart in markup or a11y (the same
// one-copy discipline as SegmentedControl / UndoToast). Chips are plain
// buttons on purpose: ChatCapture's dialogFocus trap picks them up
// automatically, Enter/Space work for free, and the global :focus-visible
// ring applies. The kind tag is TEXT ("task"/"proj"), never color-only
// meaning; colors are tokens only (no raw hex). 44px touch targets, relaxed
// at >= sm like the rest of the app.
export function RelatedChips({
  entities,
  onOpen,
  heading = "Related",
}: {
  entities: RelatedEntity[];
  onOpen: (entity: RelatedEntity) => void;
  heading?: string;
}) {
  if (entities.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {heading}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {entities.map((e) => (
          <li key={`${e.kind}:${e.id}`} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => onOpen(e)}
              title={`Open ${e.kind === "task" ? "ticket" : "project"} ${e.id}`}
              aria-label={`Open ${e.kind === "task" ? "ticket" : "project"}: ${e.label}`}
              className="inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] sm:min-h-0"
            >
              <span
                aria-hidden="true"
                className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted)]"
              >
                {e.kind === "task" ? "task" : "proj"}
              </span>
              <span className="truncate">{e.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
