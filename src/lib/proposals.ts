// ---------------------------------------------------------------------------
// Pure helpers for the instruction-proposal loop (DISC-W3, docs/data-schema.md
// §5 Decision 4): the owner stops hand-editing a source's crawl instructions -
// they leave a note, the scout files a proposal, the owner approves it or
// rejects it with a reason. No fetch, no JSX (the lib/sources.ts discipline):
// everything here is a pure read of the served DerivedSource, so the drawer's
// proposal card, the source card's badge, and the tests can never disagree
// about what "pending", "reviewing", or "approved from a proposal" means.
// ---------------------------------------------------------------------------
import type { DerivedSource, InstructionProposal } from "../types";

// Shared copy for the busy state - one string, three render sites (drawer
// status box, card badge, tests), so the wording can't drift.
export const PROPOSAL_BUSY_LABEL = "Reviewing your note…";
export const PROPOSAL_BADGE_BUSY_LABEL = "Reviewing note…";
export const PROPOSAL_BADGE_READY_LABEL = "Proposal ready";

// The newest pending proposal (instructionProposals is served newest-first) -
// the one the drawer's proposal card puts up for review. Tolerant of a
// hand-edited out-of-order log: first pending in served order.
export function pendingProposal(source: DerivedSource): InstructionProposal | null {
  return (source.instructionProposals || []).find((p) => p.status === "pending") ?? null;
}

// Resolved (approved/rejected) proposals in served (newest-first) order - the
// collapsed "Past proposals" history list.
export function archivedProposals(source: DerivedSource): InstructionProposal[] {
  return (source.instructionProposals || []).filter((p) => p.status !== "pending");
}

// A propose-instructions run is live for this source right now. proposeRunId
// is DERIVED server process state (survives a page reload) - the exact signal
// the server's own 409 guard reads, so the UI can never disagree with the
// server about "in flight".
export function isProposing(source: DerivedSource): boolean {
  return !!source.proposeRunId;
}

// What the source card's proposal badge shows: a live propose run wins
// ("Reviewing note…" - the same busy family as "Running…"), else a pending
// proposal ("Proposal ready" - good news, not an alarm), else nothing (the
// caller renders null - the NewBadge convention).
export type ProposalBadgeState = { kind: "reviewing" } | { kind: "ready"; proposal: InstructionProposal };

export function proposalBadgeState(source: DerivedSource): ProposalBadgeState | null {
  if (isProposing(source)) return { kind: "reviewing" };
  const p = pendingProposal(source);
  return p ? { kind: "ready", proposal: p } : null;
}

// ---- provenance (the caption under the instructions block) -----------------

// DERIVED, never stored (the app-wide derive-not-store discipline). Display
// rule per the server contract: BOTH stamps set = approved from a proposal;
// instructionsUpdatedAt alone = set manually (a manual edit clears
// instructionsApprovedFrom + re-stamps instructionsUpdatedAt server-side, so
// this can never lie); neither = never set via the loop. A degenerate
// approvedFrom-with-no-date (impossible via the API) degrades to "never".
export type InstructionsProvenance =
  | { kind: "approved"; date: string; proposalId: string }
  | { kind: "manual"; date: string }
  | { kind: "never" };

export function instructionsProvenance(source: DerivedSource): InstructionsProvenance {
  if (source.instructionsApprovedFrom && source.instructionsUpdatedAt) {
    return { kind: "approved", date: source.instructionsUpdatedAt, proposalId: source.instructionsApprovedFrom };
  }
  if (source.instructionsUpdatedAt) return { kind: "manual", date: source.instructionsUpdatedAt };
  return { kind: "never" };
}

// Human date for a provenance stamp ("Jul 2, 2026") - locale-formatted like
// relativeTime's absolute fallback; an unparseable stamp falls back to the raw
// string rather than "Invalid Date".
function provenanceDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function provenanceLabel(p: InstructionsProvenance): string {
  if (p.kind === "approved") return `Approved ${provenanceDate(p.date)} from a proposal`;
  if (p.kind === "manual") return `Set manually ${provenanceDate(p.date)}`;
  return "Never set via the proposal loop";
}

// ---- resolve payload (the approve / reject-with-reason PATCH body) ---------

// Build the PATCH body for an approve/reject click, or null when the input
// cannot be submitted (rejecting with a blank reason - the server would 400).
// The confirm button disables exactly when this returns null, so the UI gate
// and the server gate are the SAME rule, not two copies of it.
export type ResolveProposalPayload = { status: "approved" } | { status: "rejected"; rejectionReason: string };

export function buildResolvePayload(
  verdict: "approved" | "rejected",
  rejectionReason = "",
): ResolveProposalPayload | null {
  if (verdict === "approved") return { status: "approved" };
  const reason = rejectionReason.trim();
  if (!reason) return null;
  return { status: "rejected", rejectionReason: reason };
}

// ---- BEFORE/AFTER word diff (the proposal card's Current | Proposed view) --

// Instructions are prose, not code (design spec §11.2), so the diff is a cheap
// word-level LCS: enough to bold what changed, no line-diff machinery. Returns
// per-side segments with adjacent same-op words merged; returns null when the
// two texts are big enough that the O(n*m) table stops being cheap - the
// caller then renders plain side-by-side blocks (the spec's v1 baseline).
export type DiffOp = "same" | "removed" | "added";
export interface DiffSeg {
  text: string;
  op: DiffOp;
}

const DIFF_CELL_BUDGET = 250_000; // ~500x500 words; beyond this, plain blocks

export function diffWords(
  before: string,
  after: string,
): { before: DiffSeg[]; after: DiffSeg[] } | null {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length * b.length > DIFF_CELL_BUDGET) return null;

  // LCS length table (a.length+1 x b.length+1).
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  // Walk the table into per-side op streams.
  const beforeSegs: DiffSeg[] = [];
  const afterSegs: DiffSeg[] = [];
  const push = (list: DiffSeg[], op: DiffOp, word: string) => {
    const last = list[list.length - 1];
    if (last && last.op === op) last.text += ` ${word}`;
    else list.push({ text: word, op });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(beforeSegs, "same", a[i]);
      push(afterSegs, "same", b[j]);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      push(beforeSegs, "removed", a[i]);
      i++;
    } else {
      push(afterSegs, "added", b[j]);
      j++;
    }
  }
  while (i < a.length) push(beforeSegs, "removed", a[i++]);
  while (j < b.length) push(afterSegs, "added", b[j++]);
  return { before: beforeSegs, after: afterSegs };
}

// ---- starting-link authoring rule (SourceFormDrawer validation) ------------

// A NEW source needs only a name and a landing URL - the proposal loop authors
// the instructions after the first save (design spec §11.4), so instructions
// are deliberately NOT validated here. Editing keeps only the name required (a
// legacy source may predate URLs; blocking its save would be hostile). Returns
// the inline error message, or null when the draft can save.
export function validateSourceDraft(draft: { editing: boolean; name: string; urls: string[] }): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!draft.editing && !draft.urls.some((u) => u.trim())) {
    return "A landing URL is required - the scout studies it to propose this source's crawl instructions.";
  }
  return null;
}
