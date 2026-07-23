import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { statusColor } from "../lib/statusColors";
import { Badge, Textarea } from "ssc-ui";
import {
  filterChatbotReports,
  latestCtoComment,
  linkChatbotCaptureToIntake,
  partitionReports,
  reportSource,
} from "../lib/chatbotQueue";
import {
  MAX_ATTACHMENTS_PER_TICKET,
  imageDisplayName,
  ingestNote as buildIngestNote,
  planFileIngest,
  uploadPendingImages,
} from "../lib/attachments";
import {
  relatedEntitiesForAssessment,
  type EntityRef,
} from "../lib/relatedEntities";
import type { Portfolio, Task, TaskType } from "../types";
import { shortcutBlockReason } from "../lib/shortcuts";
import { chatCaptureKeyDecision } from "../lib/chatCaptureKeys";
import {
  clampFabPosition,
  isDragGesture,
  parseFabPosition,
  serializeFabPosition,
  type FabPoint,
} from "../lib/fabPosition";
import { track } from "../lib/telemetry";
import { subscribe } from "../hooks/useEventStream";
import { getFocusableElements, nextTrapTarget } from "./dialogFocus";
import { RelatedChips } from "./RelatedChips";

// Global chat-capture surface (docs/chatbot-scoping.md, "Decision" + section 3):
// v1 is capture-and-delegate, ticket-first. Filing a ticket is a plain POST
// /api/tasks write (no LLM, no new endpoint); "delegate now" is opt-in per
// message and gated behind an explicit confirm step so a typo can never
// silently fire a tool-using agent. Mounted once in App.tsx so it is reachable
// from any view.
//
// Deep-link note (t-1783255872307, re-targeted for SIM-59): report rows and
// their "Related" chips navigate through App's openEntity, which now opens the
// standalone SSC Product Hub (lib/sscHub) at the specific ticket / project -
// not just the generic Tasks page. Every entity click closes this panel FIRST
// (consistent surface handoff). The chips are plain buttons, so the panel's
// dialogFocus trap picks them up automatically.

const TASK_TYPES: TaskType[] = ["bug", "feature", "chore", "spike"];
const PRIORITY_OPTIONS: NonNullable<Task["priority"]>[] = ["high", "medium", "low"];
const MAX_TITLE = 90;

// "My reports" groups open vs done (t-1783119900332): done/canceled reports
// collapse under a disclosure so the open ones read at a glance. The expanded
// state survives reloads, same best-effort localStorage idiom as the Jobs
// board/table toggle (App.tsx JOBS_VIEW_KEY) and JobTable's collapsed sections.
const SHOW_DONE_KEY = "jobhunt.chatCapture.showDone";

// Where the dragged FAB's {x,y} survives reloads (t-1783256152026). Same
// best-effort localStorage idiom as SHOW_DONE_KEY; all the parsing/clamping
// decisions live in lib/fabPosition (pure, unit-tested).
const FAB_POS_KEY = "jobhunt.chatCapture.fabPosition";

function loadFabPos(): FabPoint | null {
  try {
    const stored = parseFabPosition(window.localStorage.getItem(FAB_POS_KEY));
    // Clamp ON RESTORE: a position saved on a larger window must not strand
    // the FAB off-screen (or under the run dock) on this one.
    return stored
      ? clampFabPosition(stored, { width: window.innerWidth, height: window.innerHeight })
      : null;
  } catch {
    return null; // no/blocked storage -> the CSS default home
  }
}

function loadShowDone(): boolean {
  try {
    return window.localStorage.getItem(SHOW_DONE_KEY) === "true";
  } catch {
    return false; // collapsed by default - the open reports are the scan target
  }
}

// While the panel is open, "My reports" stays live off the shared SSE stream: a
// `tasks-changed` event (any task POST/PATCH/DELETE - the assess-ticket routine's
// comment write, a status move) triggers a refetch. This replaced a 4s poll that
// re-fetched the whole board every tick even when nothing changed. The
// subscription is torn down when the panel closes/unmounts, so a background panel
// does no work.

// Structural equality over the filtered reports so an identical refetch keeps the
// SAME array reference - otherwise every refresh minted a new array and re-rendered
// the whole panel (including the compose textarea, which lost caret/scroll). Tasks
// are plain JSON the server serializes deterministically, so a stable stringify is
// a sound, cheap deep-equal here.
function reportsEqual(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Status pill labels for the "My reports" queue - the Tasks board's column
// vocabulary (TaskBoard COL_LABEL). Kept local to this component's file lane;
// unknown statuses fall back to a title-cased form so a new status never
// renders blank. The pill COLOR always comes from the shared statusColors
// module (no raw hex in components).
const STATUS_PILL_LABEL: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

function statusLabel(status: string): string {
  return STATUS_PILL_LABEL[status] || status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// A chatbot ticket's `created` is date-only ("YYYY-MM-DD"); a comment `ts` is a
// full ISO stamp. Format both defensively - fall back to the raw string rather
// than render "Invalid Date" if the shape ever changes.
function formatCreated(created: string): string {
  if (!created) return "";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(created) ? `${created}T00:00:00` : created;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return created;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatStamp(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The assess-ticket routine is fire-and-degrade: the ticket is already queued
// before it runs, so a full concurrency cap (HTTP 429) must never block or
// error the capture flow - it becomes a soft "queued behind other runs" note.
// "unknown routine" gets friendly copy for the window before the routine is
// registered server-side; anything else surfaces honestly.
function assessNoteFor(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/too many routines/i.test(msg)) {
    return "Assessment queued behind other runs - it will start when a slot frees up. Your report is already filed.";
  }
  if (/unknown routine/i.test(msg)) {
    return "Filed. The CTO assessment will run once the assess-ticket routine is live.";
  }
  return `Filed. Assessment could not start automatically: ${msg}`;
}

// First line/sentence of the free text becomes the ticket title (per the
// capture contract in docs/chatbot-scoping.md section 3) - no LLM involved.
function deriveTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split("\n")[0].trim();
  const sentenceMatch = firstLine.match(/^(.{1,120}?[.!?])(\s|$)/);
  const candidate = sentenceMatch ? sentenceMatch[1] : firstLine;
  return candidate.length > MAX_TITLE ? `${candidate.slice(0, MAX_TITLE - 1).trimEnd()}...` : candidate;
}

// The routine isn't registered on the server yet (a parallel agent is building
// it) - "unknown routine" is today's exact failure mode for that case, so it
// gets the friendly, spec'd copy. Any other failure (e.g. the concurrency cap)
// still surfaces honestly; the ticket is queued either way.
function delegateFailureMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown routine/i.test(msg)) {
    return "Queued. Delegation will run once the work-ticket routine is live.";
  }
  return `Queued, but delegation could not start: ${msg}`;
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-[44px] items-center justify-center rounded-full border px-3 text-[12px] font-semibold capitalize transition sm:min-h-0 sm:py-1 ${
        active
          ? "border-transparent bg-[var(--color-accent)] text-white"
          : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );
}

// Per-row attribution in "My reports": who filed the report. NOT color-only -
// the text label ("You" / "QA") carries the meaning; QA gets an accent tint,
// the owner's own reports a neutral one. Same pill vocabulary as the status
// pill (rounded, 10px, uppercase, tracked) so the row reads as one system.
function ReporterBadge({ source }: { source: "you" | "qa" }) {
  const isQa = source === "qa";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isQa
          ? "border-[var(--color-accent)] text-[var(--color-accent-text)]"
          : "border-[var(--color-edge)] text-[var(--color-muted)]"
      }`}
    >
      {isQa ? "QA" : "You"}
    </span>
  );
}

type Step = "compose" | "confirm" | "done";

// An image pasted/dropped into the compose box but NOT yet uploaded (ADR-014).
// It lives ONLY in memory here until the ticket is filed - queueTicket uploads
// each one AFTER the task POST returns, so abandoning the compose (closing the
// panel) uploads nothing. `url` is an object URL for the thumbnail/lightbox
// preview and MUST be revoked when the image is removed/cleared to avoid a leak.
interface PendingImage {
  id: string; // stable React key + remove handle
  file: File; // in-memory bytes; uploaded on file, never before
  name: string; // display label sent as X-Attachment-Name
  url: string; // URL.createObjectURL(file) - revoke on cleanup
}

// The in-panel image viewer (lightbox). A VIEWER, never a download: it renders
// an <img> at large size over a dimmed backdrop. `alt` names the image for AT.
interface Lightbox {
  src: string;
  alt: string;
}

// Two views inside the one panel: compose the report, or review "My reports"
// (the queue of everything filed through here, with live status + the CTO's
// assessment). A section, per t-1783042256121 - modelled as a tab so the narrow
// (420px) drawer isn't split between a tall compose form and a growing list.
type Tab = "compose" | "reports";

type DelegateOutcome =
  | { kind: "none" }
  // assess-ticket auto-fires after "Queue it": in flight, tracked in RunPanel,
  // or softly degraded (concurrency cap / routine not yet live) - never an error.
  | { kind: "assessing" }
  | { kind: "assessed"; runId: string; label: string }
  | { kind: "delegated"; runId: string; label: string }
  | { kind: "degraded"; message: string };

export function ChatCapture({
  onRunStarted,
  onViewTasks,
  onOpenEntity,
  agentAssessmentAvailable = true,
}: {
  // Reuses the SAME run-tracking the rest of the app uses (App.tsx's
  // setActiveRun -> the one shared <RunPanel>), rather than spinning up a
  // second, parallel run-tracking UI.
  onRunStarted: (run: { runId: string; label: string }) => void;
  // Generic "open the Product Hub" (the done step's button keeps it - lands on
  // the Product tab's handoff panel).
  onViewTasks: () => void;
  // Entity deep link (t-1783255872307): App's openEntity (SSC hub handoff).
  // Report rows and "Related" chips use it to land ON the ticket / project.
  onOpenEntity: (entity: EntityRef) => void;
  // SIM-577: App.tsx's config.agentSpawnAvailable (CLAUDE_BIN_PRESENT server-
  // side) - whether this instance can spawn the assess-ticket routine at all.
  // "Queue it" auto-fires assess-ticket regardless (the ticket still files;
  // that path never touches spawn), but renderReportRow below uses this to
  // resolve the "Awaiting CTO assessment..." spinner honestly instead of
  // spinning forever when no CTO comment can ever arrive. Defaults to
  // available (optimistic) so a not-yet-loaded config never flashes the
  // unavailable copy.
  agentAssessmentAvailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Where the FAB sits (top-left px). null = never dragged, so the CSS default
  // home (bottom-6 left-6) applies. Clamped on restore, on every drag move,
  // and on window resize - it can never rest off-screen or on the run dock.
  const [fabPos, setFabPos] = useState<FabPoint | null>(loadFabPos);
  const [tab, setTab] = useState<Tab>("compose");
  const [step, setStep] = useState<Step>("compose");
  const [text, setText] = useState("");
  const [taskType, setTaskType] = useState<TaskType | "">("");
  const [priority, setPriority] = useState<Task["priority"] | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [outcome, setOutcome] = useState<DelegateOutcome>({ kind: "none" });

  // "My reports" queue + a soft note for clipboard/file ingest outcomes.
  const [reports, setReports] = useState<Task[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  // The FULL board + portfolio, kept only to derive each report's "Related"
  // chips (labels for referenced t-* ids; the epic/project charter join).
  // Same reference-stability guard as `reports` so an idle refetch never
  // re-renders the panel; the portfolio is fetched once per panel open and is
  // fail-soft (null just degrades the chips to task-only).
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  // Whether the collapsed "Done" group in "My reports" is expanded.
  const [showDone, setShowDoneState] = useState<boolean>(loadShowDone);
  const [ingestNote, setIngestNote] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Pasted/dropped images held in memory until the ticket is filed (no orphan
  // uploads); a soft amber note if some fail to attach AFTER the ticket is filed;
  // and the in-panel lightbox viewer.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // SIM-601: the FAB is only in the DOM while `!open` ({!open && <button>}
  // below), so it UNMOUNTS the moment the panel opens - the exact node
  // previouslyFocusedRef captured is gone by the time a close would restore
  // to it, and focus()-ing a detached element is a silent no-op (focus falls
  // to body instead). fabRef always points at whichever FAB node is CURRENTLY
  // mounted, so the restore effect below has a live fallback target.
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  // Mirror of pendingImages so the unmount-only cleanup can revoke every live
  // object URL without re-running (and revoking still-in-use URLs) on each edit.
  const pendingImagesRef = useRef<PendingImage[]>([]);
  // Focus restore for the nested lightbox dialog (back to the thumbnail button).
  const lightboxRef = useRef<HTMLDivElement>(null);
  const lightboxReturnFocusRef = useRef<HTMLElement | null>(null);
  // Depth counter so nested dragenter/dragleave (crossing child elements) don't
  // flicker the drop overlay off while the file is still over the panel.
  const dragDepthRef = useRef(0);
  // In-flight FAB drag gesture (null when idle). `dragging` flips once the
  // pointer travels past the click threshold; a ref so tracking never renders.
  const fabDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  } | null>(null);
  // The browser fires a click right after pointerup; after a DRAG that click
  // must not open the panel (click-vs-drag disambiguation, t-1783256152026).
  const suppressFabClickRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep the ref in sync so the unmount cleanup below sees the latest list.
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  // Revoke every remaining object URL when the component unmounts (per-image and
  // clear-all revokes happen inline in the mutators below; this catches whatever
  // is still live at teardown). Empty deps => runs only on unmount.
  useEffect(
    () => () => {
      for (const img of pendingImagesRef.current) URL.revokeObjectURL(img.url);
    },
    [],
  );

  // Drop one pending image and revoke its preview URL immediately (no leak).
  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  // Discard ALL pending images and revoke their URLs. Called on file-complete,
  // on panel close, and on reset - the no-orphan guarantee: nothing pasted into
  // an abandoned compose is ever uploaded, and no object URL is leaked.
  const clearPendingImages = useCallback(() => {
    setPendingImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.url);
      return [];
    });
  }, []);

  const openLightbox = useCallback((src: string, alt: string) => {
    setLightbox({ src, alt });
  }, []);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  // Nested-dialog focus for the lightbox: capture focus on open, move it into the
  // viewer (its close button), and restore it to the thumbnail on close - the
  // same discipline the panel itself uses for the FAB.
  useEffect(() => {
    if (lightbox) {
      lightboxReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (lightboxRef.current) getFocusableElements(lightboxRef.current)[0]?.focus();
    } else if (lightboxReturnFocusRef.current) {
      lightboxReturnFocusRef.current.focus();
      lightboxReturnFocusRef.current = null;
    }
  }, [lightbox]);

  // Telemetry: one view event whenever the capture panel opens (J1). Fires on
  // every open (FAB click or the `c` shortcut); dedupe within a session is not
  // needed for a user-initiated open.
  useEffect(() => {
    if (open) track("view", "chat-capture", "open", { journey: "J1" });
  }, [open]);

  // Re-clamp a dragged FAB position whenever the window resizes, so a saved
  // spot near an edge can never end up off-screen or under the run dock.
  // Reference-stable when nothing changes (no idle re-render).
  useEffect(() => {
    function onResize() {
      setFabPos((prev) => {
        if (!prev) return prev;
        const next = clampFabPosition(prev, { width: window.innerWidth, height: window.innerHeight });
        return next.x === prev.x && next.y === prev.y ? prev : next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --- FAB drag (t-1783256152026). Pointer events cover mouse AND touch (the
  // button is touch-none, so a touch drag moves the FAB instead of scrolling);
  // drag is pointer-only sugar - the FAB stays a plain tabbable button, and
  // Enter/Space/click still open the panel through onFabClick below. ---------

  function fabViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function onFabPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Primary mouse button only; any touch/pen contact qualifies.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    suppressFabClickRef.current = false;
    const rect = e.currentTarget.getBoundingClientRect();
    fabDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      dragging: false,
    };
    // Keep receiving moves even when a fast pointer outruns the button.
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onFabPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const s = fabDragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    // Under the ~5px threshold the gesture is still a CLICK - move nothing.
    if (!s.dragging && !isDragGesture(dx, dy)) return;
    s.dragging = true;
    setFabPos(clampFabPosition({ x: s.originX + dx, y: s.originY + dy }, fabViewport()));
  }

  function onFabPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const s = fabDragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    fabDragRef.current = null;
    if (!s.dragging) return; // a plain click - onFabClick opens the panel
    suppressFabClickRef.current = true;
    const pos = clampFabPosition(
      { x: s.originX + (e.clientX - s.startX), y: s.originY + (e.clientY - s.startY) },
      fabViewport(),
    );
    setFabPos(pos);
    try {
      window.localStorage.setItem(FAB_POS_KEY, serializeFabPosition(pos));
    } catch {
      /* best-effort persistence */
    }
  }

  function onFabPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    // Gesture taken over (scroll takeover, alt-tab, screen edge): keep the
    // last clamped position for the session but persist/suppress nothing -
    // no click event follows a cancel.
    const s = fabDragRef.current;
    if (s && e.pointerId === s.pointerId) fabDragRef.current = null;
  }

  function onFabClick() {
    if (suppressFabClickRef.current) {
      suppressFabClickRef.current = false;
      return; // the tail end of a drag, not an open request
    }
    setOpen(true);
  }

  // Focus management: capture/restore whatever had focus across open<->closed
  // transitions (the FAB, on open; back to it, on close).
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (previouslyFocusedRef.current && document.contains(previouslyFocusedRef.current)) {
      previouslyFocusedRef.current.focus();
      previouslyFocusedRef.current = null;
    } else if (fabRef.current) {
      // SIM-601: the captured element (normally the FAB) is gone - it
      // unmounted while the panel was open - so fall back to the freshly
      // re-mounted FAB rather than silently dropping focus to body.
      fabRef.current.focus();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  // Move focus to the most useful control whenever the panel opens or moves
  // to a new step (compose -> confirm -> done all swap the visible controls).
  useEffect(() => {
    if (!open) return;
    if (step === "compose") {
      textareaRef.current?.focus();
    } else if (panelRef.current) {
      getFocusableElements(panelRef.current)[0]?.focus();
    }
  }, [open, step]);

  // "c" opens the panel from anywhere (matches the app's single-letter shortcut
  // scheme - b/t/d/i/p, n=add), behind the shared guard in lib/shortcuts (inert
  // while typing, on a Ctrl/Cmd/Alt chord - Ctrl+C must copy, never open this -
  // or behind an open modal dialog); Esc closes the topmost layer (lightbox
  // over panel); Tab/Shift+Tab is trapped inside via the shared dialogFocus
  // helpers, exactly like the HubSidebar/TeamView drawers.
  //
  // WHAT each key means is the pure decision in lib/chatCaptureKeys (bug
  // t-1783145481696); this effect only does the DOM half. Two load-bearing
  // details: the listener runs in the CAPTURE phase (keydown targets are
  // focused elements/body, never window itself, so it always beats App's
  // bubble-phase global handler), and a CONSUMED key gets preventDefault +
  // stopImmediatePropagation - preventDefault alone does not stop sibling
  // window listeners, which is exactly how one Esc used to close this panel
  // AND minimize a live run panel behind it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const decision = chatCaptureKeyDecision({
        key: e.key,
        panelOpen: open,
        lightboxOpen: !!lightbox,
        blocked: !!shortcutBlockReason(e),
      });
      if (decision.action === "none") return;
      if (decision.exclusive) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      if (decision.action === "open-panel") {
        setOpen(true);
      } else if (decision.action === "close-lightbox") {
        closeLightbox();
      } else if (decision.action === "close-panel") {
        closePanel();
      } else if (decision.action === "trap-tab") {
        // The topmost dialog traps Tab: the lightbox when stacked, else the panel.
        const container = lightbox ? lightboxRef.current : panelRef.current;
        if (!container) return;
        const target = nextTrapTarget(getFocusableElements(container), document.activeElement, e.shiftKey);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, lightbox]);

  // Single fetch of the queue, guarded against a late resolve after unmount.
  // Used by the on-open load, each `tasks-changed` SSE refresh, and as an
  // immediate nudge right after a submit so the new report shows at once.
  const loadReports = useCallback(async () => {
    try {
      const data = await api.getTasks();
      if (!mountedRef.current) return;
      const next = filterChatbotReports(data.tasks);
      // Reference-equal when nothing changed, so an idle refetch does not re-render.
      setReports((prev) => (reportsEqual(prev, next) ? prev : next));
      setAllTasks((prev) => (reportsEqual(prev, data.tasks) ? prev : data.tasks));
      setReportsError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setReportsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setReportsLoading(false);
    }
  }, []);

  // Keep "My reports" live only while the panel is OPEN: load once on open, then
  // refetch on every `tasks-changed` from the shared stream. The subscription is
  // torn down on close/unmount, so a closed panel does no work.
  useEffect(() => {
    if (!open) return;
    setReportsLoading(true);
    loadReports();
    return subscribe("tasks-changed", () => loadReports());
  }, [open, loadReports]);

  // The portfolio backs the per-report project chip (epic -> charter join).
  // Fetched once per session on first open; FAIL-SOFT - a failure just leaves
  // project chips off, never an error state (the chips are an affordance).
  useEffect(() => {
    if (!open || portfolio) return;
    let alive = true;
    api
      .getPortfolio()
      .then((p) => alive && mountedRef.current && setPortfolio(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, portfolio]);

  // Soft ingest notes (empty clipboard, blocked permission, skipped binary)
  // self-dismiss so they never linger as stale state.
  useEffect(() => {
    if (!ingestNote) return;
    const t = window.setTimeout(() => setIngestNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [ingestNote]);

  // Append ingested text (clipboard button / file paste / drop) to the report,
  // separated from any existing text; clears the "describe it first" error.
  function appendText(chunk: string) {
    const clean = chunk.replace(/\r\n/g, "\n").trimEnd();
    if (!clean) return;
    setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${clean}` : clean));
    setError(null);
  }

  // Explicit "Paste" affordance (one tap; friendlier than long-press on mobile).
  // Feature-detected: where the async Clipboard API is unavailable or blocked,
  // we point the user at Ctrl/Cmd+V, which the plain textarea still handles.
  async function pasteFromClipboard() {
    if (!navigator.clipboard?.readText) {
      setIngestNote("Clipboard button isn't available here - press Ctrl/Cmd+V to paste instead.");
      textareaRef.current?.focus();
      return;
    }
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) {
        appendText(clip);
        setIngestNote(null);
      } else {
        setIngestNote("Clipboard is empty.");
      }
    } catch {
      setIngestNote("Clipboard access was blocked - press Ctrl/Cmd+V to paste instead.");
    }
    textareaRef.current?.focus();
  }

  // Classify a batch of pasted/dropped files: text-ish -> ingested as report
  // text (existing behavior); an allowlisted image within caps -> held as a
  // PENDING attachment (in memory, uploaded only when the ticket is filed);
  // anything else -> named in a soft note, not uploaded. The pure planner
  // (planFileIngest) makes every accept/reject decision against the client
  // mirror of the server caps; the server stays authoritative on upload.
  async function ingestFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;

    const remainingSlots = MAX_ATTACHMENTS_PER_TICKET - pendingImages.length;
    const plan = planFileIngest(
      list.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      remainingSlots,
    );

    // Text-ish files are read into the report (async IO, so track read failures).
    const chunks: string[] = [];
    const unreadable: string[] = [];
    for (const i of plan.text) {
      const file = list[i];
      try {
        const content = await file.text();
        chunks.push(`--- ${file.name} ---\n${content.trim()}`);
      } catch {
        unreadable.push(file.name);
      }
    }
    if (!mountedRef.current) return;
    if (chunks.length) appendText(chunks.join("\n\n"));

    // Accepted images become pending chips, each with a preview object URL.
    if (plan.images.length) {
      const additions: PendingImage[] = plan.images.map((i) => {
        const file = list[i];
        return {
          id: `pi-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          name: imageDisplayName({ name: file.name, type: file.type }),
          url: URL.createObjectURL(file),
        };
      });
      setPendingImages((prev) => [...prev, ...additions]);
    }

    setIngestNote(buildIngestNote(plan, unreadable));
    textareaRef.current?.focus();
  }

  // Clipboard paste on the textarea: intercept ONLY when files are present so we
  // can ingest them; plain text paste falls through to the native handler so
  // Ctrl/Cmd+V keeps working untouched.
  function onTextareaPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      ingestFiles(files);
    }
  }

  // Drag-and-drop onto the panel. preventDefault always (so the browser never
  // navigates away to open the dropped file). Files can be ingested whenever a
  // report is being composed (step "compose"), even from the reports tab - the
  // drop switches back to compose so the appended text is visible. Once a report
  // is submitted (confirm/done), there is nothing to attach to.
  const canIngest = step === "compose";
  const dragOverlayVisible = dragActive && tab === "compose" && step === "compose";
  function hasFiles(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes("Files");
  }
  function onPanelDragOver(e: React.DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }
  function onPanelDragEnter(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }
  function onPanelDragLeave(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }
  function onPanelDrop(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (!canIngest) {
      setIngestNote("Finish or clear the current report before attaching a file.");
      return;
    }
    setTab("compose");
    if (e.dataTransfer.files?.length) ingestFiles(e.dataTransfer.files);
  }

  // The ONE compose-form reset (t-1783371570597): clears the composed report,
  // the filed-ticket state (createdTask/outcome), and any pasted-but-unuploaded
  // images. closePanel() and fileAnother() both route through it so the reset
  // paths can never drift out of sync.
  function resetForm() {
    setText("");
    setTaskType("");
    setPriority("");
    setCreatedTask(null);
    setOutcome({ kind: "none" });
    // No-orphan: pasted images were never uploaded, so revoke their object URLs.
    clearPendingImages();
    setAttachNote(null);
  }

  function closePanel() {
    setOpen(false);
    setError(null);
    setIngestNote(null);
    setDragActive(false);
    dragDepthRef.current = 0;
    setTab("compose");
    setLightbox(null);
    if (createdTask) {
      // A ticket was ALREADY filed this session - reset the whole form so the
      // next open starts fresh. The old guard was `step === "done"`, which MISSED
      // the "Queue & delegate now" flow: that files the ticket then parks on the
      // "confirm" step, so closing there (X / Esc / backdrop) left the submitted
      // text to reappear on reopen (the exact reported bug). createdTask is
      // non-null on both "confirm" and "done", so it is the honest gate.
      resetForm();
    } else {
      // A genuinely unsent draft (nothing filed yet): PRESERVE the composed
      // text/type/priority so the owner can reopen and keep writing, but still
      // discard pasted images (never uploaded, would orphan) - the pre-existing
      // no-orphan posture.
      clearPendingImages();
      setAttachNote(null);
    }
    setStep("compose");
  }

  function fileAnother() {
    resetForm();
    setError(null);
    setIngestNote(null);
    setTab("compose");
    setStep("compose");
  }

  // Shared write path for both buttons - no LLM, straight to the existing
  // POST /api/tasks, exactly the payload the spec calls for.
  async function queueTicket(): Promise<Task | null> {
    setBusy(true);
    setError(null);
    try {
      const title = deriveTitle(text) || "Untitled report";
      const task = await api.addTask({
        title,
        detail: text.trim(),
        type: taskType === "" ? undefined : taskType,
        priority: priority === "" ? undefined : priority,
        status: "triage",
        labels: ["chatbot"],
      });
      // D1 (ADR-009): ALSO record this capture in the intake ledger and link it
      // to the spawned task, so the origin chain (request -> assessment ->
      // spawned task) is complete for in-app chatbot captures, not just
      // CTO-session prompts. Fire-and-forget + fully self-contained catch: the
      // task above is the PRIMARY capture (already filed, returned below), so
      // this ledger write is best-effort - a POST/PATCH failure is logged and
      // swallowed, never surfaced as a capture error and never able to block or
      // fail the return. Same fail-soft posture as JobDetail's activity fetch.
      void linkChatbotCaptureToIntake(text, task.id, api, (e) =>
        // eslint-disable-next-line no-console
        console.warn("chatbot intake ledger write failed (task still filed):", e),
      );
      // Upload the pasted/dropped images AFTER the task POST (they need its id),
      // FAIL-SOFT: uploadPendingImages never rejects, so a partial/total failure
      // degrades to a soft amber note and the ticket STAYS filed - the same
      // best-effort posture as the assess-ticket call and the D1 intake write
      // above. Never let an attachment failure throw out of queueTicket.
      await attachPendingImages(task.id);
      return task;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Best-effort upload of every pending image to the just-filed ticket. Clears
  // the pending list afterward (the bytes now live server-side, surfaced under
  // "My reports" via task.attachments) and, on any failure, sets a soft amber
  // note. Deliberately swallows everything - the ticket is already filed.
  async function attachPendingImages(taskId: string) {
    const total = pendingImages.length;
    if (total === 0) return;
    const { failed } = await uploadPendingImages(
      taskId,
      pendingImages.map((img) => ({ blob: img.file, name: img.name })),
      api.uploadTaskAttachment,
    );
    clearPendingImages();
    if (!mountedRef.current) return;
    if (failed === 0) {
      setAttachNote(null);
    } else if (failed === total) {
      const noun = total === 1 ? "Your image" : "None of your images";
      setAttachNote(`${noun} couldn't attach - the report was filed without ${total === 1 ? "it" : "them"}.`);
    } else {
      setAttachNote(`Some images couldn't attach - the report was filed with ${total - failed} of ${total} added.`);
    }
  }

  function validate(): boolean {
    if (!text.trim()) {
      setError("Describe the bug or request first.");
      textareaRef.current?.focus();
      return false;
    }
    return true;
  }

  // "Queue it" - primary, default, safe: files the ticket, then auto-fires the
  // COMMENT-ONLY assess-ticket routine so the CTO assesses it without a second
  // click (t-1783042256172). This is NOT the work-ticket path - no code-writing
  // agent runs here; that stays the explicit "Queue & delegate now" button.
  // The assessment call degrades gracefully: the ticket is already filed, so a
  // 429 (concurrency cap) or a not-yet-live routine becomes a soft note, never
  // an error, and never blocks the capture flow.
  async function queueOnly() {
    if (!validate()) return;
    // The primary capture action (J1). Records the action only, never the
    // report text the user typed.
    track("action", "chat-capture", "queue-it", { journey: "J1" });
    const task = await queueTicket();
    if (!task) return;
    setCreatedTask(task);
    setOutcome({ kind: "assessing" });
    setStep("done");
    loadReports(); // surface the new report in the queue immediately
    try {
      const r = await api.runRoutine("assess-ticket", task.id);
      onRunStarted({ runId: r.runId, label: r.label }); // same shared RunPanel channel
      if (mountedRef.current) setOutcome({ kind: "assessed", runId: r.runId, label: r.label });
    } catch (e) {
      if (mountedRef.current) setOutcome({ kind: "degraded", message: assessNoteFor(e) });
    }
  }

  // "Queue & delegate now" - secondary, guarded: the ticket write itself is
  // inert/safe and happens immediately, same as Queue it. Only the
  // agent-firing step (runRoutine) is gated behind the confirm screen.
  async function startQueueAndDelegate() {
    if (!validate()) return;
    const task = await queueTicket();
    if (task) {
      setCreatedTask(task);
      setStep("confirm");
    }
  }

  function cancelDelegate() {
    setOutcome({ kind: "none" });
    setStep("done");
  }

  async function confirmDelegate() {
    if (!createdTask) return;
    setBusy(true);
    try {
      const r = await api.runRoutine("work-ticket", createdTask.id);
      onRunStarted({ runId: r.runId, label: r.label });
      setOutcome({ kind: "delegated", runId: r.runId, label: r.label });
    } catch (e) {
      // Graceful degrade: the ticket is already queued regardless of this
      // outcome, so a failed delegate call never loses the report.
      setOutcome({ kind: "degraded", message: delegateFailureMessage(e) });
    } finally {
      setBusy(false);
      setStep("done");
    }
  }

  function setShowDone(next: boolean) {
    setShowDoneState(next);
    try {
      window.localStorage.setItem(SHOW_DONE_KEY, String(next));
    } catch {
      /* best-effort persistence */
    }
  }

  const triageColor = statusColor("triage");

  // Open vs done split for the reports tab - both halves keep the queue's
  // newest-first order (t-1783119900332).
  const { open: openReports, closed: doneReports } = partitionReports(reports);

  // Every entity click-through from this panel: close the overlay FIRST (the
  // deep-link target renders behind it otherwise), then navigate via App's
  // hub-focus primitive.
  function openEntityAndClose(entity: EntityRef) {
    closePanel();
    onOpenEntity(entity);
  }

  // One report row, shared by the Open list and the collapsed Done group so the
  // two sections can never drift apart in markup.
  function renderReportRow(report: Task) {
    const color = statusColor(report.status);
    const cto = latestCtoComment(report.comments);
    const source = reportSource(report);
    return (
      <li key={report.id} className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3">
        <button
          type="button"
          onClick={() => openEntityAndClose({ kind: "task", id: report.id })}
          aria-label={`Open "${report.title}" on the Tasks board`}
          className="group w-full text-left"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-[13px] font-semibold leading-snug text-[var(--color-text)] group-hover:text-[var(--color-accent-text)]">
              {report.title}
            </span>
            <Badge tone={color} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {statusLabel(report.status)}
            </Badge>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
            <ReporterBadge source={source} />
            <span>
              #{report.id} &middot; {formatCreated(report.created)}
            </span>
          </div>
        </button>

        {report.attachments && report.attachments.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.attachments.map((att, i) => {
              const src = api.taskAttachmentUrl(report.id, att.file);
              return (
                <li key={att.file}>
                  <button
                    type="button"
                    onClick={() => openLightbox(src, att.name)}
                    aria-label={`View attachment ${i + 1} on report "${report.title}"`}
                    title={att.name}
                    className="block h-14 w-14 overflow-hidden rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] transition hover:border-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {cto ? (
          <>
            <div className="mt-2 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <Badge
                  tone={statusColor("triage")}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                >
                  CTO assessment
                </Badge>
                <span className="text-[10px] text-[var(--color-muted)]">{formatStamp(cto.ts)}</span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text)]">
                {cto.body}
              </p>
            </div>
            {/* The assessed ticket, its project (charter surface), and any
                tasks/projects the assessment references - openable, not just
                readable (t-1783255872307). The comment body is the extraction
                text; each chip closes the panel first, then deep-links. */}
            <div className="mt-2">
              <RelatedChips
                entities={relatedEntitiesForAssessment({
                  ticketId: report.id,
                  text: cto.body,
                  tasks: allTasks,
                  portfolio,
                })}
                onOpen={openEntityAndClose}
              />
            </div>
          </>
        ) : agentAssessmentAvailable ? (
          <div className="mt-2 flex items-center gap-1.5 text-[11.5px] italic text-[var(--color-muted)]">
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
            />
            Awaiting CTO assessment...
          </div>
        ) : (
          // SIM-577: no CTO comment, and this instance cannot spawn assess-ticket
          // at all (agentAssessmentAvailable derived from GET /api/config's
          // agentSpawnAvailable, the same CLAUDE_BIN_PRESENT fact server-side) -
          // an honest terminal state instead of a spinner that would never
          // resolve. Ticket-scoped routines have no runner leg (deliberately
          // excluded from runner routing), so this can never self-correct.
          <div className="mt-2 rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
            Assessment runs on the laptop runner - unavailable on this instance.
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      {!open && (
        <button
          ref={fabRef}
          type="button"
          onClick={onFabClick}
          onPointerDown={onFabPointerDown}
          onPointerMove={onFabPointerMove}
          onPointerUp={onFabPointerUp}
          onPointerCancel={onFabPointerCancel}
          aria-label="Report a bug or request (opens chat capture)"
          title="Report a bug or request (c) - drag to move"
          className={`fixed z-[55] flex h-14 w-14 touch-none select-none items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow-2xl transition hover:opacity-90 ${
            fabPos ? "" : "bottom-6 left-6"
          }`}
          style={fabPos ? { left: fabPos.x, top: fabPos.y } : undefined}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {open && (
        <>
          {/* Stacking (t-1783742858526): the open panel is MODAL (backdrop +
              aria-modal), so it must sit ABOVE the non-modal run surfaces -
              the expanded RunPanel stack, run note, and UndoToast (z-[70])
              and the RunDock (z-[65]) - or a tall run panel covers the
              New report / My reports tabs. z-[71]/[72] keeps it under the
              confirm modals (z-[80]) and ShortcutHelp (z-[90]). */}
          <div className="fixed inset-0 z-[71] bg-black/50" onClick={closePanel} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Report a bug or request"
            onDragOver={onPanelDragOver}
            onDragEnter={onPanelDragEnter}
            onDragLeave={onPanelDragLeave}
            onDrop={onPanelDrop}
            className="fixed right-0 top-0 z-[72] flex h-full w-[min(420px,92vw)] flex-col overflow-hidden border-l border-[var(--color-edge)] bg-[var(--color-panel)] shadow-2xl"
          >
            {/* Drop hint - shown only while a file is dragged over the compose view. */}
            {dragOverlayVisible && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-[60] m-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-panel)]/85 text-center"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="none"
                  stroke="var(--color-accent-text)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <div className="text-[13px] font-semibold text-[var(--color-text)]">Drop images or text files</div>
                <div className="text-[11px] text-[var(--color-muted)]">Images attach to the report; .md .txt .json .csv add their text</div>
              </div>
            )}
            {/* Header */}
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--color-edge)] p-4">
              <div>
                <h2 className="text-[15px] font-semibold text-[var(--color-text)]">Report a bug or request</h2>
                <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                  Files straight into the Tasks board Triage column
                </p>
              </div>
              <button
                type="button"
                onClick={closePanel}
                aria-label="Close"
                title="Close (Esc)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                &#x2715;
              </button>
            </div>

            {/* Tabs: compose a new report, or review "My reports" (t-1783042256121).
                Both tabs stay Tab-reachable (no roving tabindex) so the panel's
                focus trap keeps working; aria-selected marks the active one. */}
            <div
              role="tablist"
              aria-label="Chat capture"
              className="flex shrink-0 gap-1 border-b border-[var(--color-edge)] px-2"
            >
              <button
                type="button"
                role="tab"
                id="chat-tab-compose"
                aria-selected={tab === "compose"}
                onClick={() => setTab("compose")}
                className={`min-h-[44px] border-b-2 px-3 text-[13px] font-medium transition sm:min-h-0 sm:py-2.5 ${
                  tab === "compose"
                    ? "border-[var(--color-accent)] text-[var(--color-text)]"
                    : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                New report
              </button>
              <button
                type="button"
                role="tab"
                id="chat-tab-reports"
                aria-selected={tab === "reports"}
                onClick={() => setTab("reports")}
                className={`inline-flex min-h-[44px] items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium transition sm:min-h-0 sm:py-2.5 ${
                  tab === "reports"
                    ? "border-[var(--color-accent)] text-[var(--color-text)]"
                    : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                My reports
                {reports.length > 0 && (
                  <span className="rounded-full bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-muted)]">
                    {reports.length}
                  </span>
                )}
              </button>
            </div>

            {tab === "compose" && step === "compose" && (
              <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="chat-capture-text"
                      className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]"
                    >
                      What&apos;s the bug or request?
                    </label>
                    <button
                      type="button"
                      onClick={pasteFromClipboard}
                      aria-label="Paste clipboard text into the report"
                      title="Paste from clipboard"
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-edge)] px-2.5 text-[12px] font-medium text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)] sm:min-h-0 sm:py-1"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="13"
                        height="13"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="3" width="6" height="4" rx="1" />
                        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                      </svg>
                      Paste
                    </button>
                  </div>
                  <Textarea
                    id="chat-capture-text"
                    ref={textareaRef}
                    rows={7}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        queueOnly();
                      }
                    }}
                    onPaste={onTextareaPaste}
                    placeholder="e.g. The Insights tab shows the wrong weekly-applied count when a job is submitted twice in one day..."
                    className="min-h-[160px] w-full flex-1 p-3 text-[13px] leading-relaxed"
                  />
                  <div className="text-[11px] text-[#7a869d]">
                    Plain language is fine - the first line becomes the ticket title. Paste or drop an image to attach it,
                    or a .md/.txt/.json/.csv file to add its text. Ctrl/Cmd+Enter queues it.
                  </div>
                  {ingestNote && (
                    <div
                      role="status"
                      className="rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]"
                    >
                      {ingestNote}
                    </div>
                  )}

                  {pendingImages.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                        Attached images ({pendingImages.length}/{MAX_ATTACHMENTS_PER_TICKET})
                      </div>
                      <ul className="flex flex-wrap gap-2.5">
                        {pendingImages.map((img, i) => (
                          <li key={img.id} className="relative">
                            <button
                              type="button"
                              onClick={() => openLightbox(img.url, img.name)}
                              aria-label={`View pasted image ${i + 1}`}
                              title={img.name}
                              className="block h-16 w-16 overflow-hidden rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] transition hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                            >
                              <img src={img.url} alt="" className="h-full w-full object-cover" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removePendingImage(img.id)}
                              aria-label={`Remove pasted image ${i + 1}`}
                              title="Remove image"
                              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] text-[12px] leading-none text-[var(--color-muted)] shadow-md transition hover:border-rose-400/60 hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                            >
                              &#x2715;
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div role="group" aria-label="Type (optional)" className="flex flex-wrap gap-1.5">
                    {TASK_TYPES.map((t) => (
                      <Chip key={t} label={t} active={taskType === t} onClick={() => setTaskType(taskType === t ? "" : t)} />
                    ))}
                  </div>
                  <div role="group" aria-label="Priority (optional)" className="flex flex-wrap gap-1.5">
                    {PRIORITY_OPTIONS.map((p) => (
                      <Chip key={p} label={p} active={priority === p} onClick={() => setPriority(priority === p ? "" : p)} />
                    ))}
                  </div>

                  {error && (
                    <div role="alert" className="text-[12px] text-rose-400">
                      {error}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--color-edge)] p-4">
                  <button
                    type="button"
                    onClick={startQueueAndDelegate}
                    disabled={busy}
                    className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-50 sm:min-h-0"
                  >
                    Queue &amp; delegate now
                  </button>
                  <button
                    type="button"
                    onClick={queueOnly}
                    disabled={busy}
                    className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0"
                  >
                    {busy ? "Queuing..." : "Queue it"}
                  </button>
                </div>
              </>
            )}

            {tab === "compose" && step === "confirm" && createdTask && (
              <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                  <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={triageColor} className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                        Triage
                      </Badge>
                      <span className="text-[11px] text-[var(--color-muted)]">#{createdTask.id}</span>
                    </div>
                    <div className="mt-1.5 text-[13px] font-semibold leading-snug text-[var(--color-text)]">
                      {createdTask.title}
                    </div>
                  </div>

                  <div
                    role="alert"
                    className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] leading-relaxed text-amber-200"
                  >
                    Delegate this ticket to the CTO now? This spawns a scoped headless Claude agent, the same channel
                    Draft and Finalize already use, with edit, write, and bash access in your vault, using this ticket
                    as its instructions. This confirmation is the guard - closing or canceling leaves the ticket
                    queued with nothing else fired.
                  </div>

                  {attachNote && (
                    <div
                      role="status"
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] leading-relaxed text-amber-200"
                    >
                      {attachNote}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--color-edge)] p-4">
                  <button
                    type="button"
                    onClick={cancelDelegate}
                    disabled={busy}
                    className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-50 sm:min-h-0"
                  >
                    Just queue it (cancel)
                  </button>
                  <button
                    type="button"
                    onClick={confirmDelegate}
                    disabled={busy}
                    className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0"
                  >
                    {busy ? "Delegating..." : "Yes, delegate now"}
                  </button>
                </div>
              </>
            )}

            {tab === "compose" && step === "done" && createdTask && (
              <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px] leading-relaxed text-emerald-200"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      className="mt-0.5 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 12.5l5 5L20 6" />
                    </svg>
                    <div>
                      <div className="font-semibold">Queued to Triage.</div>
                      <div className="mt-0.5 text-[12.5px] text-emerald-200/90">{createdTask.title}</div>
                    </div>
                  </div>

                  {attachNote && (
                    <div
                      role="status"
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] leading-relaxed text-amber-200"
                    >
                      {attachNote}
                    </div>
                  )}

                  {outcome.kind === "assessing" && (
                    <div
                      role="status"
                      className="flex items-center gap-2 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]"
                    >
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
                      />
                      Starting the CTO assessment...
                    </div>
                  )}
                  {outcome.kind === "assessed" && (
                    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3 text-[12.5px] leading-relaxed text-[var(--color-text)]">
                      The CTO is assessing this report - tracking{" "}
                      <span className="font-medium">{outcome.label}</span> in the run panel at the bottom right. Its
                      verdict will appear under this report in{" "}
                      <button
                        type="button"
                        onClick={() => setTab("reports")}
                        className="font-medium text-[var(--color-accent-text)] underline underline-offset-2 hover:opacity-90"
                      >
                        My reports
                      </button>
                      .
                    </div>
                  )}
                  {outcome.kind === "delegated" && (
                    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-2)] p-3 text-[12.5px] leading-relaxed text-[var(--color-text)]">
                      Delegated - tracking <span className="font-medium">{outcome.label}</span> in the run panel at
                      the bottom right.
                    </div>
                  )}
                  {outcome.kind === "degraded" && (
                    <div
                      role="status"
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] leading-relaxed text-amber-200"
                    >
                      {outcome.message}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--color-edge)] p-4">
                  <button
                    type="button"
                    onClick={fileAnother}
                    className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-text)] sm:min-h-0"
                  >
                    File another
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onViewTasks();
                      closePanel();
                    }}
                    className="min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0"
                  >
                    Open Product Hub
                  </button>
                  <button
                    type="button"
                    onClick={closePanel}
                    className="min-h-[44px] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 sm:min-h-0"
                  >
                    Close
                  </button>
                </div>
              </>
            )}

            {/* "My reports": everything filed through here, newest-first, with a
                live status pill and the latest CTO assessment. Read-only except
                the click-throughs: the row header deep-links to ITS ticket card
                on the Tasks board, and the "Related" chips under an assessment
                open the referenced ticket/project (all via onOpenEntity). */}
            {tab === "reports" && (
              <div
                id="chat-panel-reports"
                role="tabpanel"
                aria-labelledby="chat-tab-reports"
                className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
              >
                {reportsError ? (
                  <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] text-amber-200">
                    Could not load your reports: {reportsError}
                  </div>
                ) : reportsLoading && reports.length === 0 ? (
                  <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--color-muted)]">
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]"
                    />
                    Loading your reports...
                  </div>
                ) : reports.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="text-[13px] font-medium text-[var(--color-text)]">No reports yet</div>
                    <p className="max-w-[260px] text-[12px] leading-relaxed text-[var(--color-muted)]">
                      Anything you file from the New report tab shows up here with its live status and the CTO&apos;s
                      assessment.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab("compose")}
                      className="mt-1 min-h-[44px] rounded-md border border-[var(--color-edge)] px-3 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] sm:min-h-0 sm:py-1.5"
                    >
                      File your first report
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Open reports first, newest-first - the quick-scan target
                        (t-1783119900332). */}
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Open ({openReports.length})
                    </div>
                    {openReports.length === 0 ? (
                      <p className="py-2 text-[12px] text-[var(--color-muted)]">
                        No open reports - everything you filed is closed.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">{openReports.map((r) => renderReportRow(r))}</ul>
                    )}

                    {/* Done + canceled reports collapse under a disclosure so
                        they never crowd the open scan; each row's status pill
                        still says which terminal state it is. */}
                    {doneReports.length > 0 && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => setShowDone(!showDone)}
                          aria-expanded={showDone}
                          aria-controls="chat-reports-done"
                          className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-left text-[12px] font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-text)]"
                        >
                          <span aria-hidden="true" className="shrink-0 font-mono text-[11px]">
                            {showDone ? "▾" : "▸"}
                          </span>
                          Done ({doneReports.length})
                        </button>
                        {showDone && (
                          <ul id="chat-reports-done" className="mt-2 flex flex-col gap-2">
                            {doneReports.map((r) => renderReportRow(r))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* In-panel image viewer (lightbox). A nested dialog stacked OVER the
              panel: dimmed backdrop, close on Esc (handled in the panel keydown)
              and on backdrop click, focus-trapped + focus-restored. It is a
              VIEWER, never a download - a plain <img>, no <a download>. */}
          {lightbox && (
            <div
              ref={lightboxRef}
              role="dialog"
              aria-modal="true"
              aria-label={`Image viewer: ${lightbox.alt}`}
              onClick={closeLightbox}
              className="fixed inset-0 z-[74] flex items-center justify-center bg-black/80 p-6"
            >
              <button
                type="button"
                onClick={closeLightbox}
                aria-label="Close image viewer"
                title="Close (Esc)"
                className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-black/40 text-[18px] text-white/90 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                &#x2715;
              </button>
              <img
                src={lightbox.src}
                alt={lightbox.alt}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
