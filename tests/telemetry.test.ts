import { describe, it, expect } from "vitest";
import { buildTelemetryEvent, TELEMETRY_MAX_BATCH, TELEMETRY_SURFACES } from "../src/lib/telemetry";
import type { TelemetryExtra } from "../src/lib/telemetry";

// Unit tests for the telemetry client's pure event builder (ADR-017). The module
// also contains browser-only transport (sendBeacon/fetch) and React wiring; this
// file pins the normalization + caps that prevent malformed events from ever
// leaving the page, without needing a DOM or network.

describe("buildTelemetryEvent", () => {
  it("normalizes a valid event into the required shape", () => {
    const event = buildTelemetryEvent("sess-123", "action", "jobs-board", "save-view");
    expect(event).toMatchObject({
      sessionId: "sess-123",
      kind: "action",
      surface: "jobs-board",
      name: "save-view",
    });
    expect(Object.keys(event ?? {})).not.toContain("meta");
    expect(Object.keys(event ?? {})).not.toContain("journey");
  });

  it("accepts a valid journey and scalar meta", () => {
    const extra: TelemetryExtra = {
      journey: "J1",
      meta: { to: "submitted", via: "drag" },
      durationMs: 42,
    };
    const event = buildTelemetryEvent("sess-123", "view", "jobs-board", "jobs-board", extra);
    expect(event).toMatchObject({
      journey: "J1",
      meta: { to: "submitted", via: "drag" },
      durationMs: 42,
    });
  });

  it("caps session id, name, and meta keys/values", () => {
    const bigName = "x".repeat(200);
    const bigSession = "s".repeat(100);
    const event = buildTelemetryEvent(bigSession, "action", "jobs-board", bigName, {
      meta: {
        ["  "]: "v", // whitespace-only key scrubs to empty and is dropped
        ["good-key"]: "v".repeat(100),
      },
    });
    expect(event?.sessionId.length).toBeLessThanOrEqual(40);
    expect(event?.name.length).toBeLessThanOrEqual(80);
    expect(Object.keys(event?.meta ?? {})).toHaveLength(1);
    expect(Object.keys(event?.meta ?? {})).toContain("good-key");
    expect(Object.values(event?.meta ?? {})).not.toContain("v".repeat(100));
  });

  it("drops non-scalar meta values", () => {
    const event = buildTelemetryEvent("sess", "action", "jobs-board", "click", {
      meta: {
        good: "yes",
        badArray: [1, 2],
        badObject: { nested: 1 },
        badFunction: () => true,
      },
    });
    expect(event?.meta).toEqual({ good: "yes" });
  });

  it("drops non-finite numbers from meta and durationMs", () => {
    const event = buildTelemetryEvent("sess", "action", "jobs-board", "click", {
      meta: { count: 5, bad: NaN, infinite: Infinity },
      durationMs: NaN,
    });
    expect(event?.meta).toEqual({ count: 5 });
    expect(Object.keys(event ?? {})).not.toContain("durationMs");
  });

  it("returns null when the name scrubs to empty", () => {
    expect(buildTelemetryEvent("sess", "action", "jobs-board", "")).toBeNull();
    expect(buildTelemetryEvent("sess", "action", "jobs-board", "   ")).toBeNull();
    expect(buildTelemetryEvent("sess", "action", "jobs-board", "\n\t  ")).toBeNull();
  });

  it("allows an empty session id but keeps the name behavior intact", () => {
    const emptySession = buildTelemetryEvent("", "action", "jobs-board", "click");
    expect(emptySession).not.toBeNull();
    expect(emptySession?.sessionId).toBe("");
    // only a missing name causes a null return
    expect(buildTelemetryEvent("   ", "action", "jobs-board", "click")).not.toBeNull();
    expect(buildTelemetryEvent("   ", "action", "jobs-board", "")).toBeNull();
  });

  it("drops invalid journeys", () => {
    const withJourney = buildTelemetryEvent("sess", "action", "jobs-board", "click", { journey: "J1" });
    expect(withJourney?.journey).toBe("J1");

    const badJourney = buildTelemetryEvent("sess", "action", "jobs-board", "click", { journey: "J999" as "J1" });
    expect(Object.keys(badJourney ?? {})).not.toContain("journey");

    const malformed = buildTelemetryEvent("sess", "action", "jobs-board", "click", { journey: "nope" as "J1" });
    expect(Object.keys(malformed ?? {})).not.toContain("journey");
  });

  it("scrubs control characters and collapses whitespace", () => {
    const event = buildTelemetryEvent("sess\n id", "action", "jobs-board", "my\n event", {
      meta: { "key\n": "value   with     spaces" },
    });
    expect(event?.sessionId).not.toContain("\n");
    expect(event?.name).toBe("my event");
    expect(event?.meta).toEqual({ key: "value with spaces" });
  });

  it("returns undefined meta when all meta values are dropped", () => {
    const event = buildTelemetryEvent("sess", "action", "jobs-board", "click", {
      meta: { badObj: { x: 1 }, badArray: [1] },
    });
    expect(event?.meta).toBeUndefined();
    expect(Object.keys(event ?? {})).not.toContain("meta");
  });

  it("omits negative durations", () => {
    const event = buildTelemetryEvent("sess", "action", "jobs-board", "click", { durationMs: -5 });
    expect(Object.keys(event ?? {})).not.toContain("durationMs");
  });
});

describe("telemetry constants", () => {
  it("TELEMETRY_MAX_BATCH is a positive integer", () => {
    expect(Number.isInteger(TELEMETRY_MAX_BATCH)).toBe(true);
    expect(TELEMETRY_MAX_BATCH).toBeGreaterThan(0);
  });

  it("TELEMETRY_SURFACES lists every surface the app can track", () => {
    expect(TELEMETRY_SURFACES.length).toBeGreaterThan(0);
    for (const surface of TELEMETRY_SURFACES) {
      expect(typeof surface).toBe("string");
      expect(surface.length).toBeGreaterThan(0);
    }
  });

  it("batch cap is at least the eager-flush threshold (40)", () => {
    expect(TELEMETRY_MAX_BATCH).toBeGreaterThanOrEqual(40);
  });
});
