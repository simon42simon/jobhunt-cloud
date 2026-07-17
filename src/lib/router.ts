import { useMemo, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Dependency-free hash router (t-1783257189986, extended for job side-view
// deep links t-1783371156974). The app deliberately has NO react-router (no new
// dependencies - org security posture); the deep-linkable surfaces are the two
// DETAIL views, so this module models exactly them:
//   `#/tasks` + `#/tasks/<id>`  - the Product-hub task board + one task modal
//   `#/jobs`  + `#/jobs/<id>`   - the Jobs board + one job's side-view drawer
// Opening either detail reflects it in the URL (the owner's Linear/Jira/Notion
// parity ask), so a shared/refreshed link reopens the same item and Back/
// Forward drive it. Everything else stays plain component state, and any other
// navigation STRIPS the hash (clearRoute) so a stale detail route can never lie
// about what is on screen.
//
// parse/format are PURE (no window touch) so they are unit-testable without
// jsdom - see tests/router.test.ts. The live pieces (useRoute / navigate /
// clearRoute) guard every window access so importing this module in a node
// test env is safe.
// ---------------------------------------------------------------------------

export interface TasksRoute {
  page: "tasks";
  // Present on `#/tasks/<id>`; absent on the bare board hash `#/tasks`.
  taskId?: string;
}

export interface JobsRoute {
  page: "jobs";
  // Present on `#/jobs/<id>` (a job's side-view drawer is open); absent on the
  // bare board hash `#/jobs` (drawer closed, still on the Jobs surface).
  jobId?: string;
}

// The full route vocabulary: a discriminated union keyed by `page`. Extend both
// this type AND parseRoute together when a new deep-linkable surface lands.
export type Route = TasksRoute | JobsRoute;

// Parse a location.hash string into a typed route, or null for any hash this
// router does not own (including "", "#", and deeper paths like
// "#/tasks/<id>/x" - unknown shapes are NOT routes, so the caller falls back
// to its normal default view instead of guessing).
export function parseRoute(hash: string): Route | null {
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  // Split on "/" and drop empty segments, so "#/tasks", "#/tasks/" and the
  // tolerated "#tasks" all normalize to the same segment list.
  const segments = raw.split("/").filter((s) => s !== "");
  const page = segments[0];
  // Only the two detail surfaces are routes; a deeper path (>2 segments) is an
  // unknown shape, so the caller falls back to its default view.
  if ((page !== "tasks" && page !== "jobs") || segments.length > 2) return null;
  if (segments.length === 1) return page === "tasks" ? { page: "tasks" } : { page: "jobs" };
  // segments.length === 2: the entity id segment. decodeURIComponent throws on
  // a torn escape ("%" alone) - a hand-mangled URL must degrade to the raw
  // segment (the not-found panel handles an unknown id), never crash the shell.
  let id = segments[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep the raw segment */
  }
  return page === "tasks" ? { page: "tasks", taskId: id } : { page: "jobs", jobId: id };
}

// Format the tasks hash: "#/tasks" for the board, "#/tasks/<id>" for one
// task. The id is percent-encoded so parseRoute(tasksHash(id)) always
// round-trips verbatim, whatever characters a future id scheme carries.
export function tasksHash(taskId?: string): string {
  return taskId ? `#/tasks/${encodeURIComponent(taskId)}` : "#/tasks";
}

// Format the jobs hash: "#/jobs" for the board (drawer closed), "#/jobs/<id>"
// for one job's open side-view drawer. The id is percent-encoded so
// parseRoute(jobsHash(id)) round-trips verbatim as ONE segment - a job id is
// the human-readable folder name, so it carries spaces (and possibly other
// characters) the encoding preserves. Mirrors tasksHash: one deep-link mechanism.
export function jobsHash(jobId?: string): string {
  return jobId ? `#/jobs/${encodeURIComponent(jobId)}` : "#/jobs";
}

// Push-navigate to a hash. Assigning location.hash adds a history entry AND
// fires hashchange, so browser Back returns to the previous hash for free
// (detail -> board) and useRoute consumers re-render - no manual emit needed.
//
// SAME-HASH hardening (RC-4 QA BUG-1, the "zombie drawer"): assigning the hash
// its CURRENT value fires NO hashchange, so it used to be a total no-op. If a
// consumer's route state ever drifts from the URL (QA observed a drawer still
// mounted on a bare "#/jobs" URL after a missed/suppressed hashchange), every
// recovery path - the drawer's X, Escape, the backdrop click - re-navigates to
// the SAME bare hash and silently did nothing; only a reload escaped. Emitting
// manually on a same-value assignment makes every navigate self-healing: the
// subscribers re-read the real URL and any drifted state snaps back to it.
export function navigate(hash: string): void {
  if (typeof window === "undefined") return;
  const before = window.location.hash;
  window.location.hash = hash;
  if (window.location.hash === before) emit();
}

// Strip the hash WITHOUT adding a history entry (leaving the tasks surface
// via TopBar / sidebar / keyboard must not grow the Back stack, and a refresh
// after leaving must land on the normal default, not jump back to the task).
// history.replaceState fires NO hashchange, so we notify subscribers here.
export function clearRoute(): void {
  if (typeof window === "undefined" || !window.location.hash) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  emit();
}

// --- the tiny external store useRoute rides on ------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  // Iterate a copy so a listener that unsubscribes mid-dispatch cannot mutate
  // the live set (same discipline as useEventStream's dispatch).
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* one bad subscriber must not break the fan-out */
    }
  }
}

function subscribeHash(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("hashchange", emit);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("hashchange", emit);
    }
  };
}

function hashSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

// The current route as React state. Snapshot is the raw hash STRING (stable
// by value, so useSyncExternalStore never sees a fresh-object snapshot churn);
// the parsed object is memoized off it. Back/Forward (hashchange) and
// clearRoute both notify, so route changes drive state - not just clicks.
export function useRoute(): Route | null {
  const hash = useSyncExternalStore(subscribeHash, hashSnapshot);
  return useMemo(() => parseRoute(hash), [hash]);
}
