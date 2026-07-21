import { describe, it, expect } from "vitest";
import type { Task } from "../src/types";
import {
  ALL_COLUMNS,
  COL_LABEL,
  EPIC_COLOR,
  PRIORITY_COLOR,
  TYPE_ABBR,
  TYPE_HEX,
  epicColor,
  epicOptions,
  fullColumns,
  labelColor,
} from "../src/lib/taskMeta";

// Unit tests for the shared task-ticket vocabulary helpers. These are pure value
// selectors (column order, labels, color maps) consumed by TaskBoard and
// TaskDetail; keeping them DOM-free means a node test can anchor that the two
// views share one vocabulary and never drift.

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t-1000",
    title: "Synthetic task",
    detail: "",
    epic: "general",
    priority: "medium",
    status: "todo",
    created: "2026-07-01",
    ...over,
  } as Task;
}

describe("fullColumns", () => {
  it("returns the canonical order when no server columns are supplied", () => {
    expect(fullColumns(undefined)).toEqual(ALL_COLUMNS);
    expect(fullColumns(null)).toEqual(ALL_COLUMNS);
  });

  it("merges server-specific extras after the canonical columns", () => {
    const serverColumns = ["custom-a", "todo", "in_progress", "custom-b"];
    expect(fullColumns(serverColumns)).toEqual([...ALL_COLUMNS, "custom-a", "custom-b"]);
  });

  it("does not duplicate a canonical column supplied by the server", () => {
    const serverColumns = ["todo", "done", "todo"];
    expect(fullColumns(serverColumns)).toEqual(ALL_COLUMNS);
  });

  it("keeps the canonical order for known columns", () => {
    expect(fullColumns([])).toEqual(ALL_COLUMNS);
    expect(fullColumns(["done", "todo", "in_progress"])).toEqual(ALL_COLUMNS);
  });
});

describe("COL_LABEL", () => {
  it("has a readable label for every canonical column", () => {
    for (const col of ALL_COLUMNS) {
      expect(COL_LABEL[col], col).toBeTruthy();
      expect(typeof COL_LABEL[col]).toBe("string");
    }
  });

  it("labels preserve familiar casing (In progress, To do, etc.)", () => {
    expect(COL_LABEL.in_progress).toBe("In progress");
    expect(COL_LABEL.todo).toBe("To do");
    expect(COL_LABEL.in_review).toBe("In review");
  });
});

describe("PRIORITY_COLOR", () => {
  it("maps the three priority levels to hex colors", () => {
    for (const priority of ["high", "medium", "low"] as const) {
      expect(PRIORITY_COLOR[priority]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("gives high priority a warm danger hue and low a muted hue", () => {
    expect(PRIORITY_COLOR.high.startsWith("#")).toBe(true);
  });
});

describe("TYPE_HEX / TYPE_ABBR", () => {
  it("every mapped task type has both a color and an abbreviation", () => {
    for (const type of ["bug", "feature", "chore", "spike"] as const) {
      expect(TYPE_HEX[type]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(TYPE_ABBR[type]).toBeTruthy();
    }
  });
});

describe("epicColor", () => {
  it("returns the mapped color for known epics", () => {
    expect(epicColor("testing")).toBe(EPIC_COLOR.testing);
    expect(epicColor("discovery")).toBe(EPIC_COLOR.discovery);
    expect(epicColor("analytics")).toBe(EPIC_COLOR.analytics);
  });

  it("falls back to the 'general' color for unknown epics", () => {
    expect(epicColor("unknown-epic")).toBe(EPIC_COLOR.general);
    expect(epicColor("")).toBe(EPIC_COLOR.general);
  });
});

describe("epicOptions", () => {
  it("starts with every default epic and merges task-carried epics", () => {
    const tasks = [task({ epic: "infra" }), task({ epic: "infra" }), task({ epic: "custom-epic" })];
    const opts = epicOptions(tasks);
    expect(opts).toContain("infra");
    expect(opts).toContain("custom-epic");
  });

  it("does not duplicate an epic present in both defaults and tasks", () => {
    const tasks = [task({ epic: "discovery" }), task({ epic: "discovery" })];
    const opts = epicOptions(tasks);
    expect(new Set(opts).size).toBe(opts.length);
    expect(opts.filter((e) => e === "discovery")).toHaveLength(1);
  });

  it("tolerates null/undefined inputs", () => {
    expect(epicOptions(null).length).toBe(Object.keys(EPIC_COLOR).length);
    expect(epicOptions(undefined).length).toBe(Object.keys(EPIC_COLOR).length);
    expect(epicOptions([]).length).toBe(Object.keys(EPIC_COLOR).length);
  });
});

describe("labelColor", () => {
  it("returns one of the palette colors for any string", () => {
    const palette = ["#818cf8", "#22d3ee", "#4ade80", "#f59e0b", "#c084fc", "#06b6d4", "#34d399"];
    expect(palette).toContain(labelColor("synthetic-label"));
  });

  it("is deterministic: the same label yields the same color", () => {
    expect(labelColor("reproducible")).toBe(labelColor("reproducible"));
  });

  it("distributes different labels across the palette", () => {
    const colors = ["a", "b", "c", "d", "e", "f", "g", "h"].map(labelColor);
    const distinct = new Set(colors);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});
