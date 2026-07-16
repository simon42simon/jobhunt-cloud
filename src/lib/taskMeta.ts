// Shared task-ticket vocabulary: the canonical status-column order + labels
// and the type/priority/epic/label color maps. Extracted VERBATIM from
// TaskBoard (t-1783257189986) the moment a second consumer appeared (the
// full-page TaskDetail view), so board card and detail page can never render
// the same ticket in two dialects - the exact per-file drift lib/statusColors
// documents. Status hues themselves still come from statusColors.statusColor;
// these are the task-specific vocabularies that sit alongside it.

import type { Task } from "../types";

// The canonical workflow order. The server may declare extras; merge them in
// via fullColumns() below rather than re-deriving per consumer.
export const ALL_COLUMNS = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"];

export const COL_LABEL: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

// Full column list: canonical order + any server-specific extras not already
// listed. Tolerates an absent payload (initial load) by serving the canon.
export function fullColumns(serverColumns: string[] | undefined | null): string[] {
  if (!serverColumns) return ALL_COLUMNS;
  const extras = serverColumns.filter((c) => !ALL_COLUMNS.includes(c));
  return [...ALL_COLUMNS, ...extras];
}

// Colors lightened from default rose/slate to clear WCAG AA 4.5:1 on the
// 14%-alpha same-hue badge tint.
// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
export const PRIORITY_COLOR: Record<string, string> = {
  high: "#fb7185",
  medium: "#f59e0b",
  low: "#94a3b8",
};

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// violet-400 (#c084fc) replaces #a855f7 (violet-500) to clear WCAG AA on the
// 14%-alpha tint.
export const EPIC_COLOR: Record<string, string> = {
  testing: "#c084fc",
  discovery: "#22d3ee",
  analytics: "#4ade80",
  general: "#818cf8",
};

export function epicColor(epic: string): string {
  return EPIC_COLOR[epic] || EPIC_COLOR.general;
}

// The default epic vocabulary + every epic the live tasks actually carry -
// feeds the add-form / detail-sidebar datalists so both offer the same set.
export function epicOptions(tasks: Task[] | undefined | null): string[] {
  const s = new Set<string>(Object.keys(EPIC_COLOR));
  for (const t of tasks ?? []) s.add(t.epic);
  return [...s];
}

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Type badge: one colour per TaskType, matching the existing hexA() pattern.
// Colors lightened to clear WCAG AA 4.5:1 on the 15%-alpha same-hue tint
// background:
//   bug: rose-400 (#fb7185) from rose-500 (#f43f5e)
//   feature: indigo-300 (#a5b4fc) from indigo-400 (#818cf8)
//   chore: slate-400 (#94a3b8) from slate-500 (#64748b)
export const TYPE_HEX: Record<string, string> = {
  bug: "#fb7185",
  feature: "#a5b4fc",
  chore: "#94a3b8",
  spike: "#f59e0b",
};

export const TYPE_ABBR: Record<string, string> = {
  bug: "bug",
  feature: "feat",
  chore: "chore",
  spike: "spike",
};

// off-token: WCAG contrast-math data, AA-vetted in statusColors.test.ts (not themeable var()) - SIM-43 crux (2026-07-14).
// Deterministic muted color for a label string (no randomness, no deps).
// #c084fc replaces #a855f7 (violet-500 -> violet-400) to clear WCAG AA on the
// 14%-alpha tint.
export function labelColor(label: string): string {
  const palette = ["#818cf8", "#22d3ee", "#4ade80", "#f59e0b", "#c084fc", "#06b6d4", "#34d399"];
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) & 0xffffff;
  return palette[Math.abs(h) % palette.length];
}
