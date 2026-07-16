import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useEventSubscription } from "../hooks/useEventStream";
import type { ActivityRecord, AppConfig, JobDetail as JobDetailT, Status } from "../types";
import { STATUS_LABEL, STATUS_ORDER } from "../lib/constants";
import { agentActionsFor } from "../lib/agentActions";
import { statusColor } from "../lib/statusColors";
import { deriveNextAction, fmtDate, isFollowUpDue, isUndraftedDueSoon } from "../lib/utils";
import { MarkdownLite } from "./MarkdownLite";
import { JobActivityTimeline } from "./JobActivityTimeline";
import { DeadlinePill, SectorBadge } from "./Badges";
import { Badge, Textarea } from "ssc-ui";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";
import { track, useTrackView } from "../lib/telemetry";
import { RegenerateConfirmModal } from "./RegenerateConfirmModal";
import { JobChat } from "./JobChat";

// Per-action Regenerate modal copy (Part 1). Keyed by routine so the confirm gate
// names the action + what it does; the exact files replaced come from outputTargets.
const REGEN_COPY: Record<string, { title: string; body: string }> = {
  "first-draft-job": {
    title: "Regenerate CV + cover letter",
    body: "Re-drafts your CV and cover letter for this role from your facts, replacing the current versions.",
  },
  "finalize-job": {
    title: "Re-finalize application",
    body: "Regenerates the finalized CV + cover letter in place, replacing the current versions.",
  },
  "interview-prep": {
    title: "Regenerate interview prep",
    body: "Rebuilds your prep sheet and STAR stories from scratch, replacing the current ones. Use Refine instead if you only want to fold in feedback.",
  },
  "interview-prep-refine": {
    title: "Refine interview prep",
    body: "Regenerates your prep sheet and STAR stories using your feedback note, replacing the current versions.",
  },
  "offer-prep": {
    title: "Regenerate offer prep",
    body: "Rebuilds your offer comparison and negotiation strategy, replacing the current versions.",
  },
  "draft-follow-up": {
    title: "Regenerate follow-up email",
    body: "Re-drafts the follow-up email, replacing the current draft.",
  },
};

// A dated regenerate copy ("... (YYYY-MM-DD).pdf") - history, never a live target.
// Mirrors the server's isDatedCopy; display-only (the server owns the real backup).
function isDatedCopyName(name: string): boolean {
  const stem = name.replace(/\.[^.]*$/, "");
  return / \(\d{4}-\d{2}-\d{2}\)( \(\d+\))?$/.test(stem);
}

// The CURRENT output files a routine would replace, for the confirm modal's "will
// be replaced" list. Display-only mirror of the server's routineOutputFiles.
function outputTargets(routine: string, files: { name: string; ext: string }[]): string[] {
  const cur = files.filter((f) => !isDatedCopyName(f.name));
  const l = (n: string) => n.toLowerCase();
  const isDoc = (f: { ext: string }) => f.ext === "docx" || f.ext === "pdf";
  const isPrep = (n: string) =>
    l(n).endsWith(".md") && !/gaps|job-description|feedback/.test(l(n)) && /interview|prep|star/.test(l(n));
  const pick = (pred: (f: { name: string; ext: string }) => boolean) => cur.filter(pred).map((f) => f.name);
  switch (routine) {
    case "first-draft-job":
    case "finalize-job":
      return pick((f) => isDoc(f) && /cv|cover/.test(l(f.name)));
    case "interview-prep":
    case "interview-prep-refine":
      return pick((f) => isPrep(f.name));
    case "offer-prep":
      return pick((f) => f.ext === "md" && /offer|negotiation/.test(l(f.name)));
    case "draft-follow-up":
      return pick((f) => f.ext === "md" && /follow[- ]?up/.test(l(f.name)));
    default:
      return [];
  }
}

const FITS = ["strong", "moderate", "stretch"];
const SECTORS = ["private", "municipal", "provincial", "federal", "bps", "nonprofit"];
const TAILORINGS = ["light", "heavy"];

// --- "has this action already run?" badge -----------------------------------
// The activity feed writes TWO records per routine run: a start record
// carrying { routine, jobId, status:"running" } and a close record carrying
// only { runId, status: done|failed|stopped, exitCode }. So the client-side
// join pairs them by runId: collect this job's start records for the routine,
// then take the newest terminal record among those runIds. A start with no
// terminal record (still running, or the server died mid-run) is NOT
// conclusively "ran" and yields nothing - a live run is already surfaced by
// the RunPanel. Same story for a terminal record whose start fell off the
// feed's ~200-record window: no pair, no badge.

type LastRunStatus = "done" | "failed" | "stopped";

export function lastRunFor(
  activity: ActivityRecord[],
  routine: string,
  jobId: string,
): { status: LastRunStatus; ts: string } | null {
  const runIds = new Set<string>();
  for (const r of activity) {
    if (r.kind === "run" && r.status === "running" && r.runId && r.routine === routine && r.jobId === jobId) {
      runIds.add(r.runId);
    }
  }
  if (runIds.size === 0) return null;
  let best: { status: LastRunStatus; ts: string } | null = null;
  for (const r of activity) {
    if (r.kind !== "run" || !r.runId || !runIds.has(r.runId)) continue;
    if (r.status !== "done" && r.status !== "failed" && r.status !== "stopped") continue;
    // ISO-8601 timestamps compare correctly as strings.
    if (!best || r.ts > best.ts) best = { status: r.status, ts: r.ts };
  }
  return best;
}

function fmtRunStamp(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Colors come from the shared vetted module (never a raw hex here): success
// reuses the standard "done" green; failed/stopped reuse the vetted amber
// (the module has no run-terminal keys yet - adding failed/stopped entries
// there is a statusColors.ts change tracked separately).
function LastRunBadge({ run }: { run: { status: LastRunStatus; ts: string } }) {
  const ok = run.status === "done";
  const color = ok ? statusColor("done") : statusColor("active");
  const verb = ok ? "Ran" : run.status === "failed" ? "Failed" : "Stopped";
  return (
    <Badge
      tone={color}
      title={`Last run: ${verb.toLowerCase()} ${new Date(run.ts).toLocaleString()}`}
      className="shrink-0 gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium"
    >
      <span aria-hidden>{ok ? "✓" : "⚠"}</span>
      {verb} {fmtRunStamp(run.ts)}
    </Badge>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

// Is this page being viewed ON the machine that runs the server? POST /api/open
// shell-opens a file on the SERVER's desktop, which is only honest when the
// client is that same desktop - i.e. the page was loaded over loopback. Over
// the tailnet (or any non-loopback host) the tap must instead stream the file
// to THIS device via the guarded reader (GET /api/jobs/:id/files/:name), or it
// is a silent no-op on the phone that pops a window at home
// (t-1783201094679). Exported for the unit test.
export function isServerDesktopClient(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes((hostname || "").toLowerCase());
}

// Guarded-reader URL for one job-folder file (kept beside its consumer: this
// drawer is the only surface with Files buttons; promote to api.ts if a second
// consumer appears). Exported for the unit test.
export function jobFileUrl(jobId: string, name: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`;
}

// Does a `run-finished` SSE event belong to the job this drawer has open? A
// job-scoped routine run stamps its jobId with the job FOLDER name, which IS
// job.id (server: toJob sets id = folder; runRoutine stamps that same folder as
// the run's jobId), so an exact match means "this job's own action just
// finished". A ticket-scoped run (jobId is a t-* id) or another job's run must
// NOT churn this drawer. Pure + exported for the unit test. (t-1783390990670)
export function isRunForJob(event: { jobId?: string | null }, openJobId: string): boolean {
  return !!openJobId && event.jobId === openJobId;
}

// min-h-[44px] on touch (relaxed at >= sm, the app-wide tap-target idiom) so the
// Status select - the drawer's primary status-change control - and the other
// field editors are one-handed-thumb friendly at phone widths.
const selectCls =
  "min-h-[44px] rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-0";

export function JobDetailDrawer({
  jobId,
  config,
  onClose,
  onChanged,
  onRun,
}: {
  jobId: string;
  config: AppConfig | null;
  onClose: () => void;
  onChanged: () => void;
  onRun: (routine: string, jobId: string) => void;
}) {
  const [job, setJob] = useState<JobDetailT | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Activity feed slice for the "already ran" badges. Telemetry, not the write
  // path: a failed fetch just means no badges, never an error state.
  const [activity, setActivity] = useState<ActivityRecord[] | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // True while the Regenerate confirm modal is open, so the drawer's own Tab trap
  // stands down and the modal's trap (rendered as a sibling outside panelRef) can
  // take over - otherwise the drawer would keep focus pinned behind the modal.
  const modalOpenRef = useRef(false);

  // One `view` event when the job detail drawer opens (J3). The drawer mounts on
  // open and unmounts on every close, so this fires once per open (deduped
  // against a rapid remount by useTrackView).
  useTrackView("job-detail", "J3");

  // Next action + Posting URL save on blur, but closing the drawer via Esc or a
  // backdrop click unmounts it BEFORE blur fires, which silently dropped the
  // typed edit. Each keystroke is mirrored into a draft ref (null = untouched);
  // an unmount flush persists any unsaved change so no close path loses input.
  // jobRef gives that cleanup the latest job to diff against (a cleanup closure
  // would otherwise capture the first render's job).
  const nextActionDraft = useRef<string | null>(null);
  const linkDraft = useRef<string | null>(null);
  const jobRef = useRef<JobDetailT | null>(null);

  // Gaps inline-edit state
  const [gapsEditing, setGapsEditing] = useState(false);
  const [gapsText, setGapsText] = useState("");
  const [gapsSave, setGapsSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [gapsSaveErr, setGapsSaveErr] = useState<string | null>(null);

  // Interview-prep feedback-note inline-edit state (Part 3), mirroring gaps.
  const [feedbackEditing, setFeedbackEditing] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSave, setFeedbackSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [feedbackSaveErr, setFeedbackSaveErr] = useState<string | null>(null);

  // When set, the guarded Regenerate confirm modal is open for this action
  // (Part 1). Confirming fires the same onRun path a plain Run would.
  const [regenAction, setRegenAction] = useState<{ routine: string; event: string } | null>(null);
  // Mirror the modal-open state into the ref the drawer's Tab-trap reads.
  useEffect(() => {
    modalOpenRef.current = regenAction !== null;
  }, [regenAction]);

  // Focus management: move focus into the drawer on open, trap Tab inside it
  // via the shared dialogFocus helpers (its selector includes `summary`, which
  // this drawer's "Full job note" disclosure needs - the local copy that used
  // to live here had drifted for exactly that reason), and restore focus to
  // the trigger element on close. Esc + backdrop still close (Esc via the
  // global handler in App, backdrop via the overlay onClick).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      // Stand down while the Regenerate modal owns focus (it traps Tab itself).
      if (modalOpenRef.current) return;
      const root = panelRef.current;
      if (!root) return;
      const focusable = getFocusableElements(root);
      if (focusable.length === 0) {
        // Nothing focusable yet (loading state): keep focus pinned on the root.
        e.preventDefault();
        root.focus();
        return;
      }
      const target = nextTrapTarget(focusable, document.activeElement, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  function copyCmd(cmd: string) {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(cmd);
      window.setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1600);
    });
  }

  useEffect(() => {
    let alive = true;
    api
      .getJob(jobId)
      .then((j) => alive && setJob(j))
      .catch((e) => alive && setErr(String(e.message || e)));
    api
      .getActivity()
      .then((a) => alive && setActivity(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Keep jobRef pointing at the latest loaded/optimistic job for the unmount flush.
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  // Live refetch after THIS job's own routine run finishes (t-1783390990670).
  // The drawer used to load its job + activity ONCE on open and never again, so
  // clicking an Agent action (Draft / Finalize / Interview prep / ...) and
  // waiting for it to complete left the drawer stale: the button never flipped
  // to "Done / Regenerate", no Last-run badge appeared, and the freshly written
  // CV / cover-letter / prep files stayed hidden until you closed and reopened
  // the drawer - reading as "the action button doesn't update". The server
  // already broadcasts a typed `run-finished` { runId, routine, jobId } when a
  // run reaches a terminal state; we subscribe to it (the shared app-wide SSE
  // stream, same one useJobs rides for the board) and re-pull the job + activity
  // when the finished run is this job's own. Best-effort: a transient refetch
  // failure just leaves the last-good view in place, never an error state.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const refetch = useCallback(async () => {
    try {
      const [fresh, acts] = await Promise.all([
        api.getJob(jobId),
        api.getActivity().catch(() => null),
      ]);
      if (!mountedRef.current) return;
      setJob(fresh);
      if (acts) setActivity(acts);
    } catch {
      /* transient refetch failure - keep the current view */
    }
  }, [jobId]);
  useEventSubscription("run-finished", (e) => {
    if (isRunForJob(e, jobId)) refetch();
  });

  // Flush not-yet-saved Next action / Posting URL edits when the drawer closes.
  // Runs on unmount, which is EVERY close path: Esc, backdrop, and the close
  // button all clear `selected` in App and unmount this component. Uses a direct
  // api call (not save()) because the component is going away - no optimistic
  // setState on an unmounting component.
  useEffect(() => {
    return () => {
      const j = jobRef.current;
      if (!j) return;
      const u = pendingFieldUpdates(j);
      if (Object.keys(u).length === 0) return;
      api
        .updateJob(j.id, u)
        .then(() => onChanged())
        .catch(() => {});
    };
  }, []);

  async function save(updates: Record<string, string | null>) {
    if (!job) return;
    setSaving(true);
    setErr(null);
    setJob({ ...job, ...(updates as Partial<JobDetailT>) }); // optimistic
    try {
      await api.updateJob(job.id, updates);
      onChanged();
      const fresh = await api.getJob(job.id);
      setJob(fresh);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  // Which of the two blur-saved fields (Next action, Posting URL) actually differ
  // from the stored job. Empty-string-vs-undefined counts as UNCHANGED, so an
  // untouched or cleared-already-empty field never fires a spurious PATCH (the old
  // guard used `!== job.field`, and "" !== undefined wrongly triggered a save +
  // jobs reload). Shared by the onBlur commit and the unmount flush so the two can
  // never diverge. Returns {} when nothing changed.
  function pendingFieldUpdates(j: JobDetailT): Record<string, string | null> {
    const u: Record<string, string | null> = {};
    const na = nextActionDraft.current;
    if (na !== null && na !== (j.nextAction ?? "")) u.next_action = na;
    const lk = linkDraft.current;
    if (lk !== null) {
      const trimmed = lk.trim();
      if (trimmed !== (j.link ?? "")) u.link = trimmed || null;
    }
    return u;
  }

  // onBlur handler for both fields: persist via save() so the "Saving..." hint and
  // the optimistic update show on the normal (blur) path. The unmount flush covers
  // the Esc/backdrop path where blur never fires.
  function commitPendingFields() {
    if (!job) return;
    const u = pendingFieldUpdates(job);
    if (Object.keys(u).length > 0) save(u);
  }

  async function saveGaps() {
    if (!job?.gaps) return;
    setGapsSave("saving");
    setGapsSaveErr(null);
    try {
      await api.writeJobFile(job.id, job.gaps.name, gapsText);
      setJob({ ...job, gaps: { name: job.gaps.name, content: gapsText } });
      setGapsSave("saved");
      window.setTimeout(() => setGapsSave((s) => (s === "saved" ? "idle" : s)), 2000);
      setGapsEditing(false);
    } catch (e) {
      setGapsSaveErr(String((e as Error).message || e));
      setGapsSave("error");
    }
  }

  function startGapsEdit() {
    if (!job?.gaps) return;
    setGapsText(job.gaps.content);
    setGapsSave("idle");
    setGapsSaveErr(null);
    setGapsEditing(true);
  }

  function cancelGapsEdit() {
    setGapsEditing(false);
    setGapsSave("idle");
    setGapsSaveErr(null);
  }

  // Feedback-note editor (Part 3), mirroring saveGaps. On success it REFETCHES the
  // job so prepRefineReady (a server-derived mtime signal - the note was edited
  // after the prep docs) flips to true and the Refine readiness hint updates.
  async function saveFeedback() {
    if (!job?.prepFeedback) return;
    setFeedbackSave("saving");
    setFeedbackSaveErr(null);
    try {
      await api.writeJobFile(job.id, job.prepFeedback.name, feedbackText);
      const fresh = await api.getJob(job.id);
      setJob(fresh);
      setFeedbackSave("saved");
      window.setTimeout(() => setFeedbackSave((s) => (s === "saved" ? "idle" : s)), 2000);
      setFeedbackEditing(false);
    } catch (e) {
      setFeedbackSaveErr(String((e as Error).message || e));
      setFeedbackSave("error");
    }
  }

  function startFeedbackEdit() {
    if (!job?.prepFeedback) return;
    setFeedbackText(job.prepFeedback.content);
    setFeedbackSave("idle");
    setFeedbackSaveErr(null);
    setFeedbackEditing(true);
  }

  function cancelFeedbackEdit() {
    setFeedbackEditing(false);
    setFeedbackSave("idle");
    setFeedbackSaveErr(null);
  }

  // DERIVED next-action suggestion (US-3), DISPLAY-ONLY: a hint shown UNDER the
  // Next action field only while the owner has NOT set a real next_action. Pure
  // + derived, writes NOTHING (no PATCH, no accept button). Reflects the saved
  // value (job.nextAction) - the input is uncontrolled, so this stays visible
  // while empty and disappears once a real next_action is saved on blur.
  const suggestedNextAction = job && !job.nextAction ? deriveNextAction(job) : null;

  // Interview-prep docs the interview-prep routine wrote into the job folder
  // (prep sheet + STAR bank). Nullish-guarded so a cached response without the
  // field never throws; empty array reads as "no prep yet".
  const prepDocs = job?.prep ?? [];

  // Per-routine "already done" state (Part 1), from the server's artifact-derived
  // flags. A done action swaps its plain Run for a guarded Regenerate.
  const doneByRoutine: Record<string, boolean> = {
    "first-draft-job": !!job?.draftDone,
    "finalize-job": !!job?.finalizeDone,
    "merge-application-pdf": !!job?.mergedPdfDone,
    "interview-prep": !!job?.interviewPrepDone,
    "offer-prep": !!job?.offerPrepDone,
    "draft-follow-up": !!job?.followUpDone,
  };

  // Run an assistant-suggested action (Part 4) through the SAME guard as the
  // action buttons: refine or an already-done action opens the confirm modal; a
  // fresh action runs directly. The assistant proposes, the human disposes.
  function runSuggested(routine: string) {
    if (!job) return;
    if (routine === "interview-prep-refine" || doneByRoutine[routine]) {
      setRegenAction({ routine, event: routine });
    } else {
      track("run", "job-detail", routine, { journey: "J3" });
      onRun(routine, job.id);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={job ? `${job.role} at ${job.employer}` : "Job detail"}
        tabIndex={-1}
        className="fixed right-0 top-0 z-50 flex h-full w-[min(560px,92vw)] flex-col overflow-y-auto border-l border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
      >
        {!job ? (
          <div className="flex h-full items-center justify-center text-[var(--color-muted)]">
            {err ? <span className="text-rose-400">{err}</span> : "Loading..."}
          </div>
        ) : (
          <>
            {/* header */}
            <div className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-edge)] bg-[var(--color-panel)] p-5">
              <div>
                <h2 className="text-[18px] font-semibold leading-tight text-[var(--color-text)]">
                  {job.role}
                </h2>
                <div className="mt-1 text-[14px] text-[var(--color-muted)]">{job.employer}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <SectorBadge sector={job.sector} />
                  {job.deadline && (
                    <span className="text-[12px] text-[var(--color-muted)]">
                      deadline {fmtDate(job.deadline)}
                    </span>
                  )}
                  <DeadlinePill deadline={job.deadline} undrafted={isUndraftedDueSoon(job)} />
                  {job.applied && (
                    <span className="text-[12px] text-emerald-400">applied {fmtDate(job.applied)}</span>
                  )}
                </div>
                <div className="mt-1.5">
                  {job.link ? (
                    <a
                      href={job.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12px] text-[var(--color-accent-text)] hover:underline"
                      title={job.link}
                    >
                      Open posting ↗
                    </a>
                  ) : (
                    <span className="text-[12px] text-[#7a869d]">no posting URL yet - add one below</span>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-[var(--color-edge)] px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>

            {/* editable fields - overrides; the agent normally sets track/fit/tailoring */}
            <div className="shrink-0 border-b border-[var(--color-edge)] p-5">
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Fields
                </span>
                <span className="text-[11px] text-[#7a869d]">overrides - the agent sets these when drafting</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status">
                  <select
                    className={selectCls}
                    value={job.status}
                    onChange={(e) => save({ status: e.target.value })}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Fit">
                  <select className={selectCls} value={job.fit} onChange={(e) => save({ fit: e.target.value })}>
                    {!FITS.includes(job.fit) && job.fit && <option value={job.fit}>{job.fit}</option>}
                    {FITS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Track">
                  <select className={selectCls} value={job.track} onChange={(e) => save({ track: e.target.value })}>
                    {config &&
                      Object.entries(config.tracks).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    {config && !config.tracks[job.track] && job.track && (
                      <option value={job.track}>{job.track}</option>
                    )}
                  </select>
                </Field>
                <Field label="Sector">
                  <select className={selectCls} value={job.sector} onChange={(e) => save({ sector: e.target.value })}>
                    {!SECTORS.includes(job.sector) && job.sector && <option value={job.sector}>{job.sector}</option>}
                    {SECTORS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Deadline">
                  <input
                    type="date"
                    className={selectCls}
                    value={job.deadline || ""}
                    onChange={(e) => save({ deadline: e.target.value || null })}
                  />
                </Field>
                <Field label="Tailoring">
                  <select
                    className={selectCls}
                    value={job.tailoring}
                    onChange={(e) => save({ tailoring: e.target.value })}
                  >
                    {!TAILORINGS.includes(job.tailoring) && job.tailoring && (
                      <option value={job.tailoring}>{job.tailoring}</option>
                    )}
                    {TAILORINGS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Next action">
                  <input
                    type="text"
                    placeholder="e.g. tailor CV, email referral, follow up"
                    className={selectCls}
                    defaultValue={job.nextAction}
                    onChange={(e) => {
                      nextActionDraft.current = e.target.value;
                    }}
                    onBlur={commitPendingFields}
                  />
                </Field>
                {/* DISPLAY-ONLY suggestion (US-3): shown only when no real
                    next_action is set. Text prefix "Suggested:" (not color
                    alone, CC-A11Y-SR) + italic + muted tone so it is clearly a
                    hint, not a saved value. Nothing is written. */}
                {suggestedNextAction && (
                  <p className="mt-1.5 pl-0.5 text-[11px] italic leading-relaxed text-[#7a869d]">
                    <span className="font-semibold not-italic text-[var(--color-muted)]">Suggested:</span>{" "}
                    {suggestedNextAction} - based on this job's status; not saved until you set it.
                  </p>
                )}
              </div>
              <div className="mt-3">
                <Field label="Posting URL">
                  <input
                    type="url"
                    placeholder="https://... (link to actually apply)"
                    className={selectCls}
                    defaultValue={job.link}
                    onChange={(e) => {
                      linkDraft.current = e.target.value;
                    }}
                    onBlur={commitPendingFields}
                  />
                </Field>
              </div>
              <div className="mt-2 h-4 text-[11px] text-[var(--color-muted)]">
                {saving ? "Saving to file..." : err ? <span className="text-rose-400">{err}</span> : ""}
              </div>
            </div>

            {/* agent actions - these are run by the existing routines/agents, not typed by hand */}
            <div className="shrink-0 border-b border-[var(--color-edge)] px-5 py-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Agent actions
              </div>
              <p className="mb-2.5 text-[11px] leading-relaxed text-[#7a869d]">
                Done by your Claude Code routines, not manual forms. <strong className="text-[#9aa6bd]">Run</strong> launches
                a scoped Claude agent in your vault (it edits files but never submits). Or copy the command to run it yourself.
              </p>
              <div className="flex flex-col gap-2">
                {/* DERIVED action list (src/lib/agentActions.ts): the two core
                    pipeline routines always, plus the status-gated late-stage prep
                    routines - interview-prep only at `interview`, offer-prep only
                    at `offer` (US-4/US-5) - plus draft-follow-up when this job is
                    follow-up-due (US-6), gated by the derived isFollowUpDue signal
                    passed in as context, plus the optional merge-application-pdf
                    once both rendered PDFs exist (mergePdfReady, t-1783650792067).
                    Same launch path for every button: onRun(routine, job.id), same
                    Run panel, copy-CLI, and Last-run badge as Draft/Finalize. */}
                {agentActionsFor(job.status, {
                  followUpDue: isFollowUpDue(job),
                  interviewPrepDone: job.interviewPrepDone,
                  mergePdfReady: job.mergePdfReady,
                }).map((a) => {
                  const cmd = `run ${a.routine} for "${job.folder}"`;
                  // job.id IS the job folder name (server: toJob sets id = folder),
                  // and it is what runRoutine stamps onto the start record's jobId.
                  const lastRun = activity ? lastRunFor(activity, a.routine, job.id) : null;
                  // Refine is always a guarded regenerate (it only appears once a
                  // prep draft exists); a done action becomes a guarded Regenerate.
                  const isRefine = a.routine === "interview-prep-refine";
                  const done = !!doneByRoutine[a.routine];
                  const guarded = isRefine || done;
                  return (
                    <div key={a.routine} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        {done && !isRefine && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300">
                            <span aria-hidden>✓</span> Done
                          </span>
                        )}
                        {guarded ? (
                          // Guarded: open the confirm modal (which fires onRun) rather
                          // than re-running destructively on a single click.
                          <button
                            onClick={() => setRegenAction({ routine: a.routine, event: a.event })}
                            title={isRefine ? a.label : `Regenerate ${a.regenLabel}`}
                            className="inline-flex min-h-[44px] flex-1 items-center gap-1.5 rounded-md border border-amber-500/40 bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] hover:border-amber-400 sm:min-h-0"
                          >
                            {/* Name the specific action, not the bare word "Regenerate"
                                (t-1783374313180): three done actions used to collapse to
                                the same unlabelled button. Visible text == title, so the
                                accessible name reads the full action too. */}
                            <span className="text-amber-300" aria-hidden>↻</span>{" "}
                            {isRefine ? a.label : `Regenerate ${a.regenLabel}`}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              // Routine run trigger (J3): a stable, content-free event
                              // name carried on the action (draft | finalize |
                              // interview-prep | offer-prep).
                              track("run", "job-detail", a.event, { journey: "J3" });
                              onRun(a.routine, job.id);
                            }}
                            className="inline-flex min-h-[44px] flex-1 items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0"
                          >
                            <span className="text-[var(--color-accent-text)]" aria-hidden>▶</span> {a.label}
                          </button>
                        )}
                        {lastRun && <LastRunBadge run={lastRun} />}
                        <button
                          onClick={() => copyCmd(cmd)}
                          title={`Copy: ${cmd}`}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-[var(--color-edge)] px-2 py-1.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0 sm:min-w-0"
                        >
                          {copied === cmd ? "copied" : "copy"}
                        </button>
                      </div>
                      {/* Readiness heuristic (INFORMATIONAL, never blocking - the
                          Finalize button stays enabled): a disclosed signal that the
                          gaps note was answered after the draft. */}
                      {a.routine === "finalize-job" && job.finalizeReady && (
                        <span className="pl-0.5 text-[11px] text-emerald-400">
                          Gaps note updated after the draft - ready to finalize
                        </span>
                      )}
                      {a.routine === "finalize-job" &&
                        !job.finalizeReady &&
                        job.status === "drafted" &&
                        job.hasCV && (
                          <span className="pl-0.5 text-[11px] text-[#7a869d]">
                            Answer the gaps note first, then finalize
                          </span>
                        )}
                      {/* Send-anxiety guard (US-6): this action writes an email
                          DRAFT into the job folder and never sends it - said
                          explicitly here since an "email" action reads as riskier
                          than the section's general "never submits" line. */}
                      {a.routine === "draft-follow-up" && (
                        <span className="pl-0.5 text-[11px] text-[#7a869d]">
                          Drafts a follow-up email in the job folder - never sends it
                        </span>
                      )}
                      {/* Refine readiness (Part 3), mirroring the finalize hint: the
                          feedback note was edited AFTER the prep docs were generated. */}
                      {a.routine === "interview-prep-refine" && job.prepRefineReady && (
                        <span className="pl-0.5 text-[11px] text-emerald-400">
                          Feedback note updated - ready to refine
                        </span>
                      )}
                      {a.routine === "interview-prep-refine" && !job.prepRefineReady && (
                        <span className="pl-0.5 text-[11px] text-[#7a869d]">
                          Add your notes in the feedback box below, then refine
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Interview prep (US-4, J3): the prep sheet + STAR bank the
                interview-prep routine wrote into the job folder, rendered INLINE
                as a first-class read surface instead of buried among the raw
                Files chips - the whole point of prep is to READ it before the
                interview, on a phone if need be. Each doc is a disclosure; the
                prep sheet (sorted first server-side) opens by default, the STAR
                bank stays collapsed as reference. Shown whenever prep exists (any
                status). When the job is AT `interview` with no prep yet, a hint
                points at the "Interview prep (STAR)" agent action above. */}
            {(prepDocs.length > 0 || job.status === "interview") && (
              <div className="shrink-0 border-b border-[var(--color-edge)] px-5 py-4">
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-text)]">
                    Interview prep
                  </span>
                  {prepDocs.length > 0 && (
                    <span className="text-[11px] text-[#7a869d]">
                      {prepDocs.length} doc{prepDocs.length > 1 ? "s" : ""} - grounded in your facts
                    </span>
                  )}
                </div>

                {/* Consistency check (feature 1, 2026-07-06 design): read-only,
                    deterministic cross-check of the prep sheet's STAR-story citations
                    against the bank. A `high` finding is a hard flag (a cited story the
                    bank never defines - e.g. a "-> Story G" that was never written);
                    `info` findings are advisory. Server-derived (job.consistency), so a
                    cached response without the field never throws. */}
                {job.consistency?.findings?.length ? (
                  <div className="mb-3 flex flex-col gap-1.5" role="status" aria-label="Interview prep consistency">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Consistency check
                    </span>
                    {job.consistency.findings.map((f, i) => {
                      const hard = f.severity === "high";
                      return (
                        <div
                          key={`${f.kind}-${i}`}
                          className={
                            "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed " +
                            (hard
                              ? "border-[#6b2d2d] bg-[#241315] text-[#f0a9a9]"
                              : "border-[var(--color-edge)] bg-[var(--color-panel-2)] text-[#8b96ad]")
                          }
                        >
                          <span aria-hidden="true" className="mt-[1px] shrink-0">
                            {hard ? "⚠" : "ℹ"}
                          </span>
                          <span>{f.message}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {prepDocs.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {prepDocs.map((doc, i) => (
                      <details
                        key={doc.name}
                        open={i === 0}
                        className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)]"
                      >
                        <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                          {doc.name.replace(/\.md$/i, "")}
                        </summary>
                        <div className="border-t border-[var(--color-edge)] px-3 py-3 text-[13px] leading-relaxed">
                          <MarkdownLite text={doc.content} />
                        </div>
                      </details>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] leading-relaxed text-[#7a869d]">
                    No prep yet. Run{" "}
                    <strong className="text-[#9aa6bd]">Interview prep (STAR)</strong> above to generate a
                    tailored prep sheet + STAR stories from your facts, written into this job folder.
                  </p>
                )}

                {/* Feedback & clarifications note (Part 3) - the interview-loop
                    analog of the gaps note. The draft writes it with the coach's
                    clarifying questions; answering/commenting here (its mtime then
                    beats the prep docs) flips "Refine" to ready. Same inline editor
                    as gaps; written through the same guarded PUT allowlist. */}
                {prepDocs.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                        Feedback &amp; clarifications
                      </span>
                      {job.prepFeedback && !feedbackEditing && (
                        <button
                          onClick={startFeedbackEdit}
                          className="min-h-[44px] rounded border border-[var(--color-edge)] px-2 py-1 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0"
                          aria-label="Edit interview-prep feedback"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {!job.prepFeedback ? (
                      <p className="text-[11px] leading-relaxed text-[#7a869d]">
                        No feedback note yet. Regenerate interview prep to have the coach add clarifying
                        questions you can answer - then Refine folds your answers in.
                      </p>
                    ) : feedbackEditing ? (
                      <div className="flex flex-col gap-2">
                        <Textarea
                          className="w-full text-[13px] leading-relaxed"
                          style={{ minHeight: "160px" }}
                          value={feedbackText}
                          onChange={(e) => setFeedbackText(e.target.value)}
                          aria-label="Interview-prep feedback content"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={saveFeedback}
                            disabled={feedbackSave === "saving"}
                            className="min-h-[44px] rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0"
                          >
                            {feedbackSave === "saving" ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={cancelFeedbackEdit}
                            disabled={feedbackSave === "saving"}
                            className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50 sm:min-h-0"
                          >
                            Cancel
                          </button>
                          {feedbackSave === "error" && feedbackSaveErr && (
                            <span className="text-[11px] text-rose-400">{feedbackSaveErr}</span>
                          )}
                          {feedbackSave === "saved" && <span className="text-[11px] text-emerald-400">Saved</span>}
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="mb-1.5 text-[11px] leading-relaxed text-[#7a869d]">
                          Answer the coach's questions and note anything wrong, then run{" "}
                          <strong className="text-[#9aa6bd]">Refine interview prep</strong> above to fold it in.
                        </p>
                        <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-2">
                          <MarkdownLite text={job.prepFeedback.content} />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* files - two honest behaviors per client (t-1783201094679):
                on the server's own desktop (loopback) a tap shell-opens the
                file in its native app via POST /api/open, exactly as before;
                from a remote client (phone over the tailnet) that would be a
                silent no-op HERE and a surprise window at home, so the button
                becomes a link that streams the file to THIS device through the
                guarded read-only reader (view in browser / download). */}
            {job.files.length > 0 && (
              <div className="shrink-0 border-b border-[var(--color-edge)] px-5 py-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    Files
                  </div>
                  {/* Reveal the whole job folder in the desktop's file manager -
                      the shortcut next to Files (t-1783481685241). Shown on the
                      server's own desktop ONLY (same honesty gate as the per-file
                      Open buttons below): a remote client has no local folder to
                      reveal, so opening one would just pop a surprise window at
                      home. It reaches every artifact, including any the Files
                      chips don't surface. */}
                  {isServerDesktopClient(window.location.hostname) && (
                    <button
                      onClick={() =>
                        api.openJobFolder(job.id).catch((e) => setErr(String(e.message || e)))
                      }
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[11px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0"
                      title="Open this job's folder in your file manager"
                    >
                      Open folder ↗
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {job.files.map((f) => {
                    const cls =
                      "inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0";
                    const inner = (
                      <>
                        <span className="text-[10px] uppercase text-[var(--color-muted)]">{f.ext || "file"}</span>
                        <span className="max-w-[200px] truncate">{f.name}</span>
                      </>
                    );
                    return isServerDesktopClient(window.location.hostname) ? (
                      <button
                        key={f.name}
                        onClick={() => api.openFile(job.id, f.name).catch((e) => setErr(String(e.message || e)))}
                        className={cls}
                        title={`Open ${f.name}`}
                      >
                        {inner}
                      </button>
                    ) : (
                      <a
                        key={f.name}
                        href={jobFileUrl(job.id, f.name)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cls}
                        title={`View or download ${f.name} on this device`}
                      >
                        {inner}
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Activity timeline (US-7, J3): READ-ONLY, newest-first history
                merged from this job's routine runs (the `activity` slice already
                fetched above for the Last-run badges) + its applied/deadline date
                milestones. Writes nothing; friendly empty state when a job has no
                derivable activity. */}
            <JobActivityTimeline job={job} activity={activity} />

            {/* lead-with + body + gaps */}
            <div className="shrink-0 p-5">
              {job.leadWith && (
                <div className="mb-5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-text)]">
                    Lead with
                  </div>
                  <div className="text-[13px] leading-relaxed text-[var(--color-text)]">{job.leadWith}</div>
                </div>
              )}

              {job.gaps && (
                <div className="mb-5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Gaps &amp; questions
                    </span>
                    {!gapsEditing && (
                      <button
                        onClick={startGapsEdit}
                        className="rounded px-2 py-1 text-[11px] text-[var(--color-muted)] border border-[var(--color-edge)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)] min-h-[44px]"
                        aria-label="Edit gaps and questions"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {gapsEditing ? (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        className="w-full text-[13px] leading-relaxed"
                        style={{ minHeight: "180px" }}
                        value={gapsText}
                        onChange={(e) => setGapsText(e.target.value)}
                        aria-label="Gaps and questions content"
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={saveGaps}
                          disabled={gapsSave === "saving"}
                          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]"
                        >
                          {gapsSave === "saving" ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={cancelGapsEdit}
                          disabled={gapsSave === "saving"}
                          className="rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50 min-h-[44px]"
                        >
                          Cancel
                        </button>
                        {gapsSave === "error" && gapsSaveErr && (
                          <span className="text-[11px] text-rose-400">{gapsSaveErr}</span>
                        )}
                        {gapsSave === "saved" && (
                          <span className="text-[11px] text-emerald-400">Saved</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <MarkdownLite text={job.gaps.content} />
                  )}
                </div>
              )}

              <details>
                <summary className="cursor-pointer py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] hover:text-[var(--color-text)]">
                  Full job note
                </summary>
                <div className="mt-2">
                  <MarkdownLite text={job.body} />
                </div>
              </details>
            </div>

            {/* Per-job assistant chat (Part 4), pinned to the bottom. Read-only
                assistant; a suggested action routes through runSuggested (the same
                guard as the action buttons). */}
            <JobChat jobId={job.id} onRunSuggested={runSuggested} />
          </>
        )}
      </aside>
      {/* Guarded Regenerate confirm gate (Part 1). Only ever set from a done /
          refine button above, so job is loaded here; confirming fires the same
          onRun path a plain Run would. */}
      {regenAction && job && (
        <RegenerateConfirmModal
          title={REGEN_COPY[regenAction.routine]?.title ?? "Regenerate"}
          role={job.role}
          employer={job.employer}
          body={
            REGEN_COPY[regenAction.routine]?.body ??
            "Regenerates this action's output, replacing the current version."
          }
          targets={outputTargets(regenAction.routine, job.files)}
          onConfirm={() => {
            track("run", "job-detail", regenAction.event, { journey: "J3" });
            onRun(regenAction.routine, job.id);
            setRegenAction(null);
          }}
          onCancel={() => setRegenAction(null)}
        />
      )}
    </>
  );
}
