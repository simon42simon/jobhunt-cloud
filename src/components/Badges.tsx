import { Badge } from "ssc-ui";
import { STATUS_LABEL } from "../lib/constants";
import { fitAccent, pipelineAccent, trackAccent } from "../lib/statusColors";
import { deadlineLabel, undraftedDeadlineText } from "../lib/utils";
import type { Status } from "../types";

// DS-5 (SIM-43): every tint-pill badge below renders via ssc-ui's Badge
// `tone` variant (DS-6a) - `color` = the text, background = a 14%
// color-mix() tint of that same color. The vetted hues driving `tone` still
// come from lib/statusColors (never a raw hex here); Badge's fixed 14% tint
// is within the 0.12-0.22 alpha range statusColors.test.ts already sweeps,
// so no new contrast risk is introduced by standardizing on one recipe.

export function FitBadge({ fit }: { fit: string }) {
  if (!fit) return null;
  // fitAccent/trackAccent/pipelineAccent (statusColors.ts, UX F7) already fall
  // back to the shared AA-safe DEFAULT_MUTED for an unrecognized value - the
  // old `|| "#64748b"` fallback here was itself an unvetted hex (2.98:1 FAIL).
  const color = fitAccent(fit);
  return (
    <Badge tone={color} className="gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {fit}
    </Badge>
  );
}

export function TrackBadge({ track, label }: { track: string; label: string }) {
  if (!label) return null;
  const color = trackAccent(track);
  return (
    <Badge tone={color} className="rounded px-2 py-0.5 text-[11px] font-medium">
      {label}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const color = pipelineAccent(status);
  return (
    <Badge tone={color} className="rounded px-2 py-0.5 text-[11px] font-semibold">
      {STATUS_LABEL[status] || status}
    </Badge>
  );
}

// `undrafted` (t-1783183576640, ops audit F6): the caller has already decided
// this is a queued job with no CV yet inside the due-soon horizon - swap the
// plain countdown for the "due Nd - not drafted" marker so it reads
// differently from a due-soon job whose draft is already in flight.
export function DeadlinePill({ deadline, undrafted }: { deadline: string | null; undrafted?: boolean }) {
  const info = undrafted ? undraftedDeadlineText(deadline) : deadlineLabel(deadline);
  if (!info) return null;
  const color = DEADLINE_TONE[info.tone];
  return (
    <Badge tone={color} className="gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium">
      {info.text}
    </Badge>
  );
}

// off-token: WCAG contrast-math data, AA-vetted alongside statusColors.ts's sweep (not themeable var()) - SIM-43 crux (2026-07-14).
// Brightened so deadline text clears WCAG AA on dark cards (calm was #64748b
// at 3.5:1, muted was #475569 at 2.2:1).
const DEADLINE_TONE: Record<string, string> = {
  urgent: "#f43f5e",
  soon: "#f59e0b",
  calm: "#8b97ae",
  muted: "#7e8ba3",
};

export function SectorBadge({ sector }: { sector: string }) {
  if (!sector) return null;
  return (
    <Badge variant="outline" className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {sector}
    </Badge>
  );
}
