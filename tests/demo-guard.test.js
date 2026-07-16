// RC-3 / SIM-87 I6 - forbidden-substrings guard (guardian MF-11). Proves the seed
// AND the canned transcripts AND the pre-baked artifacts carry zero real-vault
// content, and that a planted real term IS caught.

import { describe, it, expect } from "vitest";
import { generate } from "../demo/seed.mjs";
import { collectStrings, scanForbidden, loadForbiddenList, guardDemoData } from "../demo/guard.mjs";
import { allTranscriptText, loadTranscriptLines } from "../demo/replay.mjs";

describe("forbidden-substrings guard", () => {
  it("the committed sample list loads and is non-empty", () => {
    const { terms, source } = loadForbiddenList({});
    expect(terms.length).toBeGreaterThan(0);
    expect(source).toMatch(/forbidden\.sample\.json$/); // no local override in CI
    // the sample list must NOT drop comment lines into terms
    expect(terms.some((t) => t.startsWith("#"))).toBe(false);
  });

  it("the real seed + transcripts + artifacts are CLEAN against the sample list", () => {
    const ds = generate(1);
    const artifactBuffers = ds.jobs.flatMap((j) => j.artifacts.map((a) => Buffer.from(a.text, "utf8")));
    const res = guardDemoData(ds, [allTranscriptText(), ...artifactBuffers], {});
    expect(res.ok).toBe(true);
    expect(res.hits).toEqual([]);
    expect(res.scanned).toBeGreaterThan(0);
  });

  it("the guard covers all three channels - a planted real term in the SEED is caught", () => {
    const ds = generate(1);
    ds.jobs[0].employer = "REAL_EMPLOYER_PLACEHOLDER Inc"; // simulate a leak
    const res = guardDemoData(ds, [], {});
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.term === "REAL_EMPLOYER_PLACEHOLDER")).toBe(true);
  });

  it("a planted real term in a TRANSCRIPT channel is caught", () => {
    const ds = generate(1);
    const leakyTranscript = 'assistant said: ops/facts leaked here';
    const res = guardDemoData(ds, [leakyTranscript], {});
    expect(res.ok).toBe(false);
    expect(res.hits.some((h) => h.term === "ops/facts")).toBe(true);
  });

  it("scanForbidden is case-insensitive", () => {
    expect(scanForbidden(["My name is Onedrive path"], ["OneDrive"]).length).toBe(1);
    expect(scanForbidden(["nothing here"], ["OneDrive"]).length).toBe(0);
  });

  it("collectStrings walks nested objects, arrays, and buffers", () => {
    const strings = collectStrings({ a: "x", b: [1, "y", { c: "z" }], d: Buffer.from("buf", "utf8") });
    expect(strings).toContain("x");
    expect(strings).toContain("y");
    expect(strings).toContain("z");
    expect(strings).toContain("buf");
  });

  it("every transcript loads as parseable stream-json lines", () => {
    for (const kind of ["first-draft-job", "finalize-job", "discover-jobs"]) {
      const lines = loadTranscriptLines(kind);
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    }
  });
});
