import { describe, it, expect, vi } from "vitest";
import { parseEvent, subscribe, dispatch, type ServerEvent } from "../src/hooks/useEventStream";

// Pure-logic unit tests for the shared event stream (SSE consolidation). The two
// testable seams with no DOM/network are the frame PARSER and the subscribe/dispatch
// FAN-OUT; in a node env the module's connection layer is inert (IN_BROWSER is
// false), so subscribe just registers a handler. No DOM test framework is pulled
// in - matching the ticket's "pure-logic tests only where cheap".

describe("parseEvent", () => {
  it("parses a well-formed typed frame", () => {
    expect(parseEvent('{"type":"tasks-changed"}')).toEqual({ type: "tasks-changed" });
  });

  it("carries payload fields through", () => {
    expect(
      parseEvent('{"type":"run-finished","runId":"r1","routine":"first-draft-job","jobId":"J"}'),
    ).toEqual({ type: "run-finished", runId: "r1", routine: "first-draft-job", jobId: "J" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("")).toBeNull();
  });

  it("returns null when there is no string `type`", () => {
    expect(parseEvent('{"foo":1}')).toBeNull();
    expect(parseEvent('{"type":123}')).toBeNull();
    expect(parseEvent("null")).toBeNull();
    expect(parseEvent('"a bare string"')).toBeNull();
  });
});

describe("subscribe / dispatch fan-out", () => {
  it("delivers an event only to handlers of its own type", () => {
    const jobs = vi.fn();
    const tasks = vi.fn();
    const offJobs = subscribe("jobs-changed", jobs);
    const offTasks = subscribe("tasks-changed", tasks);
    dispatch({ type: "jobs-changed" });
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(tasks).not.toHaveBeenCalled();
    offJobs();
    offTasks();
  });

  it("fans out to every handler registered for a type", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe("tasks-changed", a);
    const offB = subscribe("tasks-changed", b);
    dispatch({ type: "tasks-changed" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("stops delivering after unsubscribe", () => {
    const h = vi.fn();
    const off = subscribe("jobs-changed", h);
    dispatch({ type: "jobs-changed" });
    off();
    dispatch({ type: "jobs-changed" });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("passes the full event payload to the handler", () => {
    const h = vi.fn();
    const ev: ServerEvent = { type: "source-run-finished", sourceId: "acme" };
    const off = subscribe("source-run-finished", h);
    dispatch(ev);
    expect(h).toHaveBeenCalledWith(ev);
    off();
  });

  it("a throwing handler does not sink the rest of the fan-out", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offBad = subscribe("tasks-changed", bad);
    const offGood = subscribe("tasks-changed", good);
    expect(() => dispatch({ type: "tasks-changed" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });

  it("dispatch to a type with no subscribers is a no-op", () => {
    expect(() => dispatch({ type: "run-finished", runId: "x" })).not.toThrow();
  });
});
