// Records -> Reviews & Logs, the addressed-via-tickets join
// (docs/product-hub-ia-v2.md sections 4a + 6). Given the docs list (filtered
// to meta.type "review" | "log") and the tasks list, computes each doc's
// linked tickets, done tickets, and clear/open/not-tracked status via the
// verbatim `source: "review:<doc-name>"` field - a pure client-side join, no
// parallel status store. No React, no fetch - callers (ReviewsLogsView) pass
// in already-fetched data so this stays trivially unit-testable.

import type { DocSummary, Task } from "../types";

export type AddressedStatus = "clear" | "open" | "not-tracked";

export interface ReviewLogRow {
  doc: DocSummary;
  date: string;
  linked: Task[];
  done: Task[];
  status: AddressedStatus;
}

// Date fallback for docs whose frontmatter has not been authored yet (spec:
// "meta.date, else parsed from the filename"). Matches a YYYY-MM-DD anywhere
// in the doc id ("enablement-reviews/2026-07-01", "build-log-2026-07-01",
// "audits/2026-07-01-ultracode-audit"); ids with no date (e.g.
// "agent-roster-audit") fall through to null.
export function dateFromName(name: string): string | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// clear = every linked ticket is done AND no untriaged recs remain; open = a
// linked ticket is not done, or recs > linked; not-tracked = no meta.recs
// declared and no ticket has linked itself to this doc yet (spec section 4a).
export function computeStatus(recs: number | undefined, linked: Task[], done: Task[]): AddressedStatus {
  if (recs === undefined && linked.length === 0) return "not-tracked";
  const allLinkedDone = linked.length === 0 || done.length === linked.length;
  const recsCovered = recs === undefined || linked.length >= recs;
  return allLinkedDone && recsCovered ? "clear" : "open";
}

// Per-doc "pending decisions": recommendations the doc declared (meta.recs)
// that have no linked ticket yet. Untriaged = recs - linked.length, floored
// at 0 (a doc can accumulate more tickets than it declared recs, e.g.
// follow-up work discovered after triage - that is not a negative count of
// pending decisions). Returns 0 when the doc declares no recs at all, so
// callers can render the "pending decisions" callout purely off this number
// without re-checking meta.recs themselves. Drives the per-doc drill-down
// table's pending-decisions banner in ReviewsLogsView (docs/product-hub-ia-v2.md
// section 6).
export function untriagedRecsCount(recs: number | undefined, linked: Task[]): number {
  if (recs === undefined) return 0;
  return Math.max(0, recs - linked.length);
}

// Buckets a ticket's raw status string (see statusColors.ts STATUS_COLOR for
// the full vocabulary) into one of four coarse progression stages for the
// per-doc ticket table's compact progress cue - a Linear/Asana-style status
// ring that reads at a glance, independent of and alongside the full-fidelity
// status pill (which keeps the exact status word, e.g. "in review").
export type ProgressionStage = "not-started" | "in-progress" | "done" | "blocked";

const DONE_STATUSES = new Set(["done", "shipped", "complete"]);
const IN_PROGRESS_STATUSES = new Set(["in_progress", "active", "in_review"]);
const BLOCKED_STATUSES = new Set(["blocked", "paused", "canceled"]);

export function progressionStage(status: string): ProgressionStage {
  if (DONE_STATUSES.has(status)) return "done";
  if (BLOCKED_STATUSES.has(status)) return "blocked";
  if (IN_PROGRESS_STATUSES.has(status)) return "in-progress";
  return "not-started";
}

// The full join: filter docs to review/log types, match each against the
// tasks whose `source` exactly equals `review:<doc.name>`, and compute the
// per-row addressed status. Sorted newest-first by date (docs with no
// resolvable date sort last, per the "" fallback of a string compare).
export function computeReviewLogRows(docs: DocSummary[], tasks: Task[]): ReviewLogRow[] {
  return docs
    .filter((d) => d.meta?.type === "review" || d.meta?.type === "log")
    .map((d) => {
      const linked = tasks.filter((t) => t.source === `review:${d.name}`);
      const done = linked.filter((t) => t.status === "done");
      return {
        doc: d,
        date: d.meta?.date || dateFromName(d.name) || "",
        linked,
        done,
        status: computeStatus(d.meta?.recs, linked, done),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
