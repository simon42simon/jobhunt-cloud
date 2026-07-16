import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, Status } from "../types";
import { ACTIVE_STATUSES, STATUS_ACCENT, STATUS_LABEL, STATUS_ORDER } from "../lib/constants";
import { track } from "../lib/telemetry";
import { isUndraftedDueSoon } from "../lib/utils";
import { JobCard } from "./JobCard";
import { DeadlinePill, FitBadge, TrackBadge } from "./Badges";
import {
  KANBAN_SCREEN_READER_INSTRUCTIONS,
  buildKanbanAnnouncements,
  resolveDrop,
} from "./kanbanDnd";

function Column({
  status,
  jobs,
  onOpen,
}: {
  status: Status;
  jobs: Job[];
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const accent = STATUS_ACCENT[status];
  return (
    <div className="flex w-[260px] shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
          <span className="text-[13px] font-semibold text-[var(--color-text)]">
            {STATUS_LABEL[status]}
          </span>
        </div>
        <span className="rounded-full bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
          {jobs.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className="flex min-h-[120px] flex-1 flex-col gap-2 rounded-xl border p-2 transition"
        style={{
          borderColor: isOver ? accent : "var(--color-edge)",
          background: isOver ? `${accent}12` : "var(--color-panel)",
        }}
      >
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} onOpen={onOpen} />
        ))}
        {jobs.length === 0 && (
          <div className="flex flex-1 items-center justify-center py-6 text-[11px] text-[#7c88a4]">
            drop here
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({
  jobs,
  onOpen,
  onMove,
}: {
  jobs: Job[];
  onOpen: (id: string) => void;
  onMove: (id: string, status: Status) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Terminal columns (rejected/closed) hide behind an Archive toggle so the
  // default board is the active pipeline lead -> offer. Off by default.
  const [showArchive, setShowArchive] = useState(false);
  // Pointer/touch drag (5px activation guard so a click still opens the card) PLUS
  // a KeyboardSensor (D2): a focused card lifts on Space, moves between columns on
  // the arrow keys (sortableKeyboardCoordinates jumps to the nearest column in the
  // pressed direction), drops on Space/Enter, and cancels on Escape. Enter is left
  // OUT of the drag start keys so it stays free to OPEN the card (see JobCard).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Enter],
      },
    }),
  );

  // Named, human-friendly live-region announcements for the keyboard/AT drag flow.
  const announcements = useMemo(() => buildKanbanAnnouncements(jobs), [jobs]);

  const archiveCount = useMemo(
    () => jobs.filter((j) => j.status === "rejected" || j.status === "closed").length,
    [jobs],
  );
  const visibleStatuses = showArchive ? STATUS_ORDER : ACTIVE_STATUSES;

  // Subtle right-edge fade, shown only while the columns actually overflow.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflowRight, setOverflowRight] = useState(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setOverflowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [showArchive, jobs]);

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const move = resolveDrop(
      jobs,
      e.active?.id != null ? String(e.active.id) : null,
      e.over?.id != null ? String(e.over.id) : null,
    );
    if (move) {
      // Board drag is one of the two status-change paths (the other is the
      // table's status select); `via` distinguishes them. Names/ids only.
      track("action", "jobs-board", "status-change", { journey: "J2", meta: { to: move.status, via: "drag" } });
      onMove(move.id, move.status);
    }
  }

  const active = jobs.find((j) => j.id === activeId) || null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: KANBAN_SCREEN_READER_INSTRUCTIONS,
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-end px-5 pb-2">
          <button
            type="button"
            onClick={() => setShowArchive((v) => !v)}
            aria-pressed={showArchive}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-[36px]"
            title={showArchive ? "Hide rejected and closed columns" : "Show rejected and closed columns"}
          >
            <span className="text-[10px]" aria-hidden>
              {showArchive ? "▾" : "▸"}
            </span>
            Archive
            <span className="rounded-full bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
              {archiveCount}
            </span>
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={scrollerRef} className="flex h-full gap-3 overflow-x-auto px-5 pb-5">
            {visibleStatuses.map((status) => (
              <Column
                key={status}
                status={status}
                jobs={jobs.filter((j) => j.status === status)}
                onOpen={onOpen}
              />
            ))}
          </div>
          {overflowRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--color-ink)] to-transparent" />
          )}
        </div>
      </div>
      <DragOverlay>
        {active ? (
          <div className="w-[244px] rotate-2 rounded-lg border border-[#33405f] bg-[var(--color-panel-2)] p-3 shadow-2xl">
            <div className="text-[13px] font-semibold">{active.role}</div>
            <div className="mb-2 text-[12px] text-[var(--color-muted)]">{active.employer}</div>
            <div className="flex flex-wrap gap-1.5">
              <FitBadge fit={active.fit} />
              <TrackBadge track={active.track} label={active.trackLabel} />
              <DeadlinePill deadline={active.deadline} undrafted={isUndraftedDueSoon(active)} />
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
