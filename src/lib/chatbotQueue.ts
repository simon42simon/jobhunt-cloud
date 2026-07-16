import type { NewRequestInput, SpawnedRefs, Task, TaskComment } from "../types";

// Pure selectors backing ChatCapture's "My reports" queue. "My reports" is the
// union of two report sources, newest-first:
//   - "chatbot"   - filed through the chat-capture surface at creation
//                   (ChatCapture.queueTicket -> POST /api/tasks
//                   { labels: ["chatbot"] }); attributed to the owner as "You".
//   - "qa-report" - bug tickets filed by the QA tester
//                   (labels: ["qa-report","bug"]); attributed as "QA".
// reportSource() decides the per-row attribution; a ticket carrying BOTH labels
// counts as QA-filed ("qa" wins). These live in a separate, DOM-free module so
// they can be unit-tested node-env style (no React render layer exists in this
// project - see tests/statusColors.test.ts).

const CHATBOT_LABEL = "chatbot";
const QA_REPORT_LABEL = "qa-report";

// A ticket is a "my report" if it carries ANY of these labels. A Set so
// membership stays O(1) and a new report source is a one-line addition.
const REPORT_LABELS = new Set<string>([CHATBOT_LABEL, QA_REPORT_LABEL]);

// Who filed a report, for the per-row reporter badge. "qa" when the QA tester
// filed it (label "qa-report"), otherwise "you" (the owner's chatbot report).
export type ReportSource = "you" | "qa";

// `created` is a date-only string ("YYYY-MM-DD") on chatbot tickets, so it can
// only order reports to the day; ids are `t-<epochMs>`, which carry sub-day
// precision, so they break ties within a day (and give a stable order even
// when two dates are equal). Both compare newest-first.
function createdMs(created: string | undefined): number {
  if (!created) return 0;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(created) ? `${created}T00:00:00` : created;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function compareNewestFirst(a: Task, b: Task): number {
  const diff = createdMs(b.created) - createdMs(a.created);
  if (diff !== 0) return diff;
  // Larger (newer) id first; localeCompare is safe on the fixed `t-<digits>` shape.
  return (b.id || "").localeCompare(a.id || "");
}

// "My reports" - chatbot-filed AND QA-filed reports, newest-first. Does not
// mutate the input array.
export function filterChatbotReports(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => (t.labels ?? []).some((label) => REPORT_LABELS.has(label)))
    .slice()
    .sort(compareNewestFirst);
}

// Attribution for a report row. A QA-filed ticket ("qa-report") is "qa" even
// when it also carries "chatbot" - QA-filed wins; everything else is "you".
export function reportSource(task: Task): ReportSource {
  return (task.labels ?? []).includes(QA_REPORT_LABEL) ? "qa" : "you";
}

// Terminal statuses for the open/done grouping in "My reports"
// (t-1783119900332): "done" AND "canceled" both read as closed for the quick
// open-vs-done scan - the per-row status pill still names which one it is.
const CLOSED_REPORT_STATUSES = new Set<string>(["done", "canceled"]);

export function isClosedReport(task: Task): boolean {
  return CLOSED_REPORT_STATUSES.has(task.status);
}

// Split an (already newest-first) reports list into open vs closed halves,
// preserving the input order within each half - so both sections stay
// newest-first without re-sorting. Pure + DOM-free like the rest of this
// module so it unit-tests node-env style.
export function partitionReports(reports: Task[]): { open: Task[]; closed: Task[] } {
  const open: Task[] = [];
  const closed: Task[] = [];
  for (const t of reports) (isClosedReport(t) ? closed : open).push(t);
  return { open, closed };
}

// The latest CTO verdict on a ticket. The assess-ticket routine (and any manual
// CTO note) appends author:"cto" comments to the append-only log; we surface
// the last one. Returns null when there is no CTO comment yet (assessment
// still pending, or the log is empty/undefined).
export function latestCtoComment(comments: TaskComment[] | undefined): TaskComment | null {
  if (!comments) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].author === "cto") return comments[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// D1 (ADR-009): a chatbot capture writes its OWN intake record, so the origin
// chain (request -> assessment -> spawned task) is complete for in-app captures
// too, not just CTO-session prompts. These three pure, DOM-free units back that
// side-write; kept here with the other chatbot selectors so they unit-test
// node-env style (no React render layer exists in this project - see
// tests/statusColors.test.ts).
// ---------------------------------------------------------------------------

// POST /api/requests payload for an in-app chatbot capture. `source: "chatbot"`
// is the origin marker the ledger already models (the only two sources are
// "session" | "chatbot"), matching every chatbot row already in
// docs/requests.yaml. `text` is the verbatim ask - the same text the task's
// `detail` carries - stored byte-for-byte by the server (validated non-blank,
// never trimmed of content). Server stamps id/created/ts.
export function buildChatbotRequestInput(text: string): NewRequestInput {
  return { text: text.trim(), source: "chatbot" };
}

// PATCH /api/requests/:id payload that links a freshly-filed request to the task
// it spawned, using the SpawnedRefs shape (`spawned.tasks`). This is the same
// request -> task edge every existing ledger row uses; the server MERGES +
// dedupes spawned refs, so the link is never lost and re-linking is idempotent.
// A task carries no reverse `origin_request` field (only a Project does), so
// this one-way spawned edge is the whole data model for a task's origin link.
export function buildTaskSpawnLink(taskId: string): { spawned: Partial<SpawnedRefs> } {
  return { spawned: { tasks: [taskId] } };
}

// The minimal ledger-write surface `linkChatbotCaptureToIntake` needs - a
// structural subset of `api` (api.addRequest / api.updateRequest satisfy it), so
// the orchestration can be injected with mocks and unit-tested without a DOM or
// a live fetch.
export interface IntakeLedgerWriter {
  addRequest: (input: NewRequestInput) => Promise<{ id: string }>;
  updateRequest: (id: string, updates: { spawned?: Partial<SpawnedRefs> }) => Promise<unknown>;
}

// Mirror a chatbot capture into the intake ledger and link it to the spawned
// task, as ONE pure, injectable unit. FAIL-SOFT by contract: the task is the
// PRIMARY capture (already filed by the caller before this runs), so any
// rejection from addRequest/updateRequest is swallowed - handed to `onError` for
// logging - and the returned promise NEVER rejects. That non-throwing guarantee
// is what lets the caller fire this without awaiting and be sure it can never
// break (or even perturb) task creation. Resolves the new request id on success,
// or null when the ledger write failed; the caller ignores the result. Mirrors
// the fail-soft posture of JobDetail's telemetry activity fetch
// (api.getActivity().catch(() => {})).
export async function linkChatbotCaptureToIntake(
  askText: string,
  taskId: string,
  writer: IntakeLedgerWriter,
  onError?: (err: unknown) => void,
): Promise<string | null> {
  try {
    const request = await writer.addRequest(buildChatbotRequestInput(askText));
    await writer.updateRequest(request.id, buildTaskSpawnLink(taskId));
    return request.id;
  } catch (err) {
    onError?.(err);
    return null;
  }
}
