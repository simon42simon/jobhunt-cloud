import { describe, it, expect } from "vitest";
import {
  ACTIVE_STATUSES,
  PRE_SUBMISSION_ACTIVE,
  STATUS_ACCENT,
  STATUS_INFO,
  STATUS_LABEL,
  STATUS_ORDER,
  TRACK_LABEL,
  FIT_ACCENT,
} from "../src/lib/constants";
import type { Status } from "../src/types";

// Unit tests for the canonical job-pipeline constants. These definitions are
// shared vocabulary between the Kanban board, table, status modal, and server:
// if a status is missing from ORDER, or if a label/accent gap opens, UI pieces
// will disagree on what the job pipeline looks like.

const ALL_STATUSES: Status[] = [
  "lead",
  "queued",
  "drafted",
  "ready",
  "submitted",
  "interview",
  "offer",
  "rejected",
  "closed",
];

describe("STATUS_ORDER", () => {
  it("contains every canonical status exactly once", () => {
    const set = new Set(STATUS_ORDER);
    expect(set.size).toBe(STATUS_ORDER.length);
    expect(STATUS_ORDER.sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe("STATUS_LABEL", () => {
  it("has a readable label for every canonical status", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABEL[status], status).toBeTruthy();
      expect(typeof STATUS_LABEL[status]).toBe("string");
    }
  });

  it("labels use title-case casing", () => {
    expect(STATUS_LABEL.lead).toBe("Lead");
    expect(STATUS_LABEL.submitted).toBe("Submitted");
  });
});

describe("STATUS_ACCENT", () => {
  it("has a hex accent for every canonical status", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_ACCENT[status], status).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("ACTIVE_STATUSES", () => {
  it("includes every status before rejected/closed and excludes terminal statuses", () => {
    expect(ACTIVE_STATUSES).toContain("lead");
    expect(ACTIVE_STATUSES).toContain("offer");
    expect(ACTIVE_STATUSES).not.toContain("rejected");
    expect(ACTIVE_STATUSES).not.toContain("closed");
    expect(new Set(ACTIVE_STATUSES).size).toBe(ACTIVE_STATUSES.length);
  });
});

describe("PRE_SUBMISSION_ACTIVE", () => {
  it("includes only statuses before application submission", () => {
    expect(PRE_SUBMISSION_ACTIVE).toEqual(["lead", "queued", "drafted", "ready"]);
    expect(PRE_SUBMISSION_ACTIVE.every((s) => STATUS_ORDER.includes(s))).toBe(true);
  });
});

describe("STATUS_INFO", () => {
  it("has trigger + impact text for every status", () => {
    for (const status of ALL_STATUSES) {
      const info = STATUS_INFO[status];
      expect(info, status).toBeDefined();
      expect(info.trigger.length).toBeGreaterThan(0);
      expect(info.impact.length).toBeGreaterThan(0);
    }
  });

  it("non-terminal statuses include a next-step hint", () => {
    for (const status of ACTIVE_STATUSES) {
      expect(STATUS_INFO[status].next, status).toBeTruthy();
    }
  });
});

describe("FIT_ACCENT / TRACK_LABEL", () => {
  it("every fit accent is a real hex color", () => {
    for (const hex of Object.values(FIT_ACCENT)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("career-track labels use title-case wording", () => {
    expect(TRACK_LABEL.industry_outreach_focused).toBe("Industry Outreach");
    expect(TRACK_LABEL.higher_ed_generalist_focused).toBe("Higher-Ed Generalist");
  });
});
