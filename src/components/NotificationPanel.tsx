import { useEffect, useRef, useState } from "react";
import { attentionToneColor, hexA, statusColor } from "../lib/statusColors";
import { Badge } from "ssc-ui";
import {
  NOTIFICATION_META,
  NOTIFICATION_TYPES,
  filterNotifications,
  isTimedNotification,
  notificationColorKey,
  notificationMeta,
  type NotificationPrefs,
} from "../lib/notifications";
import { relativeTime } from "../lib/time";
import type { Notification, NotificationType } from "../types";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";
import type { ViewMode } from "./TopBar";

// Slide-over notification drawer. Reuses the exact drawer + focus-trap contract
// the app's other overlays follow (AgentDrawer in TeamView, the ChatCapture
// panel): role=dialog + aria-modal, Escape closes, Tab/Shift+Tab is trapped
// inside (via the shared dialogFocus helpers), and focus is restored to the
// opener (the bell) on close. All color comes from lib/statusColors (hexA over
// a STATUS_COLOR key) - no raw hex.

// The ACT/amber tone (vetted dueSoon hue) for the pinned decisions banner -
// distinct from every FYI event tone in the feed below.
const ACT_TONE = attentionToneColor("dueSoon");

// A branching "choose a path" glyph for the decisions banner, deliberately
// distinct from every TypeIcon in the feed so a call to ACT never reads like an
// FYI event. Decorative - the banner heading + button carry the meaning.
function DecisionGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M6 12h6a3 3 0 0 0 3-3v-.5" />
    </svg>
  );
}

// One glyph per type, currentColor so the row's tint applies. Icon + text label
// together (never color alone) carry the meaning, so the row is legible to
// color-blind users and in high-contrast modes.
function TypeIcon({ type }: { type: NotificationType }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 15,
    height: 15,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (type) {
    case "run_finished":
      // terminal / agent run
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3M13 15h4" />
        </svg>
      );
    case "wave_done":
      // stacked layers = a batch/wave
      return (
        <svg {...common}>
          <path d="M12 3l9 5-9 5-9-5 9-5z" />
          <path d="M3 13l9 5 9-5" />
        </svg>
      );
    case "task_added":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "task_done":
      return (
        <svg {...common}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      );
    case "project_added":
      // flag = a new project
      return (
        <svg {...common}>
          <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
        </svg>
      );
    default:
      // Unknown/future type (defense-in-depth, t-1783145481687): a neutral
      // info glyph so the generic row still carries icon + label together.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      );
  }
}

// Task/project events deep-link to the Product Hub (which hosts the Tasks board
// and Projects); run/wave events are informational (no obvious in-lane target),
// matching "a cheap click-through where obvious".
function targetFor(n: Notification): ViewMode | null {
  if (n.ref.kind === "task" || n.ref.kind === "project") return "product";
  return null;
}

function EventRow({ n, onNavigate }: { n: Notification; onNavigate: (v: ViewMode) => void }) {
  const c = statusColor(notificationColorKey(n));
  // Guarded lookup (t-1783145481687): a type this build doesn't know renders
  // as a generic row (raw type string as its label) instead of throwing -
  // this row renders OUTSIDE App's <main> ErrorBoundary, so a bare unguarded
  // META-table index on the row's type used to white-screen the whole app.
  const meta = notificationMeta(n.type);
  const target = targetFor(n);
  const timed = isTimedNotification(n.type);

  const body = (
    <>
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ color: c, background: hexA(c, 0.16) }}
      >
        <TypeIcon type={n.type} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={c} className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {meta.label}
          </Badge>
          {n.unread && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: statusColor("todo") }}
              aria-hidden="true"
            />
          )}
          {n.unread && <span className="sr-only">unread</span>}
        </span>
        <span className="mt-1 block text-[13px] font-medium leading-snug text-[var(--color-text)]">
          {n.title}
        </span>
        <span className="mt-0.5 block text-[11px] text-[var(--color-muted)]">
          {timed ? (
            <time dateTime={n.ts} title={new Date(n.ts).toLocaleString()} className="tabular-nums">
              {relativeTime(n.ts)}
            </time>
          ) : (
            "new"
          )}
          {target && (
            <span className="text-[var(--color-accent-text)]">
              {" · "}
              {n.ref.kind === "project" ? "Open Projects →" : "Open Tasks →"}
            </span>
          )}
        </span>
      </span>
    </>
  );

  const rowCls =
    "flex w-full items-start gap-2.5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-2.5 text-left";

  if (target) {
    return (
      <button
        type="button"
        onClick={() => onNavigate(target)}
        aria-label={`${meta.label}: ${n.title}. ${n.ref.kind === "project" ? "Open Projects" : "Open Tasks board"}`}
        className={`${rowCls} min-h-[44px] transition hover:border-[var(--color-accent)]`}
      >
        {body}
      </button>
    );
  }
  return <div className={rowCls}>{body}</div>;
}

export function NotificationPanel({
  events,
  prefs,
  parkedCount,
  onReviewDecisions,
  onTogglePref,
  onNavigate,
  onClose,
}: {
  events: Notification[];
  prefs: NotificationPrefs;
  // Parked owner-decisions (design 2.2). When > 0 a pinned "needs you" banner is
  // the FIRST element, ABOVE the feed and OUTSIDE the filterable/markable list -
  // the type filters and "mark all read" never touch it; it persists exactly as
  // long as a decision is parked.
  parkedCount: number;
  onReviewDecisions: () => void;
  onTogglePref: (type: NotificationType) => void;
  onNavigate: (v: ViewMode) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  // On mount: remember the opener (the bell) and move focus in. On unmount:
  // hand focus back - identical to AgentDrawer.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = panelRef.current ? getFocusableElements(panelRef.current) : [];
    focusable[0]?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  // Escape closes; Tab/Shift+Tab trapped inside the panel while open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const target = nextTrapTarget(
        getFocusableElements(panelRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const visible = filterNotifications(events, prefs);

  // How the segmented-off filters manifest, so an empty-looking panel is never
  // mistaken for "nothing happened".
  const hiddenCount = events.length - visible.length;

  function navigateAndClose(v: ViewMode) {
    onNavigate(v);
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notif-panel-title"
        tabIndex={-1}
        className="fixed right-0 top-0 z-50 flex h-full w-[min(420px,92vw)] flex-col overflow-hidden border-l border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--color-edge)] p-4">
          <div>
            <h2 id="notif-panel-title" className="text-[15px] font-semibold text-[var(--color-text)]">
              Notifications
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Runs, waves, tasks &amp; projects</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSettings((s) => !s)}
              aria-label="Notification settings"
              aria-pressed={showSettings}
              title="Settings"
              className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border transition ${
                showSettings
                  ? "border-[var(--color-accent)] text-[var(--color-text)]"
                  : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              &#x2715;
            </button>
          </div>
        </div>

        {/* Settings: per-type show/hide, persisted in localStorage by the bell. */}
        {showSettings && (
          <div className="shrink-0 border-b border-[var(--color-edge)] bg-[var(--color-panel-2)] p-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Show these events
            </div>
            <ul className="flex flex-col gap-1">
              {NOTIFICATION_TYPES.map((t) => (
                <li key={t}>
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-[var(--color-text)] hover:bg-[var(--color-panel)] sm:min-h-0">
                    <input
                      type="checkbox"
                      checked={prefs[t]}
                      onChange={() => onTogglePref(t)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    {NOTIFICATION_META[t].label}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pinned "needs you" banner (design 2.2): FIRST element, ABOVE the feed
            and OUTSIDE the filterable/markable list. It is NOT an EventRow -
            markNotificationsRead and the type filters never touch it; it persists
            exactly as long as a decision is parked. */}
        {parkedCount > 0 && (
          <div className="shrink-0 border-b border-[var(--color-edge)] p-3">
            <div
              className="flex items-start gap-2.5 rounded-lg p-3"
              style={{ background: hexA(ACT_TONE, 0.14), border: `1px solid ${hexA(ACT_TONE, 0.4)}` }}
            >
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{ color: ACT_TONE, background: hexA(ACT_TONE, 0.16) }}
              >
                <DecisionGlyph />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-[var(--color-text)]">
                  {parkedCount} decision{parkedCount === 1 ? "" : "s"} need{parkedCount === 1 ? "s" : ""} you
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Parked for your call.</p>
                <button
                  type="button"
                  onClick={onReviewDecisions}
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-md px-3 text-[12px] font-semibold sm:min-h-0 sm:py-1.5"
                  style={{ background: ACT_TONE, color: "var(--color-ink)" }}
                >
                  Review decisions
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Feed - newest first (server order preserved). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          {visible.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                {events.length === 0 ? "You're all caught up" : "Nothing to show"}
              </div>
              <p className="max-w-[260px] text-[12px] leading-relaxed text-[var(--color-muted)]">
                {events.length === 0
                  ? "Finished runs, completed waves, and new tasks or projects will appear here."
                  : `${hiddenCount} ${hiddenCount === 1 ? "notification is" : "notifications are"} hidden by your filters.`}
              </p>
              {events.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  className="mt-1 min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0 sm:py-1.5"
                >
                  Adjust filters
                </button>
              )}
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {visible.map((n) => (
                  <li key={n.id}>
                    <EventRow n={n} onNavigate={navigateAndClose} />
                  </li>
                ))}
              </ul>
              {hiddenCount > 0 && (
                <p className="mt-3 text-center text-[11px] text-[var(--color-muted)]">
                  {hiddenCount} {hiddenCount === 1 ? "notification" : "notifications"} hidden by your filters
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
