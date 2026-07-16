import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_META,
  NOTIFICATION_TYPES,
  coercePrefs,
  filterNotifications,
  isTimedNotification,
  notificationColorKey,
  unreadCount,
  type NotificationPrefs,
} from "../src/lib/notifications";
import { statusColor, STATUS_COLOR } from "../src/lib/statusColors";
import type { Notification, NotificationType } from "../src/types";

// Unit tests for the notification-bell PURE helpers (the localStorage load/save
// and rendering live in the components; this file, node-env like
// statusColors.test.ts, covers only the deterministic logic): the per-type
// metadata is complete, the color mapping only ever names a real (pre-vetted)
// STATUS_COLOR hue, the client-side filter honors prefs, and the badge count
// tracks the filtered-unread set.

function ev(over: Partial<Notification> & { type: NotificationType; ref: Notification["ref"] }): Notification {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type,
    ts: over.ts ?? "2026-07-03T10:00:00.000Z",
    title: over.title ?? "Something happened",
    ref: over.ref,
    unread: over.unread ?? false,
  };
}

describe("NOTIFICATION_META / types", () => {
  it("has metadata for every declared type and vice-versa", () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_META[t], t).toBeTruthy();
      expect(NOTIFICATION_META[t].label.length, t).toBeGreaterThan(0);
    }
    // No stray meta key that isn't a declared type.
    expect(Object.keys(NOTIFICATION_META).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("marks only the activity-log events as timed (real clock), detections as not", () => {
    expect(isTimedNotification("run_finished")).toBe(true);
    expect(isTimedNotification("wave_done")).toBe(true);
    expect(isTimedNotification("task_added")).toBe(false);
    expect(isTimedNotification("task_done")).toBe(false);
    expect(isTimedNotification("project_added")).toBe(false);
  });
});

describe("notificationColorKey", () => {
  it("only ever names a key that STATUS_COLOR actually defines (never the muted fallback)", () => {
    const samples: Notification[] = [
      ev({ type: "run_finished", ref: { kind: "run", runId: "r1", routine: "x", jobId: null, status: "done" } }),
      ev({ type: "run_finished", ref: { kind: "run", runId: "r2", routine: "x", jobId: null, status: "failed" } }),
      ev({ type: "run_finished", ref: { kind: "run", runId: "r3", routine: "x", jobId: null, status: "stopped" } }),
      ev({ type: "run_finished", ref: { kind: "run", runId: "r4", routine: "x", jobId: null, status: "running" } }),
      ev({ type: "wave_done", ref: { kind: "batch", batchId: "b1", total: 4, done: 4, failed: 0, stopped: 0 } }),
      ev({ type: "wave_done", ref: { kind: "batch", batchId: "b2", total: 4, done: 2, failed: 2, stopped: 0 } }),
      ev({ type: "wave_done", ref: { kind: "batch", batchId: "b3", total: 4, done: 3, failed: 0, stopped: 1 } }),
      ev({ type: "task_added", ref: { kind: "task", id: "t1" } }),
      ev({ type: "task_done", ref: { kind: "task", id: "t2" } }),
      ev({ type: "project_added", ref: { kind: "project", id: "p1" } }),
    ];
    for (const n of samples) {
      const key = notificationColorKey(n);
      expect(STATUS_COLOR[key], `${n.type}/${n.ref.kind} -> ${key}`).toBeTruthy();
      // statusColor must resolve to that mapped hue, not the muted default.
      expect(statusColor(key)).toBe(STATUS_COLOR[key]);
    }
  });

  it("routes failure outcomes to a distinct (attention) hue from success", () => {
    const okRun = ev({ type: "run_finished", ref: { kind: "run", runId: "r", routine: "x", jobId: null, status: "done" } });
    const badRun = ev({ type: "run_finished", ref: { kind: "run", runId: "r", routine: "x", jobId: null, status: "failed" } });
    expect(notificationColorKey(okRun)).not.toBe(notificationColorKey(badRun));

    const okWave = ev({ type: "wave_done", ref: { kind: "batch", batchId: "b", total: 3, done: 3, failed: 0, stopped: 0 } });
    const badWave = ev({ type: "wave_done", ref: { kind: "batch", batchId: "b", total: 3, done: 1, failed: 2, stopped: 0 } });
    expect(notificationColorKey(okWave)).not.toBe(notificationColorKey(badWave));
  });

  it("a USER-STOPPED wave is paused (muted), never the failure hue (t-1783091385623)", () => {
    // `ref.failed` used to lump stopped members in, so a batch the owner
    // deliberately stopped tinted as blocked. Stopped-only waves now mirror the
    // single-run mapping: stopped -> paused; a genuine failure still wins.
    const stoppedWave = ev({ type: "wave_done", ref: { kind: "batch", batchId: "b", total: 3, done: 2, failed: 0, stopped: 1 } });
    const failedWave = ev({ type: "wave_done", ref: { kind: "batch", batchId: "b", total: 3, done: 2, failed: 1, stopped: 0 } });
    const stoppedRun = ev({ type: "run_finished", ref: { kind: "run", runId: "r", routine: "x", jobId: null, status: "stopped" } });
    expect(notificationColorKey(stoppedWave)).toBe(notificationColorKey(stoppedRun)); // paused
    expect(notificationColorKey(stoppedWave)).not.toBe(notificationColorKey(failedWave));
    // A wave with BOTH a failure and a stop still demands attention.
    const mixedWave = ev({ type: "wave_done", ref: { kind: "batch", batchId: "b", total: 3, done: 1, failed: 1, stopped: 1 } });
    expect(notificationColorKey(mixedWave)).toBe(notificationColorKey(failedWave));
  });
});

describe("coercePrefs", () => {
  it("defaults every type to shown", () => {
    for (const t of NOTIFICATION_TYPES) expect(DEFAULT_NOTIFICATION_PREFS[t]).toBe(true);
  });

  it("overlays only known-type booleans and ignores junk", () => {
    const merged = coercePrefs({ task_added: false, bogus: true, run_finished: "nope" });
    expect(merged.task_added).toBe(false); // honored
    expect(merged.run_finished).toBe(true); // non-boolean ignored -> default
    expect((merged as Record<string, unknown>).bogus).toBeUndefined();
    // Untouched types keep their default.
    expect(merged.wave_done).toBe(true);
  });

  it("returns all-defaults for non-object input", () => {
    expect(coercePrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(coercePrefs("garbage")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(coercePrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });
});

describe("filterNotifications / unreadCount", () => {
  const events: Notification[] = [
    ev({ type: "run_finished", unread: true, ref: { kind: "run", runId: "r", routine: "x", jobId: null, status: "done" } }),
    ev({ type: "task_added", unread: true, ref: { kind: "task", id: "t1" } }),
    ev({ type: "task_added", unread: false, ref: { kind: "task", id: "t2" } }),
    ev({ type: "project_added", unread: true, ref: { kind: "project", id: "p1" } }),
  ];

  it("hides only the switched-off types", () => {
    const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, task_added: false };
    const visible = filterNotifications(events, prefs);
    expect(visible.map((e) => e.type)).toEqual(["run_finished", "project_added"]);
  });

  it("counts only filtered-unread events toward the badge", () => {
    // All shown: 3 unread (run + task t1 + project).
    expect(unreadCount(events, DEFAULT_NOTIFICATION_PREFS)).toBe(3);
    // Hide task_added -> drops its one unread (t1); run + project remain.
    const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, task_added: false };
    expect(unreadCount(events, prefs)).toBe(2);
  });

  it("shows an unknown future type by default (fail-open filter)", () => {
    const future = ev({ type: "future_kind" as NotificationType, ref: { kind: "task", id: "z" } });
    expect(filterNotifications([future], DEFAULT_NOTIFICATION_PREFS)).toHaveLength(1);
  });
});
