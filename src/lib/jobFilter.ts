// Advanced multi-condition filter model for the Job Tracker table (ticket
// t-1783121052007). PURE logic only - no React, no DOM - so it is trivially
// unit-testable and can be reused anywhere. The builder UI lives in
// src/components/JobFilterBar.tsx; JobTable owns the state + persistence.
//
// A filter is an array of conditions joined by ONE combinator ("AND" | "OR").
// Each condition targets a real Job field (validated against src/types.ts), an
// operator valid for that field's TYPE (enum / text / date), and a value. The
// completion date is DERIVED (not a stored field), reusing jobCompletedDate so
// the filter can never disagree with the tracker's Completed column.

import type { Job } from "../types";
import { jobCompletedDate } from "./utils";

// The fields a job can be filtered on. Every one maps to a REAL Job field (or,
// for `completed`, the derived jobCompletedDate) - see fieldValue below.
export type FilterableField =
  | "status"
  | "track"
  | "fit"
  | "sector"
  | "tailoring"
  | "employer"
  | "role"
  | "deadline"
  | "applied"
  | "completed";

export type FieldType = "enum" | "text" | "date";

export type EnumOperator = "is" | "is_not" | "is_any_of";
export type TextOperator = "contains" | "not_contains" | "is_empty" | "is_not_empty";
export type DateOperator = "before" | "after" | "on" | "is_empty" | "is_not_empty";
export type Operator = EnumOperator | TextOperator | DateOperator;

export type Combinator = "AND" | "OR";

export interface Condition {
  id: string; // stable id for React keys + per-row removal
  field: FilterableField;
  operator: Operator;
  // A single string for single-value operators; a string[] for `is_any_of`;
  // irrelevant (kept as "") for is_empty / is_not_empty.
  value: string | string[];
}

export interface JobFilter {
  combinator: Combinator;
  conditions: Condition[];
}

export const EMPTY_FILTER: JobFilter = { combinator: "AND", conditions: [] };

// Field catalogue: label (for the UI) + type (drives the operator + value input).
export interface FieldDef {
  field: FilterableField;
  label: string;
  type: FieldType;
}

export const FIELD_DEFS: FieldDef[] = [
  { field: "status", label: "Status", type: "enum" },
  { field: "track", label: "Track", type: "enum" },
  { field: "fit", label: "Fit", type: "enum" },
  { field: "sector", label: "Sector", type: "enum" },
  { field: "tailoring", label: "Tailoring effort", type: "enum" },
  { field: "employer", label: "Employer", type: "text" },
  { field: "role", label: "Role", type: "text" },
  { field: "deadline", label: "Deadline", type: "date" },
  { field: "applied", label: "Applied", type: "date" },
  { field: "completed", label: "Completed", type: "date" },
];

const FIELD_TYPE: Record<FilterableField, FieldType> = Object.fromEntries(
  FIELD_DEFS.map((d) => [d.field, d.type])
) as Record<FilterableField, FieldType>;

export function fieldType(field: FilterableField): FieldType {
  return FIELD_TYPE[field];
}

// Operators offered per field type, in menu order. First entry is the default.
export const OPERATORS_BY_TYPE: Record<FieldType, { op: Operator; label: string }[]> = {
  enum: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_any_of", label: "is any of" },
  ],
  text: [
    { op: "contains", label: "contains" },
    { op: "not_contains", label: "does not contain" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  date: [
    { op: "before", label: "before" },
    { op: "after", label: "after" },
    { op: "on", label: "on" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
};

export const OPERATOR_LABEL: Record<Operator, string> = {
  is: "is",
  is_not: "is not",
  is_any_of: "is any of",
  contains: "contains",
  not_contains: "does not contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  before: "before",
  after: "after",
  on: "on",
};

// Operators that need NO value input (they test presence only).
const NO_VALUE_OPS: ReadonlySet<Operator> = new Set(["is_empty", "is_not_empty"]);

// ---------------------------------------------------------------------------
// Field access - the single place that reads a job's real shape. `completed` is
// DERIVED (jobCompletedDate), never a stored field. Returns null for absent.
// ---------------------------------------------------------------------------
function fieldValue(job: Job, field: FilterableField): string | null {
  switch (field) {
    case "status":
      return job.status;
    case "track":
      return job.track;
    case "fit":
      return job.fit;
    case "sector":
      return job.sector;
    case "tailoring":
      return job.tailoring;
    case "employer":
      return job.employer;
    case "role":
      return job.role;
    case "deadline":
      return job.deadline;
    case "applied":
      return job.applied;
    case "completed":
      return jobCompletedDate(job);
    default:
      return null;
  }
}

function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

function asStr(v: string | string[]): string {
  return Array.isArray(v) ? v[0] ?? "" : v;
}

function asArr(v: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

// Normalize a date-ish value to a comparable YYYY-MM-DD key, or null when it is
// not a real calendar date. Job dates are already YYYY-MM-DD; the slice guards
// any stray time component. ISO YYYY-MM-DD sorts lexically = chronologically.
function dateKey(raw: string | null): string | null {
  if (isBlank(raw)) return null;
  const k = raw!.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
}

// ---------------------------------------------------------------------------
// Matching - one condition against one job. Case-insensitive text.
// ---------------------------------------------------------------------------
export function matchCondition(job: Job, cond: Condition): boolean {
  const raw = fieldValue(job, cond.field);
  switch (cond.operator) {
    case "is":
      return raw !== null && raw === asStr(cond.value);
    // "is not X" excludes X and INCLUDES empty (an absent value is not X) -
    // matches Airtable single-select semantics.
    case "is_not":
      return raw !== asStr(cond.value);
    case "is_any_of":
      return raw !== null && asArr(cond.value).includes(raw);
    case "contains":
      return (raw ?? "").toLowerCase().includes(asStr(cond.value).toLowerCase());
    // Empty field "does not contain" anything -> true (standard behavior).
    case "not_contains":
      return !(raw ?? "").toLowerCase().includes(asStr(cond.value).toLowerCase());
    case "is_empty":
      return isBlank(raw);
    case "is_not_empty":
      return !isBlank(raw);
    case "before": {
      const f = dateKey(raw);
      const v = asStr(cond.value);
      return f !== null && v !== "" && f < v;
    }
    case "after": {
      const f = dateKey(raw);
      const v = asStr(cond.value);
      return f !== null && v !== "" && f > v;
    }
    case "on": {
      const f = dateKey(raw);
      const v = asStr(cond.value);
      return f !== null && v !== "" && f === v;
    }
    default:
      return true;
  }
}

// A condition is "complete" (ready to actually filter) when it has the value it
// needs. Incomplete conditions (a half-built row) are INERT - applyJobFilter
// skips them so building a filter never blanks the table mid-edit.
export function isConditionComplete(cond: Condition): boolean {
  if (NO_VALUE_OPS.has(cond.operator)) return true;
  if (cond.operator === "is_any_of") return Array.isArray(cond.value) && cond.value.length > 0;
  return typeof cond.value === "string" && cond.value.trim() !== "";
}

export function activeConditions(filter: JobFilter): Condition[] {
  return filter.conditions.filter(isConditionComplete);
}

export function activeConditionCount(filter: JobFilter): number {
  return activeConditions(filter).length;
}

// ---------------------------------------------------------------------------
// The one entry point: filter a list of jobs. AND = every active condition
// matches; OR = at least one does. No active conditions => the filter is inert
// and returns the input unchanged.
// ---------------------------------------------------------------------------
export function applyJobFilter(jobs: Job[], filter: JobFilter): Job[] {
  const active = activeConditions(filter);
  if (active.length === 0) return jobs;
  if (filter.combinator === "OR") {
    return jobs.filter((job) => active.some((c) => matchCondition(job, c)));
  }
  return jobs.filter((job) => active.every((c) => matchCondition(job, c)));
}

// Distinct non-blank values a field actually takes across the given jobs, sorted.
// Feeds the enum value dropdowns for data-driven fields (sector, tailoring).
export function distinctValues(jobs: Job[], field: FilterableField): string[] {
  const set = new Set<string>();
  for (const j of jobs) {
    const v = fieldValue(j, field);
    if (!isBlank(v)) set.add(v!);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Condition construction / mutation helpers (pure). The builder UI uses these
// so field/operator changes always leave a VALID condition (operator legal for
// the new field type; value shaped for the new operator).
// ---------------------------------------------------------------------------
let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `c${Date.now().toString(36)}${idSeq}`;
}

function defaultValueFor(op: Operator): string | string[] {
  if (op === "is_any_of") return [];
  return "";
}

export function newCondition(field: FilterableField = "status"): Condition {
  const op = OPERATORS_BY_TYPE[fieldType(field)][0].op;
  return { id: newId(), field, operator: op, value: defaultValueFor(op) };
}

export function changeField(cond: Condition, field: FilterableField): Condition {
  const ops = OPERATORS_BY_TYPE[fieldType(field)];
  const operator = ops.some((o) => o.op === cond.operator) ? cond.operator : ops[0].op;
  return { ...cond, field, operator, value: defaultValueFor(operator) };
}

export function changeOperator(cond: Condition, operator: Operator): Condition {
  let value: string | string[];
  if (operator === "is_any_of") {
    value = Array.isArray(cond.value) ? cond.value : cond.value ? [cond.value] : [];
  } else if (NO_VALUE_OPS.has(operator)) {
    value = "";
  } else {
    value = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
  }
  return { ...cond, operator, value };
}

// ---------------------------------------------------------------------------
// Persistence (localStorage). Tolerant parse: an unknown field, an illegal
// operator, or a malformed value is dropped rather than throwing - the same
// best-effort discipline as JobTable's grouped/collapsed state.
// ---------------------------------------------------------------------------
function isFilterableField(x: unknown): x is FilterableField {
  return typeof x === "string" && FIELD_DEFS.some((d) => d.field === x);
}

function isValidOperatorFor(field: FilterableField, op: unknown): op is Operator {
  return OPERATORS_BY_TYPE[fieldType(field)].some((o) => o.op === op);
}

function normalizeValue(op: Operator, v: unknown): string | string[] {
  if (op === "is_any_of") {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }
  if (NO_VALUE_OPS.has(op)) return "";
  return typeof v === "string" ? v : "";
}

export function serializeFilter(filter: JobFilter): string {
  return JSON.stringify(filter);
}

export function parseFilter(raw: string | null): JobFilter {
  if (!raw) return EMPTY_FILTER;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_FILTER;
    const obj = parsed as Record<string, unknown>;
    const combinator: Combinator = obj.combinator === "OR" ? "OR" : "AND";
    const rawConds = Array.isArray(obj.conditions) ? obj.conditions : [];
    const conditions: Condition[] = [];
    for (const rc of rawConds) {
      if (!rc || typeof rc !== "object") continue;
      const c = rc as Record<string, unknown>;
      if (!isFilterableField(c.field)) continue;
      if (!isValidOperatorFor(c.field, c.operator)) continue;
      conditions.push({
        id: typeof c.id === "string" ? c.id : newId(),
        field: c.field,
        operator: c.operator as Operator,
        value: normalizeValue(c.operator as Operator, c.value),
      });
    }
    return { combinator, conditions };
  } catch {
    return EMPTY_FILTER;
  }
}
