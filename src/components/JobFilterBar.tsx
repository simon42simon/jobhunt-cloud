import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Job } from "../types";
import { SegmentedControl } from "./SegmentedControl";
import { STATUS_LABEL, STATUS_ORDER, TRACK_LABEL } from "../lib/constants";
import { fmtDate } from "../lib/utils";
import {
  activeConditions,
  changeField,
  changeOperator,
  distinctValues,
  fieldType,
  FIELD_DEFS,
  newCondition,
  OPERATOR_LABEL,
  OPERATORS_BY_TYPE,
  type Combinator,
  type Condition,
  type FilterableField,
  type JobFilter,
  type Operator,
} from "../lib/jobFilter";

// ---------------------------------------------------------------------------
// Airtable/Asana-style advanced filter builder for the Job Tracker table.
// Presentation only - all matching + model logic lives in src/lib/jobFilter.ts.
// JobTable owns the filter state + localStorage persistence and passes it here.
// ---------------------------------------------------------------------------

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Human label for a stored enum value: canonical maps for status/track/fit,
// capitalized raw for the data-driven fields (sector, tailoring).
function enumValueLabel(field: FilterableField, value: string): string {
  if (field === "status") return STATUS_LABEL[value as keyof typeof STATUS_LABEL] ?? value;
  if (field === "track") return TRACK_LABEL[value] ?? value;
  return cap(value);
}

// Options for an enum field's value picker: canonical set first (so the full
// choice list is stable even when the current view is narrow), then any extra
// distinct values actually present in the data.
function enumOptions(field: FilterableField, jobs: Job[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  const push = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label: enumValueLabel(field, value) });
  };
  if (field === "status") STATUS_ORDER.forEach(push);
  else if (field === "track") Object.keys(TRACK_LABEL).forEach(push);
  else if (field === "fit") ["strong", "moderate", "stretch"].forEach(push);
  for (const v of distinctValues(jobs, field)) push(v);
  return out;
}

// Chip summary of one condition, e.g. "Status is Lead", "Deadline before Jul 1".
function conditionSummary(cond: Condition, jobs: Job[]): string {
  const def = FIELD_DEFS.find((d) => d.field === cond.field);
  const fieldLabel = def?.label ?? cond.field;
  const op = OPERATOR_LABEL[cond.operator];
  if (cond.operator === "is_empty" || cond.operator === "is_not_empty") {
    return `${fieldLabel} ${op}`;
  }
  const type = fieldType(cond.field);
  let valueText = "";
  if (cond.operator === "is_any_of") {
    const arr = Array.isArray(cond.value) ? cond.value : [];
    valueText = arr.map((v) => enumValueLabel(cond.field, v)).join(", ");
  } else {
    const v = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
    if (type === "enum") valueText = enumValueLabel(cond.field, v);
    else if (type === "date") valueText = fmtDate(v) || v;
    else valueText = v;
  }
  return `${fieldLabel} ${op} ${valueText}`.trim();
}

// 44px tap targets on touch, relaxed to the compact 36px at >= sm - the
// app-wide phone-fit idiom (t-1783201082838: these sat at 30-36px on touch).
const selectCls =
  "min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-[36px]";
const inputCls =
  "min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[#7c88a4] focus:border-[var(--color-accent)] sm:min-h-[36px]";

// The value input for one condition, shaped by the field type + operator.
function ValueInput({
  cond,
  jobs,
  onChange,
}: {
  cond: Condition;
  jobs: Job[];
  onChange: (value: string | string[]) => void;
}) {
  const type = fieldType(cond.field);

  if (cond.operator === "is_empty" || cond.operator === "is_not_empty") {
    return <span className="min-h-[36px] self-center text-[12px] text-[#7c88a4]">no value needed</span>;
  }

  if (type === "date") {
    const v = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
    return (
      <input
        type="date"
        value={v}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Value"
        className={`${inputCls} min-w-[9.5rem]`}
      />
    );
  }

  if (type === "text") {
    const v = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
    return (
      <input
        type="text"
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter text..."
        aria-label="Value"
        className={`${inputCls} min-w-[9.5rem] flex-1`}
      />
    );
  }

  // enum
  const options = enumOptions(cond.field, jobs);

  if (cond.operator === "is_any_of") {
    const selected = Array.isArray(cond.value) ? cond.value : [];
    const toggle = (value: string) => {
      const next = selected.includes(value)
        ? selected.filter((x) => x !== value)
        : [...selected, value];
      onChange(next);
    };
    return (
      <div role="group" aria-label="Values" className="flex flex-1 flex-wrap items-center gap-1">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.value)}
              className={`min-h-[44px] rounded-full border px-2.5 py-1 text-[12px] font-medium transition sm:min-h-[30px] ${
                on
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                  : "border-[var(--color-edge)] bg-[var(--color-panel-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {o.label}
            </button>
          );
        })}
        {options.length === 0 && <span className="text-[12px] text-[#7c88a4]">no values</span>}
      </div>
    );
  }

  // is / is_not -> single select
  const v = Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value;
  return (
    <select
      value={v}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Value"
      className={`${selectCls} min-w-[9.5rem] flex-1`}
    >
      <option value="">Select...</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function JobFilterBar({
  jobs,
  filter,
  onChange,
}: {
  jobs: Job[];
  filter: JobFilter;
  onChange: (next: JobFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const active = useMemo(() => activeConditions(filter), [filter]);
  const activeCount = active.length;
  const combLabel = filter.combinator === "AND" ? "and" : "or";

  // Esc closes the panel (and returns focus to the trigger); an outside click
  // closes it too. Matches the app's overlay conventions.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  function setCombinator(combinator: Combinator) {
    onChange({ ...filter, combinator });
  }

  function updateCondition(id: string, next: Condition) {
    onChange({ ...filter, conditions: filter.conditions.map((c) => (c.id === id ? next : c)) });
  }

  function removeCondition(id: string) {
    onChange({ ...filter, conditions: filter.conditions.filter((c) => c.id !== id) });
  }

  function addCondition() {
    onChange({ ...filter, conditions: [...filter.conditions, newCondition()] });
  }

  function clearAll() {
    onChange({ combinator: filter.combinator, conditions: [] });
  }

  // Shared segmented control (canonical accent-fill pill, t-1783183576693);
  // its buttons are 44px tap targets on touch (t-1783201082838).
  const combToggle = (
    <SegmentedControl<Combinator>
      ariaLabel="Match all or any condition"
      value={filter.combinator}
      onChange={setCombinator}
      options={[
        { value: "AND", label: "All" },
        { value: "OR", label: "Any" },
      ]}
    />
  );

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 items-center gap-2">
      {/* Filter trigger */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition sm:min-h-[36px] ${
          activeCount > 0
            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text)]"
            : "border-[var(--color-edge)] bg-[var(--color-panel-2)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        }`}
        title="Build a multi-condition filter"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 3h13M4 8h8M6.5 13h3" />
        </svg>
        Filter
        {activeCount > 0 && (
          <span className="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            {activeCount}
          </span>
        )}
      </button>

      {/* Active-condition chips (shown when the panel is closed) */}
      {!open && activeCount > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
          {active.map((cond, i) => (
            <span key={cond.id} className="inline-flex items-center gap-1">
              {i > 0 && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  {combLabel}
                </span>
              )}
              <span className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel-2)] py-0.5 pl-2 pr-1 text-[11px] text-[var(--color-text)]">
                <span className="truncate" title={conditionSummary(cond, jobs)}>
                  {conditionSummary(cond, jobs)}
                </span>
                <button
                  type="button"
                  onClick={() => removeCondition(cond.id)}
                  aria-label={`Remove filter: ${conditionSummary(cond, jobs)}`}
                  // 44px hit area on touch (the x glyph stays small); compact
                  // 16px again at >= sm (t-1783201082838).
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-edge)] hover:text-[var(--color-text)] sm:h-4 sm:w-4"
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                  </svg>
                </button>
              </span>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="ml-0.5 min-h-[44px] rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline sm:min-h-0"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Builder panel */}
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Filter conditions"
          className="absolute left-0 top-full z-40 mt-2 w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 shadow-2xl"
        >
          {filter.conditions.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-[var(--color-muted)]">
              No conditions yet. Add one to narrow the table.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {filter.conditions.map((cond, i) => {
                const ops = OPERATORS_BY_TYPE[fieldType(cond.field)];
                return (
                  <div key={cond.id} className="flex flex-wrap items-center gap-2">
                    {/* Leading combinator: "Where" for row 0, the toggle for row 1,
                        a static combinator word thereafter (one global combinator). */}
                    <div className="w-[3.75rem] shrink-0 text-[12px] text-[var(--color-muted)]">
                      {i === 0 ? (
                        <span className="pl-1 font-medium">Where</span>
                      ) : i === 1 ? (
                        combToggle
                      ) : (
                        <span className="pl-1 font-semibold uppercase tracking-wide">{combLabel}</span>
                      )}
                    </div>

                    <select
                      value={cond.field}
                      onChange={(e) =>
                        updateCondition(cond.id, changeField(cond, e.target.value as FilterableField))
                      }
                      aria-label="Field"
                      className={selectCls}
                    >
                      {FIELD_DEFS.map((d) => (
                        <option key={d.field} value={d.field}>
                          {d.label}
                        </option>
                      ))}
                    </select>

                    <select
                      value={cond.operator}
                      onChange={(e) =>
                        updateCondition(cond.id, changeOperator(cond, e.target.value as Operator))
                      }
                      aria-label="Operator"
                      className={selectCls}
                    >
                      {ops.map((o) => (
                        <option key={o.op} value={o.op}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    <ValueInput
                      cond={cond}
                      jobs={jobs}
                      onChange={(value) => updateCondition(cond.id, { ...cond, value })}
                    />

                    <button
                      type="button"
                      onClick={() => removeCondition(cond.id)}
                      aria-label="Remove this condition"
                      className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] text-[var(--color-muted)] hover:border-rose-500/50 hover:text-rose-300 sm:h-8 sm:w-8"
                      title="Remove condition"
                    >
                      <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-edge)] pt-3">
            <button
              type="button"
              onClick={addCondition}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-[34px]"
            >
              <span className="text-[var(--color-accent-text)]">+</span> Add condition
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={filter.conditions.length === 0}
              className="min-h-[44px] rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:text-[var(--color-muted)] sm:min-h-0"
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
