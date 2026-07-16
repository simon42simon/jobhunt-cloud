// Records -> Releases (docs/product-hub-ia-v2.md section 4c): parses a
// Keep-a-Changelog markdown document into reverse-chronological version
// entries with grouped change-type sections. Pure string parsing - no React,
// no fetch - so ReleasesView can stay a thin renderer and this stays
// unit-testable in isolation.

export interface ChangelogCategory {
  name: string;
  raw: string;
  bulletCount: number;
}

export interface ChangelogVersionEntry {
  version: string;
  date: string;
  summary: string;
  categories: ChangelogCategory[];
}

// Deterministic, line-based parse of the Keep-a-Changelog markdown: "## [ver]
// - date" version headers, "### Category" subsections, "-" bullets. Only
// top-level (non-indented) bullets are counted for the collapsed-card tally;
// indented continuation lines (a few entries nest a sub-list under one top
// bullet) stay part of the same category's raw block so MarkdownLite still
// renders them in the expanded view. No re-sort by date: docs/changelog.md is
// already newest-first by its own stated convention.
export function parseChangelog(raw: string): ChangelogVersionEntry[] {
  const lines = raw.replace(/\r/g, "").split("\n");
  const versions: ChangelogVersionEntry[] = [];
  let cur: ChangelogVersionEntry | null = null;
  let curCat: ChangelogCategory | null = null;
  let summaryLines: string[] = [];
  let inSummary = false;

  function closeCategory() {
    if (cur && curCat) {
      curCat.raw = curCat.raw.trim();
      cur.categories.push(curCat);
    }
    curCat = null;
  }
  function closeSummary() {
    if (cur && !cur.summary && summaryLines.length) cur.summary = summaryLines.join(" ");
    summaryLines = [];
  }

  for (const line of lines) {
    const vMatch = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+?)\s*$/);
    if (vMatch) {
      closeCategory();
      closeSummary();
      cur = { version: vMatch[1], date: vMatch[2], summary: "", categories: [] };
      versions.push(cur);
      inSummary = true;
      continue;
    }
    if (!cur) continue; // skip the doc's H1 + intro paragraph before the first version
    const cMatch = line.match(/^###\s+(.+?)\s*$/);
    if (cMatch) {
      closeCategory();
      closeSummary();
      inSummary = false;
      curCat = { name: cMatch[1], raw: "", bulletCount: 0 };
      continue;
    }
    if (line.trim() === "---") continue; // the separator rule between versions
    if (curCat) {
      curCat.raw += `${line}\n`;
      if (/^-\s+/.test(line)) curCat.bulletCount++;
      continue;
    }
    if (inSummary && line.trim()) summaryLines.push(line.trim());
  }
  closeCategory();
  closeSummary();
  return versions;
}
