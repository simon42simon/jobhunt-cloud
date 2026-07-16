// ---------------------------------------------------------------------------
// Pure helpers for the Discovery Sources console + triage inbox (Discovery
// Sources v1). No fetch, no JSX - just the vocabulary maps, the human-phrase
// formatters, and the client-side mirror of the server's find->source join so a
// find's provenance chip and the source deep-link can never disagree with the
// server's own resolveFindSourceId. Colors are AA-legible tints on the dark
// panels (the pill's text is drawn in the status color, so it must read); the
// status pill is ALWAYS paired with its text label, never color alone.
// ---------------------------------------------------------------------------
import type {
  ContractGap,
  Discovery,
  DerivedSource,
  LastRunSignal,
  RunOutcome,
  RunRecord,
  SourceActive,
  SourceCadence,
  SourceStatus,
  SourceType,
} from "../types";
import { TRACK_LABEL, TRACK_ACCENT } from "./constants";
import { relativeFuture } from "./time";

// The relative-clock formatters moved to the shared lib/time module (UI
// consistency pack t-1783183576693) - re-exported here so the sources-domain
// consumers (SourceCard, SourceDetailDrawer, sourcesShared) keep their one
// import path.
export { relativeTime, relativeFuture } from "./time";

// Enum vocab (kept in sync with server SOURCE_* constants).
export const SOURCE_TYPES: SourceType[] = ["employer", "board", "apify"];
export const SOURCE_SECTORS = ["private", "municipal", "provincial", "federal", "bps", "nonprofit"];
export const SOURCE_ACTIVE: SourceActive[] = ["yes", "maybe", "no"];
export const SOURCE_CADENCES: SourceCadence[] = ["manual", "daily", "weekly", "monthly"];
export const DEFAULT_OUTPUT_FIELDS = ["title", "employer", "location", "deadline", "salary", "link"];

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  employer: "Employer",
  board: "Job board",
  apify: "Apify",
};

// ---- apify Add-source form vocab (type:"apify") ----------------------------
// A deterministic Apify actor run replaces instruction-only scraping: the owner
// gives an Actor ID + a run-input JSON object instead of landing URLs +
// instructions. These pure helpers back the form's field swap + validation and
// the payload build, so the form and its tests read ONE rule.

// The prefilled run-input example for a NEW apify source (design §8). Pretty so
// the owner can edit it in place; parses to a valid object.
export const APIFY_INPUT_STUB = '{\n  "position": "",\n  "location": "Toronto, ON",\n  "maxItems": 50\n}';

// The compact stub shown as the textarea placeholder (mirrors the design's
// stub); if the owner clears the field it reappears as guidance.
export const APIFY_INPUT_PLACEHOLDER = '{"position":"","location":"Toronto, ON","maxItems":50}';

// Parse the Actor-input JSON textarea into a plain object, with a FRIENDLY error
// and never a throw. Empty/whitespace = an empty object (a valid default - the
// actor runs with no extra input). A non-object JSON value (array, number,
// string, boolean, null) or malformed JSON is rejected with a legible message.
export type ApifyInputParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseApifyInput(text: string | undefined | null): ApifyInputParse {
  const t = (text ?? "").trim();
  if (!t) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: "Actor input is not valid JSON - check for a missing quote, comma, or brace." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'Actor input must be a JSON object, e.g. {"position":"","location":"Toronto, ON"}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// The apify branch of the Add-source form's draft validation - REPLACES
// validateSourceDraft's landing-URL rule for type:"apify" (design §8): a
// non-empty name + a non-empty Actor ID + an Actor-input textarea that parses as
// a JSON object. Returns the inline error message, or null when the draft can
// save. One shared rule so the form and the tests agree.
export function validateApifyDraft(draft: { name: string; actorId: string; inputText: string }): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!draft.actorId.trim()) return "Actor ID is required.";
  const parsed = parseApifyInput(draft.inputText);
  return parsed.ok ? null : parsed.error;
}

export const SOURCE_ACTIVE_LABEL: Record<SourceActive, string> = {
  yes: "Active",
  maybe: "Trialing",
  no: "Paused",
};

export const CADENCE_LABEL: Record<SourceCadence, string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

// The CadenceEditor popover's per-row secondary text ("Manual - on demand only",
// "Daily - every 24h", ...).
export const CADENCE_HINT: Record<SourceCadence, string> = {
  manual: "On demand only",
  daily: "Every 24h",
  weekly: "Every 7 days",
  monthly: "Every 30 days",
};

// Human cadence phrase for a card ("Every week" reads better than "Weekly" next
// to a next-run time).
export function cadencePhrase(cadence: SourceCadence): string {
  switch (cadence) {
    case "daily":
      return "Every day";
    case "weekly":
      return "Every week";
    case "monthly":
      return "Every month";
    default:
      return "On demand";
  }
}

// The most load-bearing pixel: the computed status. label + color together (the
// text label is the non-color signal). `dot` is the vivid semantic dot; `text`
// is the AA-legible tint used for the label + translucent pill background.
export const SOURCE_STATUS_META: Record<SourceStatus, { label: string; text: string; dot: string }> = {
  "never-run": { label: "Never run", text: "#94a3b8", dot: "#64748b" }, // idle slate
  healthy: { label: "Healthy", text: "#34d399", dot: "#10b981" }, // ok green
  running: { label: "Running", text: "#38bdf8", dot: "#38bdf8" }, // running sky
  due: { label: "Due", text: "#f59e0b", dot: "#f59e0b" }, // warning amber
  stale: { label: "Stale", text: "#fb923c", dot: "#fb923c" }, // overdue orange
  failed: { label: "Failed", text: "#fb7185", dot: "#f43f5e" }, // fail rose
  paused: { label: "Paused", text: "#8a96ad", dot: "#64748b" }, // idle muted
};

// Per-run outcome glyph + color, for the last-run line + the run-history list.
export const RUN_OUTCOME_META: Record<RunOutcome, { label: string; symbol: string; color: string }> = {
  succeeded: { label: "Succeeded", symbol: "✓", color: "#34d399" }, // check
  failed: { label: "Failed", symbol: "✕", color: "#fb7185" }, // cross
  incomplete: { label: "Incomplete", symbol: "⚠", color: "#f59e0b" }, // warning
  running: { label: "Running", symbol: "…", color: "#38bdf8" }, // ellipsis
};

export function hexA(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

// A source is "running" when any run in its (already newest-first) history is
// still open - the same signal the server's status derivation uses.
export function isRunning(source: DerivedSource): boolean {
  return source.status === "running" || source.runs.some((r) => r.outcome === "running");
}

// The newest terminal (non-running) run, if any - drives the last-run line.
export function lastTerminalRun(source: DerivedSource) {
  return source.runs.find((r) => r.outcome !== "running") ?? null;
}

// ---- v4 run-honesty captions (schema v4 §2.2) --------------------------------
// The human phrase that makes a succeeded zero-lead run legible on the card /
// drawer last-run line, keyed off the SERVER-derived lastRunSignal - read
// DIRECTLY, never re-derived client-side (the contractGaps rule). Returns null
// for "leads" and for a null signal so callers keep the existing "N found"
// rendering; also null for a non-succeeded run (the signal describes only the
// newest terminal SUCCEEDED run - if the newest terminal run failed, the
// failure copy owns the line).
export function runSignalCaption(run: RunRecord, signal: LastRunSignal | null): string | null {
  if (!signal || signal === "leads" || run.outcome !== "succeeded") return null;
  if (signal === "quiet") return "0 new - nothing new to review";
  if (signal === "unverified") return "0 found - run unverified";
  // "dedup": the scrape WORKED - everything reviewed was already tracked or
  // filtered out (the University Affairs case: leadsFound 0, reviewed 8).
  const reviewed = typeof run.candidatesReviewed === "number" ? run.candidatesReviewed : 0;
  const tracked = typeof run.alreadyTracked === "number" ? run.alreadyTracked : null;
  const filtered = typeof run.filteredOut === "number" ? run.filteredOut : null;
  if (tracked !== null && reviewed > 0 && tracked >= reviewed) {
    return `0 new - ${reviewed} reviewed, all tracked`;
  }
  const parts: string[] = [];
  if (tracked) parts.push(`${tracked} tracked`);
  if (filtered) parts.push(`${filtered} filtered`);
  return `0 new - ${reviewed} reviewed, ${parts.length > 0 ? parts.join(" + ") : "all tracked or filtered"}`;
}

// The full counters breakdown for a run, for `title=` tooltips ("8 candidates
// reviewed · 6 already tracked · 2 filtered out"). null = nothing reported
// (a pre-v4 run, or the scout skipped the best-effort report) - callers render
// nothing rather than a fake 0.
export function runCountersPhrase(run: RunRecord): string | null {
  const bits: string[] = [];
  if (typeof run.candidatesReviewed === "number") bits.push(`${run.candidatesReviewed} candidates reviewed`);
  if (typeof run.alreadyTracked === "number") bits.push(`${run.alreadyTracked} already tracked`);
  if (typeof run.filteredOut === "number") bits.push(`${run.filteredOut} filtered out`);
  return bits.length > 0 ? bits.join(" · ") : null;
}

// How many sources a "Run all due" click would target right now - the N in the
// TopBar's "Discover due (N)" button and due-chip (t-1783183576588). Mirrors
// POST /api/discovery/run-all-due's selection: due && not already running. The
// server additionally skips sources already sitting in its launch queue (state
// the client cannot see), so this is the count the UI SHOWS; the server stays
// authoritative about what actually launches.
export function countDueSources(sources: DerivedSource[]): number {
  return sources.filter((s) => s.due && !isRunning(s)).length;
}

// Total unseen finds across the managed sources (each source's server-derived
// newSinceVisit, summed) - the N on the Finds toggle's "+N new" badge. Visiting
// a source-filtered Finds view stamps that source's lastVisitedAt and drains
// its share of this total.
export function totalNewSinceVisit(sources: DerivedSource[]): number {
  return sources.reduce((n, s) => n + (s.newSinceVisit || 0), 0);
}

// A run's wall-clock duration, humanized ("820ms", "4.2s", "3m 12s"). Null-safe.
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

// The next-run phrase for a card: "Due now" when overdue, else the forward time,
// else "On demand" for a manual source.
export function nextRunPhrase(source: DerivedSource): string {
  if (source.due) return "Due now";
  if (source.nextRunAt) return `Next ${relativeFuture(source.nextRunAt)}`;
  return "On demand";
}

// ---- find -> source join (client mirror of server resolveFindSourceId) -----
// Build lowercased(name / alias / id) -> canonical source id.
export function buildAliasIndex(sources: DerivedSource[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const s of sources) {
    idx.set(s.id.toLowerCase(), s.id);
    const name = (s.name || "").trim().toLowerCase();
    if (name) idx.set(name, s.id);
    for (const a of s.aliases || []) {
      const k = String(a).trim().toLowerCase();
      if (k) idx.set(k, s.id);
    }
  }
  return idx;
}

// Resolve one find to a source id, or null (the unassigned bucket). Prefer a
// stamped sourceId; else fall back to the raw Source label via the alias index.
export function resolveFindSourceId(find: Discovery, idx: Map<string, string>): string | null {
  const sid = find.sourceId != null ? String(find.sourceId).trim().toLowerCase() : "";
  if (sid && idx.has(sid)) return idx.get(sid) ?? null;
  const key = find.Source != null ? String(find.Source).trim().toLowerCase() : "";
  if (key && idx.has(key)) return idx.get(key) ?? null;
  return null;
}

// A stable identity for a find across renders + the decide/pursue calls (which
// key off title + link).
export function findKey(find: Discovery): string {
  return `${find.Title}\u0000${find.Employer}\u0000${find.Link}`;
}

// Whether a URL string is a real, openable http(s) link (so we only render an
// <a href> for a genuine URL - fixes the "Open ↗" literal-text bug).
export function isRealUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return /^https?:\/\/\S+$/i.test(url.trim());
}

// Client mirror of the server's canonical scrape-contract alias table
// (server/index.js CONTRACT_FIELD_ALIASES) - kept in sync exactly like the
// SOURCE_* enum vocab above. Used ONLY by SourceFormDrawer's live draft
// advisory: an UNSAVED draft has no server-derived contractGaps yet, so the
// form checks its own in-progress outputFields against the same table. Every
// rendered badge/callout on a PERSISTED source reads DerivedSource.contractGaps
// (server-derived, docs/data-schema.md §5 Decision 3a) - never this helper.
export const CONTRACT_FIELD_ALIASES = {
  directLink: ["link", "url", "posting url", "direct link", "apply link", "job url"],
  deadline: ["deadline", "closing date", "application deadline", "due date"],
};

export function draftContractGaps(outputFields: string[]): ContractGap[] {
  const norm = outputFields.map((f) => f.trim().toLowerCase());
  const gaps: ContractGap[] = [];
  if (!CONTRACT_FIELD_ALIASES.directLink.some((a) => norm.includes(a))) gaps.push("direct-link");
  if (!CONTRACT_FIELD_ALIASES.deadline.some((a) => norm.includes(a))) gaps.push("deadline");
  return gaps;
}

// Whether a find's Deadline cell carries ANY value - a literal YYYY-MM-DD is
// high-confidence, a free-text note like "rolling" is accepted-but-low-confidence
// (docs/data-schema.md §5 Decision 3), but a truly blank cell is the real gap. The
// equivalent-to-isRealUrl "is this genuinely present" check for the lead-level
// scrape-contract flag (3b) - deliberately NOT a YYYY-MM-DD format check (that
// would wrongly flag a legitimate "rolling"/"ongoing" deadline as missing).
export function hasDeadline(deadline: string | undefined | null): boolean {
  return !!(deadline && deadline.trim());
}

// A single find's lead-level scrape-contract gaps (docs/data-schema.md §5 Decision
// 3b) - a PRESENTATION rule over data already on the Discovery object, not a new
// stored/derived field: a find missing a real direct link or a real deadline is
// flagged, never silently omitted (the defect TriageInbox/SourceDetailDrawer used
// to have, closed here).
export type LeadGap = "link" | "deadline";
export function leadContractGaps(find: Discovery): LeadGap[] {
  const gaps: LeadGap[] = [];
  if (!isRealUrl(find.Link)) gaps.push("link");
  if (!hasDeadline(find.Deadline)) gaps.push("deadline");
  return gaps;
}

// ---- freshness roll-up (section 4) -----------------------------------------

export interface FreshnessSummary {
  dueCount: number;
  staleCount: number;
  neverRunCount: number;
  healthyCount: number;
  // The next still-healthy source approaching its cadence window - distinct from
  // the due/stale segments above (already flagged amber/orange), so this answers
  // "what's coming up next", not "what's already late".
  soonest: { source: DerivedSource; nextRunAt: string } | null;
}

// Console-level freshness roll-up (section 4.1). Counts by the DISCRETE `status`
// enum, never the raw `due` boolean (`due` is true for both "due" and "stale" -
// counting off it would double-count and disagree with each card's own pill;
// section 4.3 / docs/data-schema.md §5 Decision 2).
export function computeFreshnessSummary(sources: DerivedSource[]): FreshnessSummary {
  let dueCount = 0;
  let staleCount = 0;
  let neverRunCount = 0;
  let healthyCount = 0;
  let soonest: { source: DerivedSource; nextRunAt: string } | null = null;
  for (const s of sources) {
    if (s.status === "due") dueCount++;
    else if (s.status === "stale") staleCount++;
    else if (s.status === "never-run" && s.active !== "no") neverRunCount++;
    else if (s.status === "healthy") healthyCount++;
    if (s.status === "healthy" && s.nextRunAt) {
      const t = Date.parse(s.nextRunAt);
      if (Number.isFinite(t) && (!soonest || t < Date.parse(soonest.nextRunAt))) {
        soonest = { source: s, nextRunAt: s.nextRunAt };
      }
    }
  }
  return { dueCount, staleCount, neverRunCount, healthyCount, soonest };
}

// ---- active/inactive partition (ops F10, t-1783183576759) -------------------
// The console grid defaults to sources that are genuinely ON (`active: "yes"` -
// scheduled and run); everything else ("maybe" trial/seed stubs, "no" paused)
// is a dormant card that dilutes the load-bearing health pills, so it collapses
// under an "Inactive (N)" disclosure. The stubs STAY listed (honest alias
// anchors), just out of the default scan. Preserves input order within each
// half; does not mutate.
export function partitionSourcesByActive(sources: DerivedSource[]): {
  active: DerivedSource[];
  inactive: DerivedSource[];
} {
  const active: DerivedSource[] = [];
  const inactive: DerivedSource[] = [];
  for (const s of sources) (s.active === "yes" ? active : inactive).push(s);
  return { active, inactive };
}

// ---- group-by (section 3) --------------------------------------------------

export type SourceGroupBy = "none" | "track" | "sector" | "type";

export interface SourceGroup {
  key: string;
  label: string;
  accent?: string;
  sources: DerivedSource[];
}

// Pinned-first "All tracks" group key - a source with `tracks` absent/empty feeds
// every track, so it lands ONLY here, never fanned into all 7 specific groups
// (section 3.1 / docs/data-schema.md §5 Decision 1).
export const ALL_TRACKS_GROUP_KEY = "__all-tracks__";

// Bucket sources for the console's group-by control. "none" returns a single
// unlabeled group so the caller can render the EXACT SAME grid markup whether
// grouped or not (one render path, not two). "track" fans a multi-track source
// into EVERY group it lists (tag membership, not exclusive ownership) and pins
// "All tracks" first (section 3.1: these tend to be the highest-volume generic
// boards, not a leftover bucket - a deliberate deviation from TaskBoard's own
// "no-project sorts last" convention). "sector"/"type" are straight buckets in
// each field's canonical enum order, same shape as TaskBoard's tasksByProject.
export function groupSources(sources: DerivedSource[], groupBy: SourceGroupBy): SourceGroup[] {
  if (groupBy === "none") return [{ key: "__all__", label: "All sources", sources }];

  if (groupBy === "type") {
    const byType = new Map<SourceType, DerivedSource[]>();
    for (const s of sources) (byType.get(s.type) ?? byType.set(s.type, []).get(s.type)!).push(s);
    return SOURCE_TYPES.filter((t) => byType.has(t)).map((t) => ({
      key: t,
      label: SOURCE_TYPE_LABEL[t],
      sources: byType.get(t)!,
    }));
  }

  if (groupBy === "sector") {
    const bySector = new Map<string, DerivedSource[]>();
    for (const s of sources) (bySector.get(s.sector) ?? bySector.set(s.sector, []).get(s.sector)!).push(s);
    const order = SOURCE_SECTORS.filter((sec) => bySector.has(sec));
    for (const sec of bySector.keys()) if (!order.includes(sec)) order.push(sec); // tolerant: an unlisted sector still renders
    return order.map((sec) => ({ key: sec, label: sec, sources: bySector.get(sec)! }));
  }

  // groupBy === "track"
  const byTrack = new Map<string, DerivedSource[]>();
  const allTracks: DerivedSource[] = [];
  for (const s of sources) {
    if (!s.tracks || s.tracks.length === 0) {
      allTracks.push(s);
      continue;
    }
    for (const t of s.tracks) (byTrack.get(t) ?? byTrack.set(t, []).get(t)!).push(s);
  }
  const groups: SourceGroup[] = [];
  if (allTracks.length > 0) groups.push({ key: ALL_TRACKS_GROUP_KEY, label: "All tracks", sources: allTracks });
  const trackOrder = Object.keys(TRACK_LABEL);
  for (const t of trackOrder) {
    if (byTrack.has(t)) groups.push({ key: t, label: TRACK_LABEL[t], accent: TRACK_ACCENT[t], sources: byTrack.get(t)! });
  }
  for (const [t, srcs] of byTrack.entries()) {
    if (!trackOrder.includes(t)) groups.push({ key: t, label: t, sources: srcs }); // tolerant: an unknown track id still renders
  }
  return groups;
}
