import { describe, it, expect } from "vitest";
import { parseChangelog } from "../src/lib/changelog";

// Unit tests for the Keep-a-Changelog markdown parser (docs/product-hub-ia-v2.md
// section 4c). Pure string-in/struct-out - no React, no fetch - so a hand-built
// fixture is enough; no need to hit the real docs/changelog.md. Layer: unit.

const FIXTURE = `# Changelog

All notable changes are recorded here. Format follows Keep a Changelog. Newest first.

---

## [0.11.1] - 2026-07-01 20:32 ET

Post-v0.11.0 hardening pass: audit findings shipped.

### Added
- ULTRACODE governance audit shipped.
- CRLF round-trip test added.

### Changed
- Weekly enablement review folds in operational health metrics.

### Fixed
- CRLF-preserving frontmatter writes.

### Security
- Dev server bound to localhost by default.

---

## [0.10.0] - 2026-06-20 09:00 ET

A changed-only release: no additions, fixes, or security items this round.

### Changed
- Renamed the docs browser groups.
- Reordered the sidebar sections.
  - Sub-note under the reorder, still part of the same bullet.

---

## [0.9.0] - 2026-06-01 08:00 ET

### Fixed
- Nothing to see, just a fix.
`;

describe("parseChangelog", () => {
  const versions = parseChangelog(FIXTURE);

  it("parses every version header into a reverse-chronological entry with its date and summary", () => {
    expect(versions.map((v) => v.version)).toEqual(["0.11.1", "0.10.0", "0.9.0"]);
    expect(versions[0].date).toBe("2026-07-01 20:32 ET");
    expect(versions[0].summary).toBe("Post-v0.11.0 hardening pass: audit findings shipped.");
    // No re-sort happens inside the parser - it trusts the doc's own
    // newest-first ordering and just preserves it.
    expect(versions[1].version).toBe("0.10.0");
  });

  it("groups bullets under their change-type heading with the right per-category counts", () => {
    const v = versions[0];
    const byName = Object.fromEntries(v.categories.map((c) => [c.name, c]));
    expect(Object.keys(byName)).toEqual(["Added", "Changed", "Fixed", "Security"]);
    expect(byName.Added.bulletCount).toBe(2);
    expect(byName.Added.raw).toContain("ULTRACODE governance audit shipped.");
    expect(byName.Changed.bulletCount).toBe(1);
    expect(byName.Fixed.bulletCount).toBe(1);
    expect(byName.Security.bulletCount).toBe(1);
  });

  it("handles a version that only declares some of the change-type groups", () => {
    // 0.10.0 has only a Changed section - Added/Fixed/Security must simply be
    // absent, not present-with-zero-count.
    const v = versions.find((x) => x.version === "0.10.0")!;
    expect(v.categories.map((c) => c.name)).toEqual(["Changed"]);
  });

  it("counts only top-level bullets but keeps an indented continuation line in the category's raw block", () => {
    const v = versions.find((x) => x.version === "0.10.0")!;
    const changed = v.categories.find((c) => c.name === "Changed")!;
    // Two top-level "- " bullets; the indented sub-note is not double-counted.
    expect(changed.bulletCount).toBe(2);
    expect(changed.raw).toContain("Sub-note under the reorder");
  });

  it("tolerates an empty/malformed section (no version headers at all) without throwing", () => {
    expect(() => parseChangelog("")).not.toThrow();
    expect(parseChangelog("")).toEqual([]);

    // Prose with no "## [x] - date" header anywhere - the H1/intro-paragraph
    // case that precedes the first real version in every real changelog.
    const malformed = "# Changelog\n\nSome stray prose with a - dash that is not a bullet under any category.\n";
    expect(() => parseChangelog(malformed)).not.toThrow();
    expect(parseChangelog(malformed)).toEqual([]);
  });

  it("tolerates a version with no change-type sections at all (summary only, no bullets)", () => {
    const noSections = "## [0.1.0] - 2026-01-01\n\nJust a summary line, nothing else.\n";
    const [v] = parseChangelog(noSections);
    expect(v.version).toBe("0.1.0");
    expect(v.summary).toBe("Just a summary line, nothing else.");
    expect(v.categories).toEqual([]);
  });
});
