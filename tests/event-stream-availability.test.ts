// SIM-390 item 3 - the shared EventSource is gated on the server-declared SSE
// capability. On the pg-backed cloud instances GET /api/stream 503s, so the
// client must not fire the request at all until /api/config answers, and never
// when it answers `sse: false`.
//
// The module computes IN_BROWSER at load time, so a fake window + EventSource
// are installed BEFORE a dynamic import - the "browser" here is just enough
// transport surface to count constructor calls; no DOM framework involved.

import { describe, it, expect, beforeAll, afterEach } from "vitest";

const opened: FakeEventSource[] = [];

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

let stream: typeof import("../src/hooks/useEventStream");

beforeAll(async () => {
  // Install the fake browser BEFORE the module evaluates IN_BROWSER.
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  stream = await import("../src/hooks/useEventStream");
});

afterEach(() => {
  opened.length = 0;
});

describe("EventSource availability gate", () => {
  it("defers the connection while availability is unknown (no doomed request)", () => {
    const off = stream.subscribe("jobs-changed", () => {});
    // Before the fix the first subscribe() opened /api/stream immediately -
    // exactly the request that 503s on the cloud instances.
    expect(opened.length).toBe(0);
    off();
  });

  it("connects once the server declares SSE available", () => {
    const off = stream.subscribe("jobs-changed", () => {});
    stream.setStreamAvailability(true);
    expect(opened.length).toBe(1);
    expect(opened[0].url).toBe("/api/stream");
    off();
    stream.setStreamAvailability(false); // tear down for the next test
  });

  it("never connects when the server declares SSE unavailable", () => {
    stream.setStreamAvailability(false);
    const off = stream.subscribe("tasks-changed", () => {});
    expect(opened.length).toBe(0);
    off();
  });

  it("flipping to unavailable closes a live connection", () => {
    const off = stream.subscribe("jobs-changed", () => {});
    stream.setStreamAvailability(true);
    expect(opened.length).toBe(1);
    stream.setStreamAvailability(false);
    expect(opened[0].closed).toBe(true);
    off();
  });

  it("events still dispatch to subscribers when the transport is gated off", () => {
    stream.setStreamAvailability(false);
    let got = 0;
    const off = stream.subscribe("tasks-changed", () => got++);
    stream.dispatch({ type: "tasks-changed" });
    expect(got).toBe(1); // polling consumers still share the fan-out
    off();
  });
});
