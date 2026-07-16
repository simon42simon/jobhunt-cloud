import { describe, it, expect } from "vitest";
import {
  DEFER_SNOOZE_DAYS,
  OWNER_DECISION_LABEL,
  PARKED_LABEL,
  buildDeferComment,
  daysBetween,
  isParkedForOwner,
  isSnoozed,
  selectActiveDecisions,
  selectDeferredDecisions,
  selectParkedDecisions,
  snoozeResurfaceDate,
} from "../src/lib/decisions";
import type { Task } from "../src/types";

// ADR-021 / t-1783371847653: "Defer" must SNOOZE a decision out of the ACTIVE
// inbox for DEFER_SNOOZE_DAYS instead of leaving it counted-and-visible (the old
// bug: Defer only appended a comment, so the decision reappeared on refresh). The
// snooze is DERIVED PURELY from the existing "Owner deferred on YYYY-MM-DD"
// comment - no new field - so tasks.yaml stays the source of truth. Pure node-env
// tests (this project's decisions-test posture).

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t-1000",
    title: "Decide the thing",
    detail: "PARKED FOR OWNER\nWhy this needs you: ...",
    epic: "general",
    priority: "high",
    status: "triage",
    created: "2026-07-06",
    labels: [OWNER_DECISION_LABEL, PARKED_LABEL],
    comments: [],
    ...over,
  };
}

// A parked task carrying a defer comment dated `on`.
function deferredTask(on: string, over: Partial<Task> = {}): Task {
  return mkTask({
    comments: [{ author: "owner", body: buildDeferComment(on).body }],
    ...over,
  });
}

describe("daysBetween (pure whole-day arithmetic, DST-safe)", () => {
  it("counts calendar days and is signed", () => {
    expect(daysBetween("2026-07-01", "2026-07-08")).toBe(7);
    expect(daysBetween("2026-07-08", "2026-07-01")).toBe(-7);
    expect(daysBetween("2026-07-01", "2026-07-01")).toBe(0);
  });

  it("crosses month/year boundaries correctly", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("is NaN on a malformed date", () => {
    expect(daysBetween("nope", "2026-07-01")).toBeNaN();
  });
});

describe("isSnoozed (deferred within DEFER_SNOOZE_DAYS)", () => {
  it("a task never deferred is never snoozed", () => {
    expect(isSnoozed(mkTask(), "2026-07-10")).toBe(false);
  });

  it("is snoozed on the day of the defer and through the window", () => {
    const on = "2026-07-07";
    expect(isSnoozed(deferredTask(on), on)).toBe(true); // same day
    expect(isSnoozed(deferredTask(on), "2026-07-13")).toBe(true); // day 6 (< 7)
  });

  it("resurfaces once the window has fully elapsed", () => {
    const on = "2026-07-07";
    // day 7 (== DEFER_SNOOZE_DAYS) is no longer snoozed
    expect(isSnoozed(deferredTask(on), "2026-07-14")).toBe(false);
    expect(isSnoozed(deferredTask(on), "2026-08-01")).toBe(false);
  });

  it("uses the LATEST defer when a decision was deferred more than once", () => {
    const t = mkTask({
      comments: [
        { author: "owner", body: buildDeferComment("2026-06-01").body },
        { author: "owner", body: buildDeferComment("2026-07-07").body },
      ],
    });
    // The stale June defer would have elapsed; the July one still snoozes it.
    expect(isSnoozed(t, "2026-07-10")).toBe(true);
  });
});

describe("snoozeResurfaceDate", () => {
  it("is the latest defer date + DEFER_SNOOZE_DAYS", () => {
    expect(snoozeResurfaceDate(deferredTask("2026-07-07"))).toBe("2026-07-14");
    expect(DEFER_SNOOZE_DAYS).toBe(7);
  });
  it("is null when never deferred", () => {
    expect(snoozeResurfaceDate(mkTask())).toBeNull();
  });
});

describe("active vs deferred selection (the reported bug's real fix)", () => {
  const today = "2026-07-10";
  const activeA = mkTask({ id: "t-a", created: "2026-07-09" });
  const snoozed = deferredTask("2026-07-08", { id: "t-b", created: "2026-07-05" }); // day 2, snoozed
  const elapsed = deferredTask("2026-06-01", { id: "t-c", created: "2026-07-01" }); // long past, resurfaced
  const tasks = [activeA, snoozed, elapsed];

  it("a freshly-deferred decision LEAVES the active inbox (fixes 'reappears on refresh')", () => {
    const active = selectActiveDecisions(tasks, today).map((t) => t.id);
    expect(active).not.toContain("t-b");
    // The still-active and the resurfaced ones remain.
    expect(active).toEqual(expect.arrayContaining(["t-a", "t-c"]));
  });

  it("the deferred selection is exactly the currently-snoozed set", () => {
    expect(selectDeferredDecisions(tasks, today).map((t) => t.id)).toEqual(["t-b"]);
  });

  it("active + deferred partition the full parked set (nothing lost, nothing double-counted)", () => {
    const parked = selectParkedDecisions(tasks).map((t) => t.id).sort();
    const split = [
      ...selectActiveDecisions(tasks, today),
      ...selectDeferredDecisions(tasks, today),
    ]
      .map((t) => t.id)
      .sort();
    expect(split).toEqual(parked);
  });

  it("a resolved (terminal) decision is neither active nor deferred", () => {
    const done = deferredTask("2026-07-09", { id: "t-done", status: "done" });
    expect(isParkedForOwner(done)).toBe(false);
    expect(selectActiveDecisions([done], today)).toEqual([]);
    expect(selectDeferredDecisions([done], today)).toEqual([]);
  });
});
