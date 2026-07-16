import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Discovery, DerivedSource, DiscoveryDecision, InstructionProposal, SourceCadence } from "../types";
import { FitBadge, SectorBadge } from "./Badges";
import { Badge, Textarea } from "ssc-ui";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";
import {
  CadenceEditor,
  ContractWarningBadge,
  LeadGapWarning,
  OutcomeIcon,
  Sparkline,
  SourceStatusPill,
  SourceTypeBadge,
  SourceTypeIcon,
  TracksEditor,
} from "./sourcesShared";
import {
  SOURCE_ACTIVE_LABEL,
  SOURCE_STATUS_META,
  SOURCE_TYPE_LABEL,
  buildAliasIndex,
  cadencePhrase,
  findKey,
  formatDuration,
  hexA,
  isRealUrl,
  isRunning,
  lastTerminalRun,
  leadContractGaps,
  nextRunPhrase,
  relativeTime,
  resolveFindSourceId,
  runCountersPhrase,
  runSignalCaption,
} from "../lib/sources";
import { pursueFind } from "../lib/pursue";
import {
  PROPOSAL_BUSY_LABEL,
  archivedProposals,
  buildResolvePayload,
  diffWords,
  instructionsProvenance,
  isProposing,
  pendingProposal,
  provenanceLabel,
  type DiffSeg,
} from "../lib/proposals";
import { PROPOSAL_STATUS_META } from "../lib/statusColors";
import { track, useTrackView } from "../lib/telemetry";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "instructions", label: "Instructions" },
  { id: "runs", label: "Run history" },
  { id: "leads", label: "Leads" },
  { id: "settings", label: "Settings" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

type LeadDecision = "" | "skip" | "maybe" | "pursue";
// What a Leads-tab row action can MAKE ("clear" is only ever sent by undoLead,
// reverting to undecided - it is not a valid optimistic override value).
type ActiveLeadDecision = Exclude<DiscoveryDecision, "clear">;
function normLead(raw: string | undefined): LeadDecision {
  const d = (raw || "").trim().toLowerCase();
  if (d === "skip" || d === "maybe" || d === "pursue") return d;
  return "";
}

function Tile({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3.5 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-[14px] font-semibold text-[var(--color-text)]">{children}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">{hint}</div>}
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-edge)] py-2 last:border-b-0">
      <span className="text-[12px] text-[var(--color-muted)]">{label}</span>
      <span className="text-[13px] text-[var(--color-text)]">{children}</span>
    </div>
  );
}

export function SourceDetailDrawer({
  source,
  sources,
  finds,
  findsLoading,
  findsErr,
  active,
  busyRun,
  initialTab,
  onClose,
  onEdit,
  onRun,
  onToggleActive,
  onDelete,
  onViewFinds,
  onPursued,
  onRunStarted,
  onCadenceChange,
  onTracksChange,
  onAddContractFields,
  onRefresh,
}: {
  source: DerivedSource;
  sources: DerivedSource[];
  // The discovery workbook is fetched ONCE by DiscoveryView and shared (UX F3);
  // the Leads tab renders the caller's copy instead of pulling the workbook again.
  finds: Discovery[] | null;
  findsLoading: boolean;
  findsErr: string | null;
  active: boolean;
  busyRun: boolean;
  // Deep-link a specific tab open (e.g. the card's ContractWarningBadge opens
  // straight to "instructions"). Defaults to "overview" when omitted.
  initialTab?: TabId;
  onClose: () => void;
  onEdit: (source: DerivedSource) => void;
  onRun: (id: string) => void;
  onToggleActive: (source: DerivedSource) => void;
  onDelete: (source: DerivedSource) => void;
  onViewFinds: (id: string) => void;
  onPursued: (jobId: string) => void;
  // Registers the auto-launched first-draft-job run in App's dock (same contract
  // as the source Run affordance) so a Pursue from the Leads tab surfaces its
  // draft run too, not just the Triage inbox.
  onRunStarted: (run: { runId: string; label: string }) => void;
  onCadenceChange: (id: string, cadence: SourceCadence) => void;
  onTracksChange: (id: string, tracks: string[]) => void;
  onAddContractFields: (source: DerivedSource) => void;
  // Soft-reload the sources payload (proposal filed/resolved, propose run
  // launched) - the SSE events cover the background, this keeps clicks snappy.
  onRefresh: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<TabId>(initialTab ?? "overview");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Leads tab per-drawer triage state (the finds list itself comes from props).
  const [leadOverride, setLeadOverride] = useState<Record<string, LeadDecision>>({});
  const [leadBusy, setLeadBusy] = useState<string | null>(null);
  const [leadMsg, setLeadMsg] = useState<Record<string, string>>({});

  // Instruction-proposal loop (§11.2): the owner note + propose-run trigger.
  const [note, setNote] = useState("");
  const [proposeBusy, setProposeBusy] = useState(false);
  const [proposeMsg, setProposeMsg] = useState<string | null>(null);

  const meta = SOURCE_STATUS_META[source.status];
  const running = isRunning(source);
  const lastRun = lastTerminalRun(source);
  // v4 run honesty (schema v4 §2.2): same server-derived signal + counters the
  // card renders, so the drawer's Last-run tile can never disagree with it.
  const lastRunCaption = lastRun ? runSignalCaption(lastRun, source.lastRunSignal) : null;
  const lastRunCounters = lastRun ? runCountersPhrase(lastRun) : null;
  const titleId = `source-detail-${source.id}`;

  // Instruction-proposal derivations - all pure reads of the served source
  // (lib/proposals), so this drawer, the card badge, and the tests agree.
  const pending = pendingProposal(source);
  const archived = archivedProposals(source);
  const proposing = isProposing(source);

  // One `view` event when a source card opens its detail drawer (J10).
  useTrackView("source-detail", "J10");

  // Initial focus + focus restore on unmount (only on unmount so a stacked form
  // drawer doesn't steal focus back to the card).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Focus-trap + Esc, gated on `active` (disabled while the edit form is stacked
  // on top so the two dialogs don't fight over Tab/Esc). Uses the app's shared
  // dialogFocus helper (getFocusableElements + nextTrapTarget) so this drawer's
  // Tab-wrap matches AddJobModal / StatusChangeModal rather than a local copy.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const target = nextTrapTarget(
        getFocusableElements(panelRef.current),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, onClose]);

  const idx = useMemo(() => buildAliasIndex(sources), [sources]);
  const myFinds = useMemo(
    () => (finds ?? []).filter((f) => resolveFindSourceId(f, idx) === source.id),
    [finds, idx, source.id],
  );

  async function leadDecide(find: Discovery, decision: ActiveLeadDecision) {
    const key = findKey(find);
    const prior = key in leadOverride ? leadOverride[key] : normLead(find.Decision);
    setLeadBusy(key);
    setLeadMsg((m) => ({ ...m, [key]: "" }));
    setLeadOverride((o) => ({ ...o, [key]: decision }));
    try {
      const res = await api.decideDiscovery(find.Title, find.Link, decision);
      if (!res.ok) {
        setLeadMsg((m) => ({ ...m, [key]: res.message || "Could not save decision." }));
        setLeadOverride((o) => ({ ...o, [key]: prior }));
      }
    } catch (e) {
      setLeadMsg((m) => ({ ...m, [key]: String((e as Error).message || e) }));
      setLeadOverride((o) => ({ ...o, [key]: prior }));
    } finally {
      setLeadBusy((b) => (b === key ? null : b));
    }
  }

  // Undo a Skip/Maybe made in THIS drawer session (the action buttons only
  // render on an undecided row, so the prior state is always undecided):
  // revert the optimistic override and persist via the "clear" verb, which
  // BLANKS the Decision cell so the find is New again after a reload too
  // (t-1783178044080). Best-effort, the same posture as TriageInbox's
  // undoDecision - a locked workbook degrades gracefully server-side.
  function undoLead(find: Discovery) {
    const key = findKey(find);
    setLeadOverride((o) => ({ ...o, [key]: "" }));
    setLeadMsg((m) => ({ ...m, [key]: "" }));
    api.decideDiscovery(find.Title, find.Link, "clear").catch(() => {});
  }

  // The owner's note + run trigger, ONE action (§11.2 step 2): POST the note,
  // then refresh so the served proposeRunId flips this tab (and the card badge)
  // into "Reviewing your note…". 409 (already reviewing) / 429 (run cap) land
  // as a soft inline note, never a crash. Event name only - never the note text.
  async function handlePropose() {
    setProposeBusy(true);
    setProposeMsg(null);
    try {
      await api.proposeInstructions(source.id, note.trim());
      track("action", "discovery-sources", "proposal-propose", { journey: "J10" });
      setNote("");
      onRefresh();
    } catch (e) {
      setProposeMsg(String((e as Error).message || e));
    } finally {
      setProposeBusy(false);
    }
  }

  async function leadPursue(find: Discovery) {
    const key = findKey(find);
    setLeadBusy(key);
    setLeadMsg((m) => ({ ...m, [key]: "" }));
    try {
      // Same one-action Pursue as the Triage inbox: queue the job + start its
      // first draft (t-1783655444456), shared via pursueFind so the two surfaces
      // can never drift.
      const job = await pursueFind(find, onRunStarted);
      setLeadOverride((o) => ({ ...o, [key]: "pursue" }));
      onPursued(job.id);
    } catch (e) {
      setLeadMsg((m) => ({ ...m, [key]: String((e as Error).message || e) }));
    } finally {
      setLeadBusy((b) => (b === key ? null : b));
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[58] bg-black/50" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed right-0 top-0 z-[59] flex h-full w-[min(760px,96vw)] flex-col border-l border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        {/* Health header */}
        <div
          className="shrink-0 border-b border-l-[3px] border-[var(--color-edge)] p-5"
          style={{ borderLeftColor: meta.dot }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="mt-1 shrink-0 text-[var(--color-muted)]">
                <SourceTypeIcon type={source.type} />
              </span>
              <div className="min-w-0">
                <h2 id={titleId} className="text-[18px] font-semibold leading-tight text-[var(--color-text)]">
                  {source.name}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <SourceStatusPill status={source.status} signal={source.lastRunSignal} size="md" />
                  <SourceTypeBadge type={source.type} />
                  <SectorBadge sector={source.sector} />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[32px] sm:min-w-[32px]"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRun(source.id)}
              disabled={busyRun || running}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {running ? "Running…" : busyRun ? "Starting…" : source.status === "failed" ? "Retry" : "Run now"}
            </button>
            <button
              type="button"
              onClick={() => onToggleActive(source)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)]"
            >
              {source.active === "no" ? "Resume" : "Pause"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Source detail" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-edge)] px-3">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={`tabpanel-${t.id}`}
                id={`tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition ${
                  on
                    ? "border-[var(--color-accent)] text-[var(--color-text)]"
                    : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Panels */}
        <div
          role="tabpanel"
          id={`tabpanel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto p-5"
        >
          {tab === "overview" && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <Tile label="Status">
                  <SourceStatusPill status={source.status} signal={source.lastRunSignal} />
                </Tile>
                <Tile
                  label="Last run"
                  hint={
                    lastRun
                      ? lastRunCaption
                        ? `${relativeTime(lastRun.startedAt)} · ${lastRunCaption}`
                        : relativeTime(lastRun.startedAt)
                      : undefined
                  }
                >
                  {lastRun ? (
                    <span
                      className="inline-flex items-center gap-1.5"
                      title={lastRunCounters ?? undefined}
                    >
                      <OutcomeIcon outcome={lastRun.outcome} />
                      {typeof lastRun.leadsFound === "number" ? `${lastRun.leadsFound} found` : lastRun.outcome}
                    </span>
                  ) : (
                    "Never"
                  )}
                </Tile>
                <Tile label="Next run">
                  <span title={source.nextRunAt ? new Date(source.nextRunAt).toLocaleString() : undefined}>
                    {nextRunPhrase(source)}
                  </span>
                </Tile>
                <Tile label="Leads lifetime" hint={source.jobCount ? `${source.pursuedPct}% pursued` : undefined}>
                  <span className="tabular-nums">{source.jobCount}</span>
                </Tile>
                <Tile label="New since visit">
                  <span className="tabular-nums">{source.newSinceVisit}</span>
                </Tile>
                <Tile label="Cadence">{cadencePhrase(source.cadence)}</Tile>
              </div>
              <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-4">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Run trend (leads found)
                </div>
                {/* Fixed-width chart: scroll it inside its own container so it can
                    never push horizontal overflow onto the narrow (cover-screen) drawer. */}
                <div className="overflow-x-auto">
                  <Sparkline runs={source.runs} color={meta.dot} width={240} height={56} />
                </div>
              </div>
            </div>
          )}

          {tab === "instructions" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-[var(--color-text)]">Instructions</h3>
                <button
                  type="button"
                  onClick={() => onEdit(source)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1 text-[12px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)]"
                >
                  Edit
                </button>
              </div>
              {/* The pending proposal renders FIRST (§11.2.3) - the most
                  important thing to review. Keyed by proposal so the reject
                  two-step state resets when a new proposal lands. */}
              {pending && (
                <ProposalCard key={pending.id} source={source} proposal={pending} onResolved={onRefresh} />
              )}
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  URL(s)
                </div>
                {source.urls.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {source.urls.map((u, i) => (
                      <li key={i} className="min-w-0 text-[13px]">
                        {isRealUrl(u) ? (
                          <a
                            href={u}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-[var(--color-accent-text)] hover:underline"
                          >
                            {u}
                          </a>
                        ) : (
                          <span className="break-all text-[var(--color-text)]">{u}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted)]">No URLs set.</p>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Extraction instructions
                </div>
                {source.instructions ? (
                  <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3 text-[13px] leading-relaxed text-[var(--color-text)]">
                    {source.instructions}
                  </pre>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted)]">No instructions yet.</p>
                )}
                {/* Provenance caption (§11.2.1) - DERIVED from the two server
                    stamps, so it can never disagree with what actually happened. */}
                <p
                  className="mt-1.5 text-[11px] text-[var(--color-muted)]"
                  title={source.instructionsUpdatedAt ? new Date(source.instructionsUpdatedAt).toLocaleString() : undefined}
                >
                  {provenanceLabel(instructionsProvenance(source))}
                </p>
              </div>
              {/* Comment box / busy state (§11.2.2): leaving a note IS the
                  propose-run trigger - one human-gated action. While the run is
                  live (proposeRunId, survives reload) the box yields to the
                  same busy visual family as "Running…". */}
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Suggest a change
                </div>
                {proposing ? (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
                    style={{
                      borderColor: hexA(PROPOSAL_STATUS_META.pending.color, 0.4),
                      background: hexA(PROPOSAL_STATUS_META.pending.color, 0.14),
                      color: PROPOSAL_STATUS_META.pending.color,
                    }}
                  >
                    <span aria-hidden="true">◐</span>
                    <span>
                      <span className="font-semibold">{PROPOSAL_BUSY_LABEL}</span> The scout is studying the
                      page and will file a proposal here.
                    </span>
                  </div>
                ) : (
                  <>
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      aria-label="Leave a note for the scout"
                      placeholder="Tell the scout what's wrong or missing - e.g. 'this misses senior roles' or 'links open a search page, not the posting.'"
                      className="w-full px-2.5 py-2 text-[13px]"
                      style={{ minHeight: "72px" }}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handlePropose}
                        disabled={proposeBusy}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-[36px]"
                      >
                        {proposeBusy ? "Starting…" : "Propose instructions"}
                      </button>
                      <span className="text-[11px] text-[var(--color-muted)]">
                        Files your note and sends the scout to study the page. Empty is fine - it just asks
                        for a fresh look.
                      </span>
                    </div>
                    {proposeMsg && <p className="mt-1.5 text-[12px] text-rose-300">{proposeMsg}</p>}
                  </>
                )}
              </div>
              {source.contractGaps.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12.5px] text-amber-300">
                  <p className="leading-snug">
                    This source doesn't declare a{" "}
                    {source.contractGaps.map((g, i) => (
                      <span key={g}>
                        {i > 0 ? " or a " : ""}
                        <code>{g === "direct-link" ? "direct-link" : "deadline"}</code>
                      </span>
                    ))}{" "}
                    output field. Leads from it may get flagged in triage for missing required Job fields.
                  </p>
                  <button
                    type="button"
                    onClick={() => onAddContractFields(source)}
                    className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-amber-500/40 px-2.5 py-1 text-[12px] font-medium text-amber-300 hover:border-amber-500"
                  >
                    Add missing field{source.contractGaps.length > 1 ? "s" : ""}
                  </button>
                </div>
              )}
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Output fields
                </div>
                {source.outputFields.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {source.outputFields.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center rounded-full border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-0.5 text-[12px] text-[var(--color-text)]"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted)]">No output fields set.</p>
                )}
              </div>
              {source.aliases.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    Aliases
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {source.aliases.map((a) => (
                      <span
                        key={a}
                        className="inline-flex items-center rounded-full border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-0.5 text-[12px] text-[var(--color-muted)]"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {/* Archived (resolved) proposals, collapsed by default (§11.2.4) -
                  rejected ones are never deleted; their reasons feed the next run. */}
              <ProposalHistory proposals={archived} />
            </div>
          )}

          {tab === "runs" &&
            (source.runs.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-[var(--color-muted)]">No runs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                      <th className="px-2 py-2 font-semibold">When</th>
                      <th className="px-2 py-2 font-semibold">Outcome</th>
                      <th className="px-2 py-2 font-semibold">Trigger</th>
                      <th className="px-2 py-2 text-right font-semibold">Found</th>
                      <th className="px-2 py-2 text-right font-semibold">New</th>
                      <th className="px-2 py-2 text-right font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {source.runs.map((r) => (
                      <RunRows key={r.runId} r={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {tab === "leads" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-[var(--color-muted)]">
                  {findsLoading ? "Loading leads…" : `${myFinds.length} ${myFinds.length === 1 ? "lead" : "leads"} from this source`}
                </span>
                <button
                  type="button"
                  onClick={() => onViewFinds(source.id)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-1 text-[12px] font-medium text-[var(--color-accent-text)] hover:border-[var(--color-accent)]"
                >
                  Open in Finds <span aria-hidden="true">→</span>
                </button>
              </div>
              {findsErr ? (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[13px] text-rose-300">{findsErr}</div>
              ) : findsLoading ? (
                <div aria-hidden>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="mb-2 h-14 animate-pulse rounded-lg bg-[var(--color-panel-2)]" />
                  ))}
                </div>
              ) : myFinds.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-[var(--color-muted)]">
                  No leads joined to this source yet. Run it to produce some.
                </p>
              ) : (
                <ul className="rounded-lg border border-[var(--color-edge)]">
                  {myFinds.map((f) => {
                    const key = findKey(f);
                    const eff = key in leadOverride ? leadOverride[key] : normLead(f.Decision);
                    const busy = leadBusy === key;
                    return (
                      <li key={key} className="border-b border-[var(--color-edge)] p-2.5 last:border-b-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[var(--color-text)]">{f.Title}</div>
                            <div className="truncate text-[12px] text-[var(--color-muted)]">{f.Employer}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <FitBadge fit={f.Fit} />
                            <LeadGapWarning gaps={leadContractGaps(f)} />
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {f.tracked ? (
                            <span className="rounded bg-[var(--color-panel-2)] px-2 py-1 text-[11px] text-[var(--color-muted)]">
                              tracked
                            </span>
                          ) : eff ? (
                            <>
                              <span className="rounded bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                                {eff === "pursue" ? "pursued" : eff === "skip" ? "skipped" : "maybe"}
                              </span>
                              {/* Undo only a Skip/Maybe made THIS session on a
                                  previously-undecided row (never a pursue - that
                                  created a job) - persists via "clear". */}
                              {(eff === "skip" || eff === "maybe") &&
                                leadOverride[key] === eff &&
                                normLead(f.Decision) === "" && (
                                  <button
                                    type="button"
                                    onClick={() => undoLead(f)}
                                    aria-label={`Undo ${eff} for ${f.Title}`}
                                    className="min-h-[36px] rounded-md px-2 py-1 text-[12px] font-medium text-[var(--color-accent-text)] hover:underline"
                                  >
                                    Undo
                                  </button>
                                )}
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => leadDecide(f, "skip")}
                                disabled={busy}
                                aria-label={`Skip ${f.Title}`}
                                className="min-h-[36px] rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
                              >
                                Skip
                              </button>
                              <button
                                type="button"
                                onClick={() => leadDecide(f, "maybe")}
                                disabled={busy}
                                aria-label={`Mark ${f.Title} as maybe`}
                                className="min-h-[36px] rounded-md border border-amber-500/40 px-2.5 py-1 text-[12px] text-amber-400 hover:border-amber-500 disabled:opacity-50"
                              >
                                Maybe
                              </button>
                              <button
                                type="button"
                                onClick={() => leadPursue(f)}
                                disabled={busy}
                                aria-label={`Pursue ${f.Title}: queue and start the draft`}
                                title="Queues the job and starts the CV + cover letter draft"
                                className="min-h-[36px] rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                              >
                                Pursue → Draft
                              </button>
                            </>
                          )}
                          {leadMsg[key] && <span className="text-[11px] text-rose-300">{leadMsg[key]}</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3.5 py-1">
                <SummaryRow label="Name">{source.name}</SummaryRow>
                <SummaryRow label="Type">{SOURCE_TYPE_LABEL[source.type]}</SummaryRow>
                <SummaryRow label="Sector">{source.sector}</SummaryRow>
                <SummaryRow label="Cadence">
                  <CadenceEditor source={source} onChange={(c) => onCadenceChange(source.id, c)} align="right" />
                </SummaryRow>
                <SummaryRow label="Tracks">
                  <TracksEditor source={source} onChange={(t) => onTracksChange(source.id, t)} align="right" />
                </SummaryRow>
                <SummaryRow label="Active">{SOURCE_ACTIVE_LABEL[source.active]}</SummaryRow>
                {source.contractGaps.length > 0 && (
                  <SummaryRow label="Scrape contract">
                    <ContractWarningBadge gaps={source.contractGaps} />
                  </SummaryRow>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEdit(source)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)]"
                >
                  Edit source
                </button>
                <button
                  type="button"
                  onClick={() => onToggleActive(source)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)]"
                >
                  {source.active === "no" ? "Resume" : "Pause"}
                </button>
              </div>
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3.5">
                <div className="mb-1 text-[12px] font-semibold text-rose-300">Delete source</div>
                <p className="mb-2.5 text-[12px] leading-snug text-[var(--color-muted)]">
                  Removes only this source's config. Its finds are kept (they move to unassigned).
                </p>
                {confirmDelete ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onDelete(source)}
                      className="min-h-[40px] rounded-md bg-rose-500/90 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-500"
                    >
                      Delete {source.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="min-h-[40px] rounded-md border border-[var(--color-edge)] px-3.5 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="min-h-[40px] rounded-md border border-rose-500/40 px-3.5 py-1.5 text-[13px] font-medium text-rose-300 hover:border-rose-500"
                  >
                    Delete…
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// Render merged diff segments (lib/proposals diffWords) as prose: unchanged
// words plain, removals as <del> in the rejected rose, additions as <ins> in
// the approved emerald - color plus the del/ins semantics, never color alone.
function DiffSegs({ segs }: { segs: DiffSeg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        const sep = i > 0 ? " " : "";
        if (s.op === "same") return <span key={i}>{sep + s.text}</span>;
        const Tag = s.op === "removed" ? ("del" as const) : ("ins" as const);
        const color = s.op === "removed" ? PROPOSAL_STATUS_META.rejected.color : PROPOSAL_STATUS_META.approved.color;
        return (
          <span key={i}>
            {sep}
            <Tag className="rounded-sm px-0.5" style={{ color, background: hexA(color, 0.14), textDecoration: "none" }}>
              {s.text}
            </Tag>
          </span>
        );
      })}
    </>
  );
}

// The live proposal review card (§11.2.3): owner note + rationale + a
// Current | Proposed word diff + Approve / Reject-with-reason. Self-contained:
// it owns the reject two-step (the app's "must act before you can confirm"
// idiom - SourceCard's delete confirm) and the PATCH call; the parent keys it
// by proposal id so the state resets when a new proposal lands. The reject
// confirm disables on exactly buildResolvePayload's rule - the same gate the
// server enforces with its 400.
function ProposalCard({
  source,
  proposal,
  onResolved,
}: {
  source: DerivedSource;
  proposal: InstructionProposal;
  onResolved: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function resolve(verdict: "approved" | "rejected") {
    const payload = buildResolvePayload(verdict, reason);
    if (!payload) return; // blank reject reason - the button is already disabled
    setBusy(true);
    setMsg(null);
    try {
      await api.resolveInstructionProposal(source.id, proposal.id, payload);
      // Event name only - never the instruction/reason text (telemetry posture).
      track("action", "discovery-sources", verdict === "approved" ? "proposal-approve" : "proposal-reject", {
        journey: "J10",
      });
      onResolved(); // the refreshed source unmounts this card
    } catch (e) {
      setMsg(String((e as Error).message || e));
      setBusy(false);
    }
  }

  // Word-level diff; null (over budget) falls back to plain side-by-side
  // blocks - the spec's v1 baseline.
  const diff = diffWords(source.instructions, proposal.proposedInstructions);
  const preCls =
    "whitespace-pre-wrap break-words rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3 text-[12.5px] leading-relaxed text-[var(--color-text)]";

  return (
    <section
      aria-label="Proposed instructions"
      className="rounded-lg border bg-[var(--color-panel-2)] p-4"
      style={{ borderColor: hexA("#5a5df0", 0.45) }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold text-[var(--color-text)]">Proposed instructions</h4>
        <Badge tone="var(--color-accent-text)" className="rounded-full px-1.5 py-0.5 text-[10px] font-bold">
          NEW
        </Badge>
        <span className="ml-auto text-[11px] text-[var(--color-muted)]" title={new Date(proposal.ts).toLocaleString()}>
          {relativeTime(proposal.ts)}
        </span>
      </div>
      {proposal.ownerComment && (
        <p className="mt-2 text-[12px] leading-snug text-[var(--color-muted)]">
          <span className="font-semibold">Your note:</span> {proposal.ownerComment}
        </p>
      )}
      {proposal.rationale && (
        <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-text)]">{proposal.rationale}</p>
      )}

      {/* Side-by-side on the 760px drawer, stacked Current-above-Proposed on a
          narrow (cover-screen) drawer via the plain sm: breakpoint (§11.2.3). */}
      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Current
          </div>
          <pre className={preCls}>
            {source.instructions ? (
              diff ? <DiffSegs segs={diff.before} /> : source.instructions
            ) : (
              <span className="text-[var(--color-muted)]">(no instructions yet)</span>
            )}
          </pre>
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Proposed
          </div>
          <pre className={preCls}>
            {diff ? <DiffSegs segs={diff.after} /> : proposal.proposedInstructions}
          </pre>
        </div>
      </div>

      {!rejecting ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => resolve("approved")}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-[36px]"
          >
            {busy ? "Applying…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => {
              setRejecting(true);
              setMsg(null);
            }}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-rose-500/40 px-3.5 py-1.5 text-[13px] font-medium text-rose-300 hover:border-rose-500 disabled:opacity-50 sm:min-h-[36px]"
          >
            Reject…
          </button>
          <span className="text-[11px] text-[var(--color-muted)]">Approving replaces this source's instructions.</span>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Why reject? (required)
            </span>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. still points at the search page - the per-posting links are under 'View details'"
              className="w-full bg-[var(--color-panel)] px-2.5 py-2 text-[13px]"
              style={{ minHeight: "64px" }}
            />
            <span className="text-[11px] text-[var(--color-muted)]">
              A reason is required - the scout reads it before its next attempt.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => resolve("rejected")}
              disabled={busy || !buildResolvePayload("rejected", reason)}
              className="min-h-[44px] rounded-md bg-rose-500/90 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50 sm:min-h-[36px]"
            >
              {busy ? "Rejecting…" : "Reject proposal"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setReason("");
                setMsg(null);
              }}
              disabled={busy}
              className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3.5 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[36px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-[12px] text-rose-300">{msg}</p>}
    </section>
  );
}

// Collapsed history of resolved proposals (§11.2.4), newest-first as served.
// Rendered only when there is history (the NewBadge "only render on n > 0"
// convention); each entry shows its outcome chip, when, the owner note, the
// rejection reason, and the proposed text (scrollable, so a long proposal
// can't blow the drawer up).
function ProposalHistory({ proposals }: { proposals: InstructionProposal[] }) {
  const [open, setOpen] = useState(false);
  if (proposals.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md text-[12px] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-[32px]"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Past proposals ({proposals.length})
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-2">
          {proposals.map((p) => {
            const meta = PROPOSAL_STATUS_META[p.status];
            const when = p.resolvedAt ?? p.ts;
            return (
              <li key={p.id} className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={meta.color} className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold">
                    {meta.label}
                  </Badge>
                  <span className="text-[11px] text-[var(--color-muted)]" title={new Date(when).toLocaleString()}>
                    {relativeTime(when)}
                  </span>
                </div>
                {p.ownerComment && (
                  <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-muted)]">
                    <span className="font-semibold">Note:</span> {p.ownerComment}
                  </p>
                )}
                {p.rejectionReason && (
                  <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-muted)]">
                    <span className="font-semibold">Rejected because:</span> {p.rejectionReason}
                  </p>
                )}
                {p.proposedInstructions && (
                  <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] p-2.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    {p.proposedInstructions}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// One run's row(s): the metrics row, plus an inline error row on a failure.
function RunRows({ r }: { r: DerivedSource["runs"][number] }) {
  return (
    <>
      <tr className="border-t border-[var(--color-edge)]">
        <td className="px-2 py-2 text-[var(--color-muted)]" title={new Date(r.startedAt).toLocaleString()}>
          {relativeTime(r.startedAt)}
        </td>
        <td className="px-2 py-2">
          <span className="inline-flex items-center gap-1.5 text-[var(--color-text)]">
            <OutcomeIcon outcome={r.outcome} />
            <span className="capitalize">{r.outcome}</span>
          </span>
        </td>
        <td className="px-2 py-2 text-[var(--color-muted)] capitalize">{r.trigger}</td>
        <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text)]">
          {typeof r.leadsFound === "number" ? r.leadsFound : "—"}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text)]">
          {typeof r.leadsNew === "number" ? r.leadsNew : "—"}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-[var(--color-muted)]">{formatDuration(r.durationMs)}</td>
      </tr>
      {r.errorReason && (
        <tr>
          <td colSpan={6} className="px-2 pb-2 text-[12px] text-rose-300">
            <span className="text-[var(--color-muted)]">error:</span> {r.errorReason}
          </td>
        </tr>
      )}
    </>
  );
}
