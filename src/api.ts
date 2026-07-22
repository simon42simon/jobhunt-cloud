import type {
  ActivityRecord,
  AppConfig,
  BatchStatus,
  ChatMessage,
  DecideResult,
  DerivedSource,
  DiscoveryData,
  DiscoveryDecision,
  DocContent,
  DocSummary,
  IntakeRequest,
  Job,
  JobDetail,
  NewCommentInput,
  NewRequestInput,
  NewTaskInput,
  NotificationFeed,
  OrgData,
  Portfolio,
  RequestsData,
  Roadmap,
  RoutineRun,
  SourceInput,
  SourcesData,
  SpawnedRefs,
  Task,
  TaskAttachment,
  TaskBoardData,
  TelemetrySummary,
} from "./types";

import { notifyUnauthorized, type AuthStatus } from "./lib/authSession";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Mid-session 401 = the session cookie expired or was cleared (SIM-391):
    // flip the client back to the login gate instead of surfacing a dead-board
    // error. Only the auth-walled instance can ever 401 (auth off mounts no
    // gate), and the login route's own credential 401 does not pass through
    // here (api.login returns the raw Response).
    if (res.status === 401) notifyUnauthorized();
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// HTTP header values must be Latin1 (a ByteString); a unicode filename - and the
// vault path here is Korean - would otherwise make fetch throw when it builds
// the Headers, silently losing the attachment. The server treats
// X-Attachment-Name as a DISPLAY LABEL only (never a path), so percent-encoding
// an out-of-range name is a safe, lossless fallback that keeps the upload alive;
// a plain ASCII/Latin1 name (the common "pasted image.png" case) passes through
// untouched. CR/LF are stripped so a name can never inject a header.
function attachmentNameHeader(name: string): string {
  const oneLine = (name || "").replace(/[\r\n]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\xff]*$/.test(oneLine) ? oneLine : encodeURIComponent(oneLine);
}

export const api = {
  // ---- app auth (SIM-391; server/auth.js, ADR-024) --------------------------
  // An auth-OFF server (laptop dev, the public demo) does not register the
  // /api/auth/* routes at all, so this probe 404s there - the CALLER (LoginGate)
  // maps any failure to { authRequired:false }, which renders exactly today's
  // app. Explicit credentials:"same-origin" throughout: the httpOnly session
  // cookie must ride every auth call.
  getAuthStatus: () =>
    fetch("/api/auth/status", { credentials: "same-origin" }).then((r) => json<AuthStatus>(r)),

  // Returns the RAW Response (never json()): a 401 here is the server's
  // credential verdict on this attempt, not an expired session, and must not
  // trip the global back-to-gate hook. The gate reads res.status and maps it
  // through one pure copy rule (lib/authSession loginErrorMessage) - the body's
  // error detail is deliberately never shown.
  login: (passphrase: string) =>
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ passphrase }),
    }),

  logout: () =>
    fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  getConfig: () => fetch("/api/config").then((r) => json<AppConfig>(r)),

  getJobs: () => fetch("/api/jobs").then((r) => json<Job[]>(r)),

  getJob: (id: string) => fetch(`/api/jobs/${encodeURIComponent(id)}`).then((r) => json<JobDetail>(r)),

  // Per-job assistant chat (Part 4): read the transcript, or post a message and get
  // the assistant's reply (which may carry a suggestedAction the human confirms).
  getJobChat: (id: string) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}/chat`).then((r) => json<{ messages: ChatMessage[] }>(r)),

  // SIM-425: on demo/hosted the server gates the live assistant off (never
  // spawns the CLI) and returns { disabled, reason, messages } instead of a
  // { reply, messages } pair - the transcript comes back unchanged. Both shapes
  // are typed here so JobChat can branch on `disabled` without a cast.
  postJobChat: (id: string, message: string) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) =>
      json<{ reply: ChatMessage; messages: ChatMessage[]; disabled?: false } | { disabled: true; reason: string; messages: ChatMessage[] }>(r),
    ),

  updateJob: (id: string, updates: Partial<Record<string, string | null>>) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then((r) => json<Job>(r)),

  createJob: (data: Record<string, string>) =>
    fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => json<Job>(r)),

  openFile: (id: string, path: string) =>
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, path }),
    }).then((r) => json<{ ok: boolean }>(r)),

  // Reveal the job's own folder in the server desktop's file manager (sibling to
  // openFile, which opens one file). Only honest on the server's own desktop -
  // the drawer gates the button behind isServerDesktopClient, same as openFile.
  openJobFolder: (id: string) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}/open-folder`, { method: "POST" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  getRoadmap: () => fetch("/api/roadmap").then((r) => json<Roadmap>(r)),

  getAgents: () => fetch("/api/agents").then((r) => json<OrgData>(r)),

  getPortfolio: () => fetch("/api/portfolio").then((r) => json<Portfolio>(r)),

  // Intake ledger (ADR-009): the request -> assessment -> spawned tasks/projects
  // chain. Read-mostly; `text` is stored verbatim by the server.
  getRequests: () => fetch("/api/requests").then((r) => json<RequestsData>(r)),

  // File an intake record. Only `text` is required (non-blank); the server
  // stamps id/created/ts and defaults source to 'session'. 400s on blank text.
  addRequest: (r: NewRequestInput) =>
    fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    }).then((res) => json<IntakeRequest>(res)),

  // Set/replace the CTO assessment and/or MERGE + dedupe spawned refs onto a
  // request (spawned is unioned, never replaced, so a link is never lost). 404s
  // on an unknown id.
  updateRequest: (id: string, updates: { assessment?: string; spawned?: Partial<SpawnedRefs> }) =>
    fetch(`/api/requests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then((r) => json<IntakeRequest>(r)),

  getDocs: () => fetch("/api/docs").then((r) => json<DocSummary[]>(r)),

  // `name` is whatever GET /api/docs listed (a bare id or "routines/<id>") -
  // not just the original 3 literals; the server now serves any doc under
  // docs/. Interpolated unencoded so a "routines/<id>" name's "/" reaches the
  // server as a literal path separator (matches the server's wildcard route).
  getDoc: (name: string) =>
    fetch(`/api/doc/${name}`).then((r) => json<DocContent>(r)),

  runRoutine: (routine: string, jobId?: string) =>
    fetch("/api/routines/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routine, jobId }),
    }).then((r) => json<{ runId: string; prompt: string; label: string }>(r)),

  // 404 is TYPED here (SIM-543): the poll hook must tell "this run record does
  // not exist" (terminal - server restarted or id unknown) apart from a
  // transient network/5xx error it should keep retrying.
  getRun: (runId: string) =>
    fetch(`/api/routines/run/${runId}`).then((r) => {
      if (r.status === 404) throw Object.assign(new Error("run not found"), { runNotFound: true });
      return json<RoutineRun>(r);
    }),

  stopRun: (runId: string) =>
    fetch(`/api/routines/run/${runId}/stop`, { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),

  batchRun: (routine: string, jobIds: string[]) =>
    fetch("/api/routines/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routine, jobIds }),
    }).then((r) => json<{ batchId: string; total: number; label: string }>(r)),

  getBatch: (batchId: string) =>
    fetch(`/api/routines/batch/${batchId}`).then((r) => json<BatchStatus>(r)),

  // Fan out per-source discovery runs over every due source (replaces the
  // retired global discover-jobs sweep). batchId is null when nothing is due.
  runAllDue: () =>
    fetch("/api/discovery/run-all-due", { method: "POST" }).then((r) =>
      json<{ batchId: string | null; total: number; label: string; targets: string[] }>(r)
    ),

  getTasks: () => fetch("/api/tasks").then((r) => json<TaskBoardData>(r)),

  addTask: (t: NewTaskInput) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    }).then((r) => json<Task>(r)),

  updateTask: (id: string, updates: Partial<Task>) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then((r) => json<Task>(r)),

  deleteTask: (id: string) =>
    fetch(`/api/tasks/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  // Resolve a parked owner-decision in ONE atomic write (Decisions surface v2,
  // t-1783336697733). The server's applyTaskFields processes labels (REPLACE),
  // status, and an appended comment in a single PATCH, so a resolve can never
  // half-apply (drop the label but lose the comment). `labels` is the WHOLE
  // intended array (current minus "parked"), never a delta - see
  // lib/decisions.labelsAfterResolve / buildResolveWrite.
  resolveDecision: (id: string, body: { comment: NewCommentInput; labels: string[]; status?: string; title?: string }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Task>(r)),

  // Append ONE comment to a ticket; the server stamps ts. Comments are
  // append-only after creation (no whole-array replace exists on PATCH), so
  // history can never be rewritten or dropped through the API. 400s when
  // author/body are missing or blank.
  addTaskComment: (id: string, comment: NewCommentInput) =>
    fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    }).then((r) => json<Task>(r)),

  // Upload ONE image as RAW bytes to a ticket (ADR-014). The body is the image
  // bytes themselves (Content-Type = blob.type, e.g. "image/png"); the display
  // label rides in X-Attachment-Name. The SERVER is authoritative - it sniffs
  // the magic bytes, enforces the 5 MB / 6-per-ticket caps, de-dupes identical
  // bytes, and returns the server-computed TaskAttachment (201 new, 200 on an
  // idempotent re-paste). A guard failure (404/415/400/413/409) surfaces via
  // json()'s thrown Error, so the caller can degrade it to a soft note.
  uploadTaskAttachment: (taskId: string, blob: Blob, name: string) =>
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": blob.type,
        "X-Attachment-Name": attachmentNameHeader(name),
      },
      body: blob,
    }).then((r) => json<TaskAttachment>(r)),

  // Reader URL for an <img src> - the guarded endpoint that streams the image
  // INLINE (view, never a download). `file` is the server-generated,
  // content-addressed basename ("<sha256hex>.<ext>"); the server reconstructs
  // the on-disk path and 404s anything the task does not reference.
  taskAttachmentUrl: (taskId: string, file: string) =>
    `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(file)}`,

  // Upload ONE file into a job folder from the drawer (SIM-393 I4). Raw bytes
  // body; the file name rides URI-ENCODED in X-File-Name (headers are Latin1 -
  // encodeURIComponent keeps a unicode vault-style name lossless; the server
  // always decodes). The server is authoritative: shared name-safety rules,
  // size cap (413), demo per-job count cap (409), and INSERT-ONLY unique-name
  // derivation - the 201 body carries the ACTUAL stored name (a collision
  // lands as "<stem> (2).<ext>", never a replace).
  uploadJobFile: (jobId: string, blob: Blob, name: string) =>
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/files`, {
      method: "POST",
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(name),
      },
      body: blob,
    }).then((r) => json<{ name: string; mime: string | null; bytes: number; sha256: string }>(r)),

  getDiscovery: () => fetch("/api/discovery").then((r) => json<DiscoveryData>(r)),

  pursueDiscovery: (d: {
    title: string;
    employer: string;
    track?: string;
    fit?: string;
    sector?: string;
    deadline?: string;
    link?: string;
    // Fast path (ops audit F5, t-1783183576640): land straight in "queued"
    // instead of the default "lead". Optional + tolerant - the server
    // defaults to "lead" (today's behavior) when omitted or not "queued".
    status?: "lead" | "queued";
  }) =>
    fetch("/api/discovery/pursue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    }).then((r) => json<Job>(r)),

  // Triage a discovery find: write skip | maybe | pursue into its Decision cell.
  // Resolves { ok:false, locked:true, message } (not a throw) when Excel has the
  // workbook open, so the UI can prompt "close Excel and retry".
  decideDiscovery: (title: string, link: string, decision: DiscoveryDecision) =>
    fetch("/api/discovery/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, link, decision }),
    }).then((r) => json<DecideResult>(r)),

  // ---- Discovery Sources (Channels) v1 ------------------------------------
  // The managed-source registry with DERIVED status/counts + the honest
  // unassigned bucket. `locked`+`message` mean the workbook is open in Excel;
  // the registry still serves, so treat it as a soft note, not an error.
  getDiscoverySources: () => fetch("/api/discovery/sources").then((r) => json<SourcesData>(r)),

  // Create a source. Only `name` is required. Returns 201 with the DERIVED
  // shape. A bad enum -> 400, an explicit id collision -> 409 (both surface via
  // json()'s thrown Error so the form can show them inline).
  createSource: (input: SourceInput) =>
    fetch("/api/discovery/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<DerivedSource>(r)),

  // Patch any subset of a source's fields except `id`. `lastVisitedAt` (ISO or
  // null) is how a visit is stamped (drives newSinceVisit to 0); `lastRunAt` /
  // `runs` are server-managed and ignored if sent.
  updateSource: (id: string, input: SourceInput) =>
    fetch(`/api/discovery/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<DerivedSource>(r)),

  // Delete a source's config only; its finds are untouched (they fall back to
  // the honest unassigned bucket).
  deleteSource: (id: string) =>
    fetch(`/api/discovery/sources/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  // Per-source "Run now": launches the discover-jobs routine scoped to this one
  // source and returns { runId, source } with the source already flipped to
  // status:"running". 409 = a run is already in progress, 429 = too many
  // routines (both thrown as Error so the caller can show a soft note). Observe
  // completion by re-reading getDiscoverySources().
  runSource: (id: string) =>
    fetch(`/api/discovery/sources/${encodeURIComponent(id)}/run`, { method: "POST" }).then((r) =>
      json<{ runId: string; source: DerivedSource }>(r),
    ),

  // ---- Instruction proposals (DISC-W3) -------------------------------------
  // The owner's note + the propose-run trigger in ONE human-gated action.
  // ownerComment may be "" (a brand-new source's cold start is legitimate).
  // 404 unknown source, 409 a propose run is already in flight for this source,
  // 429 global run cap, 500 spawn failure - all thrown as Error so the drawer
  // can show a soft inline note. Deliberately does NOT stamp lastRunAt/runs[]
  // (a propose run is not a scrape - cadence health stays honest). Observe
  // progress via the served proposeRunId + the source-proposals-changed /
  // run-finished (routine "propose-instructions") stream events.
  proposeInstructions: (id: string, ownerComment: string) =>
    fetch(`/api/discovery/sources/${encodeURIComponent(id)}/instruction-proposals/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerComment }),
    }).then((r) => json<{ runId: string; ownerComment: string }>(r)),

  // Resolve ONE pending proposal - the owner's Approve / Reject-with-reason
  // click. ONE-WAY: re-resolving a resolved proposal is a 400; a reject with a
  // blank rejectionReason is a 400 (the UI gates on lib/proposals'
  // buildResolvePayload, the same rule). Returns the FULL derived source
  // (updated instructions + provenance + proposal log in one shot).
  resolveInstructionProposal: (
    id: string,
    proposalId: string,
    body: { status: "approved" } | { status: "rejected"; rejectionReason: string },
  ) =>
    fetch(
      `/api/discovery/sources/${encodeURIComponent(id)}/instruction-proposals/${encodeURIComponent(proposalId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).then((r) => json<DerivedSource>(r)),

  // Newest-first activity feed (routine runs + subagent delegations), capped ~200.
  getActivity: () => fetch("/api/activity").then((r) => json<ActivityRecord[]>(r)),

  // Overwrite a whole freeform note in a job folder. Server-RESTRICTED to the gaps
  // and job-description .md files only; the main <Role>.md stays on the surgical
  // PATCH path and can never be written here.
  writeJobFile: (id: string, name: string, content: string) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    }).then((r) => json<{ ok: boolean; name: string; bytes: number }>(r)),

  // Notification feed: newest-first, capped 50, with a running unread count and
  // the read cursor. Read-only derivation - see the Notification types.
  getNotifications: () => fetch("/api/notifications").then((r) => json<NotificationFeed>(r)),

  // Advance the read cursor so unread clears. Body forms: { ts } | { id } | {}
  // (empty = "read up to now"). Returns the new cursor.
  markNotificationsRead: (body: { ts?: string; id?: string } = {}) =>
    fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ ok: boolean; cursor: string | null }>(r)),

  // Usage-journey telemetry read model (ADR-017). Read-only aggregate; the raw
  // events are never dumped over the wire (the insights routine reads the jsonl
  // on disk). A missing file yields an empty summary, never an error.
  getTelemetrySummary: () => fetch("/api/telemetry/summary").then((r) => json<TelemetrySummary>(r)),
};
