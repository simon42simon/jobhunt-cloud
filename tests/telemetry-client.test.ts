import { describe, it, expect } from "vitest";
import {
  buildTelemetryEvent,
  TELEMETRY_MAX_BATCH,
  TELEMETRY_SURFACES,
  type TelemetryEvent,
} from "../src/lib/telemetry";

// Client-side unit tests for the usage-telemetry beacon builder (ADR-017, Wave
// 2). Node-env style (no DOM/React), matching tests/chatbotQueue.test.ts /
// tests/attachments-client.test.ts. The seam under test is buildTelemetryEvent -
// the pure normalizer that every track() call flows through. Its job is the
// CONTENT-BLOCK: an event may carry only a closed kind, a closed surface id, a
// bounded name, an optional journey, a scalar-only meta, and a numeric
// durationMs - and nothing else. The server re-enforces all of this; these tests
// prove the client mirror does too, so a guardian review of the diff can trust
// the client never smuggles content off the page.

const ALLOWED_KEYS = new Set(["sessionId", "kind", "surface", "name", "journey", "meta", "durationMs"]);

function keysOf(ev: TelemetryEvent): string[] {
  return Object.keys(ev);
}

describe("mirror stays in lockstep with the server contract", () => {
  it("exposes exactly the 11 allowlisted surfaces", () => {
    expect([...TELEMETRY_SURFACES]).toEqual([
      "jobs-board",
      "jobs-table",
      "job-detail",
      "discovery-sources",
      "discovery-finds",
      "source-detail",
      "insights",
      "product-hub",
      "chat-capture",
      "notifications",
      "topbar",
    ]);
  });

  it("mirrors the 50-event batch cap", () => {
    expect(TELEMETRY_MAX_BATCH).toBe(50);
  });
});

describe("buildTelemetryEvent - core shape", () => {
  it("builds the minimal event with only the four required fields", () => {
    const ev = buildTelemetryEvent("s1", "action", "topbar", "nav:jobs");
    expect(ev).toEqual({ sessionId: "s1", kind: "action", surface: "topbar", name: "nav:jobs" });
    expect(keysOf(ev!).every((k) => ALLOWED_KEYS.has(k))).toBe(true);
  });

  it("never emits a key outside the allowlist even with every optional field set", () => {
    const ev = buildTelemetryEvent("s1", "action", "jobs-board", "status-change", {
      journey: "J2",
      meta: { to: "submitted", via: "drag" },
      durationMs: 12,
    });
    for (const k of keysOf(ev!)) expect(ALLOWED_KEYS.has(k)).toBe(true);
  });
});

describe("buildTelemetryEvent - name is a bounded id, never content", () => {
  it("caps the name to 80 chars", () => {
    const ev = buildTelemetryEvent("s1", "view", "job-detail", "x".repeat(200));
    expect(ev!.name.length).toBe(80);
  });

  it("removes control chars / newlines/tabs and collapses runs of spaces (server parity)", () => {
    // Control chars (incl. \n \t) are stripped outright, THEN runs of regular
    // spaces collapse to one - exactly the server's scrubTelemetryText order.
    const dirty = `a${String.fromCharCode(10)}b${String.fromCharCode(9)}c   d`;
    const ev = buildTelemetryEvent("s1", "view", "job-detail", dirty);
    expect(ev!.name).toBe("abc d");
    expect(ev!.name).not.toMatch(/[\n\t]/);
  });

  it("returns null when the name scrubs to empty (a soft-drop on the server)", () => {
    expect(buildTelemetryEvent("s1", "view", "job-detail", "   ")).toBeNull();
    expect(buildTelemetryEvent("s1", "view", "job-detail", String.fromCharCode(0))).toBeNull();
  });
});

describe("buildTelemetryEvent - journey gating", () => {
  it("keeps a well-formed journey id", () => {
    const ev = buildTelemetryEvent("s1", "view", "product-hub", "hub:tasks", { journey: "J5" });
    expect(ev!.journey).toBe("J5");
  });

  it("drops a malformed journey rather than failing the event", () => {
    // Cast past the typed union to prove the runtime guard (server: /^J\d{1,2}$/).
    const ev = buildTelemetryEvent("s1", "view", "product-hub", "hub:tasks", {
      journey: "not-a-journey" as unknown as "J5",
    });
    expect(ev!.journey).toBeUndefined();
    expect(ev!.name).toBe("hub:tasks");
  });
});

describe("buildTelemetryEvent - meta is scalar-only (the structural content-block)", () => {
  it("keeps string / number / boolean values", () => {
    const ev = buildTelemetryEvent("s1", "action", "discovery-finds", "triage", {
      meta: { decision: "skip", count: 3, flagged: true },
    });
    expect(ev!.meta).toEqual({ decision: "skip", count: 3, flagged: true });
  });

  it("drops non-scalar values (object / array / null) so no document can ride along", () => {
    const ev = buildTelemetryEvent("s1", "action", "discovery-finds", "triage", {
      meta: {
        ok: "yes",
        nested: { secret: "job title" } as unknown as string,
        list: [1, 2, 3] as unknown as string,
        nothing: null as unknown as string,
      },
    });
    expect(ev!.meta).toEqual({ ok: "yes" });
  });

  it("caps meta at 8 keys, keys at 40 chars, and string values at 60 chars", () => {
    const bigMeta: Record<string, string> = {};
    for (let i = 0; i < 20; i++) bigMeta[`k${i}`] = "v";
    const ev = buildTelemetryEvent("s1", "action", "topbar", "x", { meta: bigMeta });
    expect(Object.keys(ev!.meta!).length).toBe(8);

    const ev2 = buildTelemetryEvent("s1", "action", "topbar", "x", {
      meta: { [`k${"x".repeat(80)}`]: "y".repeat(200) },
    });
    const [k] = Object.keys(ev2!.meta!);
    expect(k.length).toBe(40);
    expect((ev2!.meta![k] as string).length).toBe(60);
  });

  it("omits meta entirely when nothing scalar survives (no empty meta:{})", () => {
    const ev = buildTelemetryEvent("s1", "action", "topbar", "x", {
      meta: { bad: { a: 1 } as unknown as string },
    });
    expect(ev!.meta).toBeUndefined();
    expect("meta" in ev!).toBe(false);
  });

  it("drops non-finite numbers", () => {
    const ev = buildTelemetryEvent("s1", "run", "topbar", "batch-draft", {
      meta: { count: Number.NaN, real: 5 },
    });
    expect(ev!.meta).toEqual({ real: 5 });
  });
});

describe("buildTelemetryEvent - durationMs", () => {
  it("keeps a finite non-negative duration", () => {
    const ev = buildTelemetryEvent("s1", "run", "job-detail", "draft", { durationMs: 0 });
    expect(ev!.durationMs).toBe(0);
  });

  it("drops a negative or non-finite duration", () => {
    expect(buildTelemetryEvent("s1", "run", "job-detail", "draft", { durationMs: -1 })!.durationMs).toBeUndefined();
    expect(
      buildTelemetryEvent("s1", "run", "job-detail", "draft", { durationMs: Number.POSITIVE_INFINITY })!.durationMs,
    ).toBeUndefined();
  });
});
