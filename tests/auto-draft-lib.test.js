// SIM-596 (JP-4) - pure unit tests for server/lib.js's nightly auto-draft
// scheduler helpers (todayET, msUntilNextAutoDraftFire, selectAutoDraftCandidates).
// No socket, no fs, no server boot - the selection/timing math is exercised
// directly, including across the two DST transitions per year.

import { describe, it, expect } from "vitest";
import { todayET, msUntilNextAutoDraftFire, selectAutoDraftCandidates } from "../server/lib.js";

describe("todayET", () => {
  it("reads the calendar date in America/Toronto, not the machine's own timezone", () => {
    // 2026-07-23T05:03:00Z is 2026-07-23T01:03:00-04:00 (EDT) - same calendar day
    expect(todayET(new Date("2026-07-23T05:03:00.000Z"))).toBe("2026-07-23");
    // 2026-01-01T04:30:00Z is 2025-12-31T23:30:00-05:00 (EST) - the UTC date has
    // already rolled to Jan 1, but ET is still Dec 31 - proves this is NOT a
    // naive UTC slice.
    expect(todayET(new Date("2026-01-01T04:30:00.000Z"))).toBe("2025-12-31");
  });
});

describe("msUntilNextAutoDraftFire", () => {
  it("returns the ms to the SAME day's 2am ET when called before it", () => {
    const now = new Date("2026-07-23T05:03:00.000Z"); // 01:03 EDT
    const ms = msUntilNextAutoDraftFire(now);
    const fireAt = new Date(now.getTime() + ms);
    expect(fireAt.toISOString()).toBe("2026-07-23T06:00:00.000Z"); // 02:00 EDT
  });

  it("rolls to TOMORROW's 2am ET when called after today's has passed", () => {
    const now = new Date("2026-07-23T07:00:00.000Z"); // 03:00 EDT, past today's 2am
    const ms = msUntilNextAutoDraftFire(now);
    const fireAt = new Date(now.getTime() + ms);
    expect(fireAt.toISOString()).toBe("2026-07-24T06:00:00.000Z"); // tomorrow 02:00 EDT
  });

  it("never returns zero/negative (floors at 1s)", () => {
    // called AT the exact fire instant
    const now = new Date("2026-07-23T06:00:00.000Z");
    expect(msUntilNextAutoDraftFire(now)).toBeGreaterThanOrEqual(1000);
  });

  // "The night before" cases below land the tomorrow-probe EXACTLY on the DST
  // transition instant itself (2am local is precisely when the offset flips),
  // which is inherently ambiguous - ICU may resolve that exact instant to
  // either side. The code comment on msUntilNextAutoDraftFire documents this:
  // "the two nights a year DST actually flips are the only ones where the
  // fired instant may be off by up to an hour, which is immaterial for a
  // nightly batch job" - so these assert a BOUNDED range (not exact equality)
  // to prove there is no unbounded drift, while a same-day call (the "after"
  // cases, and every other test in this file) is asserted exactly since it
  // never touches the ambiguous instant.
  it("stays bounded (never drifts more than an hour) across the spring-forward transition (2026-03-08), and is exact same-day", () => {
    const beforeSpringForward = new Date("2026-03-07T17:00:00.000Z"); // noon EST, the day before
    const ms1 = msUntilNextAutoDraftFire(beforeSpringForward);
    const fire1 = new Date(beforeSpringForward.getTime() + ms1).getTime();
    const expected1 = new Date("2026-03-08T07:00:00.000Z").getTime(); // nominal 02:00 EST
    expect(Math.abs(fire1 - expected1)).toBeLessThanOrEqual(3_600_000);
    // the night AFTER spring-forward: same-day call, no ambiguity - exact EDT (UTC-4)
    const afterSpringForward = new Date("2026-03-09T05:00:00.000Z"); // 01:00 EDT
    const ms2 = msUntilNextAutoDraftFire(afterSpringForward);
    expect(new Date(afterSpringForward.getTime() + ms2).toISOString()).toBe("2026-03-09T06:00:00.000Z"); // 02:00 EDT
  });

  it("stays bounded (never drifts more than an hour) across the fall-back transition (2026-11-01), and is exact same-day", () => {
    const beforeFallBack = new Date("2026-10-31T17:00:00.000Z"); // noon EDT, the day before
    const ms1 = msUntilNextAutoDraftFire(beforeFallBack);
    const fire1 = new Date(beforeFallBack.getTime() + ms1).getTime();
    const expected1 = new Date("2026-11-01T06:00:00.000Z").getTime(); // nominal 02:00 EDT
    expect(Math.abs(fire1 - expected1)).toBeLessThanOrEqual(3_600_000);
    // the night AFTER fall-back: same-day call, no ambiguity - exact EST (UTC-5)
    const afterFallBack = new Date("2026-11-02T05:00:00.000Z"); // 00:00 EST
    const ms2 = msUntilNextAutoDraftFire(afterFallBack);
    expect(new Date(afterFallBack.getTime() + ms2).toISOString()).toBe("2026-11-02T07:00:00.000Z"); // 02:00 EST
  });
});

describe("selectAutoDraftCandidates", () => {
  const job = (over) => ({ id: over.id, status: "queued", hasCV: false, deadline: null, sector: "municipal", ...over });
  const TODAY = "2026-07-23";

  it("selects a queued, undrafted, public-sector job with a deadline inside the window", () => {
    const jobs = [job({ id: "A", deadline: "2026-07-25" })]; // +2 days
    const { selected, overflow } = selectAutoDraftCandidates(jobs, { todayET: TODAY });
    expect(selected.map((j) => j.id)).toEqual(["A"]);
    expect(overflow).toBe(0);
  });

  it("includes a deadline of TODAY (inclusive lower bound)", () => {
    const jobs = [job({ id: "A", deadline: TODAY })];
    expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected.map((j) => j.id)).toEqual(["A"]);
  });

  it("includes a deadline exactly windowDays out, excludes windowDays+1 (inclusive upper bound)", () => {
    const jobs = [job({ id: "in", deadline: "2026-07-26" }), job({ id: "out", deadline: "2026-07-27" })];
    const { selected } = selectAutoDraftCandidates(jobs, { todayET: TODAY, windowDays: 3 });
    expect(selected.map((j) => j.id)).toEqual(["in"]);
  });

  it("excludes a PAST deadline (sweepExpiredJobs already closes those, but this must never re-surface one)", () => {
    const jobs = [job({ id: "A", deadline: "2026-07-22" })];
    expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected).toEqual([]);
  });

  it("excludes hasCV=true (already drafted - no separate dedupe pass needed)", () => {
    const jobs = [job({ id: "A", deadline: "2026-07-24", hasCV: true })];
    expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected).toEqual([]);
  });

  it("excludes a status other than queued", () => {
    for (const status of ["lead", "drafted", "ready", "submitted"]) {
      const jobs = [job({ id: "A", deadline: "2026-07-24", status })];
      expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected, status).toEqual([]);
    }
  });

  it("excludes rolling/blank deadlines (v1 scope: deadline-driven public jobs only)", () => {
    const jobs = [job({ id: "rolling", deadline: "rolling" }), job({ id: "blank", deadline: null }), job({ id: "empty", deadline: "" })];
    expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected).toEqual([]);
  });

  it("excludes private-sector jobs (v1 scope)", () => {
    const jobs = [job({ id: "A", deadline: "2026-07-24", sector: "private" })];
    expect(selectAutoDraftCandidates(jobs, { todayET: TODAY }).selected).toEqual([]);
  });

  it("keeps public sectors: municipal/provincial/federal/bps/nonprofit", () => {
    const sectors = ["municipal", "provincial", "federal", "bps", "nonprofit"];
    const jobs = sectors.map((sector, i) => job({ id: `job-${i}`, deadline: "2026-07-24", sector }));
    const { selected } = selectAutoDraftCandidates(jobs, { todayET: TODAY });
    expect(selected).toHaveLength(sectors.length);
  });

  it("orders by earliest deadline first (most urgent favored under the cap)", () => {
    const jobs = [job({ id: "late", deadline: "2026-07-26" }), job({ id: "early", deadline: "2026-07-24" }), job({ id: "mid", deadline: "2026-07-25" })];
    const { selected } = selectAutoDraftCandidates(jobs, { todayET: TODAY });
    expect(selected.map((j) => j.id)).toEqual(["early", "mid", "late"]);
  });

  it("caps the selection and reports the excess as `overflow` (never silently dropped)", () => {
    const jobs = Array.from({ length: 12 }, (_, i) => job({ id: `job-${i}`, deadline: "2026-07-24" }));
    const { selected, overflow } = selectAutoDraftCandidates(jobs, { todayET: TODAY, cap: 10 });
    expect(selected).toHaveLength(10);
    expect(overflow).toBe(2);
  });

  it("applies isPending's dedupe BEFORE the cap - an already-pending job never occupies a cap slot a fresh job could use", () => {
    // 2 already-pending (earliest deadlines - would normally win the cap
    // race) + 9 fresh jobs, cap 10: without dedupe-before-cap, the 2 stale
    // ones would eat 2 slots and only 8 of the 9 fresh ones would fit.
    const jobs = [
      job({ id: "stale-1", deadline: "2026-07-24" }),
      job({ id: "stale-2", deadline: "2026-07-24" }),
      ...Array.from({ length: 9 }, (_, i) => job({ id: `fresh-${i}`, deadline: "2026-07-25" })),
    ];
    const pendingIds = new Set(["stale-1", "stale-2"]);
    const { selected, overflow, skippedPending } = selectAutoDraftCandidates(jobs, {
      todayET: TODAY,
      cap: 10,
      isPending: (j) => pendingIds.has(j.id),
    });
    expect(selected).toHaveLength(9); // ALL 9 fresh jobs fit - none starved by the stale ones
    expect(selected.every((j) => j.id.startsWith("fresh-"))).toBe(true);
    expect(overflow).toBe(0); // no fresh job was pushed out
    expect(skippedPending).toBe(2);
  });

  it("returns empty + zero overflow/skippedPending for a malformed/missing todayET (never throws)", () => {
    expect(selectAutoDraftCandidates([job({ id: "A", deadline: "2026-07-24" })], { todayET: "not-a-date" })).toEqual({
      selected: [],
      overflow: 0,
      skippedPending: 0,
    });
    expect(selectAutoDraftCandidates([job({ id: "A" })], {})).toEqual({ selected: [], overflow: 0, skippedPending: 0 });
  });
});
