# User journeys - Jobhunt Command Center, cloud edition (QA source of truth)

> **What this is.** The canonical, executable list of every primary user journey through the
> **jobhunt-cloud** app (this repo) - the Railway-hosted, Postgres-backed cloud edition of the
> Jobhunt Command Center. It is a **test charter**: a QA engineer (the `qa-tester` agent, or a
> human) should be able to run each journey top-to-bottom against a running instance and mark
> every acceptance-criteria line pass or fail. It is **CTO-owned** and kept current every release
> (see MAINTENANCE).
>
> **What this is not.** Not marketing copy, not a design spec, not the data contract. The
> load-bearing data guarantees live in `docs/data-schema.md` §7 (`DATA_CONTRACT.md` is a pointer
> stub to it); this doc verifies they hold **from the user's seat**. The RC-4 public-demo guided
> tour (the "3-minute recruiter walk," Beats 1-3) has its own frozen spec and acceptance criteria
> in `company-os/audit/2026-07-16-rc4-demo-journey-spec.md` §6 (AC1-AC9) - that document is the
> demo-tour half of the QA bar and is **not duplicated here**; this charter covers the rest of the
> product (Jobs, Discovery, Insights, auth, chat, notifications) with the tour's own surface named
> only where the tour re-uses it.
>
> **Why this document didn't exist until now (2026-07-21, SIM-124).** This repo has **no prior
> version of this file** - `git log --all -- docs/user-journeys.md` returns nothing on any branch,
> in this repo's entire history back to its first commit (`d381f14`, "clean public extraction").
> `docs/changelog.md` nonetheless carries dozens of older entries that narrate `docs/user-journeys.md`
> being written and reconciled (J1-J12, telemetry tagging, etc.) - that prose was inherited verbatim
> from the sibling desktop app `mabrain-jobhunt` at the extraction, whose own `docs/user-journeys.md`
> is real and current for *that* app. The extraction carried the changelog's history forward but
> never carried the doc itself, and nobody authored a cloud-specific replacement afterward. Every
> claim below is read fresh off **this repo's** `src/`, `server/`, `Dockerfile`, `DEPLOYMENT.md`, and
> `docs/data-schema.md` as of 2026-07-21 - it does not assume the desktop app's journeys apply here,
> because in several places (auth, storage, demo mode, the retired in-app Product Hub) they don't.

---

## How to run this charter

1. Pick a target: **cloud staging** (`https://app-staging-67d7.up.railway.app`, `APP_MODE=demo`,
   auth **required**, WebAuthn off, sync/mirror/export/runner lanes 501) is the environment the
   cc-staging release gate walks. A **private cloud** instance (real data, `APP_MODE=real`, auth
   required, WebAuthn optional) and **local dev** (`npm run dev`, `:5180`/`:8787`, no auth by
   default) are the other two shapes this same image runs as (`DEPLOYMENT.md` "Environments").
2. Open DevTools console; **any uncaught error or unhandled promise rejection fails the journey
   it occurred in** (cross-cutting CC-CONSOLE).
3. Run each journey's steps in order. A journey **passes** only when every acceptance-criteria
   checkbox passes AND every cross-cutting criterion below holds for the screens it touches.
4. Re-run the responsive + a11y checks at a narrow (~375px) and a desktop (~1280px) width.

**The CLOUD RELEASE subset.** Every journey below is tagged **[cloud-release]** or
**[not staging-reachable]** in the index. The cc-staging QA walk (SIM-416) covers exactly the
**[cloud-release]** rows, walked against the staging URL above, no local file-bridge assumptions -
nothing in those journeys depends on the visiting machine having a filesystem, a Python
interpreter, or a `Jobs/` folder of its own. Rows marked **[not staging-reachable]** exist in the
code but cannot be exercised on a hosted instance at all (they hand off to a companion desktop app
that only resolves on the operator's own laptop) or have zero UI to test through a browser at all.

**Demo-mode deltas.** Because staging runs `APP_MODE=demo`, every journey below that behaves
differently there than on a private (real-data) cloud instance carries a **"On staging (demo
mode)"** callout. The demo posture itself (fictional seed, no real Anthropic spend on routine
runs, nightly reset, the guided tour) is `company-os/audit/2026-07-16-rc4-demo-journey-spec.md`'s
territory; callouts here are scoped to how it changes *these* journeys specifically.

**Personas.** One real end user, **Simon** ("the owner"), on the private/local instances. On the
public **demo** the persona is **a cold-traffic recruiter/hiring manager** with no account and no
context (per the RC-4 spec) - staging shares that persona for QA purposes even though it sits
behind an auth wall the public demo does not.

---

## Cross-cutting acceptance criteria (apply to EVERY journey)

**Data-contract guarantees** (`docs/data-schema.md` §7 - cite that section rather than
re-deriving; do not restate the mechanism here).
- [ ] **CC-DATA-1 No hidden egress.** DevTools Network shows no request to any host besides the
  app's own origin, with the two disclosed exceptions that never carry Simon's personal data: a
  user-clicked external posting link (new tab), and an owner-enabled Apify discovery-source run
  (§7.2.1, off by default, carries only that source's own public search query).
- [ ] **CC-DATA-2 Never auto-submits.** No UI action submits an application to an employer;
  "Submitted" is always a user-declared status change (§7.1, §7.2).
- [ ] **CC-DATA-3 Never deletes user job data.** No UI action deletes a job or a generated
  document; "removing" a job is `status: closed`. (A dev/QA ticket filed via the chatbot MAY be
  deleted - that is app-managed backlog, not job data.)
- [ ] **CC-DATA-4 Surgical writes.** A field edit changes only that field (verify one job via
  `GET /api/jobs/:id` before/after a single-field edit).
- [ ] **CC-CONSOLE** No uncaught console error or unhandled rejection during the journey.
- [ ] **CC-STATE** Loading / empty / error states each render a real state (never a blank white
  screen, never a raw stack trace or an Express HTML error page).
- [ ] **CC-ERR Clean JSON errors.** A malformed body to any `POST`/`PATCH`/`PUT` route returns
  `400 {"error":"invalid JSON body"}`; any other unhandled server error returns a clean JSON 500 -
  never a stack trace or a local filesystem path (global error middleware, `server/index.js`).
- [ ] **CC-RESP** At ~375px and ~1280px: nothing overflows the viewport horizontally except inside
  a designated scroll container (tables, kanban columns); every control stays reachable.
- [ ] **CC-A11Y-KEY** Every interactive control is reachable/operable by keyboard; drawers/dialogs
  trap Tab, close on Esc, and restore focus to the opener.
- [ ] **CC-A11Y-SR** Interactive elements are real `<button>`/`<a>`/`<input>`/`<select>` with an
  accessible name; state that is color-coded also carries text/icon meaning.
- [ ] **CC-A11Y-TOUCH** Primary touch targets are >= 44x44 CSS px at mobile widths.
- [ ] **CC-AUTH** (staging + any auth-required instance only) Every `/api/*` route 401s for an
  unauthenticated request; no page renders authenticated content before `GET /api/auth/status`
  resolves (`src/components/LoginGate.tsx`).
- [ ] **CC-DEMO** (staging + any `APP_MODE=demo` instance only) The demo banner
  ("Demo · Fictional seed data · Resets nightly") is visible on every screen; the Product tab is
  absent from the top bar; `GET /api/runner/*`, `/api/sync/*`, `/api/mirror/*`, `/api/export/*`,
  and `POST /api/agent-jobs` all answer `501` (verify at least one via DevTools Network or a direct
  fetch - there is no UI surface for any of these lanes to click through, `server/index.js` lines
  582, 722-723, 945-946, 1100-1101, 1284-1285).

---

## Journey index

| # | Journey | Cloud release? | Primary surface |
| --- | --- | --- | --- |
| J1 | Report a bug/idea via the chatbot -> triaged ticket | [cloud-release] | `ChatCapture` FAB (global) |
| J2 | Track a job through its lifecycle (Board + Table) | [cloud-release] | Jobs view |
| J3 | Open a job's detail + trigger agent actions (Draft/Finalize/etc.) | [cloud-release] | Job detail drawer + Run/Batch panels |
| J4 | Ask about this job (read-only per-job assistant) | [cloud-release, currently broken on staging - see finding] | Job detail drawer -> `JobChat` |
| J5 | Discover and pursue a new posting | [cloud-release] | Discovery view (Sources <-> Finds) |
| J6 | Notifications | [cloud-release, with a caveat - see finding] | TopBar bell |
| J7 | Read the Insights view | [cloud-release] | Insights tab |
| J8 | Log in (and out) of a private/staging instance | [cloud-release] | `LoginGate` / `LoginCard` |
| J9 | Hand off to the SSC Product Hub | [not staging-reachable] | TopBar Product tab (hidden in demo mode) |
| J10 | The guided demo tour + reset | pointer only - see `rc4-demo-journey-spec.md` §6 | `DemoBanner` / `DemoTour` |
| - | Sync / Mirror / Export / Runner lanes | [not staging-reachable - no UI, API-only] | n/a (covered by CC-DEMO + `docs/data-schema.md` §7.0.1) |

---

## J1 - Report a bug/idea via the chatbot -> triaged ticket

**Persona/goal.** Any user (Simon on a private instance; a QA tester on staging): "I noticed
something wrong or have an idea - let me file it without losing my place."

**Entry point.** A draggable floating message-bubble button (`ChatCapture.tsx`), present on every
view, position remembered across visits.

**Flow.**
1. Click the FAB -> a panel opens with a compose tab (title, type, priority, optional pasted-image
   attachments) and a **"My reports"** tab.
2. **File a report** -> a plain `POST /api/tasks` write, `status: "triage"` - no LLM call, per the
   component's own header comment. The report appears in "My reports," grouped open vs. done (done
   collapses under a disclosure), kept live via the app's SSE stream while the panel is open.
3. **Delegate now** (optional, per message) is gated behind an explicit confirm step before it
   fires a code-writing agent - a typo can never silently trigger one.
4. A report row's **"Related"** chip deep-links out via `openEntity` (`src/lib/sscHub.ts`) - see
   the J6/J9 finding below; on staging this opens `http://localhost:5185` on the tester's own
   machine, which is not the app's hosted origin.

**Acceptance criteria.**
- [ ] AC-J1-1 The FAB is reachable from every top-level view (Jobs, Discovery, Insights).
- [ ] AC-J1-2 The panel is a focus-trapped dialog; Esc closes it; focus returns to the FAB.
- [ ] AC-J1-3 Filing a report with non-blank text creates exactly one ticket (`status: triage`)
  and it appears in "My reports" without a manual refresh.
- [ ] AC-J1-4 Empty text on submit shows an inline error and files nothing.
- [ ] AC-J1-5 "Delegate now" never fires a code-writing agent without the explicit confirm step;
  Cancel leaves the ticket filed only (CC-DATA-2/3).
- [ ] AC-J1-6 A pasted/dropped allowlisted image (png/jpeg/gif/webp) attaches as a thumbnail;
  removing it before filing uploads nothing.

**On staging (demo mode).** No behavioral difference in filing/triage itself - this is a plain
DB write, not gated by `APP_MODE`. The **"Related"** deep-link out of a filed report is affected -
see the J6 finding.

---

## J2 - Track a job through its lifecycle (Board + Table)

**Persona/goal.** "See the whole pipeline, move a job through its stages, never miss a deadline."

**Entry point.** Default landing view (TopBar **Jobs**, keys `b`=board / `t`=table). Two views of
one dataset, `KanbanBoard.tsx` and `JobTable.tsx`, toggled by a segmented control; the choice
persists in `localStorage["jobhunt.jobsView"]`.

**Flow (Board).**
1. Columns follow `STATUS_ORDER`: **Lead -> Queued -> Drafted -> Ready -> Submitted -> Interview
   -> Offer**, with an **Archive** toggle revealing **Rejected** and **Closed**.
2. Dragging a card to another column applies instantly with an Undo toast, EXCEPT a move to
   **Submitted, Rejected, or Closed**, which opens a confirm modal first (`CONFIRM_STATUSES` in
   `src/App.tsx`) - these are the three high-stakes, hard-to-walk-back moves.
3. Confirming a move to Submitted stamps `applied = today` (only if unset) - the only automatic
   write a status change causes.
4. A "Needs attention" strip surfaces overdue/due-soon/stale jobs above the board/table switch, on
   both sub-views.

**Flow (Table).** Sortable/groupable columns (Role, Employer, Status, Fit, Track, Deadline,
Applied, Next action); the Status cell is a `<select>` that routes through the same confirm/instant
logic as the board.

**Acceptance criteria.**
- [ ] AC-J2-1 Board and Table render the same filtered job set; the view choice survives a reload.
- [ ] AC-J2-2 A non-terminal drag applies instantly with an Undo toast that restores the prior
  status on click.
- [ ] AC-J2-3 A move to Submitted/Rejected/Closed opens the confirm modal; Cancel/Esc writes
  nothing.
- [ ] AC-J2-4 Confirming Submitted stamps `applied = today` once, never overwriting an existing
  date on a later submit-to-submit move.
- [ ] AC-J2-5 The "Needs attention" strip renders identically on Board and Table (one shared
  computation) and disappears entirely when nothing is urgent.
- [ ] AC-J2-6 No board/table action ever submits an application or deletes a job (CC-DATA-2/3).

**On staging (demo mode).** The ~22-24 seeded jobs are distributed across every status per the
demo seed spec (`rc4-demo-journey-spec.md` §3.1) so every column and the Archive toggle have real
content to test against - no empty-board edge case to chase on this environment specifically (it
still exists as a code path; exercise it on a private instance or local dev instead). Any drag/
status-change a tester makes on staging persists until the nightly reset or a later visitor's own
edit (shared-instance caveat, same spec §3.2) - do not treat a stale card left by a prior QA pass
as a new bug without checking the reset schedule first.

**Edge / empty / error states.** No jobs -> empty-column drop targets / "No jobs match" (table,
when filtered to empty). A PATCH failure on a move reverts optimistic state on reload.

---

## J3 - Open a job's detail + trigger agent actions

**Persona/goal.** "Open one job, review its materials, and kick off drafting/finalizing - watching
the agent work."

**Entry point.** Click any job card/row. Opens `JobDetail.tsx`, a right-side drawer
(`role="dialog"`, Tab-trapped, closes on Esc/backdrop, focus restored on close).

**Flow.**
1. Drawer loads via `GET /api/jobs/:id`: header (role, employer, deadline, applied date, posting
   link), field overrides (Status/Fit/Track/Sector/Deadline/Tailoring via select; Next
   action/Posting URL via text, saved on blur), generated materials (CV, cover letter, gaps note),
   and an activity timeline.
2. Under **Agent actions**, buttons are status-derived: Draft CV + cover letter, Finalize (after
   gaps), and late-stage prep actions (Interview prep at `interview`, Offer prep at `offer`). Each
   launches `POST /api/routines/run`; the shared **Run panel** (bottom-right) tracks progress. No
   confirm dialog on Run - a human click that never submits (CC-DATA-2).
3. A regenerate on an already-produced deliverable routes through `RegenerateConfirmModal` first.
4. **Batch actions** (TopBar "Draft queued (N)" etc.) fan out the same routine over multiple jobs;
   the **Batch panel** tracks per-run progress.

**Acceptance criteria.**
- [ ] AC-J3-1 The drawer opens for the clicked job, traps focus, restores it on close.
- [ ] AC-J3-2 Each field override persists via `PATCH` and only changes that one field (CC-DATA-4).
- [ ] AC-J3-3 Draft/Finalize/prep actions each launch a run and open the Run panel; a running run
  shows an elapsed timer and a Stop control; Close hides the panel without stopping the run.
- [ ] AC-J3-4 The Agent-actions list is status-gated: Interview prep appears only at `interview`,
  Offer prep only at `offer`, and neither at any other status.
- [ ] AC-J3-5 No Run/Batch/edit action ever submits an application (CC-DATA-2); the UI's own copy
  says so ("edits files but never submits").
- [ ] AC-J3-6 A regenerate over an existing deliverable is confirm-gated first.

**On staging (demo mode).** Every agent action is a **canned replay**, never a real model call -
`server/index.js` line 3308's `DEMO_MODE` branch (`runDemoReplay`) intercepts every
`POST /api/routines/run` before it would otherwise spawn `claude`. The run panel still animates
stages/activity/cost and ends with an attached artifact; the acceptance bar for "is this
convincingly a real run, and provably not one" is `rc4-demo-journey-spec.md` AC6/§7's stopwatch
script, not this document - use that script for Draft/Finalize on staging, not the steps above in
isolation.

**Edge / empty / error states.** A run that fails shows "Run failed" + the Failed status; a launch
past the concurrency cap 429s, surfaced as a toast.

---

## J4 - Ask about this job (read-only per-job assistant)

**Persona/goal.** "Ask a question about this specific application without leaving the drawer, and
get an answer grounded in its own files."

**Entry point.** Pinned at the bottom of the job detail drawer (`JobChat.tsx`), labeled "Ask about
this job," with an in-UI disclosure: *"A read-only assistant that answers from this job's files.
It can suggest a rerun or a fix - you confirm it. It never edits or sends anything."*

**Flow.**
1. Type a question, Enter to send (Shift+Enter for a newline) -> `POST /api/jobs/:id/chat`.
2. Server builds a grounded prompt (this job's files + facts) and spawns a scoped Claude agent
   (`readOnlyAssistantArgs`): `--allowedTools Read,Glob,Grep`, a hard `--disallowedTools
   Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch`, and `--strict-mcp-config`
   (loads zero MCP servers regardless of owner config) - it can read but cannot write, execute,
   delegate, or reach the network (`docs/data-schema.md` §7.3.2, cite rather than re-derive).
3. The assistant may end its reply with `ACTION: <routine>`; if the routine is on the
   allowlist, the client renders a "Run this" button that routes through the SAME guarded
   confirm-modal path as J3's normal action buttons - nothing runs until the human clicks it.
4. Transcripts persist app-side (`store.loadChats`/`saveChats`), keyed by job id.

**Acceptance criteria.**
- [ ] AC-J4-1 The chat panel is reachable at the bottom of every job's drawer, including a job
  with no prior transcript (empty state, not a 404 - `GET /api/jobs/:id/chat` 404s only when the
  job itself does not exist).
- [ ] AC-J4-2 A sent message appends optimistically, then the server's authoritative transcript
  replaces it.
- [ ] AC-J4-3 A recommended action never runs without an explicit click on the resulting "Run
  this" button, and that click goes through the same confirm path as a normal Agent-actions
  button (CC-DATA-2).
- [ ] AC-J4-4 The assistant never proposes an action outside the allowlist (`first-draft-job`,
  `finalize-job`, `merge-application-pdf`, `interview-prep`, `interview-prep-refine`,
  `offer-prep`, `draft-follow-up`) - anything else it writes is dropped, not surfaced as a button.

**On staging (demo mode) - KNOWN DIVERGENCE, filed as a finding, not fixed in this pass.**
Unlike J3's routine-run path, `POST /api/jobs/:id/chat` has **no `APP_MODE` gate at all** -
`runReadOnlyAssistant` (`server/index.js` lines 3771-3812) unconditionally spawns the `claude`
binary in every mode, demo included. The deployed container has no such binary (`Dockerfile` never
installs a Claude CLI or sets an Anthropic key), so on staging - and on any hosted instance -
sending a message is expected to return a plain `500 {"error": "..."}` (the route's own catch
block, not a crash, so CC-ERR technically still holds) rather than a real reply. This also reads
as a live contradiction of `docs/data-schema.md` §7.0's disclosure ("No Anthropic key, no
`claude.exe`, no agent execution on the cloud instance") and of the same file's own inline design
comment on the sibling routine-run path ("DEMO MODE (design 5.2): never spawn claude.exe"), which
this second agent-spawn path was apparently never wired to. **QA action on staging:** confirm the
500 (or a working reply, if the deployment has since changed), and treat AC-J4-2/3 as **N/A on
staging** either way until this is resolved - it is a product/engineering call (add a demo-mode
canned-reply branch, gate the feature off entirely in hosted modes, or bundle a CLI), not a docs
fix.

---

## J5 - Discover and pursue a new posting

**Persona/goal.** "Triage fresh postings my sources found, and turn a good one into a tracked
lead."

**Entry point.** TopBar **Discovery** (key `d`), a **Sources <-> Finds** toggle
(`DiscoveryView.tsx`), persisted choice, default **Sources**.

**Flow.**
1. **Sources** (`SourcesConsole.tsx`) - the managed-channel grid: grouping, an "Inactive (N)"
   disclosure, source detail/create/edit drawers.
2. **Finds** (`TriageInbox.tsx`) - a three-pane master-detail (saved-views rail | list | detail).
   Saved views (New/Maybe/Pursued/All/Hidden) with live counts. Keyboard triage: J/K move the
   selection, S/M/P (Skip/Maybe/Pursue) decide and auto-advance.
3. **Pursue** creates a `queued` job and immediately launches `first-draft-job` for it
   (best-effort - a refused run still leaves the job queued and draftable from its drawer), then
   opens the new job's drawer (J3). Not undoable (it creates a job). Skip/Maybe are undo-not-
   confirm (an Undo toast).
4. A find's source chip filters the list to that source, bidirectionally with the Sources side.

**Acceptance criteria.**
- [ ] AC-J5-1 The Sources <-> Finds toggle switches modes and the choice survives a reload.
- [ ] AC-J5-2 Keyboard triage (J/K/S/M/P) works end to end and is inert while a field is focused
  or a modal is open.
- [ ] AC-J5-3 Skip/Maybe write optimistically and show an Undo toast that restores prior state.
- [ ] AC-J5-4 Pursue creates exactly one job at `queued`, launches a draft best-effort, and opens
  the drawer; it never mints a job at `submitted`/`interview`/`offer` (CC-DATA-2).
- [ ] AC-J5-5 Pursue is not undoable; Skip/Maybe are.

**On staging (demo mode).** Discovery is seeded per `rc4-demo-journey-spec.md` §3.4 - a handful of
sources + finds so the view is not blank, but this is deliberately background texture, not part of
the guided tour's 3-beat script. The `first-draft-job` fired by Pursue on staging is the same
canned replay as J3, not a real run.

---

## J6 - Notifications

**Persona/goal.** "See what needs my attention without hunting for it."

**Entry point.** `NotificationBell.tsx` / `NotificationPanel.tsx`, always mounted in the TopBar,
unread badge, SSE-driven refresh plus a 60s foreground poll fallback.

**Flow.** A pinned **"Review decisions"** banner (amber "ACT" tone, distinct from FYI events)
calls `openDecisions()` -> `openSscHub("decisions")` (`src/App.tsx` lines 214-218), which opens
`http://localhost:5185/#/decisions` in a named window.

**Acceptance criteria.**
- [ ] AC-J6-1 The bell shows an accurate unread count and refreshes on relevant events without a
  manual page reload.
- [ ] AC-J6-2 Per-type filter preferences persist across reloads.
- [ ] AC-J6-3 Clicking "Review decisions" fires the SSC-hub handoff (see the finding below for
  what "fires" means on a hosted instance).

**On staging (demo mode) - KNOWN DIVERGENCE, filed as a finding.** `demoMode` gates the TopBar
**Product tab** specifically (a documented fix, "QA BUG-3," `src/App.tsx` lines 255-262 and
`src/components/TopBar.tsx` lines 68-72: "on the PUBLIC demo that is a dead link and an
internal-infra leak, so demo mode hides the tab"). The **same class of dead link** is NOT gated
anywhere else: `openEntity`/`openDecisions` (`src/App.tsx` lines 210-218), which back this bell's
"Review decisions" banner AND every related-entity chip in `RunPanel`/`ChatCapture`
(J1's "Related" chips), call `openSscHub(...)` unconditionally in every mode - demo, private
cloud, and local dev alike. `SSC_HUB_URL = "http://localhost:5185"` is hardcoded
(`src/lib/sscHub.ts`); it can only ever resolve for someone running the companion SSC Product Hub
on the SAME machine that opened the browser tab - i.e., Simon on his own laptop against local dev.
On staging, and on any hosted private instance, a QA tester or the owner clicking "Review
decisions" or a "Related" chip opens (or fails silently to open) `localhost:5185` on **their own**
machine, not the server's - the identical dead-link/infra-leak failure mode BUG-3 was written to
prevent, reached through two doors BUG-3 did not cover. **QA action:** exercise AC-J6-3 on
staging expecting a dead/blank window, and treat that as expected-per-this-finding, not a new bug
to file separately - the underlying fix (gate `openEntity`/`openDecisions` the same way the
Product tab is gated, or make the target configurable per deployment) is a product call, not made
in this docs pass.

---

## J7 - Read the Insights view

**Persona/goal.** "See pipeline health at a glance."

**Entry point.** TopBar **Insights** (key `i`). `InsightsView.tsx`, purely prop-driven off the
already-loaded jobs list - no separate fetch, no error state of its own.

**Flow.** Stat tiles (active pipeline, applied this week vs. target, interviewing, offers), a
pipeline funnel, a velocity chart, a by-track breakdown, and the same "Needs attention" bucket set
as J2's strip.

**Acceptance criteria.**
- [ ] AC-J7-1 Every stat/chart recomputes from the current jobs (change a status on Jobs, reload,
  confirm the number moved).
- [ ] AC-J7-2 Each chart exposes a `role="img"` + full-text `aria-label` alternative for screen
  readers (bars/velocity summaries), not color/shape alone (CC-A11Y-SR).
- [ ] AC-J7-3 "Needs attention" here and the J2 strip can never disagree (one shared computation).

**On staging (demo mode).** The seeded funnel is deliberately shaped narrower at the bottom (a
believable pipeline, `rc4-demo-journey-spec.md` §3.1) - do not read a "thin" top-of-funnel bar on
staging as a bug; it is the intended seed shape.

---

## J8 - Log in (and out) of a private/staging instance

**Persona/goal.** "Get into (and safely out of) an instance that requires authentication" - this
journey has no equivalent in the sibling desktop app, which runs loopback-only with auth off by
default.

**Entry point.** `LoginGate.tsx` wraps the whole app. It probes `GET /api/auth/status` once; if
`authRequired && !authenticated`, a full-screen `LoginCard` (passphrase only) renders in place of
the app.

**Flow.**
1. Enter the passphrase -> `POST /api/auth/login`. A generic one-line error on failure (never
   server detail).
2. If the server responds `{ ok:true, webauthnRequired:true }` (WebAuthn armed, >= 2 enrolled
   passkeys), the card advances to a passkey step and fires the browser's WebAuthn prompt.
3. A session cookie (`jobhunt_sid`, HMAC-signed, 7-day TTL, no server-side session store) is set
   on success. Repeated failed attempts are rate-limited and recorded (never the attempted
   passphrase) per the SIM-386 failed-login pipeline, surfacing as a bell notification past a
   threshold.
4. **Log out** (when `authRequired`) clears the cookie via `POST /api/auth/logout`.

**Acceptance criteria.**
- [ ] AC-J8-1 An unauthenticated request to any `/api/*` route 401s (CC-AUTH); no app content
  flashes before the login card on first load.
- [ ] AC-J8-2 A correct passphrase logs in and persists the session across a reload; an incorrect
  one shows a generic error and does not reveal whether the passphrase or the account was wrong.
- [ ] AC-J8-3 A rapid burst of failed attempts is rate-limited (429) and does not crash the login
  card.
- [ ] AC-J8-4 Log out clears the session; the next `/api/*` call 401s again.

**On staging (demo mode).** Per the environment brief for this QA pass, staging runs
`JOBHUNT_AUTH=required` with `JOBHUNT_WEBAUTHN` off - so only steps 1, 3, and 4 above are
reachable; **skip the WebAuthn/passkey step (AC would be AC-J8-5 if WebAuthn were on) on staging
entirely** - it is not a gap, it is the deployment's own posture (`DEPLOYMENT.md` "WebAuthn passkey
second factor": absent/off is byte-identical to the flag never having existed). This differs from
the public RC-4 demo (a *separate*, unauthenticated deployment per the frozen tour spec's AC1/AC3)
- do not conflate the two: staging is not the public demo, and the tour spec's "zero auth prompt"
acceptance criterion does not apply to this environment.

---

## J9 - Hand off to the SSC Product Hub

> Consolidates what the sibling desktop app's charter (`mabrain-jobhunt/docs/user-journeys.md`)
> still lists as six separate journeys (J5 Tasks, J6 Projects, J7a Roadmap, J8 Intake/Team/
> Activity/Docs, J11 Usage, J12 Decisions) into one pointer here. Those six describe the SSC
> Product Hub's OWN internal surfaces, which this repo does not implement, embed, or proxy - it
> only links out to `http://localhost:5185`. **Do not re-create hub content in this doc.** If the
> hub's own internals need a QA charter, that belongs in the hub's own repo (`SSC/apps/
> product-hub`), not here.

**Persona/goal.** Simon, at his own laptop, wanting the org-management surfaces (Roadmap,
Projects, Tasks, Intake, Decisions, Team, Activity, Docs, Usage) that used to live inside this app.

**Entry point.** TopBar **Product** tab (key `p`), hidden entirely when `demoMode` is true
(`src/components/TopBar.tsx` line 158). Renders `ProductMoved.tsx`: a static card ("The Product
Hub has moved to SSC") with one outbound link.

**Acceptance criteria.**
- [ ] AC-J9-1 On a non-demo instance, the Product tab renders the handoff card and nothing else -
  no legacy board, no embedded hub content.
- [ ] AC-J9-2 On a demo instance, the Product tab is absent from the TopBar, the `p` shortcut is
  inert, and no route (including a stray `#/tasks` hash) can land the view on "product" (App.tsx
  lines 255-262, 414-417 - the documented "QA BUG-3" fix).

**Why this is [not staging-reachable].** Even where the tab IS shown (any non-demo instance), its
one action opens `http://localhost:5185` - reachable only when the visiting browser and the SSC
Hub process share a machine. On staging it is hidden per AC-J9-2 anyway. There is nothing for a
QA pass against a hosted URL to walk here beyond confirming AC-J9-2's absence.

---

## J10 - The guided demo tour + reset

**Pointer only - do not duplicate here.** The full spec, acceptance criteria (AC1-AC9), and the
qa-tester stopwatch script live in `company-os/audit/2026-07-16-rc4-demo-journey-spec.md` §6-7 (a
frozen PM+UX spec; this docs pass does not edit it). What belongs here instead: the tour is
implemented as `src/components/DemoTour.tsx` + `src/components/DemoBanner.tsx`, rendered only when
`demoMode` is true, in its own crash-isolated `ErrorBoundary` so a tour bug degrades to "no tour,"
never "no demo." On staging, walk the tour using the frozen spec's own script, not this document.

---

## Known divergences (findings for the CTO/product owner - not fixed in this pass)

Per the lane constraints for this session (docs-only; a mismatch needing a CODE fix is filed, not
fixed), the following are handed back rather than patched:

1. **J4 - "Ask about this job" has no demo-mode/hosted gate and is expected to 500 on staging.**
   `runReadOnlyAssistant` (`server/index.js` ~3771-3812) spawns the `claude` CLI unconditionally in
   every `APP_MODE`, unlike the sibling routine-run path which explicitly never does in demo mode
   (line 3308's comment: "DEMO MODE (design 5.2): never spawn claude.exe"). No Claude CLI is
   installed in the deployed image (`Dockerfile`). This also contradicts `docs/data-schema.md`
   §7.0's disclosure ("No Anthropic key, no `claude.exe`, no agent execution on the cloud
   instance"). Needs an owner/architect decision: add a demo-mode canned-reply branch (mirroring
   `runDemoReplay`), gate the feature off on any hosted deployment, or provision a CLI + key on the
   private instance and update the §7.0 disclosure to match.
2. **SSC-Hub deep links are laptop-only and ungated everywhere except the one tab BUG-3 already
   fixed.** `openEntity`/`openDecisions` (`src/App.tsx` 210-218, backing the notification bell's
   "Review decisions" banner and every related-entity chip in `RunPanel`/`ChatCapture`) call
   `openSscHub(...)` -> a hardcoded `http://localhost:5185` - in every mode, with no `demoMode` (or
   any hosted-mode) check. This is the same dead-link/internal-infra-leak class of bug the Product
   tab was explicitly gated to prevent ("QA BUG-3," `TopBar.tsx` lines 68-72), reached through two
   doors that fix did not close. Affects staging, any private hosted instance, and local dev
   whenever the SSC Hub process is not also running on the same machine.
3. **This document's own upkeep is not yet wired into the release checklist.** `DEPLOYMENT.md`
   "Cutting a release" (root file, out of this lane's `docs/` write fence) does not mention this
   charter. See MAINTENANCE below for the intended discipline; wiring it into the actual release
   checklist is a follow-up, not done in this pass.

---

## MAINTENANCE

This charter should be re-read and reconciled to the shipped code at least once per SIM release
tag (`DEPLOYMENT.md` "Cutting a release"), and any time a journey's entry surface, primary flow,
or a cross-cutting guarantee changes shape. "Reconciled" means: every journey's Flow and
Acceptance criteria still match `src/`/`server/` as read, the Journey index's cloud-release tags
are still accurate, and any newly shipped user-facing surface has a journey (or an explicit,
reasoned exclusion, as J9/J10/the four dormant lanes have here) before the next release tag ships.
A change that adds, removes, or materially changes a user-facing surface without updating this
document should be treated as failing the same discipline `docs/data-schema.md` enforces for the
data contract (§ Update policy) - this document is that surface's counterpart from the user's
seat, not the wire.
