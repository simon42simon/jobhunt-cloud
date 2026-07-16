import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  selectActiveDecisions,
  selectDeferredDecisions,
  selectParkedDecisions,
} from "../lib/decisions";
import type { NewCommentInput, Task } from "../types";
import { useEventSubscription } from "./useEventStream";

// ---------------------------------------------------------------------------
// The ONE shared, live view of the task board's parked owner-decisions
// (Decisions surface v2, t-1783336697733). App instantiates this ONCE and
// threads the derived list/count to BOTH the notification bell (TopBar, always
// mounted, every screen) AND the Product hub (sidebar badge + the focused
// Decisions view). A single source matters because an optimistic resolve must
// decrement the bell badge, the sidebar badge, and drop the card in ONE coherent
// step - three independent fetches could visibly disagree during the optimistic
// window.
//
// Freshness follows the SSE-consolidation pattern (UX F1) - no new poll loop:
// `/api/tasks` is fetched on mount and refetched on the `tasks-changed` event
// the bell already subscribes to (the only live signal a tasks write emits,
// since docs/tasks.yaml is outside the JOBS_DIR file watcher).
//
// Resolve semantics (design section 4.3): optimistic + Undo toast, NO confirm
// modal. On resolve the card is hidden immediately (badges drop), but the actual
// PATCH is DEFERRED until the ~6s Undo window elapses. Undo inside the window
// discards the pending write entirely - nothing is written, so the append-only
// comment log stays clean (an undone resolve leaves no trace). Conservative on
// loss: if the tab closes mid-window the safe outcome is "not resolved" (the
// decision stays parked), the correct fail-direction for "what needs you".
// ---------------------------------------------------------------------------

export const RESOLVE_UNDO_MS = 6000;

export interface ResolveWrite {
  comment: NewCommentInput;
  labels: string[];
  status?: string;
  // Present only when resolution strips the "[PARKED]" title marker (ADR-020) so
  // the resolved decision leaves the inbox under the union predicate.
  title?: string;
}

interface Pending {
  payload: ResolveWrite;
  timer: number;
}

export interface UseTasks {
  tasks: Task[] | null;
  tasksError: string | null;
  parked: Task[]; // ACTIVE inbox (snoozed + optimistically-resolved hidden), newest-first
  parkedCount: number; // active count - a Defer drops the item, so the badge reflects "needs you now"
  deferred: Task[]; // snoozed decisions (deferred within DEFER_SNOOZE_DAYS), for the "view deferred" section
  deferredCount: number;
  reload: () => void;
  // Optimistically drop a decision + schedule its deferred write. `title` rides
  // along for the Undo toast copy.
  resolve: (id: string, payload: ResolveWrite, title: string) => void;
  // Cancel a pending resolve inside its Undo window - the card returns, nothing
  // is written.
  undoResolve: (id: string) => void;
  // The non-resolving action: append the dated comment NOW (keeps "parked").
  defer: (id: string, comment: NewCommentInput) => Promise<void>;
  // The single most-recent pending resolve, for the App-level Undo toast.
  pendingResolve: { id: string; title: string } | null;
}

export function useTasks(): UseTasks {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  // Ids optimistically resolved (write pending): hidden from `parked` so the
  // badges + card update the instant the owner acts, before the write fires.
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());
  const [pendingResolve, setPendingResolve] = useState<{ id: string; title: string } | null>(null);
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    try {
      const data = await api.getTasks();
      if (!mountedRef.current) return;
      setTasks(data.tasks);
      setTasksError(null);
    } catch (e) {
      if (mountedRef.current) setTasksError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  // A task write anywhere (resolve landing, a new parked ticket from an agent,
  // an edit on the board) refetches the one source.
  useEventSubscription("tasks-changed", reload);

  // Fire the deferred write for a resolve, exactly once. The pending entry is
  // deleted BEFORE the network call so a concurrent flush (beforeunload) can
  // never double-write. On success the `tasks-changed` refetch reconciles the
  // real state; on failure the optimistic hide is lifted so the card returns.
  const flush = useCallback(
    (id: string) => {
      const entry = pendingRef.current.get(id);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      pendingRef.current.delete(id);
      setPendingResolve((p) => (p && p.id === id ? null : p));
      api
        .resolveDecision(id, entry.payload)
        .then(() => {
          if (mountedRef.current) reload();
        })
        .catch(() => {
          if (!mountedRef.current) return;
          setResolvedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          reload();
        });
    },
    [reload],
  );

  const resolve = useCallback(
    (id: string, payload: ResolveWrite, title: string) => {
      if (pendingRef.current.has(id)) return; // guard a double-fire
      setResolvedIds((prev) => new Set(prev).add(id));
      setPendingResolve({ id, title });
      const timer = window.setTimeout(() => flush(id), RESOLVE_UNDO_MS);
      pendingRef.current.set(id, { payload, timer });
    },
    [flush],
  );

  const undoResolve = useCallback((id: string) => {
    const entry = pendingRef.current.get(id);
    if (entry) {
      window.clearTimeout(entry.timer);
      pendingRef.current.delete(id);
    }
    setResolvedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPendingResolve((p) => (p && p.id === id ? null : p));
  }, []);

  const defer = useCallback(
    async (id: string, comment: NewCommentInput) => {
      await api.addTaskComment(id, comment);
      if (mountedRef.current) reload();
    },
    [reload],
  );

  // Prune the optimistic-hide set once the server confirms a resolve landed (the
  // task is no longer parked in the refetch) so it stays bounded. Keeps hiding
  // anything still parked on the server (write in flight) to avoid a flicker.
  // Only ever REMOVES ids, so an explicit unhide on write-failure is never
  // re-hidden here.
  useEffect(() => {
    if (tasks === null || resolvedIds.size === 0) return;
    const stillParked = new Set(selectParkedDecisions(tasks).map((t) => t.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of resolvedIds) {
      if (stillParked.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setResolvedIds(next);
  }, [tasks, resolvedIds]);

  // Flush safety net. On tab close, best-effort keepalive PATCH for any resolve
  // still inside its window (so a real resolve is not lost); if it does not make
  // it, the fail-safe is "not resolved". On React unmount (HMR/teardown), fire
  // the pending writes so nothing is silently dropped.
  useEffect(() => {
    const onBeforeUnload = () => {
      for (const [id, entry] of pendingRef.current) {
        try {
          fetch(`/api/tasks/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry.payload),
            keepalive: true,
          });
        } catch {
          /* fail-safe: the decision simply stays parked */
        }
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      for (const [id, entry] of pendingRef.current) {
        window.clearTimeout(entry.timer);
        api.resolveDecision(id, entry.payload).catch(() => {});
      }
      pendingRef.current.clear();
    };
  }, []);

  // Local YYYY-MM-DD (en-CA renders ISO-like), matching DecisionsView's
  // todayLocalISO / the server's localDateISO intent, so an evening defer is not
  // measured against tomorrow. Recomputed with `tasks` (every SSE-driven reload),
  // which is frequent enough to cross a midnight boundary in a live session.
  const parked = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    return selectActiveDecisions(tasks ?? [], today).filter((t) => !resolvedIds.has(t.id));
  }, [tasks, resolvedIds]);

  const deferred = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    return selectDeferredDecisions(tasks ?? [], today).filter((t) => !resolvedIds.has(t.id));
  }, [tasks, resolvedIds]);

  return {
    tasks,
    tasksError,
    parked,
    parkedCount: parked.length,
    deferred,
    deferredCount: deferred.length,
    reload,
    resolve,
    undoResolve,
    defer,
    pendingResolve,
  };
}
