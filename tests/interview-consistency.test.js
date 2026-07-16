import { describe, it, expect } from "vitest";
import { computeInterviewConsistency } from "../server/lib.js";

// Feature 1 (2026-07-06 interview-coaching design): the read-only, deterministic
// prep-sheet <-> STAR-bank consistency check. The headline case is the live bug
// found in Jobs/CRM Coordinator - York University: the prep sheet says "-> Story G"
// but the STAR bank only defines stories A-F. These tests pin the precision bar:
// only a genuinely dangling citation is a HARD flag.

const prepDoc = (content) => ({ name: "Interview prep.md", content });
const starDoc = (content) => ({ name: "STAR stories.md", content });

// A STAR bank defining stories A..F, in the on-disk "## Story A - Title" shape.
const bankAtoF = starDoc(
  ["A", "B", "C", "D", "E", "F"].map((l) => `## Story ${l} - Example ${l}\n\nBody.\n`).join("\n"),
);

describe("computeInterviewConsistency", () => {
  it("HARD-flags a story the prep sheet cites that the bank never defines (the live Story G bug)", () => {
    const prep = prepDoc(
      "Lead with Story A + Story B. For the gap question use Story D. On priorities -> Story G. Close with Story C, Story E, Story F.",
    );
    const out = computeInterviewConsistency([prep, bankAtoF], true);
    expect(out.checked).toBe(true);
    expect(out.hasSubmitted).toBe(true);
    const hard = out.findings.filter((f) => f.severity === "high");
    expect(hard).toHaveLength(1);
    expect(hard[0].kind).toBe("dangling-story");
    expect(hard[0].refs).toEqual(["G"]);
    expect(hard[0].message).toContain("Story G");
    expect(hard[0].message).toContain("not in the STAR bank");
    // A-F are all cited here, so there is no orphan finding.
    expect(out.findings.some((f) => f.kind === "orphan-story")).toBe(false);
  });

  it("returns no findings when every cited story is defined and materials exist", () => {
    const prep = prepDoc("Use Story A, then Story B, then Story C.");
    const bank = starDoc("## Story A - x\n## Story B - y\n## Story C - z");
    const out = computeInterviewConsistency([prep, bank], true);
    expect(out.checked).toBe(true);
    expect(out.findings).toHaveLength(0);
  });

  it("flags an orphan story (defined in the bank, never cited) as info, not a hard flag", () => {
    const prep = prepDoc("Only Story A gets cited here.");
    const bank = starDoc("## Story A - x\n## Story B - y");
    const out = computeInterviewConsistency([prep, bank], true);
    expect(out.findings.some((f) => f.severity === "high")).toBe(false);
    const orphan = out.findings.find((f) => f.kind === "orphan-story");
    expect(orphan).toBeTruthy();
    expect(orphan.severity).toBe("info");
    expect(orphan.refs).toEqual(["B"]);
  });

  it("notes structural-only when no application-content.json is on file", () => {
    const prep = prepDoc("Story A only.");
    const bank = starDoc("## Story A - x");
    const out = computeInterviewConsistency([prep, bank], false);
    expect(out.hasSubmitted).toBe(false);
    const info = out.findings.find((f) => f.kind === "no-submitted");
    expect(info).toBeTruthy();
    expect(info.severity).toBe("info");
    expect(out.findings.some((f) => f.severity === "high")).toBe(false);
  });

  it("HARD-flags every cited story when the prep sheet cites stories but there is no STAR bank", () => {
    const prep = prepDoc("Use Story A and Story B.");
    const out = computeInterviewConsistency([prep], true);
    const hard = out.findings.find((f) => f.severity === "high");
    expect(hard.kind).toBe("dangling-story");
    expect(hard.refs).toEqual(["A", "B"]);
    expect(hard.message).toContain("defines no stories");
  });

  it("is checked=false with no findings when there is no prep material at all", () => {
    expect(computeInterviewConsistency([], true)).toEqual({ checked: false, hasSubmitted: true, findings: [] });
    expect(computeInterviewConsistency(null, false)).toEqual({ checked: false, hasSubmitted: false, findings: [] });
  });

  it("does not phantom-cite from 'STAR stories', 'story bank', or 'Story Approach' (precision)", () => {
    const prep = prepDoc(
      "See the STAR stories companion and the story bank. Story Approach matters. Ultimately, cite Story A.",
    );
    const bank = starDoc("## Story A - x");
    const out = computeInterviewConsistency([prep, bank], true);
    // Only Story A is a real citation; A is defined, so nothing dangles and nothing orphans.
    expect(out.findings.some((f) => f.kind === "dangling-story")).toBe(false);
    expect(out.findings.some((f) => f.kind === "orphan-story")).toBe(false);
  });

  it("tolerates a reversed doc order (STAR bank listed first)", () => {
    const prep = prepDoc("Cite Story A and Story Z.");
    const bank = starDoc("## Story A - x");
    const out = computeInterviewConsistency([bank, prep], true);
    const hard = out.findings.find((f) => f.severity === "high");
    expect(hard.refs).toEqual(["Z"]);
  });
});
