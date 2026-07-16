import type { Announcements, ScreenReaderInstructions } from "@dnd-kit/core";
import type { Job, Status } from "../types";
import { STATUS_LABEL, STATUS_ORDER } from "../lib/constants";

// Pure drag/drop helpers for the Kanban board (D2). Kept out of KanbanBoard.tsx
// so the drop CONTRACT and the screen-reader copy are unit-testable in the node
// test env without a DOM or the @dnd-kit runtime (only a type-only dnd import,
// which is erased at build). The board itself wires these into <DndContext>.

// The single decision an end-of-drag makes - identical for pointer, touch, AND
// keyboard, so a keyboard drop routes through the exact same onMove (and thus the
// exact same high-stakes confirm modal) as a mouse drop. Returns the move to make,
// or null for a no-op: dropped outside any column, onto a non-status target, or
// back onto the SAME column.
export function resolveDrop(
  jobs: Job[],
  activeId: string | null | undefined,
  overId: string | null | undefined,
): { id: string; status: Status } | null {
  if (activeId == null || overId == null) return null;
  const status = overId as Status;
  if (!STATUS_ORDER.includes(status)) return null;
  const job = jobs.find((j) => j.id === activeId);
  if (!job || job.status === status) return null;
  return { id: job.id, status };
}

// Announced when a job card receives focus (dnd-kit injects this via
// aria-describedby). Names BOTH affordances the card carries after D2: Enter opens
// the detail, Space starts a keyboard drag between columns.
export const KANBAN_SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To open this job, press Enter. To move it to another column, press Space to pick it up, " +
    "use the arrow keys to choose a column, press Space again to drop, or press Escape to cancel.",
};

// Live-region announcements wired into <DndContext>, so a keyboard / assistive-tech
// user hears each step described by role, employer, and target-column LABEL rather
// than the opaque job id dnd-kit announces by default.
export function buildKanbanAnnouncements(jobs: Job[]): Announcements {
  const cardName = (id: string | number | null | undefined): string => {
    const job = id == null ? undefined : jobs.find((j) => j.id === String(id));
    return job ? `${job.role} at ${job.employer}` : "job card";
  };
  const columnName = (id: string | number | null | undefined): string | null => {
    const status = id == null ? undefined : (String(id) as Status);
    return status && STATUS_ORDER.includes(status) ? STATUS_LABEL[status] : null;
  };
  return {
    onDragStart({ active }) {
      return `Picked up ${cardName(active.id)}.`;
    },
    onDragOver({ active, over }) {
      const col = columnName(over?.id);
      return col
        ? `${cardName(active.id)} is over the ${col} column.`
        : `${cardName(active.id)} is not over a column.`;
    },
    onDragEnd({ active, over }) {
      const col = columnName(over?.id);
      return col
        ? `Dropped ${cardName(active.id)} into the ${col} column.`
        : `${cardName(active.id)} was dropped and stayed where it was.`;
    },
    onDragCancel({ active }) {
      return `Move cancelled. ${cardName(active.id)} stayed where it was.`;
    },
  };
}
