import type { NewCommentInput, Task } from "../types";

// Pure selectors for the Parked owner-decision inbox (US-1, t-1783317937079;
// canonical-signal redesign ADR-020, t-1783371847653).
//
// A PARKED item is the standardized convention the CTO/agents apply when a
// ticket genuinely needs Simon's call in an autonomous away-session. The parking
// note lives in the ticket `detail` (a fixed template starting "PARKED FOR
// OWNER"). This module is the read-only lens over that convention - kept
// DOM-free / fetch-free so it unit-tests node-env style (tests/decisions.test.ts),
// the same model as lib/intake.ts and lib/addressed.ts. The DecisionsView and
// the hub count badge both consume it, so the panel and the badge can never
// disagree on what is waiting.
//
// CANONICAL SIGNAL (ADR-020): a ticket is "parked for the owner" iff it is
// non-terminal AND it carries the "parked" label OR its title starts "[PARKED]".
// The old rule required BOTH "owner-decision" AND "parked" - a fragile TWO-label
// conjunction. An agent that filed the ticket with "owner-decision" + a "[PARKED]"
// title but forgot the "parked" label had its decision SILENTLY DROPPED from the
// inbox (the live contacts/referrals US-9 and Apify tickets). The redesign fails
// OPEN instead: either signal surfaces the decision, so a single missed label can
// never hide a call the owner needs to make (the same "conservative on loss"
// posture useTasks takes on a pending resolve). "parked" is the machine signal the
// resolve/defer lifecycle toggles; the "[PARKED]" title is the human-visible
// backstop the parking template always writes. computeParkedConsistency
// (server/lib.js) is the deterministic guard that flags any drift between the two.
export const OWNER_DECISION_LABEL = "owner-decision";
export const PARKED_LABEL = "parked";

// The human-visible park marker the "PARKED FOR OWNER" template writes into the
// ticket title. Kept in sync with the "parked" label by the resolve lifecycle
// (both cleared on resolve) and by computeParkedConsistency.
export const PARKED_TITLE_PREFIX = "[PARKED]";
const PARKED_TITLE_RE = /^\s*\[parked\]\s*/i;

// True iff a title carries the "[PARKED]" marker (case-insensitive, leading
// whitespace tolerant). Tolerant of a missing title.
export function isParkedTitle(title: string | undefined | null): boolean {
  return PARKED_TITLE_RE.test(title ?? "");
}

// The title with the leading "[PARKED] " marker removed (resolution clears it, the
// same lifecycle step that drops the "parked" label). A no-op when unmarked, so a
// non-parked title round-trips unchanged.
export function stripParkedPrefix(title: string | undefined | null): string {
  return (title ?? "").replace(PARKED_TITLE_RE, "");
}

// Terminal board columns (docs/taskMeta ALL_COLUMNS). A decision the owner has
// already resolved lands the ticket in one of these, so it should DROP OFF the
// inbox - the panel only ever shows calls still genuinely waiting.
const TERMINAL_STATUSES = new Set(["done", "canceled"]);

// True iff the ticket is parked for the owner AND still open: non-terminal, and
// carrying EITHER canonical signal - the "parked" label OR a "[PARKED]" title
// (ADR-020). Fails OPEN: a single missed signal cannot hide the decision.
// Tolerant of a missing/empty `labels` (a task without the ticket-system fields
// round-trips with labels absent).
export function isParkedForOwner(task: Task): boolean {
  if (TERMINAL_STATUSES.has(task.status)) return false;
  const labels = task.labels ?? [];
  return labels.includes(PARKED_LABEL) || isParkedTitle(task.title);
}

// Newest-first ordering key. `created` is YYYY-MM-DD (date granularity), so a
// same-day tie is broken by the id DESC - task ids are "t-<epochms>", which is
// chronological and unique, matching the "created/id descending" rule other
// views (IntakeView ts DESC, TaskBoard created DESC) sort by.
function byNewest(a: Task, b: Task): number {
  const ca = a.created ?? "";
  const cb = b.created ?? "";
  if (ca !== cb) return cb.localeCompare(ca);
  return (b.id ?? "").localeCompare(a.id ?? "");
}

// The filtered inbox, newest-first. Does not mutate the input (filter returns a
// fresh array, sort mutates only that copy).
export function selectParkedDecisions(tasks: Task[]): Task[] {
  return tasks.filter(isParkedForOwner).sort(byNewest);
}

// The parking note to render for a ticket: the `detail` block (the "PARKED FOR
// OWNER" template) when present, else the latest comment body, whichever
// carries the note. Returns "" when neither does, so the view can show a
// graceful placeholder rather than a blank card.
export function parkingNote(task: Task): string {
  const detail = (task.detail ?? "").trim();
  if (detail) return detail;
  const comments = task.comments ?? [];
  const last = comments.length > 0 ? comments[comments.length - 1] : null;
  return last ? (last.body ?? "").trim() : "";
}

// ---------------------------------------------------------------------------
// Parking-note parser (Decisions surface v2, t-1783336697733). Turns the
// standardized "PARKED FOR OWNER" template (autonomous-session skill section 4)
// into structured fields so DecisionsView can render a scannable, actionable
// card instead of one verbatim text block. Pure + DOM/fetch-free (unit-tested
// alongside the selectors above). Deliberately TOLERANT so a hand-authored note
// never crashes the view:
//   - case-insensitive section headers;
//   - a leading "PARKED FOR OWNER..." banner (and any pre-header prose) ignored;
//   - a missing section degrades to `undefined` (never an empty header);
//   - a note with NO recognized header returns `null`, which is the view's
//     signal to fall back to the generic (verbatim) card - the safety net for a
//     ticket that did not follow the template and for the empty-`detail` case.
// ---------------------------------------------------------------------------

export interface ParkingOption {
  key: string; // the option letter, e.g. "A" (uppercased)
  text: string; // the option itself
  tradeoff?: string; // the "- <tradeoff>" tail, when present
}

export interface ParsedParkingNote {
  whatItIs?: string;
  whyParked?: string; // raw phrase, e.g. "product fork"
  options: ParkingOption[]; // [] when none
  recommendedDefault?: string;
  whatIDidMeanwhile?: string;
  howToResolve?: string;
  raw: string; // always the full note, for the fallback / details
}

type SectionField =
  | "whatItIs"
  | "whyParked"
  | "options"
  | "recommendedDefault"
  | "whatIDidMeanwhile"
  | "howToResolve";

// Header spelling (before the colon, lowercased) -> the field it feeds.
const HEADER_FIELD: Record<string, SectionField> = {
  "what it is": "whatItIs",
  "why parked": "whyParked",
  options: "options",
  "recommended default": "recommendedDefault",
  "what i did meanwhile": "whatIDidMeanwhile",
  "how to resolve": "howToResolve",
};

// A section-header line: "<HEADER>: <optional first line of the body>".
const HEADER_RE =
  /^\s*(what it is|why parked|options|recommended default|what i did meanwhile|how to resolve)\s*:\s*(.*)$/i;

// One option row (design spec section 3.1): tolerant of "A)", "- A)", "* A)",
// a missing tradeoff, and a " - <tradeoff>" tail split on the FIRST " - ".
const OPTION_RE = /^\s*[-*]?\s*([A-Za-z])\)\s*(.+?)(?:\s+-\s+(.+))?$/;

export function parseParkingNote(detail: string): ParsedParkingNote | null {
  const raw = detail ?? "";
  const buckets = new Map<SectionField, string[]>();
  let current: SectionField | null = null;
  let sawHeader = false;

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(HEADER_RE);
    if (m) {
      sawHeader = true;
      current = HEADER_FIELD[m[1].toLowerCase()];
      const bucket = buckets.get(current) ?? [];
      if (m[2].trim()) bucket.push(m[2]);
      buckets.set(current, bucket);
    } else if (current) {
      const bucket = buckets.get(current) ?? [];
      bucket.push(line);
      buckets.set(current, bucket);
    }
    // Lines before the first recognized header (the "PARKED FOR OWNER" banner)
    // belong to no section and are dropped.
  }

  if (!sawHeader) return null;

  const body = (field: SectionField): string | undefined => {
    const joined = (buckets.get(field) ?? []).join("\n").trim();
    return joined ? joined : undefined;
  };

  // Build options row-by-row so a WRAPPED option - a description that spills onto
  // the next, non-"X)" line - is APPENDED to its option instead of being dropped.
  // The old `.filter(match)` silently discarded every continuation line, which
  // could truncate a multi-line OPTIONS entry (the "OPTIONS not fully shown"
  // gap). A continuation seeds or extends the tradeoff so the full text always
  // survives; a stray line before the first "X)" row has no owner and is ignored.
  const options: ParkingOption[] = [];
  for (const line of buckets.get("options") ?? []) {
    const m = line.match(OPTION_RE);
    if (m) {
      options.push({ key: m[1].toUpperCase(), text: m[2].trim(), tradeoff: m[3]?.trim() || undefined });
    } else if (line.trim() && options.length > 0) {
      const prev = options[options.length - 1];
      const extra = line.trim();
      prev.tradeoff = prev.tradeoff ? `${prev.tradeoff} ${extra}` : extra;
    }
  }

  return {
    whatItIs: body("whatItIs"),
    whyParked: body("whyParked"),
    options,
    recommendedDefault: body("recommendedDefault"),
    whatIDidMeanwhile: body("whatIDidMeanwhile"),
    howToResolve: body("howToResolve"),
    raw,
  };
}

// Which option (if any) the RECOMMENDED DEFAULT line points at, so the card can
// star it + make its Choose button primary. Tolerant: a leading "B", "B)",
// "Option B", "B -", "B:" wins; otherwise the first option letter referenced as
// "X)" anywhere in the line. Returns undefined when nothing lines up (the card
// then shows no recommendation, never a wrong one).
export function recommendedOptionKey(note: ParsedParkingNote): string | undefined {
  const rec = note.recommendedDefault;
  if (!rec || note.options.length === 0) return undefined;
  const keys = note.options.map((o) => o.key);
  const lead = rec.match(/^\s*(?:option\s+)?([A-Za-z])\b/i);
  if (lead && keys.includes(lead[1].toUpperCase())) return lead[1].toUpperCase();
  for (const k of keys) {
    if (new RegExp(`\\b${k}\\)`, "i").test(rec)) return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The COMPLETE, ordered content model a decision DETAIL view renders from a
// parsed note. The inbox card only ever surfaced What-it-is / Options /
// What-I-did-meanwhile: the WHY-PARKED paragraph showed as a one-line tone chip
// (its full reasoning readable only via a hover title, invisible on touch) and
// the RECOMMENDED-DEFAULT reasoning had NO on-screen home at all (it only fed a
// button's aria-label). A decisions inbox you cannot read the decision in is
// broken, so this exposes EVERY prose section - each with its FULL, untruncated
// body - plus the OPTIONS block, in template order. The raw verbatim note is
// rendered by the view SEPARATELY (always, as the ultimate nothing-hidden
// fallback), so it is not a block here. A null (non-template) parse returns [],
// the view's signal to show only the raw note. Pure + DOM-free (unit-tested
// alongside the parser) so "the full detail renders, nothing truncated" is
// provable without a browser.
// ---------------------------------------------------------------------------
export type DecisionDetailBlock =
  | { kind: "section"; label: string; body: string }
  | { kind: "options"; options: ParkingOption[]; recommendedKey?: string };

export function decisionDetailBlocks(parsed: ParsedParkingNote | null): DecisionDetailBlock[] {
  if (!parsed) return [];
  const blocks: DecisionDetailBlock[] = [];
  const section = (label: string, body?: string) => {
    if (body && body.trim()) blocks.push({ kind: "section", label, body: body.trim() });
  };
  section("What it is", parsed.whatItIs);
  section("Why parked", parsed.whyParked);
  if (parsed.options.length > 0) {
    blocks.push({ kind: "options", options: parsed.options, recommendedKey: recommendedOptionKey(parsed) });
  }
  section("Recommended default", parsed.recommendedDefault);
  section("What I did meanwhile", parsed.whatIDidMeanwhile);
  section("How to resolve", parsed.howToResolve);
  return blocks;
}

// The labels to SEND on a resolve write. The server REPLACES the labels array
// wholesale (coerceLabels), so this returns the full intended set: every current
// label EXCEPT "parked". Dropping "parked" is what takes the ticket off the
// inbox (isParkedForOwner turns false); "owner-decision" and any others stay, so
// the ticket is forever greppable as an owner decision.
export function labelsAfterResolve(labels: string[] | undefined): string[] {
  return (labels ?? []).filter((l) => l !== PARKED_LABEL);
}

// The three ways to resolve, plus the exact comment each records. `choose` and
// `approve` are the one-click paths; `note` is the owner's own call.
export type ResolveAction =
  | { kind: "choose"; option: ParkingOption }
  | { kind: "approve"; recommended?: string }
  | { kind: "note"; body: string; done?: boolean }
  // DISMISS / REJECT: close the decision WITHOUT acting on any option (the owner
  // read it and is choosing to do nothing). Terminal "canceled" (abandoned, not
  // "done") takes it off the inbox; still undoable via the resolve Undo window.
  | { kind: "dismiss" };

// The ONE atomic PATCH body a resolve writes (design section 4.1): an appended
// owner comment, the labels minus "parked", a status, and - when the title still
// carries the "[PARKED]" marker - the title with that marker stripped. Pure, so
// the exact write shape is unit-tested without a network - the "never write the
// wrong thing" guard. Default status is "todo" (a resolved decision usually spawns
// work); "Resolve with note" may set "done" ("no follow-up needed").
//
// Stripping "[PARKED]" is what takes a resolved-but-still-open (status "todo")
// decision off the inbox under the ADR-020 union predicate: dropping only the
// "parked" label would not be enough while the title still says "[PARKED]". The
// two park signals are cleared together, exactly as they were meant to be set
// together. `title` is omitted when the title carries no marker, so a resolve
// never writes a redundant unchanged field.
export function buildResolveWrite(
  task: Task,
  action: ResolveAction,
): { comment: NewCommentInput; labels: string[]; status: string; title?: string } {
  let body: string;
  let status = "todo";
  if (action.kind === "choose") {
    body = `Owner decision: chose Option ${action.option.key} - ${action.option.text}.`;
  } else if (action.kind === "approve") {
    body = action.recommended
      ? `Owner decision: approved the recommended default - ${action.recommended}.`
      : "Owner decision: approved.";
  } else if (action.kind === "dismiss") {
    // Belt-and-braces off the inbox: "canceled" is terminal on its own, and the
    // label drop + title strip below clear the two park signals as well.
    body = "Owner decision: dismissed - closed without choosing an option.";
    status = "canceled";
  } else {
    body = action.body;
    if (action.done) status = "done";
  }
  const write: { comment: NewCommentInput; labels: string[]; status: string; title?: string } = {
    comment: { author: "owner", body },
    labels: labelsAfterResolve(task.labels),
    status,
  };
  const stripped = stripParkedPrefix(task.title);
  if (stripped !== task.title) write.title = stripped;
  return write;
}

// The date of the most recent "Owner deferred on YYYY-MM-DD" comment on a ticket,
// or null when it was never deferred. Defer's whole record is this appended
// comment (buildDeferComment) - the PERSISTED, durable trace. The DecisionsView
// seeds its "Deferred {date}" chip from this so the acknowledgment survives a
// refresh: previously the chip lived only in ephemeral component state, so after a
// reload the deferral looked lost and the owner re-clicked Defer (the live Chrome
// ticket accumulated FOUR identical defer comments this way). Newest date wins;
// YYYY-MM-DD compares lexically, so a string max is chronological.
const DEFER_COMMENT_RE = /^Owner deferred on (\d{4}-\d{2}-\d{2})\b/;
export function latestDeferredOn(task: Task): string | null {
  let latest: string | null = null;
  for (const c of task.comments ?? []) {
    const m = (c.body ?? "").match(DEFER_COMMENT_RE);
    if (m && (latest === null || m[1] > latest)) latest = m[1];
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Defer = SNOOZE (Option A, ADR-021 / t-1783371847653). The reported bug: Defer
// only appended the "Owner deferred on YYYY-MM-DD" comment and KEPT the "parked"
// label, so the decision never left the active inbox - on refresh it reappeared
// unchanged (the live ticket accumulated four identical defer comments this way).
// Fix: a deferred decision is SNOOZED out of the ACTIVE inbox for
// DEFER_SNOOZE_DAYS, then resurfaces on its own, with a "Deferred" section to see
// the snoozed ones meanwhile. Snooze is DERIVED PURELY from the existing defer
// comment (latestDeferredOn) - NO new persisted field - so docs/tasks.yaml stays
// the single source of truth and product-hub's ported copy mirrors this exactly.
// ---------------------------------------------------------------------------

export const DEFER_SNOOZE_DAYS = 7;

// YYYY-MM-DD -> UTC-midnight epoch ms, for whole-day arithmetic immune to
// DST/local-offset drift (both operands are date-only). NaN on a malformed date.
function ymdToUTCms(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

// Whole days from `from` to `to` (both YYYY-MM-DD), or NaN if either is bad.
export function daysBetween(from: string, to: string): number {
  const a = ymdToUTCms(from);
  const b = ymdToUTCms(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

// True iff the ticket was deferred within the last DEFER_SNOOZE_DAYS relative to
// `today` (injected as YYYY-MM-DD so this stays pure/testable). A defer older
// than the window has elapsed -> resurfaces; a future-dated defer (clock skew)
// counts as still snoozed. A ticket never deferred is never snoozed.
export function isSnoozed(task: Task, today: string): boolean {
  const on = latestDeferredOn(task);
  if (!on) return false;
  const elapsed = daysBetween(on, today);
  return Number.isNaN(elapsed) ? false : elapsed < DEFER_SNOOZE_DAYS;
}

// The YYYY-MM-DD a snoozed decision resurfaces (latest defer date +
// DEFER_SNOOZE_DAYS), for the "resurfaces {date}" copy. null when never deferred.
export function snoozeResurfaceDate(task: Task): string | null {
  const on = latestDeferredOn(task);
  const base = ymdToUTCms(on ?? "");
  if (Number.isNaN(base)) return null;
  return new Date(base + DEFER_SNOOZE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// The ACTIVE inbox (what needs the owner NOW): parked-for-owner AND not currently
// snoozed by a recent Defer. This is what the bell/sidebar badge and the primary
// Decisions list count, so a Defer immediately drops the item from "what needs
// you". `today` is injected (local YYYY-MM-DD).
export function selectActiveDecisions(tasks: Task[], today: string): Task[] {
  return tasks.filter((t) => isParkedForOwner(t) && !isSnoozed(t, today)).sort(byNewest);
}

// The SNOOZED inbox: parked-for-owner AND still inside a Defer window. The "way
// to view deferred items" the snooze UX needs; each resurfaces into the active
// inbox automatically once its window elapses.
export function selectDeferredDecisions(tasks: Task[], today: string): Task[] {
  return tasks.filter((t) => isParkedForOwner(t) && isSnoozed(t, today)).sort(byNewest);
}

// The dated comment a Defer writes. Defer is the one non-resolving action: it
// KEEPS the "parked" label (the decision is never resolved, just snoozed) and
// records that the owner looked and is not ready. That dated comment is also the
// DURABLE snooze marker isSnoozed/selectActiveDecisions read, so the decision
// leaves the active inbox for DEFER_SNOOZE_DAYS and then resurfaces - no separate
// persisted field. `today` is injected so the builder stays pure/testable (the
// caller passes a local YYYY-MM-DD).
export function buildDeferComment(today: string, reason?: string): NewCommentInput {
  const tail = reason && reason.trim() ? ` - ${reason.trim()}` : "";
  return { author: "owner", body: `Owner deferred on ${today}${tail}.` };
}
