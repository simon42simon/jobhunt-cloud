import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DerivedSource, InstructionProposal } from "../src/types";
import {
  PROPOSAL_BADGE_BUSY_LABEL,
  PROPOSAL_BADGE_READY_LABEL,
  PROPOSAL_BUSY_LABEL,
  archivedProposals,
  buildResolvePayload,
  diffWords,
  instructionsProvenance,
  isProposing,
  pendingProposal,
  proposalBadgeState,
  provenanceLabel,
  validateSourceDraft,
} from "../src/lib/proposals";
import { PROPOSAL_STATUS_META } from "../src/lib/statusColors";

// Frontend half of the instruction-proposal loop (DISC-W3, t-1783198113775).
// The drawer's proposal card, the card badge, and the form's starting-link
// validation all read ONE pure vocabulary (src/lib/proposals.ts) - these tests
// pin that vocabulary: approve-flow state, reject-requires-reason, the busy
// state derived from the served proposeRunId, badge presence, and the
// instructions-optional / landing-URL-required form rule. The wiring itself
// (which component renders what) is pinned by the static source checks at the
// bottom, the same style as the kanban/job-modal a11y tests.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// --- fixtures ----------------------------------------------------------------

function mkProposal(p: Partial<InstructionProposal> = {}): InstructionProposal {
  return {
    id: "ip-1",
    ts: "2026-07-04T10:00:00.000Z",
    ownerComment: "",
    proposedInstructions: "Crawl the careers page and open each posting.",
    rationale: "",
    status: "pending",
    ...p,
  };
}

function mkSource(p: Partial<DerivedSource> = {}): DerivedSource {
  return {
    id: "oci",
    name: "OCI",
    type: "board",
    sector: "bps",
    active: "yes",
    urls: ["https://example.com/jobs"],
    cadence: "weekly",
    instructions: "",
    outputFields: [],
    aliases: [],
    tracks: [],
    lastRunAt: null,
    lastVisitedAt: null,
    notes: "",
    runs: [],
    status: "healthy",
    due: false,
    nextRunAt: null,
    jobCount: 0,
    newSinceVisit: 0,
    pursuedPct: 0,
    contractGaps: [],
    instructionProposals: [],
    instructionsApprovedFrom: null,
    instructionsUpdatedAt: null,
    proposeRunId: null,
    ...p,
  };
}

// --- pending / archived selection (the approve-flow state) -------------------

describe("pendingProposal / archivedProposals (approve-flow state)", () => {
  it("returns null / [] on a source that never entered the loop", () => {
    const s = mkSource();
    expect(pendingProposal(s)).toBeNull();
    expect(archivedProposals(s)).toEqual([]);
  });

  it("surfaces the newest pending proposal (served newest-first)", () => {
    const newest = mkProposal({ id: "ip-2", ts: "2026-07-04T12:00:00.000Z" });
    const older = mkProposal({ id: "ip-1", ts: "2026-07-03T12:00:00.000Z", status: "rejected", rejectionReason: "no" });
    const s = mkSource({ instructionProposals: [newest, older] });
    expect(pendingProposal(s)?.id).toBe("ip-2");
  });

  it("after an approve the proposal leaves pending and lands in the archive - the card unmounts, the history grows", () => {
    const approved = mkProposal({ id: "ip-2", status: "approved", resolvedAt: "2026-07-04T13:00:00.000Z" });
    const s = mkSource({
      instructionProposals: [approved],
      instructions: approved.proposedInstructions,
      instructionsApprovedFrom: "ip-2",
      instructionsUpdatedAt: "2026-07-04T13:00:00.000Z",
    });
    expect(pendingProposal(s)).toBeNull();
    expect(archivedProposals(s).map((p) => p.id)).toEqual(["ip-2"]);
    expect(instructionsProvenance(s)).toEqual({
      kind: "approved",
      date: "2026-07-04T13:00:00.000Z",
      proposalId: "ip-2",
    });
  });

  it("keeps rejected proposals in the archive (never deleted - their reasons feed the next run)", () => {
    const rejected = mkProposal({ id: "ip-1", status: "rejected", rejectionReason: "search page, not postings" });
    const s = mkSource({ instructionProposals: [mkProposal({ id: "ip-2" }), rejected] });
    expect(archivedProposals(s)).toHaveLength(1);
    expect(archivedProposals(s)[0].rejectionReason).toBe("search page, not postings");
  });
});

// --- reject requires a reason -------------------------------------------------

describe("buildResolvePayload (reject requires a non-blank reason - the server's own 400 rule)", () => {
  it("approve needs no reason", () => {
    expect(buildResolvePayload("approved")).toEqual({ status: "approved" });
    expect(buildResolvePayload("approved", "ignored")).toEqual({ status: "approved" });
  });

  it("reject with a blank or whitespace-only reason is unsendable (null - the confirm button disables)", () => {
    expect(buildResolvePayload("rejected")).toBeNull();
    expect(buildResolvePayload("rejected", "")).toBeNull();
    expect(buildResolvePayload("rejected", "   \n\t ")).toBeNull();
  });

  it("reject with a real reason builds the PATCH body, trimmed", () => {
    expect(buildResolvePayload("rejected", "  links open a search page  ")).toEqual({
      status: "rejected",
      rejectionReason: "links open a search page",
    });
  });
});

// --- busy state from proposeRunId ----------------------------------------------

describe("isProposing / proposalBadgeState (busy state derives from the SERVED proposeRunId, so it survives reload)", () => {
  it("is busy exactly when proposeRunId is set", () => {
    expect(isProposing(mkSource({ proposeRunId: "r-123" }))).toBe(true);
    expect(isProposing(mkSource({ proposeRunId: null }))).toBe(false);
  });

  it("badge: 'reviewing' while a propose run is live - even if a pending proposal also exists", () => {
    const s = mkSource({ proposeRunId: "r-123", instructionProposals: [mkProposal()] });
    expect(proposalBadgeState(s)).toEqual({ kind: "reviewing" });
  });

  it("badge: 'ready' when a pending proposal awaits review and no run is live", () => {
    const p = mkProposal();
    const state = proposalBadgeState(mkSource({ instructionProposals: [p] }));
    expect(state).toEqual({ kind: "ready", proposal: p });
  });

  it("badge: absent (null) when there is nothing to say - the NewBadge convention", () => {
    expect(proposalBadgeState(mkSource())).toBeNull();
    expect(
      proposalBadgeState(
        mkSource({ instructionProposals: [mkProposal({ status: "approved", resolvedAt: "2026-07-04T13:00:00.000Z" })] }),
      ),
    ).toBeNull();
  });

  it("busy copy exists and the badge labels are distinct (drawer says 'your note', the badge is shorter)", () => {
    expect(PROPOSAL_BUSY_LABEL).toMatch(/Reviewing/);
    expect(PROPOSAL_BADGE_BUSY_LABEL).toMatch(/Reviewing/);
    expect(PROPOSAL_BADGE_READY_LABEL).toMatch(/Proposal ready/);
  });
});

// --- provenance display rule ---------------------------------------------------

describe("instructionsProvenance / provenanceLabel (the server-contract display rule)", () => {
  it("both stamps set -> 'Approved <date> from a proposal'", () => {
    const s = mkSource({ instructionsApprovedFrom: "ip-9", instructionsUpdatedAt: "2026-07-02T09:00:00.000Z" });
    const p = instructionsProvenance(s);
    expect(p.kind).toBe("approved");
    expect(provenanceLabel(p)).toMatch(/^Approved .*2026.* from a proposal$/);
  });

  it("instructionsUpdatedAt alone -> 'Set manually <date>' (a manual edit clears the approve stamp server-side)", () => {
    const s = mkSource({ instructionsUpdatedAt: "2026-06-30T09:00:00.000Z" });
    const p = instructionsProvenance(s);
    expect(p.kind).toBe("manual");
    expect(provenanceLabel(p)).toMatch(/^Set manually .*2026/);
  });

  it("neither -> never set via the loop", () => {
    const p = instructionsProvenance(mkSource());
    expect(p.kind).toBe("never");
    expect(provenanceLabel(p)).toBe("Never set via the proposal loop");
  });

  it("degenerate approvedFrom-without-a-date (impossible via the API) degrades to 'never', not a broken date", () => {
    expect(instructionsProvenance(mkSource({ instructionsApprovedFrom: "ip-9" })).kind).toBe("never");
  });
});

// --- BEFORE/AFTER diff -----------------------------------------------------------

describe("diffWords (the proposal card's Current | Proposed highlight)", () => {
  it("identical texts diff to all-same on both sides", () => {
    const d = diffWords("crawl the page", "crawl the page")!;
    expect(d.before).toEqual([{ text: "crawl the page", op: "same" }]);
    expect(d.after).toEqual([{ text: "crawl the page", op: "same" }]);
  });

  it("marks a replaced word as removed on the left, added on the right", () => {
    const d = diffWords("open the search page", "open the posting page")!;
    expect(d.before).toEqual([
      { text: "open the", op: "same" },
      { text: "search", op: "removed" },
      { text: "page", op: "same" },
    ]);
    expect(d.after).toEqual([
      { text: "open the", op: "same" },
      { text: "posting", op: "added" },
      { text: "page", op: "same" },
    ]);
  });

  it("an empty current side (cold start) is all-added on the proposed side", () => {
    const d = diffWords("", "crawl the careers page")!;
    expect(d.before).toEqual([]);
    expect(d.after).toEqual([{ text: "crawl the careers page", op: "added" }]);
  });

  it("returns null past the size budget so the card falls back to plain blocks", () => {
    const big = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    expect(diffWords(big, `${big} tail`)).toBeNull();
  });
});

// --- starting-link form rule -------------------------------------------------------

describe("validateSourceDraft (starting-link principle: new source = name + landing URL, instructions optional)", () => {
  it("a new source with a name and a landing URL saves (instructions deliberately not validated)", () => {
    expect(validateSourceDraft({ editing: false, name: "OPS careers", urls: ["https://example.com/jobs"] })).toBeNull();
  });

  it("a new source without a landing URL is blocked, and the message says why", () => {
    const err = validateSourceDraft({ editing: false, name: "OPS careers", urls: [] });
    expect(err).toMatch(/landing URL/i);
    expect(validateSourceDraft({ editing: false, name: "OPS careers", urls: ["   "] })).toMatch(/landing URL/i);
  });

  it("a blank name is blocked in both modes", () => {
    expect(validateSourceDraft({ editing: false, name: "  ", urls: ["https://x.io"] })).toBe("Name is required.");
    expect(validateSourceDraft({ editing: true, name: "", urls: [] })).toBe("Name is required.");
  });

  it("editing a legacy source without URLs still saves (only creation enforces the landing URL)", () => {
    expect(validateSourceDraft({ editing: true, name: "OCI", urls: [] })).toBeNull();
  });
});

// --- status vocabulary --------------------------------------------------------------

describe("PROPOSAL_STATUS_META (AA color vocabulary, statusColors module)", () => {
  it("resolves every proposal status with a label + vetted hex", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(PROPOSAL_STATUS_META[status].label).toBeTruthy();
      expect(PROPOSAL_STATUS_META[status].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// --- wiring (static source checks, the a11y-test idiom) -------------------------------

describe("component wiring (static source checks)", () => {
  const card = read("../src/components/SourceCard.tsx");
  const drawer = read("../src/components/SourceDetailDrawer.tsx");
  const form = read("../src/components/SourceFormDrawer.tsx");
  const shared = read("../src/components/sourcesShared.tsx");
  const hook = read("../src/hooks/useDiscoverySources.ts");

  it("SourceCard renders the ProposalBadge and deep-links it to the Instructions tab", () => {
    expect(card).toContain("<ProposalBadge");
    expect(card).toMatch(/ProposalBadge[\s\S]*?tab:\s*"instructions"/);
  });

  it("the shared ProposalBadge reads proposalBadgeState and the vetted proposal colors (no raw status literals)", () => {
    expect(shared).toContain("proposalBadgeState");
    expect(shared).toContain("PROPOSAL_STATUS_META");
  });

  it("the drawer gates the reject confirm on buildResolvePayload (the same rule the server 400s on)", () => {
    expect(drawer).toMatch(/disabled=\{busy \|\| !buildResolvePayload\("rejected", reason\)\}/);
  });

  it("the drawer's busy state renders the shared 'Reviewing your note…' copy off isProposing", () => {
    expect(drawer).toContain("PROPOSAL_BUSY_LABEL");
    expect(drawer).toContain("isProposing(source)");
  });

  it("the drawer renders the provenance caption via the derived rule, never a stored string", () => {
    expect(drawer).toContain("provenanceLabel(instructionsProvenance(source))");
  });

  it("the form validates through validateSourceDraft (starting-link rule, one shared copy)", () => {
    expect(form).toContain("validateSourceDraft({ editing, name, urls })");
  });

  it("the shared sources hook refreshes on both proposal signals (proposals-changed + the propose run closing)", () => {
    expect(hook).toContain('useEventSubscription("source-proposals-changed"');
    expect(hook).toMatch(/run-finished[\s\S]*?propose-instructions/);
  });
});
