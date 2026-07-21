# Changelog

All notable changes to the Jobhunt Command Center are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com); versions are semantic-ish (pre-1.0 while the surface settles). Newest first. Each entry is timestamped `version - YYYY-MM-DD HH:MM ET`.

Every shippable change gets an entry. Categories: **Added**, **Changed**, **Security**, **Fixed**, **Removed**.

---

## [Unreleased]

### Security
- **Per-IP write rate limit on the public demo (SIM-388).** The demo is intentionally writable with auth OFF; the SIM-392 load probe showed its write verbs were an unthrottled anonymous write surface. `createDemoWriteLimiter` (mirrors the login limiter) now caps anonymous writes at ~60/min/IP with a pinned 429 JSON body, env-overridable (`JOBHUNT_DEMO_WRITE_RATELIMIT_MAX` / `_WINDOW_MS`); reads are never limited or counted. Mounted on `/api` in DEMO mode only — real instances mount nothing (their writes sit behind the auth gate), proven by a 100-POST flood regression. Mirror of `mabrain-jobhunt` `22084e0`.

### Fixed
- **Demo polish batch (SIM-390, items 1–5).** Item 1 (this repo only): the run panel (z-70) opened OVER the Beat-3 callout and buried its "Finish tour" control — the callout now re-anchors onto the run panel itself once the invited click opens it, placed beside/above the panel (lifted over its z-index in the clamped phone geometry) with narration that matches the open panel. Items 2–5 (mirror of `mabrain-jobhunt` `9c3be5e`): canned Draft/Finalize replays name the actual job, not "Demo/Operations Analyst.md" (JSON-escaped substitution); `GET /api/config` declares `sse:false` on pg so the client never burns a doomed EventSource (fail-open for older servers); `GET /api/jobs/:id/chat` goes through `getJobSummary` — 200 + empty for a chat-less job on PgStore, 404 only when the job is missing; the seed carries discovery run history + 8 fictional finds (demo-mode `readDiscovery` branch) and applied dates in the current two weeks, all anchored to the boot/reset `refDate` (deterministic per calendar day, hermetic fixed anchor in tests).
- **Test infra guardian addendum (mirror of `f0e5f95`).** `REQUIRE_EMBEDDED_PG=1` turns an embedded-Postgres provisioning failure into a hard suite failure instead of a silent skip; CI sets it on the check step so the PG legs can never go vacuously green. name-safety rejects Windows trailing dot/space aliasing and `CONIN$`/`CONOUT$`.

### Added
- **Export snapshot lane, shipped DORMANT (SIM-393 I5).** The server half: a read-only `/api/export/*` surface under a new `exportAuth` (`EXPORT_TOKEN_HASH` sha256 verify-only, constant-time, per-IP failure rate-limit → 429, failures feeding SIM-386 as `surface:"export"`, mounted before the cookie gate, 401 anonymous, 501 unconfigured/demo) with **GET-only enforced as middleware** (405 on any other verb; the one sanctioned non-GET is the bounded `POST /api/export/runs` report line — GC-2's detection signal, the mirror-runs precedent). Gap-fill reads added only where no token-authed API served a domain: meta/manifest/raw job detail/guarded file reader/tasks/requests/chats/notify-state/sources/activity/telemetry/attachment blobs — each a thin wrapper over an existing store read. The laptop half: `ops/export-snapshot.mjs` pulls the ENTIRE dataset into the FileStore layout (byte-faithful `<Role>.md` reconstruction verified against the manifest rowSha, companion files re-hashed against the manifest sha256, all app-managed domains, attachments) + `snapshot-manifest.json` (per-file sha256, counts, app version, timestamp) + a `VERIFIED` marker written ONLY after the re-fetch verification pass exact-matches the bytes on disk — an unverified snapshot exits non-zero and is never certified. **GC-1 (HIGH):** every cloud-supplied name passes the shared `server/name-safety.js` + `resolveInside`-the-snapshot-root containment CLIENT-SIDE before any write; hostile-manifest fixtures prove refusal with zero filesystem effect. **GC-6:** the pinned-host redirect-refusing outbound posture is literally reused from the mirror client (`createApi`). **GC-7:** `--prune` refuses without owner-set `retention.keep`, always protects the newest VERIFIED snapshot, never touches unverified ones, wired into no schedule; ship default keep-everything. **GC-3:** demo boot-refusal extended to `EXPORT_TOKEN(_HASH)`. Cross-auth matrix extended per the I6 landing-check carried condition: EXPORT_TOKEN 401s every sync AND mirror route (incl. the dual-credential manifest); SYNC/MIRROR/RUNNER tokens 401 every export route; no token passes the cookie gate. Snapshots land append-only in `%SSC_ROOT%\data\jobhunt\cloud-snapshots\<UTC-ts>\` (data zone, outside OneDrive by design; zone index/log updated). §7.0.1 export-half disclosure + schema change-log row 8 ride this same wave (GC-5). Without `EXPORT_TOKEN_HASH` every export route answers 501; activation stays gated on token provisioning GO + the landing-time guardian check.
- **Drawer upload (SIM-393 I4).** `POST /api/jobs/:id/files` behind the EXISTING session cookie wall (guardian W4 — not a token lane): raw-bytes body, URI-encoded `x-file-name` header, every name through the shared `server/name-safety.js` rules. INSERT-ONLY via the new `addJobFileUnique` store method on BOTH backends (deliberately not `saveJobArtifact`, which upserts): a name collision derives a `"<stem> (2).<ext>"` sibling — `wx`-exclusive create on FileStore, `on conflict do nothing` + row-count on PgStore — and returns the ACTUAL stored name in the 201 body; existing bytes can never be replaced. `sha256` populated like every `job_files` write path; uploads serve only through the guarded reader. Caps per guardian **GC-4**: real instance 15 MB (`UPLOAD_FILE_MAX_BYTES` env-overridable); DEMO instance ≤ 1 MB AND a per-job count cap of 6 (`ATTACHMENT_MAX_COUNT` precedent) via the pure `resolveUploadPolicy` — a mis-set env can never raise the demo ceiling. Drawer UI gains a minimal Upload affordance on the Files list (renders on fileless jobs too); refresh rides the existing jobs-changed/refetch flow. Tests: 413 cap, hostile-name refusal sweep (incl. a literal control byte), sibling derivation never replaces, anonymous 401 + sync-token 401 with auth on, GC-4 demo caps end-to-end on embedded PG, differential File/Pg store contract.
- **Cloud→vault MIRROR lane, shipped DORMANT (SIM-393 I6).** The server half: `GET /api/mirror/changes` long-poll trigger channel (~25s hold, frames carry only `{seq, changed, ts}` — never names or paths, guardian GC-10), a raw job-detail read (`GET /api/mirror/jobs/:id`, new `mirrorJobDetail` store method on both backends) and a mirror-tokened guarded file reader, all under a new `mirrorAuth` (`MIRROR_TOKEN_HASH` sha256 verify, constant-time, per-IP failure rate-limit, SIM-386 failed-auth feed, mounted before the cookie gate); `GET /api/sync/manifest` accepts the mirror token as its diff source (the one shared route, GC-9 scope: jobs-domain GET-only + the bounded `POST /api/mirror/runs` pass report). The laptop half: `ops/mirror-vault.mjs` — standing outbound long-poll with reconnect/backoff (GC-6 pinned-host redirect-refusing posture re-asserted per request), ≥5s debounce, hourly safety-net sweep, 15s manifest-poll fallback; V2-3 write semantics in full (three-way sha check / overwrite-own-writes-only, adoption pass + one-time transition report, exclusive `wx` creates, case-collision safety, cache-loss degradation to adoption — GC-8; shared `name-safety.js` + `resolveInside` containment on every cloud-supplied name — GC-1; atomic temp+rename; **no delete path, proven structurally and behaviorally**); state/log/lock in `%LOCALAPPDATA%\ssc\` only (GC-13). Demo boot-refusal extended to `MIRROR_TOKEN(_HASH)` (GC-3). §7.0.1 mirror-half disclosure lands same-wave (GC-5/GC-11). Without `MIRROR_TOKEN_HASH` every mirror route answers 501; ACTIVATION stays gated on token provisioning GO + the landing-time guardian check + the GC-11 decision-log record. Gate: `company-os/audit/2026-07-18-sim393-v24-mirror-delta-review.md` (GREEN-WITH-CONDITIONS, GC-8..GC-13).
- **Failed-login visibility (SIM-386).** With auth on, every failed login (bad passphrase and rate-limited 429s) is recorded to stdout and as a durable `kind:"auth"` activity-log line (field-whitelisted — never credential material), with a once-per-window threshold bell notification and a session-gated `GET /api/auth/failed-logins`. Durable writes are bounded per the guardian condition (cap 20 lines + 1 alert per window; the in-memory count stays exact; stdout sampled beyond the cap). Auth-off deployments are byte-identical no-ops.
- **Vault→cloud sync ingest surface, shipped DORMANT (SIM-393 I1).** `/api/sync/*` bearer-token lane (separate least-privilege token, verify-only sha256 hash server-side), insert-only store semantics on both backends, shared `server/name-safety.js` validator, migration `0003_job_files_sha256` (ordering fixed: ALTER via `pgm.db.query`, re-runnable). Without `SYNC_TOKEN_HASH` in the env every sync route answers `501 sync is not configured` before touching anything; demo mode boot-refuses any sync token material.

### Security
- Deploy record — **2026-07-18 ~01:35 ET, demo instance (`app-production-d8f5`)**: exactly `79827bc` (detached checkout) deployed via `railway up` to jobhunt-demo, deployment `caf20236`, owner GO recorded in-session after the desk ask with QA evidence (`company-os/audit/2026-07-18-demo-qa-79827bc.md`, GO — no Critical/High). Post-deploy verify: `/healthz` 200; SIM-388 limiter live (70 anon POSTs → 60× 201 + 429s, `ratelimit-limit: 60`); demo reset 200 → seed texture live (3 sources with run history, 23-job funnel, probe junk wiped); `GET /api/config` `sse:false`; served bundle carries the Beat-3 `run-panel` anchor + "Finish tour" strings. Residual: 60-second owner eyes-on of Beat 3.
- Deploy record — **2026-07-18 ~01:38 ET, private instance (`app-production-62c9`)**: rc-tail `be49857` (SIM-394 WebAuthn mirror flag-OFF `bb99408` + SIM-393 I6 mirror lane `4c2cc44`, both guardian-gated GREEN) deployed via `railway up` under the recorded flag-off GO, deployment `54cc7290`. At-deploy checks: `/healthz` 200; migration `0004_webauthn_credentials` applied in deploy log; `JOBHUNT_WEBAUTHN` absent in env (flag-off posture, auth-status body carries no webauthn key); anon 401 on all `/api/*` incl. webauthn routes (cookie gate); 2 deliberate bad-passphrase logins → 401 generic (no oracle; visible in the owner bell, closing SIM-386's D1 leg on next login); sync AND mirror surfaces 501 dormant (no `SYNC_TOKEN`/`MIRROR_TOKEN` material exists anywhere). WebAuthn activation ([SIMON] enroll ≥2 passkeys + flag flip) and mirror-lane activation (MIRROR_TOKEN GO, GC-11 record on file) remain separately gated.
- Deploy record — **2026-07-17 ~01:45 ET, private instance (`app-production-62c9`)**: mirror commit `7dc15e2` (= `mabrain-jobhunt` `f98009e`) deployed via `railway up` under the guardian gate `company-os/audit/2026-07-17-sim386-failed-login-visibility-review.md` ("Deploy-gate re-check" — GREEN, owner GO recorded). Evidence: migration 0003 applied in deploy logs; `/healthz` 200; anon `/api/jobs` 401; bad-passphrase login 401 with `ratelimit-limit: 10` / window 900s (2026-07-16 baseline held); anon `/api/auth/failed-logins` 401; anon `/api/sync/manifest` 501 (lane dormant); `JOBHUNT_TRUST_PROXY=1` confirmed; no `SYNC_TOKEN`/`SYNC_TOKEN_HASH` on either instance. Demo instance not redeployed (services are CLI-deployed, not GitHub-wired). Authed `GET /api/auth/failed-logins` → 200 leg deferred to the owner's next login.

## [0.38.2] - 2026-07-21 02:22 ET

GATE 2 fix release for the cc-staging staging lane. The v0.38.1 QA walk (FAIL/NO-GO) surfaced five bugs; all fixed here — re-QA + same-image promote follow (SIM-403).

### Fixed
- **Demo Draft replay attaches the artifacts it promises (SIM-422).** The canned "Draft CV + cover letter" replay ended claiming the materials were ready while the drawer FILES stayed empty and the job stayed Queued. `runDemoReplay`'s `finish()` now attaches the pre-baked fictional CV + cover letter (new `fictionalDraftArtifacts()` in `demo/replay.mjs`) before advancing, so the drawer shows them and the job auto-advances queued→drafted. Verified E2E against the embedded Postgres.
- **Per-job "Ask about this job" chat degrades honestly on hosted (SIM-425).** `runReadOnlyAssistant` shelled to a `claude` CLI absent from the cloud image → a 500 on any hosted deployment. The chat route now gates on `DEMO_MODE` (mirroring `launchRun`) and returns an honest disabled state (`{disabled, reason, messages}`); the client renders a disabled compose state. No more 500 on demo/hosted.
- **SSC-Hub deep links no longer render dead localhost URLs on hosted surfaces (SIM-426).** The notification-bell "Review decisions" banner and related-entity chips hardcoded `http://localhost:5185` in every mode. Hub links now resolve from config (`/api/config` `sscHubUrl`, null on hosted) and are a hard no-op when unset — all three doors closed.
- **Demo CTA carries all three real links (SIM-423).** Banner + tour-close CTA now render CV · GitHub · LinkedIn from one shared source (`src/lib/demoLinks.ts`, no drift). The CV is served by the app itself at `/cv/simon-kim-cv.pdf` (a static `public/cv/` → `dist/cv/` asset, host-agnostic on staging + prod) — a phone-stripped public variant; LinkedIn points at the real profile.
- **Demo seed Hero A activity ordering made plausible (SIM-424).** "Finalized" no longer dates after "Applied"; activity is derived from each job's own finalize date with a fixed gap (bounded per-group schedule), guarded by an invariant test that no activity lands after the anchor day.

## [0.38.1] - 2026-07-14 04:35 ET

Hotfix for v0.38.0's built-serve activation (PH5 / SIM-66 incident fix).

### Fixed
- **`start-app.cmd`'s channel selector no longer breaks the board.** v0.38.0's selector used a deeply-nested cmd `if`/`errorlevel` block with literal `(...)` inside `set "CHANNEL=…"` values; that failed to parse at runtime, so start-app exited (0xFF) **before binding :5180/:8787** — a ~15-min board outage during the promote (postmortem: `company-os/audit/2026-07-14-ph5-promote-incident.md`). Replaced with a flat `:choose_channel` subroutine (goto-based, no nested blocks, no parens in channel values), **isolation-tested across all five channel cases** (built / no-dist / old-server / no-vite / no-package.json). Built-serve now activates correctly: stable serves the built `dist/` when present + supported, else the dev server so :5180 always binds (rollback-safe).

## [0.38.0] - 2026-07-14 03:43 ET

Build/release/run separation (PH5 / SIM-66 / RFC v2-007): the stable channel serves BUILT assets — no dev tooling in the always-on serving path.

> **Correction (see v0.38.1):** the built *server* shipped correctly here, but this version's `start-app.cmd` *activation* had a cmd-parse bug that broke the board on promote. Until v0.38.1 the board served via the dev channel; v0.38.1 is what actually delivers built-serve.

### Added
- **Built-serve mode (`JOBHUNT_SERVE_BUILT=1`).** In stable, Express serves the `vite build` output (`dist/`) statically with an SPA fallback AND the `/api` routes, listening on both the UI port (5180) and the API port (8787) — one process, no Vite, no `concurrently`. External board-API consumers (product-hub on `:8787`) are unaffected. Dev channel is byte-for-byte unchanged (flag unset → the built-serve block stays dormant; suites verified: 89 files / 1497 tests green).

### Changed
- **`promote-stable` is now build → verify → swap:** the promote runs `vite build` in the stable worktree and fails loudly if `dist/index.html` is absent, so a promoted tag always ships a real bundle (kills the npm-ci-while-serving class). **`start-app.cmd`** stable branch runs `node server/index.js` (built) when `dist\` exists **and** the checked-out server supports built-serve; otherwise it serves via the dev server so `:5180` always binds — rollback to any pre-PH5 tag is safe by construction.
- **Path-portability straggler (PH4 / criterion-2):** `weekly-enablement-review.cmd` no longer hardcodes `C:\Usersyou` (repo `cd` + data-zone path derive from script location / `%SSC_ROOT%`; CLI + agents dir via `%USERPROFILE%`).

Rollback: re-promote `v0.37.0` — `start-app.cmd` auto-serves it via the dev server (that tag has no built-serve support), so the board stays up.

## [0.37.0] - 2026-07-13 21:20 ET

Product-Hub Half B (SIM-59): the legacy in-app hub is retired for good; Job-Hunt is a job-search app again.

### Removed
- **The embedded Product Hub (21 components, −7,731 lines).** `ProductMoved` is now the permanent Product-tab content (no "show legacy" fallback); the 18 hub views + 3 orphans they alone reached are deleted; `MarkdownLite` kept (job views use it); `progressValueText` relocated to `src/lib/roadmapDerive.ts`. Rollback: tag `pre-halfB`.

### Added
- **EntityRef→SSC-hub deep links (`src/lib/sscHub.ts`).** Related-entity chips and the bell's "Review decisions" now open the SSC Product Hub (`:5185`) at the right page/ticket in one reused named window. The hub side gained a hash router (`#/tasks/<id>`, `#/projects/<id>`, `#/<page>`) — shipped in the SSC repo, live-verified.

### Changed
- **`docs/user-journeys.md` rewritten to post-Half-B reality** (J5/J6/J7a/J8/J11/J12 + index/personas; QA bug t-1783742967367): board/hub work is charted on the `:5185` surface; cutover gaps named as follow-ons, not silent failures.
- **Deployment glue derives paths from script location (PH3/SIM-54):** `start-app.cmd` (MAIN/STABLE/data-zone via `%~dp0`), `promote-stable.ps1` (SSC_ROOT-aware), `.claude/settings.json` hooks now relative. Zero hardcoded roots in live jobhunt scripts.
- Test suite reconciled (pinned contracts rewritten, not dropped): 89 files / 1497 tests green.

## [0.36.1] - 2026-07-13 17:35 ET

External-audit R1 fix (independent auditor, 2026-07-13): the check gate guards again.

### Fixed
- **Test suites no longer depend on live board data (audit R1).** The ten server suites that copied `docs/` silently relied on the live untracked stores living there — v0.36.0's data-zone move broke 31 tests across 6 suites AFTER the gate had run, leaving the pushed branch red. All ten suites now overlay **committed synthetic fixtures** (`tests/fixtures/board/`, built by `ops/scripts/build-test-fixtures.mjs`); the two consistency suites' live-data guards read the data zone via `resolveDataDir`. Full gate green: 89 files / 1526 tests. Side effects: the suite is clone-clean for the first time, and personal career data leaves the test path entirely.
- **Stale data-location claims swept (audit R2):** root `CLAUDE.md` hard rule 3, `root-layout.md` (data zone LIVE + jobhunt handle-with-care), `watchdog.ps1` header comment — all now name `data\jobhunt`.

## [0.36.0] - 2026-07-13 17:30 ET

The code/data split (RFC v2-006 Phase 3, SIM-58 — closes SIM-52 + SIM-38): live board data leaves the git working tree for good.

### Changed
- **Live app data moved out of the repo (ADR-023).** The six machine-written stores (`tasks.yaml`, `requests.yaml`, `activity-log.jsonl`, `usage-telemetry.jsonl`, `notify-state.json`, `job-chats.json`) and `attachments/` now live at `C:\Usersyou\ssc-brain\data\jobhunt` — resolved by the new `DATA_DIR` seam (`JOBHUNT_DATA_DIR` env → test-mode follows `JOBHUNT_DOCS_DIR` so suites stay hermetic → committed `config.json` `dataDir` → `docs/` back-compat). No git operation can ever touch the live board again — the fleet's last data-loss vector closes. Standalone ops scripts (`activity-log-append.mjs`, `delegation-append.mjs`, `activity-log-lint.mjs`) share the rule via `resolveDataDir` (`server/lib.js`); the weekly enablement cron prompt repointed. Markdown docs and the tracked ledgers (`roadmap.yaml`, `portfolio.yaml`, `agents.yaml`, `discovery-sources.yaml`) deliberately stay in `docs/`. Migration executed app-stopped, hash-verified per file; the dated OneDrive board backup repointed at the data zone. (`server/index.js` DATA_DIR + 7 store constants, `server/lib.js` `resolveDataDir`, `config.json` `dataDir`; schema doc re-versioned v6.)
- **P1/P4 doc splits (shipped earlier this branch, recorded here for the cut):** the product ADR log moved to `docs/product-decisions.md`; `docs/operating-model.md` renamed `docs/product-process.md`; frozen kernel copies reduced to pointers (RFC v2-006 H2).

## [0.35.0] - 2026-07-10 04:39 ET

Live agent-run visibility, a more decisive Pursue, and the new `ready` status. Agent actions now stream real milestones, a determinate progress bar, and a live "what the agent is doing right now" caption instead of an opaque multi-minute "Working…" sweep; **Pursue** becomes one decisive queue-and-draft action; a finalized job auto-advances to a new `ready` ("finalized, ready to submit") status; and a "Merge PDF into one file" convenience combines the rendered cover letter and CV into one submission-ready document. Every agent launch also sheds a 3-second stdin stall, and the job drawer gains an "Open folder" shortcut. Release gate green at 87 files / 1507 tests / tsc clean / activity-log lint pass.

### Added
- **Agent actions now show LIVE progress: milestones, a real progress bar, and what the agent is doing right now (ticket `t-1783650926662`).** The owner's ask: runs felt slow and opaque ("Working..." + a sweep for 4+ minutes). The routine runner now spawns the CLI with `--output-format stream-json --verbose` and folds the agent's own event stream into the run record AS IT HAPPENS (`server/index.js` NDJSON pump + pure parsers in `server/lib.js`: `agentEventToUpdate` / `describeToolUse` / `matchRunStage`): the polled record carries a live transcript (assistant text + one `> Reading resume.yaml`-style line per tool call), `currentActivity`, a per-routine milestone index (`stages`/`stageIndex` - first-draft-job and finalize-job declare their recipe's 5 phases, detected from the agent's real tool calls, forward-only and display-only), `expectedMs` (the median of the last 8 successful durations of that routine, seeded from the activity log's paired start/close lines and updated as runs close - only successes feed it), and finish `stats` (duration / turns / cost from the terminal `result` event). The RunPanel renders it: a DETERMINATE progress bar (time estimate capped at 97%, floored by milestone progress; the old indeterminate sweep only when neither signal exists), `elapsed / ~expected` clock, the milestone checklist (done / spinning / pending), the live activity as the caption, and "Completed in 4m 05s · 23 turns · $1.37" on finish; the dock chip tooltip carries the live activity. Graceful degradation is explicit: a non-JSON line (CLI warning, future CLI) passes through verbatim, an unrecognized-events run still gets the success result text appended, so output can never end up emptier than the old text mode. Real CLI event shapes verified live against `claude -p ... --output-format stream-json`. (`src/types.ts` `RoutineRun`+`RunStats`, `src/components/RunPanel.tsx`, `src/components/RunDock.tsx`; +9 tests `tests/run-progress.test.js`, drift-guard update in `tests/time.test.ts`.)

- **"Merge PDF into one file" agent action (ticket `t-1783650792067`).** An OPTIONAL post-finalize convenience on the job drawer that combines the rendered cover letter + CV PDFs into one submission-ready PDF, cover letter first - never a required pipeline stage (it gates nothing and advances no status). The action is DERIVED-gated, not status-gated: it surfaces only when the job's new `mergePdfReady` flag says both current rendered PDFs exist (dated history copies excluded; the PDFs render at finalize-job, so it can never appear before there is something to merge), and a current merged PDF flips `mergedPdfDone` so the button becomes the guarded "Regenerate merged application PDF". The heavy lifting is a NEW deterministic vault script, `ops/scripts/merge_application_pdf.py`: it refuses ambiguous inputs (two current CV PDFs is a hard error, never a guess), writes `Simon Kim - Application - <Role>.pdf` (a name that matches neither the "cv" nor "cover" artifact scans, so it cannot masquerade as a source), self-verifies the merged page count equals cover + CV, uses `\\?\` extended-length paths against the deep OneDrive vault (MAX_PATH), and survives a cp1252 console printing the non-ASCII vault path. The routine (`merge-application-pdf`, scope job) is bound to the application-writer per ADR-015 at sonnet/medium (running one self-verifying script is zero-judgment mechanical work, the draft-follow-up tier, not the employer-facing opus/high) and is chatbot-suggestable (`CHAT_SUGGESTABLE` + the assistant prompt's action menu). Wired end-to-end: `server/index.js` (ROUTINES, `toJob` flags), `src/types.ts`, `src/lib/agentActions.ts` (pure gate), `src/components/JobDetail.tsx` (drawer + done state), the SSC roster `owns` list; +6 tests (`tests/agent-actions.test.ts` gate/compose/labels, `tests/routine-agents.test.js` binding + tier intent locks).

- **A `ready` job status - "finalized, ready to submit" (ticket `t-1783481509014`).** The owner's headline ask: "when I run Finalize and it succeeds, it should be `ready`." A new status now sits between `drafted` and `submitted`, and the server advances a job there automatically when a `finalize-job` run succeeds - the finalize twin of the existing `queued -> drafted` advance after a Draft run (`nextStatusAfterRun`, `server/lib.js`). The advance is evidence-backed (finalize can only *launch* on a `finalizeReady` job, so exit-0 proves it finalized a real, gaps-answered draft), forward, pre-submission, idempotent (fires only while still `drafted`), and never submits. This resolves the "finalized stage" that ADR-022 deliberately deferred pending exactly this product decision. The status is wired end-to-end: `Status` union + `STATUS_ORDER`/`STATUS_LABEL`/`ACTIVE_STATUSES`/`PRE_SUBMISSION_ACTIVE`/`STATUS_INFO` (`src/lib/constants.ts`), the server `STATUSES` whitelist, an AA-vetted board/table accent (teal `#2dd4bf`, unique among pipeline hues, `src/lib/statusColors.ts`), the Kanban board column, the Insights funnel, `deriveNextAction` ("Submit application"), and the deadline auto-close set (`ready` is pre-submission, so a passed deadline still closes it). New + updated tests across `tests/status-automation.test.js`, `tests/finalize-queue.test.js` (an end-to-end run-close -> `ready` assertion through the real batch path), `tests/auto-close.test.js`, `tests/jobPresets.test.ts`, `tests/utils.test.ts`, `tests/api.test.js`.

- **An "Open folder" shortcut on the job drawer reveals the whole job folder in the desktop's file manager (ticket `t-1783481685241`).** A button next to the Files list opens the job's CONTAINING folder in Explorer / Finder so the owner can see every artifact at once and reach files the Files chips don't surface - the folder-level sibling to the existing per-file Open buttons. New `POST /api/jobs/:id/open-folder` (`server/index.js`), guarded by the same `resolveJobFolder` id -> path containment + existence gate (a traversal or unknown id 404s before any shell-open) and building an `execFile` argv via `buildOpenCommand` (never a shell string, so a folder name with shell metacharacters is passed verbatim as one arg). It is a local shell-open, honest only on the server's own desktop, so the drawer shows the button on loopback only (`isServerDesktopClient`) - a remote client has no local folder to reveal. +3 guard tests (`tests/job-open-folder.test.js`; the argv is pinned by `buildOpenCommand` in `tests/lib.test.js`). (`src/api.ts`, `src/components/JobDetail.tsx`.)

### Changed
- **Pursue is now one decisive action - queue + draft (ticket `t-1783655444456`).** The owner's ask: clicking **Pursue** in the discovery queue should move the find to **Queued** AND run the first agent action (draft the documents). It previously only minted a job - at `lead` by default, or `queued` for a strong-fit find (the PR #10 fast path) - and then waited for a separate Draft click. Now every pursued find, whatever its Fit, lands straight at **`queued`** and the client immediately launches `first-draft-job` for it (registered in the run dock); the queued -> drafted auto-advance (`nextStatusAfterRun`) then completes the pipeline once the run lands, so one click walks a find from discovery to a drafted CV + cover letter. The draft launch is **best-effort**: a refused run (429 run cap, offline) leaves the job in `queued` and draftable from its drawer, never failing the pursue. Safety posture is unchanged - `first-draft-job` writes draft files into the job folder only, never submits, nothing leaves the machine. The old fit-dependent status split and its `pursueTargetStatus` helper are retired; the button now reads **"Pursue → Draft"** on both surfaces. The behavior is centralized in a new shared `pursueFind` (`src/lib/pursue.ts`) used by BOTH the Triage inbox (`src/components/TriageInbox.tsx`) and the source drawer's Leads tab (`src/components/SourceDetailDrawer.tsx` via `src/components/SourcesConsole.tsx`), so the two pursue paths can never drift. Docs reconciled (`docs/job-status-lifecycle-sop.md` §Pursue box + §5 queued + §6 automation invariant, `docs/user-journeys.md` J4 step 5 + AC-J4-5). +5 tests (`tests/pursue.test.ts` queue-always / auto-draft / best-effort / link-passthrough; `tests/triage-pursue.test.ts` rewritten to the new label).
- **The "Ready to submit" quick-view now filters the `ready` status, matching its label.** It previously filtered `drafted + finalizeReady` - which is "ready to *finalize*", a different stage the label never matched (part of the "status/tags are all over the place" the owner flagged). The finalize-ready set is still surfaced by the "Finalize ready (N)" batch button, the board Finalize strip, and the card/table "ready to finalize" chip. (`src/lib/jobPresets.ts`.)
- **The status lifecycle SOP and the canonical trigger/impact table now tell the truth about the automatic advances.** `docs/job-status-lifecycle-sop.md`, `docs/blueprint.md` §4.4, and `docs/data-schema.md` §7.1 were stale - they described "drafted" as set by the agent and claimed the pipeline had "only two automatic writes," omitting the ADR-022 `queued -> drafted` run-completion advance entirely. All three now document both server advances (`queued -> drafted`, `drafted -> ready`) as evidence-backed, forward, pre-submission writes, add the `ready` stage, and correct the auto-close set to the full pre-submission list. `STATUS_INFO`, blueprint §4.4, and the SOP stay mirrors (SOP §6).

### Fixed
- **Every agent launch no longer stalls 3 seconds waiting on stdin (ticket `t-1783650926662`).** Both CLI spawn sites - the routine runner AND the per-job chat assistant - left stdin an open pipe, so the CLI waited 3s for piped input that never comes and printed the "no stdin data received in 3s" warning the owner screenshotted into every run's output. Both spawns now pass `stdio: ["ignore", "pipe", "pipe"]` (the prompt travels via `-p`): the stall and the warning are gone - a flat 3s off every routine run and every chat reply. The remaining run time is the deliberate part: draft/finalize runs are pinned to Opus at high effort for employer-facing quality (ADR-015 addendum), and a run is a real multi-step job (read posting + facts, tailor, run the render script, verify, update the job file). Guarded by `tests/run-progress.test.js` (spawn opts assert the ignored stdin).

## [0.34.0] - 2026-07-07 20:18 ET

Deep-linkable job side-view URLs plus an owner standing directive to the QA routine. Opening a job's side-view drawer now reflects in the URL and any such URL reopens the same drawer, with browser Back/Forward driving open/close; separately, the QA pass's browser-selection rule was rewritten to pick the verification browser by loopback reachability instead of by identity, ending the recurring live-DOM-verify parking. Release gate green at 80 files / 1449 tests / tsc clean / activity-log lint pass. Committed and tagged LOCALLY only - not pushed (the secret-in-history incident is owner-gated).

### Added
- **Deep-linkable job side-view URLs (`#/jobs/<id>`).** Opening a job's side-view drawer now reflects in the URL, and loading / refreshing / sharing that URL reopens the same drawer, with browser Back / Forward driving open/close - Linear / Jira / Notion parity (the owner's explicit parked ask, ticket `t-1783371156974`). It extends the existing dependency-free hash router (which already owned `#/tasks/<id>`) rather than adding a second navigation mechanism: one identifier scheme, no new dependency. `src/lib/router.ts`'s `Route` becomes a discriminated union (`TasksRoute | JobsRoute`); `parseRoute` owns `#/jobs[/<id>]` with the same percent-decode + torn-escape tolerance as tasks, and a new `jobsHash()` mirrors `tasksHash()`. `src/App.tsx` now DERIVES the open-drawer id from the route (single source of truth, so history drives it) instead of a parallel `useState`; every open path (board card, table row, needs-attention strip, discovery pursue, create) navigates via `jobsHash(id)`, and Esc / close push the bare board hash. `src/components/ProductHub.tsx` guards its route reads by page so the union stays type-safe. +15 tests (`tests/router.test.ts`), fail-before proven (the suite previously asserted `#/jobs/j-1 -> null`). A job id is the human-readable folder name, so it appears in the local address bar (unlike opaque task ids) - this stays within the never-leaves-the-machine (no external network) data contract and matches the owner's existing posture (folder names and `tasks.yaml` are already on a private remote); flagged for security-privacy-guardian if opaque tokens are ever preferred. (Committed `7bbc58a` since v0.33.0.)

### Changed
- **The QA pass routine selects its verification browser by LOOPBACK REACHABILITY, not by identity (owner standing directive 2026-07-07).** `docs/routines/qa-pass.md`'s browser rule changed from "land on the owner's PERSONAL Chrome / never the maplearmor work browser, and halt-and-ask if only maplearmor is connected" to: drive whichever connected Chrome can reach `http://127.0.0.1:<port>`. The managed "maplearmor" work browser is policy-locked off loopback, so it self-excludes automatically - which satisfies the never-drive-the-work-browser rule with zero identity-guessing. If NO connected browser reaches loopback, QA falls back to the static code audit SILENTLY (no halt-and-ask), and "which Chrome is personal" is never parked as an owner-decision - the owner permanently deprioritized that criterion. This ends the recurring live-DOM-verify parking caused by ambiguous / shifting Chrome labels. Routine-doc change only; no product code or behavior change.

## [0.33.0] - 2026-07-07 16:58 ET

Three ready units bundled so the owner needs only one promote: the owner Decisions inbox gains a readable detail drawer and its full action set; discovery stops recording a posting whose application deadline has already passed; and a new owner-facing Job status lifecycle SOP spells out what every Status change writes and fires. A live-board test baseline was also tightened after the usage-telemetry project's four tasks were backfilled and linked. Release gate green at 80 files / 1434 tests / tsc clean / activity-log lint pass. Committed and tagged LOCALLY only - not pushed (the secret-in-history incident is owner-gated).

### Changed
- **The owner Decisions inbox now reads in full and acts in one place.** Opening a parked owner-decision shows a roomy detail drawer that renders EVERY prose section (question, context, options, recommendation, how-to-resolve) at full length, fixing a parser bug where a multi-line OPTIONS entry was silently truncated (the "OPTIONS not fully shown" case). The full disposition set is first-class via a shared `DecisionActionBar` with progressive disclosure: **Approve recommended** (one click, the recommendation pre-selected), **choose a specific option** (A/B/C), **Defer** (persists across a refresh), and a new **Dismiss** that closes a decision without acting on any option (status `canceled`, drops the `parked` label and strips the `[PARKED]` marker, undoable via the existing resolve Undo window). The card keeps two primary buttons plus a More menu; the drawer lays every action out inline. (`src/components/DecisionsView.tsx`, `src/lib/decisions.ts`; +7 unit tests in `tests/decisions.test.ts`.)

### Fixed
- **Discovery no longer records a posting whose application deadline has already passed** (ticket `t-1783422051088`; the owner saw expired postings, e.g. Ontario Public Service careers, surfaced and fetched into the queue). Root cause: `discovery.py cmd_add` - the single write path every caller funnels through (the scout's manual `add` and the app's Apify importer) - deduped finds but never checked the deadline, so a posting already expired at run time sailed straight in. `cmd_prune` only sweeps rows that expire *after* being added, so it never caught an already-dead find. The fix guards the write path itself: `cmd_add` now skips a find whose Deadline is a real `YYYY-MM-DD` strictly before today (prints `SKIP (deadline passed): …`, writes nothing), using the same rule as `cmd_prune` / the app's auto-close - free-text ("rolling") and blank deadlines are never judged, and a deadline of *today* is still live. Because every caller goes through `cmd_add`, this is authoritative for the scout and the deterministic Apify path alike. Belt-and-suspenders: the server's `mapApifyDataset` now drops+counts an expired item before write (so the Apify honesty counters land it in `filteredOut`, not a silent skip), the source-scoped scout prompt (`buildSourceDiscoveryPrompt`) instructs the scout to skip a visibly-expired posting up front, and the shared past-deadline rule was extracted to `isExpiredDeadline` in `server/lib.js` (reused by `shouldAutoClose`) so "past deadline" means the same thing for a tracked Job and a fresh find. Data fixed: ran `discovery.py prune`, archiving 2 stale expired-and-untracked rows to the Archive sheet (pursued / already-tracked expired rows are preserved by design). New tests: `isExpiredDeadline` boundaries (`tests/auto-close.test.js`), the `mapApifyDataset` expired-drop plus an end-to-end "expired never written, counted in filteredOut" run assertion (`tests/discovery-apify.test.js`), and the prompt-wording guard (`tests/discovery-sources.test.js`).

### Added
- **Owner-facing Job status lifecycle SOP (`docs/job-status-lifecycle-sop.md`).** A step-by-step answer to "when I change a job's Status, what actually happens?" - what gets written (a surgical one-line frontmatter edit), which side effects fire (only two automatic writes in the whole pipeline: stamping `applied = today` when a job first reaches `submitted`, and the daily deadline auto-close), whether an agent runs (never - a status change only gates which action buttons the drawer offers), and where each surface shows a confirm popup. It is the job-pipeline twin of `docs/task-lifecycle-sop.md` and mirrors the canonical trigger/impact table in `docs/blueprint.md` section 4.4 and `STATUS_INFO` (`src/lib/constants.ts`); blueprint section 4.4 gained a pointer to it, and it is registered in the in-app Docs viewer under Product (`DOC_GROUP_BY_NAME`, `server/index.js`).

## [0.32.0] - 2026-07-07 11:52 ET

Owner-decisions inbox data-integrity hardening plus a security redaction. The Decisions inbox now reads ONE tolerant canonical signal, so a parked owner-decision can no longer be silently dropped; the Defer acknowledgment survives a refresh; two new deterministic integrity guards and two ADRs (020, 021) lock the invariants into the gate. A leaked Apify API token was redacted from the board data file (rotation is owner-gated). Release gate green at 80 files / 1427 tests / tsc clean / activity-log lint pass. Committed and tagged LOCALLY only - not pushed (the secret-in-history incident is owner-gated).

### Fixed
- **The Decisions inbox no longer silently drops a parked owner-decision (ADR-020).** `isParkedForOwner` used to require BOTH the `owner-decision` AND `parked` labels; a ticket filed with `owner-decision` + a `[PARKED]` title but missing the `parked` label was dropped from the inbox (the live contacts/referrals US-9 and Apify decisions were lost this way - the owner saw 2 waiting when ~3 were open). The predicate is now a tolerant UNION that fails OPEN: a ticket is parked for the owner iff it is non-terminal AND (`parked` label OR title starts `[PARKED]`). `owner-decision` is demoted to a permanent, greppable classification. (`src/lib/decisions.ts`, unit-covered in `tests/decisions.test.ts`.)
- **The "Deferred {date}" chip survives a refresh.** The defer acknowledgment lived only in ephemeral React state, so after a reload it vanished and the deferral looked lost - the owner re-clicked Defer and one live ticket accumulated four identical defer comments. The chip is now DERIVED from the persisted `Owner deferred on <date>` comment (`latestDeferredOn`), the write that always persisted. No new store.

### Changed
- **Resolving a decision now clears BOTH park signals.** `buildResolveWrite` drops the `parked` label (as before) AND strips the leading `[PARKED] ` title marker, so a resolved-but-still-open (`todo`) decision leaves the union inbox. (`src/lib/decisions.ts`, `src/hooks/useTasks.ts`, and `src/api.ts` carry the optional `title` field.)
- **The parking convention names `parked` as load-bearing.** The autonomous-session skill now files a parked owner-decision with the `parked` label AND a `[PARKED]` title prefix, and documents that `computeParkedConsistency` catches drift between the two.

### Added
- **Two deterministic, read-only integrity guards (`server/lib.js`).** `computeParkedConsistency` (ADR-020) flags any non-terminal `[PARKED]`-titled ticket missing the `parked` label; `computeProjectTaskConsistency` (ADR-021) flags a `done` project with zero or unfinished linked tasks, and surfaces genuine route breakage (dangling project/milestone refs, orphan milestones). Both are pinned by tests that run against the live board (`tests/parked-consistency.test.js`, `tests/project-task-consistency.test.js`), so drift goes red in the gate. ADR-020 and ADR-021 are recorded in `docs/governance.md`.

### Security
- **Redacted a leaked Apify API token from `docs/tasks.yaml`.** The live token had been pasted in plaintext as an owner comment; it is now a self-documenting placeholder (the ticket and all other data preserved, nothing deleted). The app already reads the token ENV-ONLY (`APIFY_TOKEN`, ADR-019) - never a data file or `config.json`. The same token remains in COMMITTED git history on a private `origin`; per the open incident, rotation and any history rewrite are OWNER-gated (parked ticket `t-1783438583907`) and were deliberately NOT performed here - this release commits the redaction LOCALLY and does not push or rewrite history.

## [0.31.0] - 2026-07-07 03:12 ET

Live job-drawer refetch: opening a job, clicking one of its Agent actions (Draft / Finalize / Interview prep / …) and waiting for the run to finish now updates the drawer in place — the action button flips to Done / Regenerate, the Last-run badge appears, and the freshly written CV / cover-letter / prep files show up — without closing and reopening the drawer. Authored alongside the v0.30.0 preset-filter work (ticket `t-1783390990670`) but left out of that selective commit; shipped here on its own. Release gate green at 78 files / 1401 tests / tsc clean / activity-log lint pass.

### Fixed
- **The job detail drawer no longer goes stale after its own routine run finishes.** The drawer used to load its job + activity exactly once on open and never again, so a completed Agent action left it showing the pre-run state (button never flipped to Done/Regenerate, no Last-run badge, new output files hidden) until you closed and reopened it — reading as "the action button doesn't update." It now subscribes to the shared app-wide `run-finished` SSE stream (the same one the board rides) and re-pulls the job + activity when the finished run is this job's own, gated by a pure, unit-tested `isRunForJob` predicate so another job's run or a ticket-scoped run never churns the open drawer. Refetch is best-effort: a transient failure leaves the last-good view in place, never an error state. New `src/components/JobDetail.tsx` wiring (`useEventSubscription`) + `tests/job-detail-refetch.test.ts` (5 unit tests for the gate).

## [0.30.0] - 2026-07-06 22:55 ET

Jobs preset filters: one-click quick-view tabs on the board and table, so 94 jobs narrow to the subset that needs action, with a deadline-focused view front and center. Built by frontend-engineer from a feature-from-research pass (`docs/proposals/2026-07-06-jobs-preset-filters-design.md`) after a movement-history review showed all 4 of the day's applications went out on their deadline date with the app's own finalize gate unmet. Release gate green at 78 files / 1401 tests / tsc clean / activity-log lint pass.

### Added
- **One-click preset "quick view" tabs above the Jobs list (board and table).** A horizontally-scrollable tablist (All, Needs attention, Overdue, Due soon, Ready to submit, Follow up due, Interview), each with a live count. The attention and deadline presets reuse the same `computeNeedsAttention` predicates as the NeedsAttentionStrip, so a preset count can never drift from the strip it sits under. New pure `src/lib/jobPresets.ts` (`filterByPreset` + `presetCounts`, 15 unit tests) and `src/components/JobPresets.tsx` (role=tablist, roving tabindex with arrow/Home/End keys, 44px touch targets). `App.tsx` applies the preset FIRST in the shared `filtered` set (so board and table narrow together), persists the choice in localStorage, and fires a `preset:<key>` usage-telemetry event (which also closes the zero-filter-events gap the same review found).

## [0.29.0] - 2026-07-06 20:55 ET

Interview-prep consistency check: the job drawer now flags when a prep sheet cites a STAR story the bank never defines, so a broken or contradictory answer is caught before the interview. First feature shipped from the 2026-07-06 interview-coaching design (`docs/proposals/2026-07-06-interview-coaching-feature-design.md`); the Mock Interview Drill Runner and the cross-job Story Bank are chartered as backlog tickets for a delegated build. Release gate green at 76 files / 1383 tests / tsc clean / activity-log lint pass.

### Added
- **Interview-prep consistency check (read-only) in the job drawer.** `computeInterviewConsistency` (`server/lib.js`) cross-references the prep sheet's STAR-story citations against the STAR bank and surfaces findings in `GET /api/jobs/:id` (`consistency`), rendered as a band at the top of the JobDetail Interview prep section. A story the prep sheet cites that the bank never defines is a hard flag (the classic `-> Story G` that was never written); an uncited bank story, or a missing `application-content.json`, is advisory. Deterministic and high-precision (case-sensitive `Story X`, so `STAR stories` / `story bank` never phantom-match), purely derived from files the endpoint already reads, with no vault writes and nothing leaving the machine. Verified live on `Jobs/CRM Coordinator - York University`, where it flags the real Story G dangling citation.

## [0.28.1] - 2026-07-06 23:29 ET

Phase B (SSC OS extraction) handoff: the in-app Product hub now defers to the standalone SSC Product Hub. The product-dev command center (Roadmap, Projects, Tasks, Intake, Decisions, Team, Activity, Knowledge) was relocated to its own app at `SSC/apps/product-hub` (http://localhost:5185), reading this same board over its API. Release gate green at 75 files / 1375 tests / tsc clean / activity-log lint pass.

### Changed
- **The Product tab hands off to the SSC Product Hub.** Opening Product (the tab or the `p` shortcut) now shows a "moved to SSC" panel linking to the standalone hub at http://localhost:5185; the full in-app hub stays available via a "Show legacy hub" fallback until the dedicated OS-extraction migration retires it (SSC ADR-000/001). No board data or API changed - the legacy in-app hub and the new SSC hub read the same `/api/tasks`, `/api/roadmap`, `/api/docs`, etc.

### Added
- **`ProductMoved` handoff panel** (`src/components/ProductMoved.tsx`) - the default content of the Product tab, wrapping the legacy `ProductHub` behind an opt-in fallback.

## [0.28.0] - 2026-07-06 17:47 ET

Idempotent agent actions, an interview-prep review loop, and a per-job assistant chat - a four-part job-page wave built agent-only on top of v0.27.0, from owner feedback that (a) actions already run outside the app still invited a destructive re-run, (b) interview prep needed the same review loop as Draft->gaps->Finalize, and (c) each job needed an in-context help chat. The read-only chat scope was hardened after an independent security review. Release gate is green at 75 files / 1375 tests / tsc clean / activity-log lint pass.

### Added
- **Interview-prep review loop: Draft -> feedback -> Refine (Part 3).** The `interview-prep` routine now also writes an owner-editable `Interview prep feedback.md` note (the coach's clarifying questions + space for comments); editing it flips a new **Refine interview prep** action to ready (server-derived `prepRefineReady`, the `finalizeReady` analog). The new `interview-prep-refine` routine (bound to interview-offer-coach) regenerates the prep docs incorporating that feedback. The feedback note renders + edits inline in the drawer's Interview prep section, written through the same guarded `PUT /api/jobs/:id/file` allowlist (extended to `feedback` notes).
- **Per-job assistant chat (Part 4).** A read-only, LOCAL assistant pinned to the bottom of the job drawer (`GET`/`POST /api/jobs/:id/chat`): it answers grounded in the job's own files and may RECOMMEND exactly one guarded routine (a `suggestedAction`), surfaced as a "Run this" button that routes through the same guarded path - the human confirms every run. Transcripts persist app-side in `docs/job-chats.json` (a git-ignored runtime store).

### Changed
- **Agent-action buttons are now idempotent (Part 1).** Each action's "already done" state is DERIVED server-side from artifacts/status (`draftDone` / `finalizeDone` / `interviewPrepDone` / `offerPrepDone` / `followUpDone`), so an action run even OUTSIDE the app reads as **Done** and its button becomes a guarded **Regenerate** (a confirm modal) instead of silently overwriting on a single click.
- **Regenerate keeps a dated copy (Part 2).** Before a job routine overwrites its output in place, the run pipeline copies each current output to `X (YYYY-MM-DD).ext` first (copy-only via `COPYFILE_EXCL`, path-contained to the job folder, never deletes - honoring the data contract). Dated copies stay in the Files list as history but are excluded from the live views (`prep[]`, `hasCV`, done-detection) so they never masquerade as the current doc.

### Security
- **The per-job chat assistant is read-only and cannot leave the machine.** It is spawned with local read tools only (`Read,Glob,Grep`), a hard deny-list of every file-mutation / exec / delegation AND network tool (`Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch`), and `--strict-mcp-config` (loads zero MCP servers regardless of user/workspace config). So free-form input - including an injected instruction inside a scraped posting - reaches a process with no write, exec, network, or MCP channel; it can only recommend a guarded action a human confirms. Closes security-review findings M1 (web-tool egress) and L1 (latent MCP-tool egress); the new path is disclosed in `docs/data-schema.md` §7.3.2.

## [0.27.0] - 2026-07-06 14:00 ET

A focused UX refinement to the v0.26.0 per-job Activity timeline, from owner feedback in live use. Release gate is green at 75 files / 1357 tests / tsc clean / activity-log lint pass.

### Changed
- **The collapsed "×N" retry row is now an expandable disclosure (US-7, AC-J3-12).** In v0.26.0 consecutive same-routine retries collapsed into one "Finalized application ×5" row, but the row looked openable and wasn't. It is now a real disclosure: `deriveJobActivity` retains each folded run (newest-first) on the group's `runs`, and `JobActivityTimeline` renders the collapsed row as a button (`aria-expanded`, the leading triangle rotates down when open) that expands to list every individual run with its own timestamp. Single runs and the date milestones are unchanged. Still read-only - expanding writes nothing (CC-DATA-4).

Verified: gate green (75 files / 1357 tests, tsc clean, activity-log lint pass) and the derivation is unit-covered by `tests/jobActivity.test.ts` (25 → 27 cases, load-bearing: the two new cases assert the folded runs are retained newest-first and that a single run carries no member list). The rendered expand interaction is a standard React disclosure over that verified data; a live browser click-through was blocked this session by the app's persistent SSE stream vs. the automation tool's network-idle wait (a tooling limitation, not an app defect).

## [0.26.0] - 2026-07-06 13:05 ET

The per-job **Activity timeline** (US-7) plus its owner-approved QA refinement, built agent-only on top of v0.25.0 and live-verified in the browser this session. Release gate is green at 75 files / 1355 tests / tsc clean / activity-log lint pass.

### Added
- **Per-job Activity timeline in the job detail drawer (US-7, t-1783353402918, AC-J3-12).** The drawer gains a read-only, newest-first **Activity** section derived (`deriveJobActivity`, `src/lib/jobActivity.ts`) from the job's routine runs (matched by `jobId`) merged with its `applied`/`deadline` date milestones - no new store, no new write path, reusing the `activity` slice the drawer already fetched for the Last-run badges. Friendly empty ("No recorded activity yet") and loading states; meaning is carried by the text label, never the decorative dot color alone (CC-A11Y). Rendering writes nothing (CC-DATA-4). The fuller status-transition-history version stays parked.

### Changed
- **Activity timeline QA refinement (owner-approved 2026-07-06).** Consecutive same-routine retries **collapse into one row carrying a run count** ("×N" as real text, not color): a job finalized five times reads as one "Finalized application ×5" row rather than five identical rows, while a milestone or a different routine between two runs still breaks the group so interleaved history is not hidden. The `applied`/`deadline` values are parsed **strictly as a bare `YYYY-MM-DD`** (a time, range, note, or an impossible date like `2026-02-30` is omitted, not salvaged); the deadline milestone is always shown, future or past.

Verified-live status, honestly: the gate is green (75 files / 1355 tests / tsc clean / activity-log lint pass) and the derivation is unit-covered by `tests/jobActivity.test.ts` (25 cases, load-bearing). The rendered drawer was **live-verified 2026-07-06** in the browser against an isolated branch instance (Vite :5181 -> Express :8788, canonical data): the Nefab drawer's Activity section renders "Finalized application ×5" (five `finalize-job` retries collapsed) + "Drafted CV + cover letter" + Deadline + Applied, newest-first.

## [0.25.0] - 2026-07-06 09:35 ET

The user-story + autonomy wave of 2026-07-06, built agent-only under CTO orchestration on top of v0.24.0. Headline: the **Decisions surface redesign** the owner asked for - parked owner-decisions were built but buried, so this wave gives them a bell awareness hook, a permanent home in Product Hub, and inline one-click resolve. Alongside it: the US-1..US-6 pipeline-attention features, a disabled-by-default Apify discovery source, dev-infra port seams for isolated live-verify, the `autonomous-session` skill, and the previously-unreleased autonomy charter + operating-model docs from main. Release gate is green at 74 files / 1330 tests / tsc clean / activity-log lint pass.

### Added
- **Decisions surface: bell awareness + focused view + inline resolve (US-1 / US-1v2, t-1783317937079, t-1783336697733).** Parked owner-decisions now have a real home: **Product Hub -> Delivery -> Decisions** with a live nav badge, a bell awareness hook in the top bar ("N decisions need you - Parked for your call" leading the notifications panel), a focused "Parked for your call" list, and **inline Choose A/B/C** resolution per decision (recommended option highlighted). The v1 was a buried hub view; this v2 redesign is the surfacing + one-click-resolve the owner requested.
- **Follow-up-due needs-attention bucket (US-2, t-1783317937204).** Submitted jobs past their follow-up window surface in a dedicated Insights bucket so nothing goes cold silently.
- **Derived next-action suggestion (US-3, t-1783318991874).** When a job has no explicit `next_action`, the app derives a sensible suggested next step from its state instead of showing nothing.
- **Interview-prep + offer-prep drawer actions (US-4 / US-5, t-1783319168901, t-1783319168957).** Jobs at interview/offer status get one-click prep actions, bound to the interview-offer-coach routine.
- **Draft-follow-up action on follow-up-due jobs (US-6, t-1783336697793).** A one-click "draft follow-up" on a follow-up-due job, run by application-writer and **never auto-sent** - it drafts for your review, consistent with the never-auto-submit guarantee.
- **Apify discovery source (`type:apify`), shipped DISABLED (t-1783339605935).** A new server-side, cost-capped discovery source (run-actor call, dataset->find mapping, token-from-env) that makes **zero outbound calls until the owner explicitly enables it**. Ships guardian-clean and off by default; enablement is parked for the owner (token + spend authorization + actor choice). Backed by ADR-019.
- **`autonomous-session` skill v1 (t-1783317287502).** The repeatable structure for an unattended multi-hour product-improvement session (mission -> backlog -> build-then-verify loop -> park owner-decisions -> debrief).
- **Operating-model overview + autonomy charter docs.** The dev+deploy cycle and intake->task->project->roadmap model (t-1783261083278), and the autonomy charter adopted with the owner (Layer A + guardian-amended Layer B).

### Changed
- **Isolated parallel-instance live-verify seams (infra).** `JOBHUNT_PORT` + `JOBHUNT_PROXY_TARGET` (env-gated, defaults unchanged) let a second full stack run alongside the owner's live app to verify an unmerged branch without disturbing `:5180`/`:8787` - used to live-verify this very release.
- **US-2 polish:** the moot deadline date is suppressed on Insights follow-up rows.
- **Journey J12 reconciled** to the Decisions surface v2 (AC-J12-6..9).

### Security
- **Apify egress disclosed across the data contract (t-1783339605935).** The one new potential off-machine call (Apify run-actor, only when owner-enabled) is documented across the contract in the same wave it was built; the source is disabled by default with hard spend caps and a token read only from the environment (never committed).

Verified-live status, honestly: the release gate is green (74 files / 1330 tests / tsc clean / activity-log lint pass). The headline Decisions surface v2 was **live-verified end-to-end by the CTO** in the browser against an isolated branch instance (Vite :5182 -> Express :8788, canonical data) - bell hook, nav badge, focused view, and inline Choose A/B/C all render and route correctly, console clean, with the parked Apify decision deliberately left unresolved (owner's call). US-2..US-6 and the Apify source are covered by the unit/integration suite (part of the 1330). Promote to stable runs immediately after this cut.

## [0.24.0] - 2026-07-05 14:29 ET

A single-commit presentation refinement on top of v0.23.0, from owner feedback (r-1783260601327: "follow the Jira model - don't redirect to the new page for the task view - it opens the window"). The deep-linkable task detail that v0.23.0 shipped as a full-page view now opens as a modal over the board instead. The board stays mounted and dimmed behind it, so your scroll position, lens, and filters survive the visit; the URL still carries `#/tasks/<id>`, so deep links and browser Back are unchanged. Built agent-only as one commit on top of v0.23.0; the release gate is green at 70 files / 1203 tests / tsc clean / activity-log lint pass.

### Changed
- **Task detail opens as a modal over the board, not a full-page redirect (t-1783260778804).** Following the Jira model, opening a ticket no longer unmounts the board to redirect to a full page - `ProductHub` keeps `TaskBoard` rendered for a `#/tasks/<id>` route and renders `TaskDetail` as a modal on top of the still-mounted, dimmed board (so scroll + lens/filter context survive). The modal reuses the app's dialog contract (the shared `dialogFocus` trap, opener focus save/restore, `role=dialog`/`aria-modal`, labelled by the title) and a local Esc that closes without disturbing App's global Esc chain. The X (top-right), the backdrop, and Esc all navigate back to `#/tasks` as a history push - so browser Back still reopens the task and returns you to the same scroll position. Deep-link, not-found, and all wave-1/-2 task-detail behavior (IME-safe Enter, failed-comment recovery, focus-visible, 375px overflow guards) are unchanged.

Verified-live status, honestly: this window is verified by the CTO's live end-to-end click-through in the owner's Chrome (modal-over-board; Esc close + focus restore + scroll preserved; browser Back reopens; deep-link and the not-found dialog all correct) on top of the green release gate (tsc clean; `tests/router.test.ts` 21/21). No separate qa-tester sweep this window - it is a single-commit presentation refinement of a feature (v0.23.0's task detail) that never reached stable. Promote to stable: deferred to the CTO, who runs the promote after this cut to control port timing and re-verify.

Tests 1203 (unchanged - a presentation rework of existing components, no test file touched; router coverage 21/21 stands).

## [0.23.0] - 2026-07-05 14:16 ET

The second build wave of 2026-07-05 (the "evening wave"): tickets become linkable, discovery triage gets honest counts and better controls, the chat button moves out of your way, and a latent discovery data-loss bug is closed. Built agent-only across several parallel lanes on top of v0.22.0; the release gate is green at 70 files / 1203 tests / tsc clean / activity-log lint pass.

### Added
- **Deep-linkable tickets: a full-page task view (t-1783257189986).** Every ticket now has its own address - a `#/tasks/<id>` link opens it as a full-page, Linear-style view with an editable title and description, a properties sidebar, the checklist, attachments, and a comment thread with a composer and copy-link. Ticket card titles on the board are real links (middle-click opens a new tab), and a deep-link opened cold wins on load. Backed by a dependency-free hash router.
- **Related-entity chips that jump you to the thing (t-1783255872307 / t-1783256391885).** Run output and chat reports now carry clickable chips to the job, ticket, project, or source they mention, so you can follow a result straight to what it refers to instead of hunting for it.
- **Discovery finds triage: sorting, filters, and clearer controls (t-1783163892053).** The finds list gains Newest / Fit / Deadline sorting and Fit / Track filters, a visible busy state on Refresh, and a one-click "run discovery" affordance when the list is empty; Skip and Maybe move into a tidy overflow menu so the primary triage actions stay uncluttered.
- **Undo of a discovery decision now sticks (t-1783178044080).** Reversing a New -> Skip / Maybe decision used to be optimistic-only and reappeared on reload; a new 'clear' verb writes the undo through to the vault so it persists. Closes a Discovery v2 item that had been deferred.

### Fixed
- **The discovery triage sidebar counts now match the filtered list (t-1783255697392).** When you filter the finds to a single source, the saved-view rail badges now count only that source's finds instead of the whole set - the badge and the list can no longer disagree.
- **A latent discovery data-loss bug is closed (t-1783258133295).** A stable-channel visit-stamp write had been silently dropping 33 sources' `fetchMode` and one `fetchNote` value, because the file serializer only knew the fields of its own version. The serializer now round-trips any key it doesn't model, so a field written by a newer version can never be discarded by an older one; the dropped values are restored.
- **Esc no longer closes the wrong thing behind the chat panel (t-1783145481696).** With the chat open, pressing Esc closes the chat first instead of popping an overlay underneath it; a second Esc still minimizes the newest run, as in v0.22.
- **A malformed notification can no longer white-screen the app (t-1783145481687).** The notification bell and panel guard against a bad feed, and the bell and chat now each sit inside their own error boundary, so a single component throw can't take down the whole page.
- **Task-detail accessibility and narrow-screen polish (t-1783257205801).** Enter now respects IME composition (Korean typing no longer commits mid-syllable), delete-confirm can be cancelled with Escape and restores focus, the copy button announces its Copied state, and long unbroken text wraps cleanly at 375px.

### Changed
- **The chat button is now draggable (t-1783256152026).** The floating chat button can be dragged anywhere with mouse or touch, remembers where you put it, stays clamped inside the viewport, and keeps clear of the run dock - while remaining a normal tabbable button.
- **Release-gate hardening: the activity-log check tolerates in-flight runs (t-1783139260257).** A legitimate run still in progress no longer false-reds the release gate; concurrent runs are tolerated within a 6h window and surfaced in a printed side-channel, while genuinely orphaned runs still flag. Dev-infra only, no product surface.
- **Weekly enablement review (people-enablement).** The second full weekly agent-workforce review, over the v0.14.0-v0.22.0 window: two latent agent-definition drift items fixed in-pass, browser-selection and known-tool-limit rules propagated across the roster, and skill currency refreshed. Scoreboard: 14 healthy / 0 drifting / 0 gap. Org-internal; no product surface change.

Tests 1034 -> 1203.

## [0.22.0] - 2026-07-05 01:30 ET

The post-v0.21.0 quality sweep, executed agent-only in five waves (S2a-S2e) plus two infrastructure heals: run ergonomics grow a minimize + bottom dock with honest concurrency notes, the Files buttons stop lying to phones, a UI consistency pack folds three drifted component copies into shared primitives and adds a "?" shortcut overlay, the three list views get honest defaults, the bridge drops its wildcard CORS grant, and the capture hook stops recording harness noise as owner asks. Test suite 875 -> 1034 (+159, red-checked where practical).

### Added
- **Run minimize + bottom dock + concurrent runs (t-1783119823228).** RunPanel minimizes to a bottom-dock chip (restore/dismiss; no `aria-modal`, so the shortcut guard never trips on it); a pure `runDock` state machine dedupes by `runId` (fixing the old overwrite when two runs raced) and a shared poll hook tracks multiple concurrent runs at once. The server's 409 duplicate-scope and 429 capacity refusals render as honest info notes - message patterns drift-pinned against the server literals in tests - while real failures keep the error toast. +40 tests.
- **Remote-honest Files buttons (t-1783201094679).** Opening a job-folder file (CV, cover letter, posting) was a desktop-only `shell.openPath`-style action that silently no-opped for a phone over the tailnet. A guarded read-only `GET /api/jobs/:id/files/:name` (the ADR-014 reader idiom: existence-allowlisted to the folder's own listed direct-child files, path-contained, conservative MIME map, `nosniff` + CSP `default-src 'none'` + `no-store`) now serves the file to remote clients as streaming links; desktop keeps shell-open. Documented in the data schema's writer/reader map same-wave; pinned by `tests/job-file-serve.test.js`.
- **Shared UI primitives + a "?" shortcut overlay (t-1783183576693).** `SegmentedControl`, `UndoToast`, and `lib/time` are extracted as the single copies (three drifted duplicates deleted), every dialog goes through the shared `dialogFocus` trap, the 44px tap-target remainder lands, and a shared shortcut guard plus a "?" cheat-sheet overlay make the keyboard surface discoverable.

### Changed
- **Views cluster: honest defaults (3 tickets).** My Reports groups Open first with Done + canceled collapsed behind a persisted disclosure, both sections rendered by one shared `renderReportRow` so they cannot drift (t-1783119900332). Intake defaults to owner-initiated asks with honest counts, machine echoes (task-notification / system-reminder blobs) hidden behind a one-click "all" (t-1783183576744). The Sources console defaults to active sources, the 32 dormant stubs under a collapsed Inactive disclosure, alias anchors kept (t-1783183576759). +17 tests.
- **Phone-fit trio at 390px (t-1783201082838, t-1783201090278, t-1783201097671).** JobFilterBar, TriageInbox checkboxes, and Insights/Usage bars are all honest at 390px touch - 44px targets, no clipped controls.
- **Capture-hook noise filter, live immediately (t-1783144206969).** The prompt-capture hook drops harness task-notification / system-reminder turns instead of filing them as owner asks; `r-1783224958199` is annotated as hook-noise, and the 90 pre-fix noise records are disclosed with bulk disposition deferred to its own ticket. Hooks run from the main tree, so this one is live now - it does not wait for a promote.
- **Org-docs reconcile + Layer B subagent rule (t-1783183576715).** Governance section 1.1's enumerated roster is de-drifted to a registry pointer (`docs/agents.yaml` is the one list), the task-lifecycle SOP cites the release-checklist step by name instead of a renumbering-prone number, and the onboarding checklist + roster audit carry the Layer B subagents-never-push rule in adoption-pending wording.
- **t-1783042256284 closed as superseded.** Decision brief on the ticket: the runner's `allowedTools` is not a ceiling, so the proposed drop would be a no-op; disposition follows separately.

### Security
- **CORS zero-grant on the file bridge (t-1783186106119, guardian).** The wildcard `cors()` middleware is removed entirely - no legitimate cross-origin browser client exists (relative fetches, the Vite proxy, and tailnet serve are all same-origin), so the bridge now grants nothing rather than everything. 5 red-checked tests prove the header is gone and same-origin flows still work. Activates for the owner's daily app at the next promote.

### Fixed
- **Keyboard shortcuts no longer fire behind modals (t-1783163892019).** The shared shortcut guard's modal branch closes the hole where list shortcuts acted on rows underneath an open dialog.
- **TaskCard expander is a real disclosure button (t-1783201086526).** Keyboard-operable with proper aria state, instead of a click-only element.
- **Notification honesty (t-1783091385623).** Failed and stopped runs are counted separately (a stop is not a failure) and the tint mapping is fixed; the deliberate behaviors QA flagged are documented at their canonical homes.
- **Vault discovery.py dedup honesty (t-1783196601634).** `dups --mark` preserves already-decided rows and the printout prefers the exact folder match; fixture-verified, workbook untouched.
- **server/index.js un-binaried (04001f7).** Two literal NUL bytes (batch dedupe-key separators) made git treat the server as a binary blob - unreviewable diffs, ripgrep truncating searches at byte 118175. Replaced with the identical-runtime `\u0000` escapes plus a one-time CRLF -> LF normalization; content byte-proven identical to HEAD after exactly those two transformations. Behavior unchanged.
- **Full-suite flake: capture-prompt hook tests get a spawn-appropriate 30s budget.** Each case spawns a real node child; under full-suite CPU load the 5s default starved random cases (all green in isolation). No behavior change - a green full run is real again.

Release checklist attests (steps 3, 6, 10, 11): data-schema doc checked - no entity or field changed this window (schema stays v4); the one API-surface addition (the guarded file reader) was documented in the schema's writer/reader map in the same wave, and app-version refs are reconciled to 0.22.0. Verified-live status, honestly: this window is verified by tests (+159, red-checked where practical) on top of W3's live E2E earlier tonight (t-1783198113775); live click-throughs of the new run dock and view defaults are deferred to the owner action plan (`docs/session-debriefs/2026-07-05-owner-actions.md` item 6) and first real use - flagged on the tickets, not claimed here. SOPs (step 10): the window's only process-behavior changes were themselves doc work shipped same-wave (t-1783183576715); the run-dock and view changes alter no lifecycle, channel, or ops procedure, so the task-lifecycle / dual-track / sysadmin manuals stand as written. Step 11: `assert-tailnet-posture.ps1` bare run PASS, exit 0 (loopback bind 127.0.0.1:8787, single serve handler -> 127.0.0.1:5180 tailnet-only, funnel off); `assert-rc-no-listener.ps1` N/A this window (no tailscale/RC change); CT-log hygiene holds (device names unchanged, non-descriptive); patch cadence: owner cadence, next due per `sysadmin-sop.md` section 4; app.log rotation block verified present in `start-app.cmd`. Promote to stable: deferred to the owner action plan (item 2) - the owner's daily app stays on v0.20.0 until the owner promotes, and promoting now lands directly on v0.22.0 (the CORS zero-grant and everything above activates then; the capture-hook filter alone is already live).

Tests 875 -> 1034.

## [0.21.0] - 2026-07-05 00:30 ET

This release turns ADR-018 stage 0 from a built thing into a governed one - the operations layer (sysadmin SOP, incident runbooks, release-checklist ops gates) lands as standing process - and completes Discovery v2's W3 **instruction-proposal loop** end-to-end, alongside a discovery run-honesty pass, a Job write-boundary hardening, and ops hardening on the launcher/promote path. First release cut through the new checklist steps 10-11 (SOP same-wave gate + ops posture attests, below).

### Added
- **W3 instruction-proposal loop, end-to-end (t-1783198113775, data-schema §5 decision 4).** Server half: an append-only `InstructionProposal` sub-entity per source, propose/file/resolve endpoints, a scout prompt template, server-managed provenance (`instructionsApprovedFrom` / `instructionsUpdatedAt`), derived `proposeRunId`, and a `source-proposals-changed` SSE event (schema v3, +22 tests). Frontend: a proposal card with word-diff, propose/busy/badge states driven off the served `proposeRunId`, approve/reject-with-reason, provenance captions, and a starting-link source form (name + landing URL only; +32 UI tests). Live-E2E-verified round-trip on a throwaway source via a parallel dev instance; evidence recorded on the ticket.
- **ADR-018 stage-0 operations layer (reflections R-1..R-5).** `docs/governance.md` gains an ADR-018 operations & maintenance subsection (R-1, t-1783207130387) and the release checklist gains **step 10** (process changed -> SOP updated same-wave) and **step 11** (ops posture re-asserted + maintenance attested) (R-4, t-1783207130534). `docs/sysadmin-sop.md` ships as the owner-followable ops manual with as-built values (R-3, t-1783207130720). Five incident runbooks land in `docs/runbooks/`, guardian verdict ALL GO (R-5, t-1783207130885). The System-health view spec passed its guardian gate - build ticketable post-release (R-2, t-1783207131078) - and the ADR-018 sysadmin blueprint's AS-BUILT register is filled from the live stage-0 session (t-1783206883841).
- **Discovery run honesty: counters + lastRunSignal pill (t-1783200897663, t-1783222789408).** Runs carry agent-reported `candidatesReviewed` / `alreadyTracked` / `filteredOut` via a new `POST .../runs/:runId/report` endpoint (the prompt carries the run's own id), and a derived `lastRunSignal` (`leads|dedup|quiet|unverified`) renders on the health pill at card + drawer - so a 0-lead run is legible as healthy dedup vs an unverified scrape (label-carried, not color-alone). Plus a single-source `GET /api/discovery/sources/:id`, and `Source.fetchMode` (closed enum `direct-list|google-site|alert-email`, loud 400, null = unclassified) + `fetchNote` fed into the run prompt - 33/46 committed sources migrated from unambiguous instruction prose, test-guarded.
- **Standing-orders autonomy charter (t-1783219899562).** Three-tier decision rights + a harness permission allowlist so sessions run deep without ten-minute owner interrupts; guardian-reviewed with the verdict folded into the charter (rule-3 deny extends to `-D`, GC-script locked-worktree skip + plain-remove preference, machine-layout same-wave trigger). Owner adoption pending - chartered, not yet in force.

### Changed
- **Job write boundary + discovery provenance (t-1783199066683, t-1783199066654, schema v4).** `track` / `fit` / `sector` / `tailoring` / `status` are enum-guarded at all three Job write paths via `dropInvalidJobEnums` (Task posture: invalid silently dropped, clears stay legal, tolerant read unchanged), and `SECTORS` is unified so the Job and Source vocabularies cannot drift. `Job.source` is wired as discovery provenance: written by `createJobFolder` (pursue resolves an explicit `sourceId`, else the workbook row's join), served verbatim by `toJob`, not PATCH-writable, legacy free-strings tolerated - closing data-schema §6 gaps 1 and 2.
- **Per-(routine, scopeId) run lock (t-1783198713071).** A duplicate live/queued run of the same routine on the same job/source now 409s, including through the batch queue - from the reproduced 2026-07-03 double finalize-job; the W3 propose guard is folded into the same mechanism.
- **Ops hardening on the launcher/promote path (R-4 t-1783207130534, t-1783209899342).** `ops/scripts/start-app.cmd` now rotates `ops/outputs/app.log` at launch above 5 MB (keeping `.1`/`.2`), takes a single-instance lock, and preflights the stable channel with a loud dev fallback; `ops/scripts/promote-stable.cmd` verifies vite resolves post-promote (distrusting a stale lockfile stamp) and fails loud with recovery steps; `assert-tailnet-posture.ps1`'s bare-run default proxy target is reconciled to the as-built `http://127.0.0.1:5180` (AB-3).
- **Phone-fit residuals merged (R3, t-1783198090972).** 44px tap targets at 390px across the five headline journeys (needs-attention chips, board/table controls, drawer status + run controls, triage bulk bar, toasts clamped to the viewport).

### Fixed
- **Release-gate audit findings fixed before the tag (t-1783224907054).** The 2026-07-05 governance audit verified the window's load-bearing claims clean (posture-script default, ticket ledger 14/14, W3 live-E2E evidence corroborated by the activity log) with one MEDIUM: `sysadmin-sop.md` / `governance.md` still described the shipped log rotation and runbooks as in-flight future work. The five stale spots were reconciled at `ce6dcd5` so checklist step 10 passes truthfully.
- **statusColors AA sweep extended over `PROPOSAL_STATUS_META`** - the W3 proposal-status vocabulary joins the vetted single source of truth instead of shipping unvetted hues.

Release checklist attests (steps 3, 10, 11): data-schema doc checked - this release's data-model changes are covered by its own v3/v4 dated entries, app-version refs reconciled to 0.21.0. SOPs updated same-wave (sysadmin-sop new, dual-track-sop promote-verification, audit-forced truth pass at ce6dcd5). Step-11: `assert-tailnet-posture.ps1` bare run PASS, exit 0 (loopback bind + single serve handler -> 127.0.0.1:5180 + funnel off); `assert-rc-no-listener.ps1` N/A this window (no tailscale/RC change); CT-log hygiene holds (device names unchanged, non-descriptive - galena/cinnabar per the AS-BUILT register); patch cadence: owner cadence, next due per `sysadmin-sop.md` section 4; app.log rotation in place (rotation block verified present in `start-app.cmd`). Promote to stable: deferred to the owner action plan (`docs/session-debriefs/2026-07-05-owner-actions.md` item 2) - the owner's daily app stays live on v0.20.0 until the owner promotes.

Tests 767 -> 875.

## [0.20.0] - 2026-07-04 23:51 ET

This release also folds the two parallel development lines back together - origin's shipped v0.19.0 (discovery-visibility + triage) is reconciled by merge with this machine's Sources v2 + data-schema + ADR-018 stage-0 + dual-track line, 767 tests green across both.

A schema-first pass ahead of the next Discovery build: the org publishes its first canonical **data schema** doc (every entity, field, writer, and relation, gated into the release checklist going forward), runs a live-data audit against it, and only then rebuilds the Sources console into a genuinely groupable, cadence-editable, contract-enforcing v2 - closing the audit's real findings (a posting-link backfill, two mis-pointed `origin_request` refs) and adding University Affairs as the Ontario higher-ed aggregator source along the way.

### Added
- **`docs/data-schema.md` v1 - the org's first canonical data schema, gated into every release (t-1783197650912).** One document for how all 11 entities (Job, Discovery Source + runs + leads, Task, Request, Portfolio Project/Milestone, Roadmap phase, Agents roster, Telemetry event, Activity log, Notify-state, Config) hang together: field tables with stored-vs-derived status and the exact writer, a relations map, and the governing rule that no field ships without a schema entry, a writer, and a reader. `DATA_CONTRACT.md` at the repo root is absorbed into this doc's section 7 ("Data contract guarantees") and is now only a pointer - it was invisible to the app's own document hub. `docs/governance.md`'s release checklist gains a standing gate: a release that adds, removes, renames, or changes the meaning of any entity/field without updating this doc fails the gate. Four build decisions are pinned for the Sources work that follows: a closed 7-key `tracks[]` enum on a source (tag membership, not exclusive assignment), the `nextRunAt` derivation confirmed correct for all four cadences including `monthly`, a server-derived `contractGaps` (never client-guessed), and the shape of a Wave-3 instruction-proposal loop (owner comments -> agent proposes crawl instructions -> owner approves/rejects with reason) - designed, not yet built.
- **Data schema audit: 0 HIGH, 3 MEDIUM, 3 LOW findings (t-1783197650929).** `docs/audits/2026-07-04-data-schema-audit.md` re-derives every finding from the live files/API rather than restating a doc's claim about itself: job-vault-to-API parity is an exact 94/94 match, referential integrity across tasks -> milestones -> projects -> roadmap -> requests is clean (zero orphan refs, zero invalid enums), and the activity-log lint passes 157/157 records. The three MEDIUM findings - two `portfolio.yaml` `origin_request` fields pointing at a task id instead of a request id, the `Task.completed` "present iff done" claim stated as universal when 82 of 126 done tasks predate the ADR-013 stamp and legitimately lack it, and the `link` posting-URL field left undocumented in the old data contract despite 61 of 94 jobs missing it - are corrected in the schema doc and `portfolio.yaml` themselves; the link gap is closed below.
- **Sources v2: group-by, cadence editing, freshness-at-a-glance, scrape-contract enforcement (t-1783197650981).** The Discovery Sources console groups by **None / Track / Sector / Type**, with a source that serves multiple tracks fanning out into every group it belongs to and an "All tracks" section pinned first for generic boards; a new **`tracks[]`** field (validated against the same 7 canonical keys as a Job's `track`, 400 on an unknown value) is authored per source. A **CadenceEditor** popover (on the card and in the detail drawer) edits `daily/weekly/monthly/manual` in place. A console-level **FreshnessBar** answers "is anything overdue right now" without a click - due/stale/healthy/never-run counts plus a "next up" pointer, each segment a clickable quick-filter. A server-derived **`contractGaps`** flags a source whose declared `outputFields` doesn't even intend to capture a direct link or a deadline (never client-guessed), rendered as a warning badge with one-click "add the missing field"; the per-source run prompt itself now requires every lead to carry a **direct posting URL** and a **deadline** - a lead missing either is flagged in triage, never silently filed clean. `docs/proposals/` joins the app's document hub (design specs are now readable in-app, not just on disk). +32 tests; `npm run check` green (732/732).
- **University Affairs added as a discovery source - the Ontario higher-ed aggregator (t-1783198184661).** Canada's largest higher-ed job board (`universityaffairs.ca`), server-rendered and directly fetchable, with deadlines and direct apply links on every job-detail page; added `bps` sector, weekly cadence, active. First run completed cleanly (0 new leads - the one strong-fit posting was already tracked, four others correctly rejected on seniority/track fit). A portfolio-rationalization pass found the aggregator carries only ~22 admin roles nationally against the per-institution boards' bulk of staff hiring, so **zero existing sources were deactivated**.

### Fixed
- **57 of 61 jobs missing a posting `link` backfilled (t-1783198713055, audit MEDIUM-3).** Recovered from body prose where already present (33 jobs), and from 23 scanned/screenshot PDFs with no text layer by rendering page 1 and reading the browser-print footer URL, written back through the existing surgical `PATCH /api/jobs/:id` path - no hand-edited frontmatter. Drafted/queued/lead jobs (the ones the owner still needs to open) were prioritized and fully resolved (36/36). 4 jobs are left blank, not invented: 1 NordSpace posting has only a careers-landing page (not a direct posting URL), and 3 York University postings' source PDFs carry no URL string or link annotation anywhere in the file.
- **Two `portfolio.yaml` projects' `origin_request` pointers corrected (audit MEDIUM-1).** `prj-ops-management-mvp` and `prj-operational-system` pointed at a task id (`t-1783097778589`) instead of the request that actually chartered them, breaking the Intake ledger's two-way traceability for the very project meant to keep the org's own record honest.

Tests 737 -> 767.

---

## [0.19.0] - 2026-07-04 19:34 ET

v0.19.0 builds on v0.18.0's Discovery Sources console with a **discovery-visibility and triage-flow pass**. Cadence "due" state and the daily new-finds count - computed but previously invisible outside Discovery -> Sources - become visible app-wide (a TopBar due-chip and a Finds "+N new" badge over the run-all-due fan-out, still human-click-gated). Pursuing a strong-fit find now lands it straight in the queue, and the needs-attention strip with its "due, not drafted" nudge rides both Jobs views. A WCAG-AA fix folds the pipeline color vocabulary back into its single source of truth (contrast failures as low as 2.20:1), discovery join-honesty makes a source's "+N new" badge reset from every triage path (plus a clean 400 on malformed request bodies), and two governance charters - the SSC release cadence and the CTO orchestration protocol - land in the repo. Cut behind the first run of the new **quality-pass** skill, which caught and forced fixes for two release blockers before the tag: run-all-due was launching PAUSED sources, and a corrupt Product-Hub key blanked the content pane.

### Added
- **Discovery due-visibility: an app-wide due-chip + new-finds badge (t-1783183576588, ops F3 + UX F13).** A TopBar **"N sources due"** amber pill now shows on every page (hidden at 0; click -> Discovery console), the Finds tab carries a **"+N new"** badge, and the run-all-due fan-out surfaces as **"Discover due (N)"**. Visibility only - no contract change, still human-click-gated; the pill color comes from the vetted `attentionToneColor` accessor.
- **Triage Pursue -> Queue fast path + a "due, not drafted" marker (t-1783183576640, ops F5+F6).** Pursuing a **strong-fit** Discovery find now creates the job directly in `queued` (the owner was hand-promoting leads -> queued anyway); moderate/stretch fit still lands as a `lead`, and the Pursue button discloses the fast path ("Pursue -> Queue") instead of silently changing behavior. A queued job with no CV and a deadline inside 0-3 days now shows a **"due Nd - not drafted"** marker with an inline batch-draft CTA.
- **Jobs hierarchy pack: the needs-attention strip on both Jobs views + a persisted Hub tab (t-1783183576609, UX F12/F14/F15).** `NeedsAttentionStrip` was hoisted above the Board/Table switch so both sub-views share the one strip, and the Product Hub now remembers its last tab (`jobhunt.hub.activeKey`) instead of always reopening on Roadmap.

### Changed
- **Governance charters folded into the repo.** The **SSC release cadence** (ship the smallest coherent user-visible improvement; feedback-sourced next-wave scope; mid-build finds go to the next window - governance section 3, intake `r-1783193148371`) and the **CTO orchestration protocol** (`docs/orchestration-protocol.md`: intake capture, wave-ticketing, lane discipline, verification, mid-wave-failure recovery) plus a **`company-os.md`** layer-boundary doc now live in-repo, closing two governance-audit findings.
- **Doc-truth: user journeys reconciled to merged reality (quality pass v1, t-1783199342269).** `docs/user-journeys.md` was reconciled to the shipped Wave-A code (a new **CC-ERR** cross-cutting journey for malformed-body handling; J2 and others updated), a QA risk list was recorded, and a reusable **quality-pass** skill was added - the skill whose first run gated this release.

### Fixed
- **WCAG-AA contrast failures in the Jobs pipeline color vocabulary (t-1783183576626, UX F7).** `lib/constants.ts` held a second, unvetted `STATUS_ACCENT` / `TRACK_ACCENT` / `FIT_ACCENT` map outside `src/lib/statusColors.ts`, the purpose-built single source of truth; several hues rendered as small text below the 4.5:1 AA bar - one as low as **2.20:1** - across `JobTable`, `JobCard`, `KanbanBoard`, `NeedsAttentionStrip`, `InsightsView`, and `Badges`. The vocabulary is folded back into `statusColors.ts` and re-vetted.
- **Discovery join honesty + a clean error on malformed bodies (t-1783183576657, audit F1a/b/c + rider).** A source's **"+N new"** badge now resets from **every** triage path: the `lastVisitedAt` visit-stamp moved into a `useEffect` keyed on `(mode, sourceFilter)`, so clicking a find's source-provenance chip stamps the source too, not just the source-card deep-link. Any malformed JSON request body now returns a clean **`400 {"error":"invalid JSON body"}`** instead of an HTML/stack response (the CC-ERR journey).
- **Two release blockers the pre-tag quality pass caught (#15).** `POST /api/discovery/run-all-due` was launching **paused** sources - the target filter used a truthy `s.active` check on a three-state string enum (`"yes"/"maybe"/"no"`), so `active:"no"` (paused) passed and the fan-out spawned real agents for it, defeating the pause safety control; it now filters on the derived `status !== "paused"` (QA live-reproduced 13/13). And a corrupt/unrecognized `jobhunt.hub.activeKey` now **falls back to Roadmap** instead of rendering a blank Product-Hub content pane.

Tests 692 -> 737.

---

## [0.18.0] - 2026-07-04 16:05 ET

The Discovery page becomes a first-class **Discovery Sources console + upgraded triage inbox**. Each employer or job board is now a managed **source** with its own crawl instructions, cadence, computed **health status**, per-source **Run now**, run history, and **lead yield**; a **Sources <-> Finds** toggle flips to a genuinely rebuilt three-pane triage inbox for the leads those sources produce. The source registry is a new native app-managed YAML store (ADR-016), not the Excel workbook; every health/count/next-run field is DERIVED (never stored), and a find that matches no source stays in an honest **unassigned** bucket. The same window lands **usage-journey telemetry v1** (ADR-017: events-never-content by construction, J-tagged across 12 components, a Usage panel, and a PM-bound `usage-insights` routine), **age-based needs-attention buckets** so deadline-less jobs can no longer hide from the nudge system (audit F1), an **SSE consolidation** that retires four client polls in favour of one typed shared event stream, and a **finalize queue** (a DERIVED readiness signal + a TopBar "Finalize ready (N)" batch) aimed at the funnel's least-instrumented step. Closed at the wire, on QA's J10 release blocker: **registry unification** retires the xlsx-driven global sweep in favour of a **run-all-due fan-out** that stamps every source's `lastRunAt` honestly.

### Added
- **Discovery Sources console (ADR-016).** A new `docs/discovery-sources.yaml` registry is the native SoT for the source list (NOT the xlsx), read/written on the same atomic safe path as `tasks.yaml` / `requests.yaml` (tolerant load, `.tmp` + rename). Backend: `GET/POST/PATCH/DELETE /api/discovery/sources` plus per-source `POST /api/discovery/sources/:id/run`. Each source stores `id` (the canonical join key), `name`, `type` (`employer` | `board`; `apify` reserved unbuilt), `sector`, `active`, `urls[]`, `cadence` (`manual` | `daily` | `weekly` | `monthly`), `instructions` (read verbatim by `discover-jobs`), `outputFields[]`, `aliases[]`, and a capped, server-managed `runs[]` history. **Status / due / nextRunAt / jobCount / newSinceVisit / pursuedPct are DERIVED, never stored** (`deriveSourceStatus`, precedence paused > running > failed > never-run > stale > due > healthy), so the health pill can never drift. A present-but-invalid enum fails **loud** (400) at the write boundary; `lastRunAt` / `runs` are server-managed and unforgeable. Frontend: `DiscoveryView` (Sources <-> Finds toggle), `SourcesConsole` (card grid), `SourceCard` (status pill + sparkline + lead yield + Run now/kebab), `SourceDetailDrawer` (Overview / Instructions / Run-history / Leads / Settings tabs), and `SourceFormDrawer` (add/edit).
- **Per-source Run now + run history.** `POST /api/discovery/sources/:id/run` launches `discover-jobs` scoped to one source (a `scope:"source"` routine, launchable only via this endpoint) and appends an optimistic `running` record immediately; the runner's close path flips it to the terminal outcome + `durationMs` + `leadsFound`/`leadsNew` (the honest delta vs a launch-time baseline). One run per source at a time (409); the concurrency cap (429) and a locked workbook degrade to a soft per-card note, never a crash. History is capped at 20 for bounded file growth.
- **The finds JOIN + unassigned bucket.** `GET /api/discovery/sources` joins the workbook finds to each source by a stamped `sourceId`, else the raw `Source` label matched through the source's `name`/`aliases`; finds matching no source are surfaced honestly as `unassignedCount` + `unassignedSources[]`. The source-scoped routine stamps each new find's `Source` to its canonical source name so the join tightens over time. A migration (`ops/scripts/migrate-discovery-sources.mjs`) seeds `aliases` from the observed legacy `Source` strings.
- **Rebuilt triage inbox (Finds).** The flat, read-only finds table is replaced by a three-pane master-detail: a **saved-views** rail (New / Maybe / Pursued / All / Hidden, each with a live count), a finds list, and a detail pane. **Keyboard-first triage** (J/K move, S/M/P decide + auto-advance), **undo-not-confirm** on Skip/Maybe (a ~6s Undo toast, never a blocking confirm), **bulk-select** with a pinned action bar (Skip all / Maybe all, a confirm past 5), and **clickable provenance** (a find's source chip filters the list to that source, bidirectional with the Sources console). **Pursue is unchanged**: it still creates a `Jobs/<Role> - <Employer>/` lead and opens the job drawer.
- **Usage-journey telemetry endpoint + store (ADR-017).** A new local-only, gitignored runtime log, `docs/usage-telemetry.jsonl`, written only through a fire-and-forget beacon (`POST /api/telemetry`) and read back only as a small aggregate (`GET /api/telemetry/summary`) - there is no raw-event dump. **Events, never content, by construction:** a closed `kind` enum (`view` / `action` / `run` - a malformed kind is a loud 400), a closed `surface` allowlist (an unknown surface soft-drops just that one event), a bounded, control-char-stripped `name` (`<= 80` chars, truncated not rejected), an optional `journey` id (`J1`-`J99`, else dropped as a field, never failing the event), and a scalar-only, capped `meta` (`<= 8` keys, string values `<= 60` chars; any object/array/null value is dropped, so no nested document - and no `__proto__` / `constructor` / `prototype` value - can ever reach `Object.prototype`), a server-stamped unforgeable `ts` (a client-supplied one is never read), and a 50-event batch cap. `DATA_CONTRACT.md` discloses the new store; see ADR-017 in `docs/governance.md`.
- **Instrumented journeys (J1-J10).** `src/lib/telemetry.ts`: a module-level, fail-soft client (`track()`; one `sessionId` per page load; a batched flush on a 15s timer / `visibilitychange` / `pagehide` via `sendBeacon` with a `fetch keepalive` fallback; an eager flush at 40 queued events) instruments navigation, the Jobs board/table + status changes, the job detail drawer and its Draft/Finalize runs, Discovery's Sources <-> Finds toggle + saved views + triage decisions (tagged `via: key|button|bulk` to measure keyboard-triage adoption) + pursue + source run-now/CRUD, the Product hub pages, chat capture, and notifications - 12 components in all, each event carrying a stable `journey` id so real usage of every journey in `docs/user-journeys.md` can be read back instead of inferred from pipeline state. The client mirrors the server's scrub (so nothing it sends is ever content) and never throws, retries, or blocks a user action.
- **Usage panel (Product hub -> Records -> Usage).** A new read-only `UsagePanel` renders the telemetry summary - total events, first/last seen, a view/action/run kind-chip row, and Top-surfaces / Top-names bar cards (matching the hub's loading / empty / error states) - plus a **Run usage insights** button that launches the routine below.
- **`usage-insights` routine.** A new global-scope routine bound to the `product-manager` agent (ADR-015: learning from usage and turning it into scoped recommendations is PM work, not engineering). It reads `docs/usage-telemetry.jsonl` (or reports "no usage recorded yet" and stops, never fabricating data) against this document's `J`-id set, computes most-/least-used surfaces, journey coverage, keyboard-vs-button triage adoption, and per-surface funnel drop-off, writes exactly one dated report at `docs/usage-reviews/YYYY-MM-DD.md`, and files **at most three** evidence-backed recommendation tickets (`labels: ["usage-insight"]`, `status: "triage"`) into the normal Triage flow (J5). Read-and-recommend only: it never edits code, another doc, or an existing ticket, and never deletes anything. See `docs/routines/usage-insights.md`.
- **Age-based needs-attention buckets for deadline-less jobs (audit F1).** `computeNeedsAttention` previously gated every bucket on a parseable deadline, blinding the nudge system to ~70% of the real backlog (19/29 drafted jobs and ~21/23 leads carried no deadline). **Stale-draft** now falls back to job-file age (mtime > 7 days) when a draft has no deadline, and a new **stale-leads** bucket (slate tone) surfaces deadline-less `lead`/`queued` jobs older than 7 days. One-bucket-per-job precedence is preserved via the `claimed` set (overdue > due-soon > stale-draft > stale-lead - the D4 invariant stays intact), chips read "`status` Nd - no deadline" via an `ageAttentionLabel` fallback, and both consumers (the Board strip and Insights) inherit through the shared function.
- **Finalize queue: a DERIVED readiness signal + "Finalize ready (N)" batch (audit #1 lever).** The drafted -> submitted step was the least instrumented in the funnel (29 jobs parked). `toJob` now derives `gapsAnswered` (the gaps-note mtime strictly newer than the generated CV; either file missing -> `false`; the SoT job file is excluded from the gaps match) and `finalizeReady` (`drafted && hasCV && gapsAnswered`) - one server-side rule, **never stored**. The batch endpoint gains a `finalize-job` readiness guard (non-ready jobs are dropped from the fan-out; `first-draft-job` is unaffected; it NEVER auto-submits). UI: an emerald ready-to-finalize chip (card + table), an informational readiness line in the job drawer (never blocking), and a TopBar **"Finalize ready (N)"** button mirroring batch-draft - with batch-finalize telemetry and a `verb` prop so the shared BatchPanel reads correctly for both batch types.

### Changed
- **SSE consolidation: typed events, one shared client stream, polls retired (audit F1-F3).** Server broadcasts are now typed (`jobs-changed` / `run-finished` / `source-run-finished` / a new `tasks-changed` on all task write paths) and the client rides ONE shared `useEventStream` (a single `EventSource`, HMR-guarded, backoff reconnect, hidden-aware); `useJobs` rides it too. The polls it retires: the notification bell's always-on 20s poll -> event-driven with a visible-only 60s fallback; the chat panel's 4s full-board poll -> `tasks-changed` while open with reference-equal state (killing the textarea flicker); BatchPanel reloads only on a progress-count change (was reload-all every 1.5s); discovery's 3s poll -> `source-run-finished` plus a 10s safety net. RunPanel's poll is kept (live output) with the double-reload race eliminated by event typing. `DiscoveryView` becomes the single finds owner (`TriageInbox` + the Leads tab consume props), ending the double workbook pull.
- **Doc-truth reconciled to the shipped code.** `docs/user-journeys.md` rewrites **J4** ("Discover and pursue a new posting") to the Sources <-> Finds model + the new triage inbox, adds **J10** ("Manage discovery sources / channels") for the console, and moves **D12** (the Discovery a11y nits) into J4/J10 as now-passing criteria (the `▶` run glyph is `aria-hidden`; the finds are a labeled list, not an unnamed-action-column table). `DATA_CONTRACT.md` discloses the new `docs/discovery-sources.yaml` app-managed store (on-machine, atomic, never auto-submits, and - unlike the vault - a source CONFIG may be deleted, which never touches a find).
- **Doc-truth: journeys are now measured (J11).** `docs/user-journeys.md` gains a "Telemetry tagging" note in the how-to-run section (J1-J10 now carry `journey` ids the usage-insights routine reads coverage against) and a new **J11** ("Review usage insights") journey covering the Usage panel and the `usage-insights` routine, with a Journey-index row alongside the existing ten.

### Fixed
- **Registry unification: the global sweep is retired for a run-all-due fan-out (t-1783183576537, QA's J10 release blocker).** The global `discover-jobs` sweep read the xlsx Config sheet and could not stamp any source's `lastRunAt`, so every health pill lied after it ran - a data-honesty defect against ADR-016's derive-never-store guarantee. Now: a new `POST /api/discovery/run-all-due` fans out per-source runs over every DUE active source through the shared queue (bounded by the concurrency cap), each launch stamping its own source AT LAUNCH time, with `trigger: "all-due"` provenance in the run history; the dead-row prune (ADR-008) moved here from the retired global path (still best-effort). `launchSourceRun` is extracted and shared with the queue drain, and sources now (re)load INSIDE the `readDiscovery` callback - fixing a write race where a stale pre-shell-out snapshot could save back over a concurrent `finalizeSourceRun` (the stuck-"running" pill the governance audit hypothesized). `POST /api/routines/run` rejects `discover-jobs` with a pointer and `GET /api/routines` hides it; the TopBar button is now **"Discover due"** -> run-all-due, surfacing in the BatchPanel. The owner-local vault routine was updated in place (owner-paired): sources live in the registry; the xlsx Config keeps Job Types + Filters only.
- **Dead "Open ↗" posting links (D12).** A find's posting now renders as an `Open posting ↗` anchor (`target="_blank" rel="noopener noreferrer"`) only when its `Link` is a real `http(s)` URL; a non-URL Link shows as plain text instead of a dead anchor.

Tests 451 -> 692.

## [0.17.0] - 2026-07-04 06:12 ET

The app grows its **first binary write-path** and closes the release window's security and doc-truth gaps. An allowlisted pasted-image attachment flow (paste/drop -> pending thumbnail -> fail-soft upload -> guarded inline lightbox) is the first time the app ever writes bytes, gated by eight ordered guards and an independent magic-byte sniff. The Express file bridge now **binds loopback-only by default**, so the unauthenticated write API is on-box unless the owner opts into LAN. Chatbot captures now write a **linked intake record**, completing the request -> assessment -> spawned-task origin chain in-app. Folded in from the same unreleased window: a **completed date** across the three most-recent surfaces (ADR-013), an **advanced multi-condition Job Tracker filter**, the **My-reports you/QA attribution**, the **Fold responsive Projects** split, and the D4/D6/D11 bug fixes. Cut behind two green release gates (QA GO, governance CLEAN), doc-true and live-verified.

### Security
- **File bridge binds loopback-only by default (audit T1).** `app.listen` now binds `resolveServerHost(config)` = `config.serverHost || 127.0.0.1`, so the unauthenticated write API is reachable only from this machine out of the box; LAN/phone access is an explicit owner opt-in (set `serverHost` to `0.0.0.0` or a LAN IP in `config.json`). Startup logs the bind posture ("loopback only..." vs "LAN-EXPOSED..."). The resolver is an exported pure helper (`resolveServerHost` / `isLoopbackHost`) unit-tested without opening a socket. The `DATA_CONTRACT.md` "never leaves the machine" guarantee now states this bind posture (audit O-2), closing the sole security-control disclosure gap the governance audit flagged.
- **The new image write-path lands through eight ordered guards.** Nothing is written until, in order: (1) the parent task exists, (2) the `Content-Type` is an allowlisted image MIME (png/jpeg/gif/webp, never SVG), (3) an independent **magic-byte sniff** agrees with the claimed type (a mislabeled HTML/script payload is rejected), (4) the body is non-empty and `<= 5 MB`, (5) the ticket holds `< 6` images, (6) the content-addressed path passes a `path.relative` containment check (no client filename ever reaches the path), (7) the write is atomic (`.tmp` -> rename), and (8) unforgeable metadata is appended server-side only (never in the task write whitelist). Read back only through a guarded inline reader (`X-Content-Type-Options: nosniff`, a locked-down CSP, and `Cache-Control: no-store`), never a static file server. See ADR-014.

### Added
- **Image attach + preview + lightbox (ADR-014) - the app's first binary write-path.** Paste or drop an allowlisted image (png/jpeg/gif/webp, `<= 5 MB`, `<= 6`/ticket) into the ChatCapture box -> an in-memory **pending thumbnail** (removable) held until the ticket is filed. On **Queue it** the image uploads to the filed ticket **after** the task POST (fail-soft: an upload failure shows a soft note and never loses the ticket). The filed report shows the thumbnail; clicking any thumbnail opens a focus-trapped inline **lightbox viewer** (Esc/backdrop close, focus restored) - never a download. Server: `POST /api/tasks/:id/attachments` (route-scoped `express.raw`), a content-addressed store at `docs/attachments/<taskId>/<sha256>.<ext>` (committed to the private git remote), and a guarded reader `GET /api/tasks/:id/attachments/:file`. A non-allowlisted (e.g. SVG), oversize, or over-cap image is rejected client-side with a friendly note; the server stays authoritative. Shipped with a `DATA_CONTRACT.md` amendment.
- **Chatbot capture -> linked intake record (D1 / ADR-009).** A ChatCapture "Queue it" now ALSO writes an intake-ledger record (`POST /api/requests` with `source: "chatbot"` and the verbatim ask) and links it to the spawned ticket (`PATCH /api/requests/:id { spawned: { tasks: [id] } }`), completing the request -> assessment -> spawned-task origin chain for in-app captures. The ledger write is **best-effort / fail-soft**: it can never block or fail the primary ticket capture.
- **Completed date across the three "most-recent" surfaces (ADR-013).** The dev task board stamps one server-managed, unforgeable `completed` (`YYYY-MM-DD`) field when a ticket enters `done` and clears it on the way out (the value is never trusted from a request body; it is always the server's own local clock). The Job Tracker and Projects view add **no** new stored field: the Job Tracker derives recency from the existing `applied` date (file-mtime fallback) and Projects derives a project's shipped date from its `target` release in the changelog. Disclosed as ADR-013.
- **Advanced multi-condition Job Tracker filter.** A new builder (`src/components/JobFilterBar.tsx` over a pure `src/lib/jobFilter.ts`) filters the Jobs table by an array of conditions joined by one AND/OR combinator; each condition targets a real `Job` field with a type-appropriate operator (enum is / is-not / is-any-of, text contains / empty, date before / after / on). The `completed` field is DERIVED (reuses `jobCompletedDate`) so the filter can never disagree with the tracker's Completed column; state + persistence live in `JobTable`.
- **My-reports you/QA attribution.** The chatbot "My reports" queue now unions two report sources newest-first - owner chatbot reports (label `chatbot`, badged "You") and QA-tester bug tickets (labels `qa-report,bug`, badged "QA") - via a pure `reportSource()` selector (QA-filed wins when a ticket carries both). Surfaces the new QA function's filed bugs in the owner's report view, attributed.

### Changed
- **Dev/infra: an honest activity log + a toolchain upgrade.** The activity-log lint (`ops/activity-log-lint.mjs`) closed a dangling run entry and fixed a lint category error, and `lint:activity-log` is now wired into `npm run check`, so the log's integrity is part of the release gate. The dev test toolchain was upgraded (vitest `^2` -> `^4.1.9`, vite -> `^6.4.3`), clearing all `npm audit` findings.
- **Projects master-detail splits at lg (1024px), single-pane below (Fold responsive).** The two-pane Projects split now turns on at `lg` (1024px), not `md`: the Product Hub's static 288px sidebar rail appears at `md+`, leaving too little content width for a list plus a usable detail at `md`. Below `lg` the view is single-column list-then-detail with a "Back to project list" button, covering the Fold inner (~768px) and cover (~280px) screens.
- **Doc-truth reconciled to the shipped code.** `DATA_CONTRACT.md` now discloses the loopback bind posture beside the "never leaves the machine" guarantee (O-2); `docs/user-journeys.md` moves D4 (needs-attention double-count) into J2 as a now-passing criterion and corrects the AC-J6 responsive breakpoint to the real `lg` split (D6/D11 were reconciled earlier in the window).

### Fixed
- **Needs-attention no longer double-counts a drafted-and-due job (D4).** `computeNeedsAttention` now places each job in at most one bucket by urgency precedence (overdue > due-soon > stale-draft) via a `claimed` set, so a drafted job due in 0-3 days renders once and is counted once in both the Board strip total and the Insights "Needs attention (N)" count.
- **Blank-title Add on the Task board (D6)** now shows an inline "Title is required." and leaves the form open (matching ChatCapture / AddJobModal) instead of silently doing nothing.
- **Silent edit loss in the job detail drawer (D11).** Next-action / Posting-URL edits (which save on blur) are now mirrored to a draft ref and flushed by an unmount effect on every close path (Esc, backdrop, close button), so closing before blur no longer discards the in-progress edit.

Tests 315 -> 451.

## [0.16.0] - 2026-07-03 20:30 ET

Operational-system part 2 + Projects UX. Projects grow an optional **stakeholder register + risk list** (risk severity is DERIVED from likelihood x impact, never stored), the Projects page is rebuilt into a **Linear-style master-detail** that also fixes a real renderer hang, and the Roadmap's phase statuses + header version become **DERIVED** from the portfolio and the changelog so they can no longer drift from what actually shipped. Three gate-green, live-verified waves, each filed as a first-class ticket in the intake ledger.

### Added
- **Stakeholder register + risk list per project (ADR-011).** Portfolio projects gain optional `stakeholders[]` and `risks[]` (`src/types.ts`), passed through `GET /api/portfolio` unchanged and rendered in the Projects **Operational Management** block ONLY when non-empty, so the projects that don't carry them look exactly as before. Risk **severity is derived, never stored**: `riskSeverity` / `RISK_SEVERITY_META` in `src/lib/statusColors.ts` map likelihood x impact to an AA-vetted tint + label. `prj-operational-system` carries its real currency-drift risk (High, mitigating, owner CTO) as the first honest instance.
- **Roadmap phase status + product version DERIVED (ADR-012).** A new pure `src/lib/roadmapDerive.ts` derives each phase's status from its linked portfolio milestones (the `roadmap_phase` join) with release-anchoring from the changelog (a cut release cannot un-ship, so it wins over an in-flight rollup), and sources the header product version + date straight from the latest changelog entry - so the Roadmap can no longer drift from reality. `RoadmapBoard.tsx` shows a subtle "derived" affordance; the stored `roadmap.yaml` values are preserved for reference. 20 new unit tests (`tests/roadmapDerive.test.ts`).

### Changed
- **Projects rebuilt into a Linear-style master-detail.** The Projects view (the owner's top priority) is now a compact, scannable project list beside a rich detail pane: one-click select, no nested expand-collapse dance. New `src/components/ProjectList.tsx`, `ProjectDetail.tsx`, and shared `projectsShared.tsx`. RACI, the new stakeholder/risk block, segmented progress, participant avatar stacks, and the portfolio-pulse tiles are all preserved.
- **Build waves tracked as intake tickets.** All three waves were filed as first-class tickets in the intake ledger (`docs/requests.yaml`), keeping the request -> assessment -> spawned-work audit trail honest.

### Fixed
- **The heavy Projects view was hanging the renderer.** Selecting or opening Projects could lock up the renderer; the master-detail rebuild mounts a single detail pane and memoizes the involvement joins, so selecting a project is cheap instead of re-rendering every project's full detail at once.

Tests 288 -> 315.

## [0.15.0] - 2026-07-03 18:45 ET

Operational management, made visible. A first-class **Intake ledger** records every request (verbatim prompt -> CTO assessment -> the tasks/projects it spawned, with live status), and every project gains a right-sized, PMBOK-grounded **operational block** (Sponsor, Project Manager, and a compact RACI whose Responsible is derived from task owners, never stored). Plus a **Product Hub sidebar** rebuilt for a legible three-level hierarchy. Grounded in a signed-off design (`docs/research/2026-07-03-operational-management.md`).

### Added
- **Intake ledger ("prompt table").** New app-managed store `docs/requests.yaml` + `GET`/`POST`/`PATCH /api/requests`: each request records its **verbatim** prompt (never trimmed or sanitized), source (`session`|`chatbot`), timestamp, the CTO assessment, and the tasks/projects it spawned. A new **Intake** view (Product hub -> Delivery) renders requests newest-first; expanding a row shows the full verbatim prompt, the CTO assessment, and every spawned task/project with its LIVE status read off the board (never copied). 5 existing requests backfilled deterministically from the chatbot/intake-labelled tickets. See ADR-009.
- **Operational-management fields per project (PMBOK-grounded, right-sized).** `portfolio.yaml` projects gain optional `origin_request`, `sponsor` (default `owner`), `project_manager` (default = `accountable`), and `raci { consulted, informed }`. The Projects view renders an **Operational Management** block: Sponsor, Project Manager, and a RACI where the single Accountable IS the existing top-level `accountable` field and Responsible is **derived** from the distinct task owners (the participant join) - never a parallel store. Backfilled truthfully across all 8 projects; the full stakeholder register + risk list are deferred until a project needs them. See ADR-010.
- **Research docs.** `docs/research/2026-07-03-operational-management.md` (the signed-off design) and `docs/research/2026-07-03-hostinger-build-vs-buy.md` (build-vs-buy verdict: skip all - nothing clears the local-first data contract).

### Changed
- **Product Hub sidebar rebuilt for hierarchy.** Domain headers (Delivery / Org & People / Records / Knowledge) now carry a divider + trailing caret (L1), top-level items are primary (L2), collapsible group sub-headers show a visible leading SVG chevron that rotates on expand (L3), and nested docs render lighter with a connecting guide line (L4). Fixes an indentation-inversion bug (domain labels were indented further right than their own children) and replaces the near-invisible 9px triangles. Uniform row rhythm + 44px mobile tap targets; the mobile drawer + focus-trap are preserved (`src/components/HubSidebar.tsx` only; no new tokens, no raw hex).
- **Roadmap reconciled** to include the v0.15.0 wave (the reconcile-at-every-release cadence).

### Security
- **Intake ledger stays on-machine and append-oriented.** `docs/requests.yaml` is a local app-managed write (atomic, disclosed in `DATA_CONTRACT.md`); request text is stored verbatim (only id-typed spawned refs are sanitized); `PATCH` merges/dedupes spawned refs and never deletes. Nothing leaves the machine.

Tests 268 -> 288.

## [0.14.0] - 2026-07-03 17:28 ET

The owner-feedback wave: an in-app notification feed (bell + slide-over panel), the chatbot grown from capture-only into a capture -> CTO-assess -> delegate loop with clipboard/file paste and a "My reports" queue, the Board and Table folded into one Jobs page, rule-based auto-close of expired jobs, and discovery auto-prune before every discovery run - all derived from data the app already holds, all reversible. Assembled from the committed owner-feedback checkpoint plus the notification + prune waves.

### Added
- **Notification feed - bell + slide-over panel (full stack).** Backend: `GET /api/notifications` + `POST /api/notifications/read`, a read-mostly event feed DERIVED from data the app already records - `run_finished` / `wave_done` folded from the durable activity log, and `task_added` / `task_done` / `project_added` diffed from `tasks.yaml` / `portfolio.yaml` against a persisted baseline. No push infra and no event store; the only write is one small app-managed state file (`docs/notify-state.json`: a read cursor + a task/project baseline snapshot), written atomically. `POST /read` advances the cursor and snapshots the baseline so unread clears on view. Runner run lines now carry an optional `batchId` so `wave_done` is derivable from the durable log across restarts. Frontend: a `NotificationBell` in the TopBar with an unread badge, opening a focus-trapped, `role=dialog` `NotificationPanel` slide-over (same Escape-to-close / Tab-trapped / restore-focus contract as the app's other overlays) with per-event-type show/hide settings persisted client-side; timed events show a relative clock, detection events a "new" chip; every tint comes from the AA-vetted `lib/statusColors` (no raw hex), and icon+label carry meaning so rows read for color-blind users. New `src/components/NotificationBell.tsx`, `NotificationPanel.tsx`, and a DOM-free `src/lib/notifications.ts` (vocabulary, per-type metadata, color mapping, filter/unread-count). See ADR-007.
- **Chatbot "My reports" queue + CTO assessment surfaced in the panel.** Reports filed through the chat-capture surface are tagged `chatbot` at creation; the panel now shows that set newest-first with the latest CTO verdict inline. New DOM-free `src/lib/chatbotQueue.ts` (`filterChatbotReports`, `latestCtoComment`).
- **Clipboard / file paste into a chatbot report.** A "Paste from clipboard" button (`navigator.clipboard.readText`, with a soft fallback note when blocked/unavailable) plus a textarea paste/drop handler that ingests pasted or dropped files and appends their text, while plain-text paste falls through to the native handler. Soft ingest notes cover empty clipboard, blocked permission, and skipped binary.
- **`assess-ticket` routine + append-only ticket comments API.** Every chatbot ticket auto-fires a comment-only CTO assessment (verdict, plan, subtask checklist, suggested owner/priority; may triage `triage -> todo`). A ticket comment `{ author, ts, body }` is an append-only feedback log: the ONLY way to grow it after creation is the `PATCH /api/tasks/:id` append-a-`comment` operation (server-stamps `ts`; there is no whole-array PATCH write, so history cannot be rewritten). See the ADR-005 ticket-scope addendum.
- **Discovery auto-prune before `discover-jobs`.** New `prune` subcommand in the vault's `discovery.py` MOVES dead `Discoveries` rows (a real deadline strictly before today, not decided `pursue`, and not already a `Jobs/` folder) into an `Archive` sheet with a provenance stamp - never deleted, fully reversible. `POST /api/routines/run` for `discover-jobs` runs prune first via `execFile` (reusing the `PYTHON` resolver + the same workbook-lock handling); a locked or failing workbook is skipped and never blocks the run. See ADR-008.
- **Rule-based auto-close of expired pre-application jobs.** On the first job-list load of each day, any job still in `lead` / `queued` / `drafted` whose `deadline` is a literal `YYYY-MM-DD` strictly before today's local date gets `status: closed` + `next_action: "Auto-closed: deadline passed"`, written through the same surgical frontmatter path as a manual edit. No agent, visible as a clean two-line diff, reversible; applied, terminal, and no-deadline / free-text-deadline jobs are never touched.
- **TeamView equipped-skills chips.** Each agent card in the Team drawer now shows that agent's equipped skills.
- **Task-lifecycle SOP + supporting docs.** `docs/task-lifecycle-sop.md` (stages, actors, project/milestone relationships), the `token-efficiency` skill (v1), and research notes (`docs/research/2026-07-02-loop-optimization.md`, `docs/research/2026-07-03-operational-management.md`).
- **New tests.** `tests/notifications.test.js`, `notifications-ui.test.ts`, `chatbotQueue.test.ts`, `discover-prune.test.js`, `assess-ticket.test.js`, `auto-close.test.js`, `task-comments.test.js`, plus `lib.test.js` / `api.test.js` additions.

### Changed
- **Jobs IA: Board + Table merged into one Jobs page.** `ViewMode` collapses `board` / `table` into a single `jobs` page (Airtable-style) with a segmented view switcher (`JobsViewMode`, persisted); the Jobs table groups by status and sinks submitted/closed rows to the bottom. The bell rides in the TopBar on every page.
- **Governance & data contract updated.** `DATA_CONTRACT.md` discloses the four new writes (auto-close frontmatter, the `notify-state.json` state file, the automatic workbook archive, and the ticket-scoped routine comment); `docs/governance.md` gains ADR-007 (derived notification feed), ADR-008 (discovery prune), and an ADR-005 addendum on the ticket-scoped `work-ticket` / `assess-ticket` routines.

### Fixed
- **BOM in job frontmatter silently hid jobs from the dashboard.** A UTF-8 byte-order mark ahead of the opening `---` broke frontmatter parsing so the job never appeared in the pipeline (2 real jobs were invisible); frontmatter reads now tolerate a leading BOM.

### Security
- **Ticket-scoped routines stay inside the ADR-005 sandbox and are validated before spawn.** `work-ticket` and `assess-ticket` point the agent at a `docs/tasks.yaml` ticket whose id is validated against the real task list before anything spawns, run under the same config-editable `claudeAllowedTools` / `acceptEdits` / visible-and-stoppable posture, and never fire on the server's own initiative (the run is click-gated client-side). `assess-ticket` is comment-only by charter: its prompt forbids executing the work, editing code or files, or creating other tickets, and it records exactly one assessment via the app's task API, never by hand-editing `tasks.yaml`.
- **Every new write is reversible and self-disclosing.** Discovery prune moves rows to an `Archive` sheet (never deletes); auto-close is a frontmatter status change (never a delete); the notification feature writes only `notify-state.json` (atomic, and re-seeds if deleted). All four are disclosed in `DATA_CONTRACT.md`.

Tests 202 -> 268.

## [0.13.0] - 2026-07-02 03:10 ET

Execution views redesigned, an in-app chatbot, and per-document review progress - a five-build wave.

### Added
- **Chatbot capture-and-delegate (v1):** a global chat slide-over. "Queue it" files a Triage ticket via the existing task API (no LLM); "Queue & delegate now" is confirm-gated, then fires the new `work-ticket` routine. New `ChatCapture.tsx`, "c" shortcut, focus-trapped.
- **`work-ticket` backend routine:** the runner's scope check generalized to tickets (not just job folders); the routine reads a ticket and runs a CTO agent against it, updating status via PATCH. Sandbox unchanged.
- **Reviews & Logs per-document progress table (`DocTicketsPanel`):** per-doc recommendations -> linked tickets -> status/progression, plus a "pending decisions" callout for untriaged recs.
- **`session-debrief` routine:** an end-of-session loop (recap, verify-nothing-at-risk, propagate lessons, queue next).

### Changed
- **Projects + Tasks execution views redesigned** (referencing Linear/Asana/Jira/Monday): every task card now shows its **project** (a `ProjectChip` that focuses the board); Projects gained a portfolio "pulse" header + active-vs-completed split + a decluttered project -> milestone -> task card; TaskBoard gained group-by-project swimlanes, a project filter, empty-lane suppression, and a cleaner card.
- Activity feed resolves each routine to its agent title ("manager" now shows as "CTO / Orchestrator").
- Enablement review actioned (equipped `loop` for the CTO; the rest deferred with sharper reasons); roster healthy 13.

Tests 190 -> 202.

## [0.12.1] - 2026-07-02 00:30 ET

Post-audit hardening + accessibility: closing the worthwhile remaining ultracode-audit findings.

### Added
- Shared status-color module (`src/lib/statusColors.ts`) - the single WCAG-AA-vetted source for status/group/type colors, with a contrast-sweep test so a bad hex fails CI.
- React `ErrorBoundary` so a malformed data payload no longer white-screens the app.
- Activity-log lint (`ops/activity-log-lint.mjs`) + a documented terminal-only logging protocol (flags dangling/idless "running" entries and unknown routines).
- Git pre-push hook running `npm run check`; OS-level weekly enablement-review schedule (Windows Task Scheduler).

### Changed
- Per-file status-color maps removed and migrated to the shared module across the app; new `--color-accent-text` token for legible accent-as-text.
- Stale project / milestone / task statuses reconciled; a status-reconciliation step added to the release checklist.

### Security
- `/api/open` now uses `execFile` (no shell re-parse); routine-runner gained a `jobId` path-traversal guard.

### Fixed
- YAML read-endpoints normalized (a partial hand-edit yields `[]`, not a white screen); task `priority`/`type` enum validation.

Tests 154 -> 190.

## [0.12.0] - 2026-07-01 22:15 ET

Product Hub IA v2 ships as a real feature wave: the sidebar consolidates to four domains, Reviews & Logs / Briefs & Debriefs / Releases become structured, clickable tables (Reviews joins tickets by source for an honest addressed-vs-not count), and every agent gets an employee/onboarding page reachable straight from Team. The Projects page is redesigned to Linear/Jira/Asana patterns. A small backend foundation (frontmatter parsing, a verbatim ticket `source` field) underpins the new views. Tests grow 110 -> 154.

### Added
- **Consolidated four-domain navigation.** The Product hub's roughly 9 flat sidebar sections collapse into four top-level domains, Delivery / Org & People / Records / Knowledge, each nesting its views and doc groups (`src/components/ProductHub.tsx`, `HubSidebar.tsx`).
- **Records structured views.** Reviews & Logs, Briefs & Debriefs, and Releases render as clickable tables/cards instead of raw markdown lists: new `src/components/RecordsTable.tsx`, `ReleasesView.tsx`, `BriefsDebriefsView.tsx`, `ReviewsLogsView.tsx`. Reviews & Logs shows an addressed-via-tickets count per review, joining tasks whose `source` matches `review:<doc>`; the ULTRACODE governance audit shows an honest 4/5 addressed.
- **Employee page and Team click-through.** The Team agent drawer (`src/components/TeamView.tsx`) gains an onboarding pill, a "Reviewed in" section, and involvement items that navigate to their source.
- **Backend foundation for the new views.** Tasks gain an optional verbatim `source` field (not id-sanitized, so values like `review:enablement-reviews/2026-07-01` round-trip untouched); a new `parseFrontmatter` helper (`server/lib.js`) powers an optional `meta` object on `GET /api/docs` and frontmatter-stripped content on `GET /api/doc` (`server/index.js`, `src/types.ts`, `src/api.ts`).
- **Doc frontmatter** added to the 7 docs the new Records views read: `docs/enablement-reviews/*`, `docs/agent-roster-audit.md`, `docs/audits/*`, `docs/briefs/*`, `docs/build-log-2026-07-01.md`.
- **5 audit-fix tickets** backfilled into `docs/tasks.yaml`, tagged `source: review:audits/2026-07-01-ultracode-audit` (4 done, 1 in progress), so the new Reviews & Logs join has real tickets to count.
- **Tests 110 -> 154.** Pure logic extracted out of components into `src/lib/changelog.ts`, `addressed.ts`, and `projectStats.ts`, each with its own test file (`tests/changelog.test.ts`, `addressed.test.ts`, `projectStats.test.ts`).
- **The IA v2 brief and debrief**: `docs/briefs/2026-07-01-ia-v2-build.md`, status shipped.

### Changed
- **Projects page redesigned** (`src/components/ProjectsView.tsx`) to Linear/Jira/Asana patterns: segmented progress bars, milestones first-class, avatar stacks for participants.

### Fixed
- **Accessibility fixes across the new Records surface.** `RecordsTable` clips to scroll instead of overflowing, long titles truncate instead of wrapping the layout, and roughly 10 color-contrast bumps bring the new views to WCAG AA.

---

## [0.11.1] - 2026-07-01 20:32 ET

Post-v0.11.0 hardening pass: the first ULTRACODE governance audit ran against the app, the agent-org meta layer, and the governance/dev-flow artifacts, and its top-5 fixes shipped. No new user-facing feature this release; the Product Hub IA v2 rebuild lands as design and backlog only, with the build itself targeted for v0.12.0.

### Added
- **ULTRACODE governance audit.** First run of the standing Governance Auditor role: `docs/audits/2026-07-01-ultracode-audit.md`. 21 findings raised, 20 confirmed real (11 corrected downward on adversarial re-verification), none rated high; 1 refuted. Surfaced under Reviews & Logs in the docs browser (`DOC_SUBDIRS`, `server/index.js`).
- **Governance & Audit role.** A lean, independent `governance-auditor` agent registered in `docs/agents.yaml` (new `governance` group, `reports_to: owner`, for separation of duties from the CTO it audits).
- **CRLF round-trip test** (`tests/lib.test.js`), locking the fix below: asserts every CRLF pair survives a status write and exactly one line (the targeted field) changes.
- **Product Hub IA v2: design and charter (planning only, not built).** `docs/product-hub-ia-v2.md` scopes consolidating the flat sidebar into four domains, structured record views (Reviews & Logs, Briefs & Debriefs, Releases), addressed-via-tickets tracking, and an employee/onboarding page per agent. Chartered as `prj-product-hub-ia-v2` (target v0.12.0, 4 milestones) in `docs/portfolio.yaml`, with the epic's tickets plus 12 backfill tickets added to `docs/tasks.yaml`. `prj-connected-execution` (v0.11.0) is chartered retroactively to close the ticketing gap the audit flagged. `docs/pm-conventions.md` gains section 10: a ticket per chartered job, so the board (not only the activity log) stays the complete engineering record.

### Changed
- **Weekly enablement review folds in operational health metrics** (throughput, cycle time, WIP, open blockers, on-time delivery), computed read-only from the activity log, task board, and portfolio, per the owner's decision not to stand up a separate ops reviewer.
- **A proposed Chief Operating Officer role was scoped and parked, not adopted** (`docs/proposals/chief-operating-officer.md`); its operational-health-metrics idea moved into the weekly enablement review instead of adding a second reviewer.
- **Trust-critical docs reconciled to match the code.** `DATA_CONTRACT.md`, `docs/governance.md`, and `CONTRIBUTING.md` now scope the "nothing leaves the machine / never touches anything outside `Jobs/`" guarantee to the file bridge (the Express API and UI), and separately describe the human-gated ADR-005 routine runner's broader, config-editable tool list (Bash, Write, WebFetch) and network reach. The CI "blocks merging" wording is corrected: this is a solo repo with no branch protection, so a red run is a visible signal to fix before shipping, not a platform-enforced gate.
- **Tests 109 -> 110.**

### Fixed
- **CRLF-preserving frontmatter writes.** `updateFrontmatter` (`server/lib.js`) now detects a file's dominant line ending and rejoins with it, instead of always rejoining with `\n`. 63 of the app's 112 real job files are CRLF; the old behavior rewrote every line ending on a single-field status change, breaking the "surgical one-line diff" and byte-identical-body promise.
- **Atomic writes for the two frontmatter/task write paths.** A new `writeFileAtomic` helper (stage to `.tmp`, `fs.renameSync` over the target) is now used by `updateFrontmatter` and `saveTasks` (`server/index.js`), so a reader of the OneDrive-synced vault can never observe a half-written source of truth.

### Security
- **Dev server bound to localhost by default.** `vite.config.ts` now sets `host: "127.0.0.1"` and `allowedHosts: ["localhost", "127.0.0.1"]` instead of binding every interface (`0.0.0.0`) by default; LAN/phone or tunnel access becomes a deliberate opt-in rather than the default posture. Takes effect on the next dev-server restart.
- **CI dependency gate.** `.github/workflows/check.yml` runs `npm audit --omit=dev --audit-level=high` before `npm run check`, scoped to production dependencies. A dev-only vitest/esbuild vulnerability is documented and deferred to a future vitest major bump; production dependencies are clean.

---

## [0.11.0] - 2026-07-01 13:57 ET

Connected execution: the org, the projects/milestones/tasks, and the activity feed are now cross-linked, so participation is visible both ways. The doc-browser taxonomy is refined, and the first weekly enablement review ran against a full activity log.

### Added
- **Connected execution.** A new pure join module, `src/lib/involvement.ts` (`agentInvolvement`, `projectParticipants`, `normalizeRoutine`), implements the participant/involvement model from `docs/pm-conventions.md` section 9, including the canonical `manager` -> `cto` alias. The **Projects** view now shows each project's owner, accountable, and participant chips, with milestones first-class (project -> milestone -> task, with progress). The **Team** view makes every agent card clickable, opening an accessible, focus-trapped drawer showing that agent's projects, tasks, and activity; `GROUP_COLOR` gained `people` and `career-delivery`. Backing data: `docs/tasks.yaml` backfilled so 24 tasks now carry `project` / `milestone` / `owner` / `delegated_by`.
- **Weekly enablement review.** First full run (not degraded) against the real activity log: `docs/enablement-reviews/2026-07-01.md`. Roster healthy 12 / drifting 0 / gap 0. `docs/agent-roster-audit.md` updated with the addendum. A new standing rule, **integrate-or-it-doesn't-count**, is encoded into `docs/management-philosophy.md`: a feature is not done until it is wired into the existing system, populated with real data, and visible in its actual surface.
- **Tests 93 -> 109.** New coverage: `involvement.test.ts` (13 tests for the join module) plus 3 docs guards for the enablement-review report.

### Changed
- **Doc-browser taxonomy refined** (`server/index.js`). The flat "Org & agents" catch-all is now 7 coherent groups: Product, Org & Agents, Routines, Reviews & Logs, Briefs & Debriefs, Releases, Docs. Routines and dated audits are split out of the old catch-all; `competitive-analysis` moves to Product; the new `enablement-reviews/` folder surfaces under Reviews & Logs.

---

## [0.10.1] - 2026-07-01 09:10 ET

The Product hub becomes a Confluence-style docs browser with a sidebar and an auto-discovered docs tree; rendered Markdown gets XSS hardening; the Execution pillar fills in with real project data.

### Added
- **Product hub redesign (Confluence-style).** The flat 8-tab row is replaced by a grouped, collapsible left sidebar plus a content pane plus a breadcrumb. A new data-driven **Docs** section auto-lists every markdown doc (`docs/*.md`, `docs/routines/`, `docs/briefs/`) with a filter box, and is responsive down to a mobile drawer. Backend: `GET /api/docs` (auto-list and group) and a generic, path-safe `GET /api/doc/*` replace the old 3-entry whitelist. New components `HubSidebar.tsx` and a rebuilt `ProductHub.tsx`; `MarkdownDoc.tsx` generalized to render any doc path.

### Changed
- **Execution pillar populated with real work.** `docs/portfolio.yaml` gains 6 projects and 12 milestones covering the company-os, usability/accessibility, ticket-board, discovery-triage, and product-hub-redesign work; the Activity feed (`docs/activity-log.jsonl`) now carries real delegation records.
- **Tests 79 -> 92.** New coverage for `GET /api/docs`, the generic `GET /api/doc/*` path-safety guard (traversal and non-md paths rejected), and the redesign surfaces. The `GET /api/activity` "empty file" test now runs against a temporary docs directory instead of the real `docs/` folder, so it no longer breaks when real activity data is present.

### Security
- **XSS hardening on rendered Markdown.** `MarkdownDoc` now runs `marked`'s HTML output through `DOMPurify` before rendering, closing a markup-injection risk in any doc content it displays. New dependency: `dompurify` ^3.4.11 (zero runtime deps, from cure53).

### Fixed
- **Mobile-drawer keyboard trap.** The Product hub's mobile sidebar drawer now traps focus while open and restores focus to the trigger element on close, completing the modal-dialog keyboard and screen-reader contract.

---

## [0.10.0] - 2026-07-01 00:12 ET

Activity log, typed ticket board, Discovery triage, inline gaps editor, People & Enablement agent, and the Career Delivery agent group. File-bridge watcher hardened; tests grow 54 -> 79.

### Added
- **Activity / Delegation log.** `GET /api/activity` serves `docs/activity-log.jsonl` (in-app routine runs: agent, task, times, outcome) rendered in a new **Activity** top-nav tab. The `SubagentStop` hook that extends capture to agent delegations requires a one-time user paste into `settings.json` - the exact snippet lives in the Governance doc.
- **Linear-style ticket board** (Product hub -> **Tasks**). Tickets gain `type` (`bug` / `feature` / `chore` / `spike`), a **Triage** inbox column, `labels`, `estimate`, `assignee`, and per-ticket **tickable checklists**. Type + status filters on the board header. The 7 optional task fields (`project`, `milestone`, `owner`, `delegated_by`, `acceptance`, `user_story`, `wbs`) are now writable via `POST /api/tasks` and `PATCH /api/tasks/:id`.
- **Discovery triage: Skip / Maybe.** Three-button triage (Pursue / Skip / Maybe) beside each Discovery find. `POST /api/discovery/decide` calls `discovery.py decide` to write the Decision back to the workbook so skipped or maybe finds are not re-surfaced.
- **Inline gaps editor** in the job drawer. The gaps markdown is now editable in place; `PUT /api/jobs/:id/file` writes the file back, restricted to `gaps.md` and `job-description.md` inside the job folder only.
- **People & Enablement agent** (`~/.claude/agents/people-enablement.md`, registered in `docs/agents.yaml`). Owns roster health audits, agent onboarding, capability adoption, and standards currency. First deliverables: `docs/agent-roster-audit.md` (10-agent drift + gap audit) and `docs/agent-onboarding-checklist.md`. Model + effort selection rubric encoded into `~/.claude/agents/manager.md` and `docs/management-philosophy.md`.
- **Career Delivery agent group.** Three new agents in `~/.claude/agents/` and `docs/agents.yaml`: `job-search-scout` (discovery, triage, track-mapping), `application-writer` (CV + cover letter from facts, never hand-edits artifacts), and `interview-offer-coach` (STAR prep, mock questions, offer comparison, negotiation).
- **`weekly-enablement-review` routine** (`workspaces/daily/ops/routines/weekly-enablement-review.md`). Cross-agent drift check with a brief health-report output.
- **Docs added:** `docs/agent-roster-audit.md`, `docs/agent-onboarding-checklist.md`, `docs/competitive-analysis.md` (7-tool benchmark, 15 capabilities), `docs/pm-conventions.md`, `docs/management-philosophy.md`.

### Changed
- **File-bridge watcher hardened.** Chokidar watcher gains an `.on("error")` handler and an ignore list for Office temp / lock files (`~$*`, `*.tmp`, `mso*`). Dev server ownership consolidated: one main-session-owned process; sub-agents and scripts must not start or stop it.
- **Tests 54 -> 79.** New coverage: `GET /api/activity` shape + empty-feed tolerance; ticket type / label / estimate / checklist create + patch; `POST /api/discovery/decide` round-trip; `PUT /api/jobs/:id/file` write-path + path-restriction guard.

### Fixed
- **File-bridge crash on Office temp-file locks.** An unhandled chokidar `error` event on Windows `EBUSY` locks (`mso*.tmp`, `~$*`) took down the Express server - the load-bearing vault write path. Fixed by the error handler and ignore patterns added above.

### Notes
- **Agent character-sheet cards (deferred).** Inline character-sheet cards in the Team view need a data-plumbing pass. Parked - current roster cards remain the default view.
- **Delegation hook: user-applied step.** The `SubagentStop` hook that feeds agent delegations into `activity-log.jsonl` lives in user-owned `settings.json` and cannot be auto-wired by a release. Snippet to paste is in the Governance doc.

---

## [0.9.0] - 2026-06-30 22:02 ET

The product now describes and operates itself as a real org, gains an Execution pillar (project -> milestone -> task), and lands a broad daily-tool usability + accessibility overhaul.

### Added
- **AI product-dev org + Team page.** A new Product-hub tab, **Team** (`src/components/TeamView.tsx`), renders the org chart, the agent roster, and the Manager Operating System from one source of truth, `docs/agents.yaml`, kept **concise** so the page scans at a glance. The org is the human **Owner** (Simon), the **CTO / Orchestrator** (the main Claude Code session), and **8 reusable agents**: product-manager, software-architect, frontend-engineer, ui-ux-expert, test-engineer, security-privacy-guardian, release-manager, and tech-writer. Each role links to its definition at `~/.claude/agents/<id>.md`; the chart draws the reporting tree (`reports_to`, e.g. the Frontend Engineer reports to the Architect) and lateral collaboration edges (`collaborates_with`), clustered by function.
- **Recursive Manager Operating System (MOS).** `docs/agents.yaml` gains a `management` block encoding the reusable 7-step manager loop, resolve / dissect / delegate / recurse / verify / integrate / optimize, flagged `recursive` and `shadow_mode`, with five cited principles from the agent-orchestration literature. The same loop runs at every level: a manager delegates work down to the best-fit report, a report that is itself a manager recurses, leaves execute, and verified results integrate up. Full cited philosophy: **`docs/management-philosophy.md`**; reusable manager template: `~/.claude/agents/manager.md`.
- **`GET /api/agents`** (`server/index.js`): a read-only endpoint that serves the parsed `docs/agents.yaml` (groups, roles, and the management block) to the Team page. App data, not the vault; it never writes.
- **Execution pillar: `docs/portfolio.yaml` + `GET /api/portfolio`.** A hand-edited Project -> Milestone hierarchy (the team WBS), served read-only by a new endpoint parsed with the YAML JSON schema. Formalized in **ADR-006** and documented by the new **`docs/pm-conventions.md`** (task-title format, WBS code, user-story / acceptance standards, status vocab, roadmap reconciliation).
- **Projects hub tab** (Product hub -> **Projects**): renders the project -> milestone -> task tree with per-milestone progress, joining the portfolio with the tasks that reference up into it.
- **Optional task structure (7 backward-compatible fields).** `docs/tasks.yaml` tasks may now carry `project`, `milestone`, `owner`, `delegated_by`, `acceptance`, `user_story`, and `wbs`, all referencing UP into the portfolio. One shared write-contract feeds both `POST` and `PATCH /api/tasks` (text fields written verbatim; id fields run through **`sanitizeId`**, a lowercase / trim / `a-z0-9._-` shape guard), so the create and patch paths cannot drift. Every existing task omits the new fields and stays byte-identical.
- **`JOBHUNT_DOCS_DIR` test seam** (`server/index.js`): doc-write tests point at a throwaway docs dir (mirrors `JOBHUNT_JOBS_DIR`), so tests never mutate committed files; default behavior is unchanged.
- **Daily-tool additions:** an **Undo toast** on status changes; a **Board Archive toggle** (rejected / closed jobs hidden by default, revealed on demand); a **Needs-attention strip** atop the Board; a Discovery **loading skeleton**; **applied** and **next-action** columns in the Table; a **focus trap** in the job Detail drawer; keyboard-openable job cards and table rows; and an inline delete-confirm on the TaskBoard.

### Changed
- **Product hub reshaped:** the **Workflow** tab was removed and folded into **Governance**; hub tab touch targets enlarged.
- **Status-change friction reduced to consequential moves only** - the transition popup now interrupts only when a move has real consequences, and an **Undo** toast covers the rest.
- **Discovery cleanup:** the disabled Apify button was removed and the trigger renamed to **"Run discovery"**.
- **Table** header buttons are now sortable with `aria-sort`; the **Insights** "by sector" breakdown was demoted to a collapsible section.
- **44px touch targets** applied across modals, panels, and hub tabs.
- **Governance** records the agent org and the Manager Operating System, adds **ADR-006** (the execution pillar), and the documentation map (section 6) now lists `docs/agents.yaml`, `docs/management-philosophy.md`, `docs/portfolio.yaml`, and `docs/pm-conventions.md`.
- **Blueprint** notes that the product is built and operated by the AI agent org via the recursive Manager Operating System.
- **Roadmap** adds a **Company OS** phase and marks the execution pillar, the concise Team page, the daily-tool usability + accessibility overhaul, and the Projects view as shipped; the Fold responsive review stays in progress.
- **Tests grew 40 -> 53** (portfolio shape + referential integrity, `sanitizeId`, task-field create / patch, tolerance of unresolvable refs, doc write-isolation, and the deadline boundary guard). `npm run check` is green at **53 tests**.

### Fixed
- **Insights bar contrast** now meets WCAG AA: a `readableOn` helper picks a legible foreground for each bar color.
- **Deadline off-by-one.** `daysUntil` now compares calendar days at local midnight instead of end-of-day-minus-now with a ceiling, so a passed deadline reads as overdue on the next day (a June 29 deadline is "closed 1d ago" on June 30, not "due today"). Fixes the label everywhere it is used - the Table, the Board deadline pills, and the Needs-attention strip. Guarded by a today / yesterday / tomorrow boundary test (tests now at 53).

---

## [0.8.0] - 2026-06-30 02:02 ET

Phone-ready (Galaxy Fold 6) + LAN access, plus accessibility fixes.

### Added
- **Use it on your phone:** the UI now binds to the network (Vite `host`), so a phone on the same WiFi opens `http://<pc-ip>:5180` (this PC: `192.168.2.79`). **SETUP.md** documents every step - WiFi (no signup), optional free **Tailscale** for off-WiFi access, firewall, and Fold notes.
- **Responsive foundations:** the header wraps; the nav and Product-hub tabs scroll horizontally; panels/modals use viewport widths - usable on the Fold cover (~360px) and unfolded inner (~840px) as well as desktop.
- The **ui-ux-expert** subagent now explicitly targets two device modes (desktop + Galaxy Fold 6 cover/inner) and resizes to ~360 / ~840 / ~1280px when auditing.

### Fixed
- **Esc now closes every overlay** (status popup, run/batch panels, error toast); the keyboard effect's dependency array was stale and would have missed the newer overlays - fixed.
- **Global `:focus-visible` rings** for keyboard accessibility.

### Notes
- A thorough Fold responsive polish is queued as a ui-ux-expert task. The PC must be on and running `npm run dev` for phone use.

---

## [0.7.0] - 2026-06-30 01:48 ET

Progress analytics + batch drafting.

### Added
- **Insights view** (top nav, key `i`): pipeline funnel, weekly velocity, interview/offer rates, by-track and by-sector breakdowns, and a **needs-attention** panel (overdue, due <=3 days, stale drafts). Computed client-side from the job files; no new dependencies. (Phase 2 shipped.)
- **Batch-draft**: "Draft queued (N)" fans out `first-draft-job` across queued jobs, bounded by the runner's concurrency cap, with a batch progress panel. New `/api/routines/batch` endpoints + a shared `startRun` + queue.

### Changed
- **Roadmap reconciled to reality**: Phase 2 marked shipped; Phase 3 items for the in-app Discovery view + batch-draft marked done; a "Quality, UX & Docs" phase added for the tests/popup/workflow/runner work.

---

## [0.6.0] - 2026-06-30 01:35 ET

In-app Discovery (off Excel), and an Apify lead-source assessment.

### Added
- **Discovery view** (top nav, key `d`): reads the Job Discovery workbook through a new `discovery.py dump` command (reuses the existing dedup logic, so you never open Excel). Lists finds with track / fit / deadline / source, flags ones already tracked, **Pursue** turns a find into a lead (carrying the discovered track + fit), and **Run discovery** triggers the `discover-jobs` agent. Config + run log shown.
- Endpoints `GET /api/discovery` and `POST /api/discovery/pursue`; a shared `createJobFolder` helper (used by manual Add-lead and Pursue) with integration tests.
- `discovery.py` gained a read-only `dump` command (additive; vault linter clean).

### Research / decision
- **Apify assessed: PARTIAL YES.** Add hosted Apify MCP scoped to two pay-per-result actors (Indeed + Google Jobs) to augment discovery on mainstream boards (fire/life-safety, aerospace, B2B/ops); keep the LLM routine for niche/government/higher-ed sources Apify cannot reach; avoid LinkedIn cookie actors (ban risk). Queued on the Tasks board with the exact MCP setup command. Needs the user's free Apify API token.

---

## [0.5.0] - 2026-06-30 01:22 ET

Tests are real now, plus a status-change popup and a workflow visual.

### Added
- **Test suite (Vitest), 34 tests, `npm run check` gate** (typecheck + tests): unit tests for the load-bearing `updateFrontmatter` write path (replace / insert / delete / byte-identical round-trip / rejects non-frontmatter), `normDate`, `yamlScalar`, and the frontend date utils; integration tests over a fixture vault (supertest) for `GET /api/jobs`, the `PATCH` round-trip + applied-stamp, and agent-first `POST` create-lead. Executes the testing epic (board tasks t-001..t-011).
- **server/lib.js**: pure, side-effect-free helpers extracted from `index.js` so they are testable; the app is now importable (`JOBHUNT_TEST`) for integration tests.
- **Status-change popup**: dragging a card or using the new table status dropdown shows the transition's **trigger + what happens** (and side effects, e.g. the applied stamp) before it is written. Mirrors the SOP status table.
- **Workflow visualization** (Product hub -> Workflow): the feature lifecycle + release pipeline, drawn.
- **Bounded parallelism + sustainability**: the routine runner caps concurrent agents (`maxConcurrentRuns`, default 4, returns 429 over the limit) and prunes old run history to keep memory bounded.
- `CONTRIBUTING.md`.

### Fixed
- `npm run typecheck` caught a real type mismatch (task `priority` widened to `string`); fixed the API signature.

---

## [0.4.0] - 2026-06-30 01:02 ET

A task board to dissect work, and a quality/testing constitution.

### Added
- **Task board** (Product hub -> **Tasks**): a granular dev backlog with columns (backlog / todo / in progress / done), per-task epic + priority, add / move / delete, persisted to `docs/tasks.yaml`. Seeded with the dissected testing-adoption tasks (epic `testing`) plus discovery + analytics epics.
- **Quality & testing constitution** (Governance section 7): test layers (unit / integration / manual smoke / vault linter), required measures gated by stage, and non-negotiables (the `updateFrontmatter` write path must have passing tests before any release; a red test blocks release).
- Validated the agent loop end to end: a live `first-draft-job` run produced a tailored CV + cover letter + gaps page and flipped a Mitacs lead to `drafted`.

### Notes
- Tests are not written yet on purpose: their implementation is dissected into tasks on the board (epic `testing`, t-001..t-011) to be executed next, per the constitution.

---

## [0.3.0] - 2026-06-30 00:36 ET

The dashboard can now run your routines. Agent-first intake corrections.

### Added
- **Routine runner (scoped autonomous agent).** A **Run** button launches the matching vault routine as a headless Claude agent restricted to an explicit, **config-editable** tool allow-list (`config.json` -> `claudeAllowedTools`), running in the vault and never auto-submitting. A bottom-right **run panel** shows status + output and can stop the run.
  - **Discover** button in the top bar -> runs `discover-jobs`.
  - **Draft CV + cover letter** / **Finalize** buttons in the job drawer -> run `first-draft-job` / `finalize-job` for that job (with a "copy command" fallback).
- ADR-005 (scoped-agent execution model) in Governance.

### Changed
- **Agent-first intake fix.** "Add" no longer asks you to pick `track`/`fit` (the `first-draft-job` agent assesses those); the form now captures only human-known facts (role, employer, sector, deadline) and is labelled **Add a lead**. `tailoring` is derived from sector, matching `discovery.py`.
- Drawer fields are now labelled **overrides** ("the agent sets these when drafting").
- Workspace is trusted for headless runs; the agent loads your `CLAUDE.md` + routines. (Backup of `~/.claude.json` saved.)
- Shortcut docs updated to include `p` (Product hub).

### Fixed
- Dev server runs as plain `node` instead of `node --watch`, so launching a routine no longer restarts the server and drops the in-flight run (the run map is in-memory). `dev:server:watch` is kept for active server development.

### Notes
- Remaining Phase 3: in-app Discovery view (off the Excel workbook), evaluate/rubric + ghost-job check, follow-up/prep, activity timeline.

---

## [0.2.0] - 2026-06-30 00:05 ET

The product now documents and governs itself in the web.

### Added
- **Product hub** (top nav, key `p`) with four tabs: **Roadmap** (a project board showing what is shipped / in progress / planned / later, with per-phase checklists and progress), **Blueprint / SOP**, **Governance**, and **Changelog**.
- **Governance doc**: roles, the feature lifecycle, Definition of Ready/Done, deployment & release rules, versioning, change control, guardrails, cadence/reminders, a documentation map (one home per thing), and a decision log (ADR-001..004).
- **Agent-actions panel** in the job drawer: copies the exact routine command (`first-draft-job`, `finalize-job`) to paste into Claude Code - a safe bridge until in-app triggering ships.

### Changed
- **Blueprint** now documents the data model explicitly: there is **no database**; the dashboard and the Obsidian Job Tracker read the same `<Role>.md` files (verified: 24 jobs added outside the app appeared automatically, 53 -> 77, no duplicates). Added the **agent-first operating model** ("who does what") so controls trigger existing routines instead of reimplementing them.
- **Roadmap**: Phase 3 reframed as the **Agent Command Surface**.

### Notes
- The true one-click **routine runner** and the in-app **Discovery** view are the next increment, pending a decision on the execution model (autonomous agent vs the copy-command bridge). Captured on the roadmap.

---

## [0.1.0] - 2026-06-29 23:35 ET

First working release. The command center is live end-to-end over the real vault (53 jobs).

### Added
- **File-bridge server** (Express): reads every `Jobs/<Role> - <Employer>/<Role>.md`, performs surgical one-line frontmatter writes, creates new job folders, and opens generated files (CV / cover letter / posting) in the OS default app.
- **Live reload**: a chokidar watcher streams a "files changed" event over Server-Sent Events so the board refreshes when a file changes here, in Obsidian, or via the Python pipeline.
- **Kanban board** by status (`lead -> queued -> drafted -> submitted -> interview -> offer -> rejected -> closed`) with drag-to-change-status that writes straight back to the file.
- **Table view**: sortable by role, employer, status, fit, track, deadline.
- **Search** (role / employer / track) and **track filter**.
- **Detail drawer**: edit status, fit, track, sector, tailoring, deadline, next action; read the lead-with, gaps checklist, and full note; one-click open of generated documents.
- **Add application**: creates a properly structured job folder + `<Role>.md` in the vault.
- **Keyboard shortcuts** (`/ n b t Esc`) and a **weekly-target ring** (applications submitted in the last 7 days).
- **Product hub** (this section): a rendered Blueprint/SOP, a Roadmap project board, and this changelog - so the product's stage and history are visible in the web.
- **DATA_CONTRACT.md** documenting data-sovereignty guarantees (read/write frontmatter only; never delete, never auto-submit, never leave the machine).

### Fixed
- **Date coercion bug**: YAML was parsing `deadline:` / `applied:` values into timezone-bearing `Date` objects, which rendered as e.g. `Mon Jun 22 2026 20:00 GMT-0400` and could shift by a day. Frontmatter is now parsed with the YAML JSON schema, so dates stay the exact strings written in the file. Verified against the literal frontmatter across all jobs; no jobs dropped.

### Notes
- Architecture decision: the vault's Markdown frontmatter is the single source of truth; no database was introduced (contra the original brainstorm's SQLite suggestion) to avoid drift. See `docs/blueprint.md`.
