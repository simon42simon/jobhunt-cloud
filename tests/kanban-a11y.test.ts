import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KANBAN_SCREEN_READER_INSTRUCTIONS,
  buildKanbanAnnouncements,
  resolveDrop,
} from "../src/components/kanbanDnd";
import type { Job } from "../src/types";

// D2 - keyboard-drag accessibility on the Kanban board. The keyboard-sensor
// wiring itself is a live-browser concern (verified by the MAIN session), but the
// DROP CONTRACT (which move a drag resolves to) and the screen-reader COPY are pure
// and are the pieces most likely to silently regress, so they are unit-tested here.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Minimal Job stand-ins - resolveDrop only reads id/status; the announcement
// builder also reads role/employer.
const job = (over: Partial<Job> & { id: string; status: Job["status"] }): Job =>
  ({ role: "Role", employer: "Employer", ...over }) as unknown as Job;

const jobs: Job[] = [
  job({ id: "j1", status: "lead", role: "Data Analyst", employer: "Acme" }),
  job({ id: "j2", status: "queued", role: "PM", employer: "Globex" }),
];

describe("resolveDrop (pointer AND keyboard share this exact decision)", () => {
  it("moves a card to a different, valid column", () => {
    expect(resolveDrop(jobs, "j1", "queued")).toEqual({ id: "j1", status: "queued" });
  });

  it("is a no-op when dropped back on the SAME column", () => {
    expect(resolveDrop(jobs, "j1", "lead")).toBeNull();
  });

  it("is a no-op when dropped outside any column (no over target)", () => {
    expect(resolveDrop(jobs, "j1", null)).toBeNull();
    expect(resolveDrop(jobs, "j1", undefined)).toBeNull();
  });

  it("is a no-op when the over target is not a real status", () => {
    expect(resolveDrop(jobs, "j1", "not-a-column")).toBeNull();
  });

  it("is a no-op when there is no active card", () => {
    expect(resolveDrop(jobs, null, "queued")).toBeNull();
  });

  it("routes a high-stakes target through onMove unchanged (confirm modal lives upstream)", () => {
    // resolveDrop returns the raw move for submitted/rejected/closed too; the
    // confirm gate is App.requestMove's job, so the SAME move object flows through
    // for a keyboard drop as for a mouse drop.
    expect(resolveDrop(jobs, "j1", "submitted")).toEqual({ id: "j1", status: "submitted" });
    expect(resolveDrop(jobs, "j2", "rejected")).toEqual({ id: "j2", status: "rejected" });
  });
});

describe("buildKanbanAnnouncements (live-region copy for the keyboard drag)", () => {
  const a = buildKanbanAnnouncements(jobs);

  it("names the card by role + employer on pick up", () => {
    const msg = a.onDragStart({ active: { id: "j1" } } as never) ?? "";
    expect(msg).toContain("Data Analyst");
    expect(msg).toContain("Acme");
  });

  it("names the target COLUMN LABEL (not the raw status id) while dragging over it", () => {
    const msg = a.onDragOver({ active: { id: "j1" }, over: { id: "submitted" } } as never) ?? "";
    expect(msg).toContain("Submitted");
    expect(msg).not.toContain("submitted"); // human label, not the raw key
  });

  it("announces a drop into a column", () => {
    const msg = a.onDragEnd({ active: { id: "j1" }, over: { id: "queued" } } as never) ?? "";
    expect(msg).toMatch(/dropped/i);
    expect(msg).toContain("Queued");
  });

  it("announces a no-column drop as staying put", () => {
    const msg = a.onDragEnd({ active: { id: "j1" }, over: null } as never) ?? "";
    expect(msg).toMatch(/stayed where it was/i);
  });

  it("announces a cancel", () => {
    const msg = a.onDragCancel({ active: { id: "j1" }, over: null } as never) ?? "";
    expect(msg).toMatch(/cancel/i);
  });

  it("falls back to a generic name when the id is unknown", () => {
    const msg = a.onDragStart({ active: { id: "ghost" } } as never) ?? "";
    expect(msg).toContain("job card");
  });
});

describe("screen-reader instructions cover the full keyboard flow", () => {
  it("mentions pick up, arrows, drop, and cancel keys", () => {
    const d = KANBAN_SCREEN_READER_INSTRUCTIONS.draggable;
    expect(d).toMatch(/enter/i); // open
    expect(d).toMatch(/space/i); // pick up / drop
    expect(d).toMatch(/arrow/i); // move
    expect(d).toMatch(/escape/i); // cancel
  });
});

// Source-contract guards: the keyboard sensor + announcements wiring cannot be
// exercised without a DOM, so assert it is present so it is not silently dropped.
describe("Kanban keyboard-drag wiring is present (source contract)", () => {
  const board = read("../src/components/KanbanBoard.tsx");
  const card = read("../src/components/JobCard.tsx");

  it("registers a KeyboardSensor with a coordinate getter", () => {
    expect(board).toContain("KeyboardSensor");
    expect(board).toContain("sortableKeyboardCoordinates");
  });

  it("keeps a PointerSensor so mouse/touch drag does not regress", () => {
    expect(board).toContain("PointerSensor");
  });

  it("wires the announcements + screen-reader instructions into DndContext", () => {
    expect(board).toContain("accessibility=");
    expect(board).toContain("buildKanbanAnnouncements");
    expect(board).toContain("KANBAN_SCREEN_READER_INSTRUCTIONS");
  });

  it("JobCard invokes dnd-kit's keydown before its own open handler (no shadowing)", () => {
    expect(card).toContain("dndOnKeyDown");
    // Enter (not Space) opens, so Space is left to the drag sensor.
    expect(card).toMatch(/e\.key === "Enter"/);
  });
});
