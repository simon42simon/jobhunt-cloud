import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATUS_ORDER } from "../src/lib/constants";

// SIM-599 / t-1784782704635 (AC-J2-1): the Jobs Table's grouped mode renders
// ONLY the sections listed in GROUP_ORDER - a status missing from that list
// silently drops every job in it from the grouped Table (`ready` was omitted,
// so the whole Ready group vanished). GROUP_ORDER's ORDER is deliberately not
// STATUS_ORDER (active work first, terminal states last), but its MEMBERSHIP
// must always be the complete status vocabulary. Source-contract idiom (no
// React render layer in this project - related-chips-ui.test.ts).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("JobTable GROUP_ORDER covers every live status (SIM-599)", () => {
  const src = read("../src/components/JobTable.tsx");
  const block = src.match(/const GROUP_ORDER: Status\[\] = \[([^\]]+)\];/);

  it("declares GROUP_ORDER as a Status[] literal", () => {
    expect(block).toBeTruthy();
  });

  it("contains exactly the full status vocabulary - no status may silently drop its group", () => {
    const entries = [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(entries.length).toBe(new Set(entries).size); // no duplicate sections
    expect([...entries].sort()).toEqual([...STATUS_ORDER].sort());
  });

  it("keeps the deliberate non-lifecycle ordering: ready sits in the active run, before interview", () => {
    const entries = [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(entries.indexOf("ready")).toBeGreaterThan(entries.indexOf("drafted"));
    expect(entries.indexOf("ready")).toBeLessThan(entries.indexOf("interview"));
  });
});
