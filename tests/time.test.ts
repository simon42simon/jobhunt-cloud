import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mmss, relativeTime, relativeFuture } from "../src/lib/time";
import { relativeTime as viaSources } from "../src/lib/sources";

// UI consistency pack t-1783183576693 (b): the relative-clock formatters are
// consolidated into lib/time. Behavior (including the sources-console callers,
// which import via lib/sources' re-export) is covered in depth by
// sources.test.ts; this file pins the CONSOLIDATION itself - the new module
// works, the re-export is the same function, and no component keeps a local
// drifted copy.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("lib/time relativeTime / relativeFuture", () => {
  it("formats the full past magnitude ladder", () => {
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime("not-a-date")).toBe("never");
    expect(relativeTime(ago(10_000))).toBe("just now");
    expect(relativeTime(ago(5 * 60_000))).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000))).toBe("3h ago");
    expect(relativeTime(ago(2 * 86_400_000))).toBe("2d ago");
    expect(relativeTime(ago(3 * 7 * 86_400_000))).toBe("3w ago");
  });

  it("formats the forward ladder", () => {
    expect(relativeFuture(null)).toBe("");
    expect(relativeFuture(ago(1_000))).toBe("due now");
    expect(relativeFuture(ahead(30 * 60_000))).toMatch(/^in (29|30)m$/);
    expect(relativeFuture(ahead(3 * 86_400_000 + 60_000))).toBe("in 3d");
  });

  it("lib/sources re-exports the SAME function (no second implementation)", () => {
    expect(viaSources).toBe(relativeTime);
  });
});

describe("lib/time mmss (run elapsed clock, consolidated from RunPanel for the run dock)", () => {
  it("formats the mm:ss ladder", () => {
    expect(mmss(0)).toBe("00:00");
    expect(mmss(999)).toBe("00:00");
    expect(mmss(1000)).toBe("00:01");
    expect(mmss(65_000)).toBe("01:05");
    expect(mmss(600_000)).toBe("10:00");
  });

  it("minutes keep counting past 99 rather than wrapping", () => {
    expect(mmss(100 * 60_000)).toBe("100:00");
  });

  it("clamps negative and non-finite input to 00:00", () => {
    expect(mmss(-5_000)).toBe("00:00");
    expect(mmss(Number.NaN)).toBe("00:00");
    expect(mmss(Number.POSITIVE_INFINITY)).toBe("00:00");
  });

  it("RunPanel and RunDock share this formatter (no local mmss copies)", () => {
    // RunDock feeds the elapsed clock inline; RunPanel names it first
    // (elapsedMs, reused by the t-1783650926662 progress estimate). Both must
    // still IMPORT the shared formatter and keep no local copy.
    for (const rel of ["../src/components/RunPanel.tsx", "../src/components/RunDock.tsx"]) {
      const src = read(rel);
      expect(src).not.toMatch(/function mmss\(/);
      expect(src).toMatch(/import \{[^}]*\bmmss\b[^}]*\} from "\.\.\/lib\/time"/);
      expect(src).toMatch(/mmss\((now - startMs|elapsedMs)\)/);
    }
  });
});

describe("no local relativeTime copies remain (source contract)", () => {
  // Components once carried drifted local copies (stopped at "h ago", fell
  // back to an absolute date after a day). The other adopters (ActivityView,
  // TeamView, UsagePanel) were deleted with the in-app hub's retirement
  // (SIM-59); the contract holds for what remains.
  it.each([
    ["NotificationPanel", "../src/components/NotificationPanel.tsx"],
  ])("%s imports the shared clock from lib/time", (_name, rel) => {
    const src = read(rel);
    expect(src).toContain('relativeTime } from "../lib/time"');
    expect(src).not.toMatch(/function relativeTime\(/);
  });
});
