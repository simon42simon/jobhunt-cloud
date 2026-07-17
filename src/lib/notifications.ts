// Pure helpers for the notification bell/panel (ticket t-1783042539284, frontend
// half). Kept side-effect-free and DOM-free so they unit-test node-env style
// (tests/notifications-ui.test.ts), the same model as lib/statusColors.ts. The
// localStorage load/save and all rendering live in the components; only the
// vocabulary, per-type metadata, color mapping, and the client-side
// filter/count logic live here.
//
// Two classes of event (see the backend DESIGN NOTE): "timed" events
// (run_finished, wave_done) carry a real activity-log timestamp and are shown
// with a relative clock; "detected" events (task_added, task_done,
// project_added) are since-last-acknowledge diffs with NO reliable time, so the
// UI shows a "new" chip rather than a fabricated time. `timed` below is that
// switch.

import type { Notification, NotificationType } from "../types";

// Declaration order == render/settings order.
export const NOTIFICATION_TYPES: NotificationType[] = [
  "run_finished",
  "wave_done",
  "task_added",
  "task_done",
  "project_added",
  "login_failed",
];

// Per-type label (used by the event row and the settings toggles) plus whether
// the event has a trustworthy timestamp. `colorKey` is a STATUS_COLOR key from
// lib/statusColors.ts - never a raw hex - so the pill tint is drawn from the one
// AA-vetted palette. run_finished/wave_done override the static colorKey at
// render time from their ref (a failed run/wave goes rose), see
// notificationColorKey.
export const NOTIFICATION_META: Record<
  NotificationType,
  { label: string; timed: boolean; colorKey: string }
> = {
  run_finished: { label: "Run finished", timed: true, colorKey: "done" },
  wave_done: { label: "Wave complete", timed: true, colorKey: "done" },
  task_added: { label: "Task added", timed: false, colorKey: "todo" },
  task_done: { label: "Task done", timed: false, colorKey: "done" },
  project_added: { label: "Project added", timed: false, colorKey: "planned" },
  // SIM-386: security signal - carries a real activity-log ts (timed) and always
  // tints as attention (blocked/rose), never a success hue.
  login_failed: { label: "Failed logins", timed: true, colorKey: "blocked" },
};

export function isTimedNotification(type: NotificationType): boolean {
  return NOTIFICATION_META[type]?.timed ?? false;
}

// Defense-in-depth (t-1783145481687): the panel renders whatever the feed
// endpoint returns, and NOTIFICATION_META[type] is undefined for a type this
// build does not know (a newer server, a malformed row). The unguarded lookup
// used to throw - and the bell mounts OUTSIDE App's <main> ErrorBoundary, so
// that throw white-screened the whole app. Every META read for RENDERING goes
// through this guard: an unknown type degrades to a generic row - the raw type
// string as its label, untimed ("new", never a fabricated clock), the neutral
// todo tone.
export function notificationMeta(type: string): { label: string; timed: boolean; colorKey: string } {
  return (
    NOTIFICATION_META[type as NotificationType] ?? {
      label: type || "Notification",
      timed: false,
      colorKey: "todo",
    }
  );
}

// The feed-boundary guard (same ticket): GET /api/notifications is our own
// server, but a malformed payload must DEGRADE, never throw. A non-array feed
// becomes empty; rows missing the fields every consumer dereferences (id key,
// type/title strings, a ref object - notificationColorKey reads ref.kind
// unconditionally) are dropped rather than rendered half-broken.
export function coerceNotificationFeed(raw: unknown): Notification[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Notification => {
    if (!e || typeof e !== "object") return false;
    const n = e as Partial<Notification>;
    return (
      typeof n.id === "string" &&
      typeof n.type === "string" &&
      typeof n.title === "string" &&
      typeof n.ref === "object" &&
      n.ref !== null
    );
  });
}

// The STATUS_COLOR key to tint an event with. For run/wave events the outcome
// (from the ref) decides: a failure goes rose, a stop goes muted, otherwise the
// static per-type key. Every returned key exists in STATUS_COLOR so statusColor()
// resolves a real, pre-vetted hue (never the muted fallback).
export function notificationColorKey(n: Notification): string {
  if (n.ref.kind === "run") {
    if (n.ref.status === "failed") return "blocked";
    if (n.ref.status === "stopped") return "paused";
    if (n.ref.status === "running") return "in_progress";
    return "done";
  }
  if (n.ref.kind === "batch") {
    // Mirror the single-run mapping: genuine failures demand attention
    // (blocked/rose); a wave whose only non-done members were USER-STOPPED is
    // paused/muted, never an alarm (t-1783091385623 - `failed` used to lump
    // stopped runs in, so a deliberately stopped batch showed as blocked).
    if (n.ref.failed > 0) return "blocked";
    if (n.ref.stopped > 0) return "paused";
    return "done";
  }
  return NOTIFICATION_META[n.type]?.colorKey ?? "todo";
}

// Per-type show/hide preferences, persisted client-side. The server always
// returns every type; filtering is purely a view concern.
export type NotificationPrefs = Record<NotificationType, boolean>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  run_finished: true,
  wave_done: true,
  task_added: true,
  task_done: true,
  project_added: true,
  login_failed: true,
};

// Merge an untrusted parsed blob (from localStorage) over the defaults, taking
// only known-type boolean values - mirrors JobTable.loadCollapsed's overlay so
// a stale or partial blob can never crash or hide a type by accident.
export function coercePrefs(raw: unknown): NotificationPrefs {
  const out: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  if (raw && typeof raw === "object") {
    for (const t of NOTIFICATION_TYPES) {
      const v = (raw as Record<string, unknown>)[t];
      if (typeof v === "boolean") out[t] = v;
    }
  }
  return out;
}

// Client-side filter: drop event types the user has switched off. An unknown
// future type (not in prefs) defaults to shown.
export function filterNotifications(events: Notification[], prefs: NotificationPrefs): Notification[] {
  return events.filter((e) => prefs[e.type] ?? true);
}

// Badge count: unread events that survive the current filter, so hiding a type
// also drops its unread contribution (the badge never promises something the
// panel won't show).
export function unreadCount(events: Notification[], prefs: NotificationPrefs): number {
  return filterNotifications(events, prefs).filter((e) => e.unread).length;
}
