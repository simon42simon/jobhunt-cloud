import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactNode } from "react";
import {
  NOTIFICATION_META,
  NOTIFICATION_TYPES,
  coerceNotificationFeed,
  notificationMeta,
} from "../src/lib/notifications";
import { STATUS_COLOR } from "../src/lib/statusColors";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import type { Notification } from "../src/types";

// Defense-in-depth for the notification surfaces (t-1783145481687). Two
// halves: (1) the META lookup and the feed boundary are guarded in
// lib/notifications (pure, unit-tested here); (2) the TopBar/bell and
// ChatCapture mount OUTSIDE App's <main> ErrorBoundary, so they get their own
// per-surface boundaries in App.tsx - pinned as source contracts, plus a
// direct render-contract test of the (class) ErrorBoundary itself, since this
// project has no React render layer (related-chips-ui.test.ts idiom).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("notificationMeta (guarded META lookup)", () => {
  it("passes every known type through to the real NOTIFICATION_META entry", () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(notificationMeta(t)).toBe(NOTIFICATION_META[t]);
    }
  });

  it("degrades an unknown type to a generic row: raw type as label, untimed, a real tone", () => {
    const meta = notificationMeta("deploy_started");
    expect(meta.label).toBe("deploy_started"); // the raw type string, honest
    expect(meta.timed).toBe(false); // never fabricate a clock
    expect(STATUS_COLOR[meta.colorKey]).toBeTruthy(); // resolves a vetted hue
  });

  it("never throws, even for an empty type", () => {
    expect(notificationMeta("").label).toBe("Notification");
  });
});

describe("coerceNotificationFeed (the feed boundary)", () => {
  const good: Notification = {
    id: "n1",
    type: "task_added",
    ts: "2026-07-03T10:00:00.000Z",
    title: "Task added",
    ref: { kind: "task", id: "t-1" },
    unread: true,
  };

  it("a non-array feed degrades to empty, never a throw", () => {
    expect(coerceNotificationFeed(undefined)).toEqual([]);
    expect(coerceNotificationFeed(null)).toEqual([]);
    expect(coerceNotificationFeed("oops")).toEqual([]);
    expect(coerceNotificationFeed({ events: [] })).toEqual([]);
  });

  it("keeps well-formed rows and drops the ones every consumer would crash on", () => {
    const junk = [
      good,
      null,
      "string row",
      42,
      { id: "n2" }, // no type/title/ref
      { ...good, id: 7 }, // non-string id (React key)
      { ...good, id: "n3", ref: null }, // notificationColorKey reads ref.kind
      { ...good, id: "n4", title: undefined }, // rendered directly
    ];
    expect(coerceNotificationFeed(junk)).toEqual([good]);
  });

  it("keeps an UNKNOWN-type row (it renders as the generic row, it is not junk)", () => {
    const future = { ...good, id: "n5", type: "future_kind" };
    expect(coerceNotificationFeed([future])).toEqual([future]);
  });
});

// --- ErrorBoundary render contract ------------------------------------------

// Collect the plain-text leaves of a React element tree (no renderer needed).
function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (isValidElement(node)) return collectText((node.props as { children?: ReactNode }).children);
  return "";
}

describe("ErrorBoundary catches a child throw (render contract)", () => {
  const boom = new Error("bell exploded");

  it("getDerivedStateFromError converts the child throw into fallback state", () => {
    expect(ErrorBoundary.getDerivedStateFromError(boom)).toEqual({ error: boom });
  });

  it("renders children untouched while no error is caught", () => {
    const child = createElement("span", null, "alive");
    const eb = new ErrorBoundary({ children: child });
    expect(eb.render()).toBe(child);
  });

  it("renders the default full-pane message once an error is caught", () => {
    const eb = new ErrorBoundary({ children: "x" });
    eb.state = { error: boom };
    const text = collectText(eb.render() as ReactNode);
    expect(text).toContain("Could not render this view");
    expect(text).toContain("bell exploded");
  });

  it("honors a caller-supplied compact fallback, including an explicit null", () => {
    const silent = new ErrorBoundary({ children: "x", fallback: null });
    silent.state = { error: boom };
    expect(silent.render()).toBeNull();

    const note = createElement("div", null, "top bar failed");
    const slim = new ErrorBoundary({ children: "x", fallback: note });
    slim.state = { error: boom };
    expect(slim.render()).toBe(note);
  });
});

// --- Source contracts: the wiring -------------------------------------------

describe("NotificationPanel renders through the guards (source contract)", () => {
  const src = read("../src/components/NotificationPanel.tsx");

  it("the event row uses notificationMeta, never a bare NOTIFICATION_META[n.type]", () => {
    expect(src).toContain("notificationMeta(n.type)");
    expect(src).not.toContain("NOTIFICATION_META[n.type]");
  });

  it("the type icon has a default glyph for unknown types", () => {
    const icon = src.slice(src.indexOf("function TypeIcon"), src.indexOf("function targetFor"));
    expect(icon).toContain("default:");
  });

  it("the settings list still iterates the DECLARED vocabulary (known-safe lookup)", () => {
    expect(src).toContain("NOTIFICATION_TYPES.map");
  });
});

describe("NotificationBell coerces the feed at the API boundary (source contract)", () => {
  const src = read("../src/components/NotificationBell.tsx");

  it("every setEvents goes through coerceNotificationFeed", () => {
    expect(src).toContain("coerceNotificationFeed(");
    expect(src).not.toMatch(/setEvents\((?!coerce)[a-z]/i);
  });
});

describe("App gives the outside-<main> surfaces their own boundaries (source contract)", () => {
  const src = read("../src/App.tsx");

  it("TopBar (which hosts the bell) is wrapped in the existing ErrorBoundary", () => {
    expect(src).toMatch(/<ErrorBoundary[^>]*>\s*<TopBar/);
  });

  it("ChatCapture is wrapped in its own boundary (a FAB crash never blanks the app)", () => {
    expect(src).toMatch(/<ErrorBoundary[^>]*>\s*<ChatCapture/);
  });
});
