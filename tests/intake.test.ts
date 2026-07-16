import { describe, it, expect } from "vitest";
import { filterOwnerInitiated, isOwnerInitiated } from "../src/lib/intake";
import type { IntakeRequest } from "../src/types";

// Unit tests for the pure owner-initiated classifier behind IntakeView's
// default filter (ops F9, t-1783183576744). Node-env style (no DOM/React)
// matching tests/chatbotQueue.test.ts - this project has no component-render
// test layer by design.

function mkRequest(over: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    id: "r-1",
    text: "please fix the dashboard count",
    source: "session",
    created: "2026-07-04",
    ts: "2026-07-04T00:00:00.000Z",
    spawned: { tasks: [], projects: [] },
    ...over,
  };
}

describe("isOwnerInitiated", () => {
  it("counts every chatbot capture as owner-initiated (owner ask by construction)", () => {
    expect(isOwnerInitiated(mkRequest({ source: "chatbot" }))).toBe(true);
    // Even one whose text LOOKS like a blob - the owner pasted it deliberately.
    expect(isOwnerInitiated(mkRequest({ source: "chatbot", text: "<task-notification>pasted</task-notification>" }))).toBe(
      true,
    );
  });

  it("counts a plain session prompt as owner-initiated (an explicit ask)", () => {
    expect(isOwnerInitiated(mkRequest({ text: "run session-debrief and give me the resume prompt" }))).toBe(true);
  });

  it("rejects a session row that IS a task-notification blob (hook echo)", () => {
    const blob = "<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>";
    expect(isOwnerInitiated(mkRequest({ text: blob }))).toBe(false);
  });

  it("rejects a system-reminder blob the same way", () => {
    expect(isOwnerInitiated(mkRequest({ text: "<system-reminder>context stuff</system-reminder>" }))).toBe(false);
  });

  it("tolerates leading whitespace/newlines before the machine marker", () => {
    expect(isOwnerInitiated(mkRequest({ text: "\n\n  <task-notification>\n<task-id>x</task-id>" }))).toBe(false);
  });

  it("keeps an owner ask that merely MENTIONS a marker mid-text", () => {
    expect(
      isOwnerInitiated(mkRequest({ text: "the hook captures <task-notification> blobs - please filter them" })),
    ).toBe(true);
  });
});

describe("filterOwnerInitiated", () => {
  it("keeps owner asks, drops machine echoes, preserving order", () => {
    const requests = [
      mkRequest({ id: "r-1", text: "fix the intake page" }),
      mkRequest({ id: "r-2", text: "<task-notification>\n<task-id>x</task-id>" }),
      mkRequest({ id: "r-3", source: "chatbot", text: "add a dark-mode toggle" }),
      mkRequest({ id: "r-4", text: "  <system-reminder>noise" }),
    ];
    expect(filterOwnerInitiated(requests).map((r) => r.id)).toEqual(["r-1", "r-3"]);
  });

  it("does not mutate the input array", () => {
    const requests = [mkRequest({ id: "r-1" }), mkRequest({ id: "r-2", text: "<task-notification>x" })];
    const snapshot = requests.map((r) => r.id);
    filterOwnerInitiated(requests);
    expect(requests.map((r) => r.id)).toEqual(snapshot);
  });

  it("returns an empty list for an empty ledger", () => {
    expect(filterOwnerInitiated([])).toEqual([]);
  });
});
