import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  DEFAULT_NOTIFICATION_PREFS,
  coerceNotificationFeed,
  coercePrefs,
  unreadCount,
  type NotificationPrefs,
} from "../lib/notifications";
import type { Notification, NotificationType } from "../types";
import { NotificationPanel } from "./NotificationPanel";
import type { ViewMode } from "./TopBar";
import { track } from "../lib/telemetry";
import { attentionToneColor } from "../lib/statusColors";
import { useDocumentVisible, useEventSubscription } from "../hooks/useEventStream";

// The ACT/amber tone (vetted dueSoon hue) for the decisions state - distinct
// from the accent-indigo FYI badge, so the bell reads "needs you", not "FYI".
const ACT_TONE = attentionToneColor("dueSoon");

// Bell button + unread badge, rendered by TopBar. Self-contained so TopBar's own
// state (view toggles, search, shortcuts) is untouched: this owns the feed
// freshness, the unread count, the open/closed panel, and the per-type filter
// prefs.
//
// Freshness (SSE consolidation, UX F1): the feed refetches when the server
// signals a relevant write - a run finishing (run_finished / wave_done derive
// from run history) or a task write (task_added / task_done) - via the shared
// event stream, instead of the old always-on 20s poll that ran even while the
// tab was hidden. A slow 60s fallback catches the notification kinds that have
// no live signal (portfolio project_added, a diff-based detection), and it runs
// ONLY while the tab is visible - a backgrounded tab does zero polling.
const FALLBACK_MS = 60000;

// Single-key JSON blob under the "jobhunt.notifications.*" namespace, same
// load-with-fallback / save-in-try-catch idiom as App.JOBS_VIEW_KEY and
// JobTable's COLLAPSED_KEY. coercePrefs merges an untrusted blob over defaults.
const PREFS_KEY = "jobhunt.notifications.filters";

function loadPrefs(): NotificationPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
    return coercePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function NotificationBell({
  onNavigate,
  parkedCount,
  onReviewDecisions,
}: {
  onNavigate: (v: ViewMode) => void;
  // Parked owner-decisions, from App's single useTasks source (Decisions surface
  // v2). Drives the amber "needs you" badge + the pinned panel banner; a call to
  // ACT is deliberately kept OUT of the notification read-cursor/filter machinery
  // (it clears only when the decision is actually resolved), so it lives here as
  // a separate signal rather than an event in the feed.
  parkedCount: number;
  onReviewDecisions: () => void;
}) {
  const [events, setEvents] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One guarded fetch, reused by the SSE handlers, the visible-tab fallback, and
  // the open-panel refresh.
  const refetch = useCallback(async () => {
    try {
      const data = await api.getNotifications();
      // Feed-boundary guard (t-1783145481687): a malformed payload (non-array
      // events, rows missing id/type/title/ref) degrades instead of throwing -
      // the bell and its panel render OUTSIDE App's <main> ErrorBoundary.
      if (mountedRef.current) setEvents(coerceNotificationFeed(data.events));
    } catch {
      /* transient bridge blip - keep the last good feed */
    }
  }, []);

  // Live refresh: a finished run or any task write can change the feed. The
  // shared stream delivers these, so the bell reacts instead of polling.
  useEventSubscription("run-finished", refetch);
  useEventSubscription("tasks-changed", refetch);

  // Initial load + a slow fallback for the signal-less kinds - but ONLY while
  // visible. Regaining visibility re-runs this effect, which refetches once to
  // catch up on anything that happened while the tab was hidden.
  const visible = useDocumentVisible();
  useEffect(() => {
    if (!visible) return;
    refetch();
    const timer = window.setInterval(refetch, FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [visible, refetch]);

  function savePrefs(next: NotificationPrefs) {
    setPrefs(next);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* best-effort persistence */
    }
  }

  // Opening acknowledges the feed (advance the read cursor to now) then refetches
  // so the badge clears and the rows lose their unread marker.
  async function openPanel() {
    track("view", "notifications", "open", { journey: "J9" });
    setOpen(true);
    try {
      await api.markNotificationsRead({});
    } catch {
      /* non-fatal: the panel still opens with the current feed */
    }
    refetch();
  }

  const count = unreadCount(events, prefs);

  // One badge, decisions outranking notifications (design 2.1). When decisions
  // are waiting the badge shows their count in the amber ACT tone and the glyph
  // takes the amber tint; otherwise today's accent-unread behavior is unchanged.
  const showParked = parkedCount > 0;
  const badgeValue = showParked ? parkedCount : count;
  const badge = badgeValue > 99 ? "99+" : String(badgeValue);
  const showBadge = showParked || count > 0;

  // Accessible name, composed decisions-first (spelled out - color is never the
  // only signal), matching the exact copy in design 2.1.
  let label: string;
  if (showParked) {
    const d = `${parkedCount} decision${parkedCount === 1 ? "" : "s"} need${parkedCount === 1 ? "s" : ""} you`;
    label = count > 0 ? `Notifications: ${d}, ${count} unread` : `Notifications: ${d}`;
  } else {
    label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  }

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] text-[var(--color-text)] transition hover:border-[var(--color-accent)] sm:min-h-0 sm:h-[38px] sm:w-[38px]"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={showParked ? { color: ACT_TONE } : undefined}
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {showBadge && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none"
            style={
              showParked
                ? { background: ACT_TONE, color: "var(--color-ink)" }
                : { background: "var(--color-accent)", color: "#fff" }
            }
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <NotificationPanel
          events={events}
          prefs={prefs}
          parkedCount={parkedCount}
          onReviewDecisions={() => {
            setOpen(false);
            onReviewDecisions();
          }}
          onTogglePref={(type: NotificationType) => savePrefs({ ...prefs, [type]: !prefs[type] })}
          onNavigate={onNavigate}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
