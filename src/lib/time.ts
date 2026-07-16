// Shared relative-time helpers (UI consistency pack, t-1783183576693). These
// used to live in lib/sources.ts with three drifted local copies in
// ActivityView / NotificationPanel / TeamView (each stopped at "h ago" and fell
// back to an absolute date after a day). This module is now the ONE clock
// vocabulary: sources.ts re-exports both functions so its domain consumers
// (SourceCard, SourceDetailDrawer, sourcesShared) keep their import path.

// A compact relative-time phrase ("just now", "5m ago", "3h ago", "2d ago",
// "3w ago", else an absolute date). ISO in, null-safe.
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Elapsed clock ("mm:ss") for live run timers. Used to live inside RunPanel;
// consolidated here when the run dock landed (t-1783119823228) so the panel
// and the dock chips share one formatter. Negative / non-finite input clamps
// to 00:00; minutes keep counting past 99 rather than wrapping.
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Same magnitude, but forward-looking ("in 3d", "in 2w") for the next-run time.
export function relativeFuture(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `in ${days}d`;
  const weeks = Math.floor(days / 7);
  return `in ${weeks}w`;
}
