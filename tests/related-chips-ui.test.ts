import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Related-entity deep links (t-1783255872307 + t-1783256391885), source
// contracts in the static-source idiom: the pure derivation is unit-tested in
// relatedEntities.test.ts and the URL mapping in sscHub.test.ts; this file
// pins the WIRING. Since SIM-59 (Phase B half B) the in-app Product Hub is
// retired: every chip surface navigates through App's one openEntity callback,
// which hands off to the standalone SSC Product Hub (lib/sscHub) in its shared
// named window - no in-app hub-focus state remains. No React render layer
// exists in this project, so behavior contracts are asserted against the
// source.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("App owns the deep-link handoff (openEntity -> SSC hub)", () => {
  const src = read("../src/App.tsx");

  it("openEntity hands the entity to the SSC hub (resolved base, config.sscHubUrl) and leaves the current view alone", () => {
    expect(src).toMatch(
      /openEntity = useCallback\(\s*\(entity: EntityRef\) => \{\s*openSscHub\(config\?\.sscHubUrl, entity\);\s*\},/,
    );
    // No view switch inside the handoff - the hub is its own surface now.
    const body = src.slice(src.indexOf("openEntity = useCallback"), src.indexOf("openDecisions"));
    expect(body).not.toContain('setView("product")');
  });

  it("the bell's Review decisions hands off to the hub's Decisions page (resolved base)", () => {
    expect(src).toMatch(
      /openDecisions = useCallback\(\(\) => \{\s*openSscHub\(config\?\.sscHubUrl, "decisions"\);\s*\}, \[config\?\.sscHubUrl\]\)/,
    );
  });

  // SIM-426: neither handoff may fall back to a hardcoded host - the resolved
  // base always travels through as the explicit first arg.
  it("neither handoff hardcodes the SSC hub host", () => {
    expect(src).not.toContain("localhost:5185");
  });

  it("the in-app hub-focus primitive is fully retired", () => {
    expect(src).not.toContain("hubFocus");
    expect(src).not.toContain("hubFocusKey");
    expect(src).not.toContain("ProductHub");
    expect(src).not.toContain("showLegacy");
  });

  it("the #/tasks deep-link route still lands on the Product tab (no off-app redirect on load)", () => {
    expect(src).toMatch(/parseRoute\(window\.location\.hash\)\?\.page === "tasks" \? "product" : "jobs"/);
    expect(src).toMatch(/if \(route\?\.page === "tasks"\) setView\("product"\)/);
  });

  it("hands openEntity to both chip surfaces (RunPanel + ChatCapture)", () => {
    // RunPanel rides the expanded-runs map; ChatCapture keeps its generic
    // onViewTasks alongside the entity deep link.
    expect(src).toContain("onOpenEntity={openEntity}");
    expect(src).toMatch(/<ChatCapture[^/]*onViewTasks=[^/]*onOpenEntity=\{openEntity\}/);
  });
});

describe("ProductMoved is the permanent Product-tab content", () => {
  const app = read("../src/App.tsx");
  const src = read("../src/components/ProductMoved.tsx");

  it("the product view renders the handoff panel, nothing legacy", () => {
    expect(app).toMatch(/view === "product" \? \(\s*<ProductMoved hubUrl=\{config\?\.sscHubUrl\} \/>/);
  });

  it("its CTA targets the hub's shared named window via lib/sscHub, resolved base only", () => {
    expect(src).toContain("sscHubUrl(hubUrl)");
    expect(src).toContain("target={SSC_HUB_WINDOW}");
    expect(src).not.toContain("showLegacy");
    expect(src).not.toContain("localhost:5185");
  });

  // SIM-426: a private hosted instance is real mode but still remote - the
  // Product tab's own hub-not-configured fallback is the OTHER door "QA BUG-3"
  // (demoMode hiding the whole tab) did not close.
  it("renders an honest fallback (not a dead link) when no hub is configured", () => {
    expect(src).toContain("hubUrl ? (");
    expect(src).toContain("isn't reachable from here");
  });
});

describe("RunPanel renders the chip strip for finished ticket-scoped runs", () => {
  const src = read("../src/components/RunPanel.tsx");

  it("gates on the ticket-id shape of the run's jobId", () => {
    expect(src).toContain("isTicketId(run.jobId)");
  });

  it("derives via the shared helper and renders the shared strip", () => {
    expect(src).toContain("relatedEntitiesForAssessment({ ticketId, text: run?.output ?? ");
    expect(src).toContain("<RelatedChips entities={related} onOpen={onOpenEntity} />");
  });

  it("only renders once the run has finished (SIM-562: not pending - waiting-for-runner/stalled aren't finished either)", () => {
    expect(src).toMatch(/\{!pending && onOpenEntity && related && related\.length > 0/);
  });

  it("the lookup is fail-soft (chips are an affordance, never an error state)", () => {
    expect(src).toContain("api.getPortfolio().catch(() => null)");
    expect(src).toContain(".catch(() => {})");
  });
});

describe("ChatCapture report rows: assessment chips + ticket deep link", () => {
  const src = read("../src/components/ChatCapture.tsx");

  it("every entity click closes the panel FIRST, then navigates", () => {
    expect(src).toMatch(/function openEntityAndClose\(entity: EntityRef\) \{\s*closePanel\(\);\s*onOpenEntity\(entity\);/);
  });

  it("the row header deep-links to the report's own ticket card", () => {
    expect(src).toContain('openEntityAndClose({ kind: "task", id: report.id })');
  });

  it("the chips extract from the latest CTO comment body, under the assessment box", () => {
    expect(src).toContain("text: cto.body");
    expect(src).toContain("<RelatedChips");
    expect(src).toContain("onOpen={openEntityAndClose}");
  });

  it("keeps the generic onViewTasks for the done step's Open Product Hub button", () => {
    expect(src).toContain("onViewTasks();");
  });
});

describe("RelatedChips: one shared strip, trap-friendly and token-only", () => {
  const src = read("../src/components/RelatedChips.tsx");

  it("chips are plain buttons (dialogFocus traps pick them up automatically)", () => {
    expect(src).toContain('type="button"');
    expect(src).not.toContain("tabIndex");
  });

  it("each chip names its target for AT and is not color-only (text kind tag)", () => {
    expect(src).toContain("aria-label={`Open ${e.kind ===");
    expect(src).toMatch(/\{e\.kind === "task" \? "task" : "proj"\}/);
  });

  it("meets the 44px-on-touch tap target with the app's sm relaxation", () => {
    expect(src).toContain("min-h-[44px]");
    expect(src).toContain("sm:min-h-0");
  });

  it("uses design tokens only - no raw hex colors", () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).toContain("var(--color-edge)");
    expect(src).toContain("var(--color-accent)");
  });

  it("renders nothing for an empty strip (no stray caption)", () => {
    expect(src).toContain("if (entities.length === 0) return null;");
  });
});
