# Data schema (v1)

**Schema version:** 6 · **Published:** 2026-07-13 · **App version at publish:** 0.36.0 (schema v6 changes NO entity or field; it relocates the six live machine-written stores + `attachments/` out of the git worktree to the data zone `C:\Usersyou\ssc-brain\data\jobhunt` via the `DATA_DIR` seam — ADR-023 in `product-decisions.md`, RFC v2-006 Phase 3. Every §7 path that read `docs/<store>` now means `<dataDir>/<store>`; tracked ledgers — `roadmap.yaml`, `portfolio.yaml`, `agents.yaml`, `discovery-sources.yaml` — stay in `docs/`. Prior v5: apify discovery-source type) (schema v5 adds the `apify` discovery-source type, its three stored fields `actorId`/`input`/`fieldMap`, and the one owner-gated Apify egress disclosed in §7.2.1; it lands this wave with the concurrent Apify discovery-source build, t-1783339605935, so release-manager confirms the exact cut version at release. Prior v4 window, unchanged: instruction-proposal loop, run honesty counters, fetch-mode flag, Job enum write boundary, Job.source provenance; the v0.22.0 sweep added no entity or field, its guarded file reader is documented in the §7.3 writer/reader map) · **Owner:** software-architect · **Status:** Accepted

> ## Update policy — read this first
> This document is re-versioned with **every** app release. It is the single reference for how all of this product's data hangs together: every entity, every field, who writes it, and how it relates to every other entity.
>
> **A release that adds, removes, renames, or changes the meaning of any entity or field without updating this document fails the release gate.** This is now item 2a of the Release checklist in `company-os/os/governance-conventions.md` (section 3). "Updating" means: the field table below reflects the code as shipped, the schema version line above is bumped (patch bump for a clarification/typo, a new dated entry in §7 for any field-level change), and — per the Governing rules in §5 — no field ships without (1) an entry here, (2) a writer, (3) a reader.
>
> This document describes **what the code actually reads and writes**, not aspirational design. Every claim below is sourced from `server/index.js`, `server/lib.js`, `src/types.ts`, and the on-disk data files as of the version above. Where the code and an ADR narrative disagree, the code wins and the discrepancy is called out explicitly (see the "Note" callouts).

---

## 0. Contents

1. Notation
2. Entities
   - 2.1 Job (vault frontmatter) + JobDetail
   - 2.2 Discovery Source + RunRecord + Discovery lead/find
   - 2.3 Task + TaskComment + TaskAttachment + ChecklistItem
   - 2.4 Request (intake ledger)
   - 2.5 Portfolio: Project + ProjectRaci + Stakeholder + Risk + Milestone
   - 2.6 Roadmap: RoadmapPhase (authored) + DerivedPhase/DerivedRoadmap
   - 2.7 Agents roster (`docs/agents.yaml`)
   - 2.8 Telemetry event (`usage-telemetry.jsonl`) + TelemetrySummary
   - 2.9 Activity log entry (`activity-log.jsonl`)
   - 2.10 Notify-state (`notify-state.json`) + Notification feed
   - 2.11 Config (`config.json` / `AppConfig`)
3. Relations map
4. Governing rules
5. Wave-2 schema decisions (Discovery Sources v2)
6. Known gaps observed while authoring this doc (for the W1b auditor)
7. Data contract guarantees (absorbed from `DATA_CONTRACT.md`)
8. Schema-doc change log

---

## 1. Notation

Every entity section uses the same shape: **Purpose**, **Storage**, **Writer(s)**, a **field table**, **Lifecycle**, **Invariants**.

Field table columns:

| Column | Meaning |
| --- | --- |
| Field | The exact key name, on disk or in `src/types.ts` |
| Type | The JS/TS shape |
| Required | Whether the field must be present for the record to be valid |
| Stored / Derived | **STORED** = persisted on disk, read back verbatim. **DERIVED** = computed at read time from other stored data; never persisted redundantly (the ADR-010..013/016/017 discipline). **SERVER-MANAGED** = stored, but only ever written by the server's own logic — a client-supplied value in a write body is ignored (unforgeable) |
| Meaning | What it is / how it's computed |

"Writer" always names the exact endpoint, function, routine, or human action responsible — per the Governing rules (§4), an entity with no identifiable writer and reader is a defect, not a feature.

---

## 2. Entities

### 2.1 Job (vault frontmatter) + JobDetail

**Purpose:** the canonical unit of the job-search pipeline — one job posting being tracked, drafted, or applied to.

**Storage:** a Markdown file with a YAML frontmatter block, at `<jobsDir>/<Role> - <Employer>/<Role>.md` (vault path from `config.json.jobsDir`). Parsed with `gray-matter` + `js-yaml` (`JSON_SCHEMA`, so dates are never auto-coerced). This is the single source of truth (ADR-001) — Obsidian, git, and the Python pipeline read the identical file.

**Writer(s):**
- **`createJobFolder`** (`server/index.js`) — a whole-file write (NOT the surgical path below), used by `POST /api/jobs` (manual "Add lead") and `POST /api/discovery/pursue`. Hand-builds the frontmatter block from scratch. Since schema v4 it runs the enum guard below and writes `source` (discovery provenance) when the caller resolved one.
- **`updateFrontmatter`** (`server/lib.js`) via **`PATCH /api/jobs/:id`** — the load-bearing surgical one-line edit. Restricted to `WRITABLE_FIELDS`; every other key in the request body is silently inert (not an error, just never written). Since schema v4, enum-VALUED writes are guarded too: a present-but-invalid `track`/`fit`/`sector`/`tailoring`/`status` value is silently dropped (`dropInvalidJobEnums`, the Task posture — see Invariants), while `null`/`""` still clears the field.
- **`sweepExpiredJobs`** — the one rule-based automatic write disclosed in `DATA_CONTRACT.md`: once per local day, on the first `GET /api/jobs` of the day, auto-closes any `lead`/`queued`/`drafted` job whose `deadline` is a literal past `YYYY-MM-DD`.
- **`PUT /api/jobs/:id/file`** — a whole-file overwrite, but only for the two companion notes (gaps, job-description); never the `<Role>.md` file itself.
- **Vault routines** (`discover-jobs`, `first-draft-job`, `finalize-job`) write generated artifacts (CVs, cover letters, `application-content.json`) and author the gaps note as plain files directly into the folder — this happens via the Claude agent's own file tools, **outside the Express write path entirely**. The schema below documents what the app reads/writes; it does not fully control everything that lands in a job's folder.

**Frontmatter fields (STORED on the file):**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `type` | string | required | STORED | Always `"job"` (the Obsidian Bases filter key); hardcoded by `createJobFolder`, never re-written |
| `role` | string | required | STORED | Job title |
| `employer` | string | required | STORED | Employer name |
| `track` | string | optional | STORED, WRITE-GUARDED (invalid ignored) | One of the 7 canonical track keys (`config.json`/`GET /api/config` → `tracks`). Since v4 (t-1783199066683): a present-but-invalid value is **silently dropped at every write boundary** (PATCH and both create paths) — never written, never a 400. Legacy on-disk values still read verbatim |
| `fit` | string | optional | STORED, WRITE-GUARDED (invalid ignored) | `strong \| moderate \| stretch` — same v4 write guard as `track` |
| `status` | string | optional | STORED, WRITABLE, WRITE-GUARDED (invalid ignored) | One of `STATUSES` (`lead, queued, drafted, submitted, interview, offer, rejected, closed`); **still coerced on read** (`toJob` falls back to `lead` for a legacy value), and since v4 an invalid value is also dropped on write, so a bogus status can no longer land on disk |
| `sector` | string | optional | STORED, WRITABLE, WRITE-GUARDED (invalid ignored) | `private \| municipal \| provincial \| federal \| bps \| nonprofit` — **literally the same array** Discovery Sources validates (`SOURCE_SECTORS = SECTORS`). Job's guard drops an invalid value (Source's 400s — see Invariants for why the postures differ); at creation an invalid/absent sector defaults to `private` |
| `tailoring` | string | optional | STORED, WRITABLE, WRITE-GUARDED (invalid ignored) | `light \| heavy`; DERIVED at creation time only (`sector === "private" ? "light" : "heavy"`), then freely editable within the enum |
| `deadline` | string \| null | optional | STORED, WRITABLE | A literal `YYYY-MM-DD` or free text (e.g. "1-yr contract"); `normDate` passes non-Date values through unchanged |
| `applied` | string \| null | optional | STORED, WRITABLE | A literal `YYYY-MM-DD`; auto-stamped (see Invariants) |
| `next_action` | string | optional | STORED, WRITABLE | Free text; served as `nextAction` |
| `next_action_date` | string \| null | optional | STORED, WRITABLE | A literal date |
| `link` | string | optional | STORED, WRITABLE | The posting URL. Read by the server (`toJob`) and rendered in `JobDetail` (the "Open posting" affordance) — part of the documented contract even though it is frequently blank in real data: **61 of 94 jobs in the vault today have no `link`** (per the W1b audit, `docs/audits/2026-07-04-data-schema-audit.md`). A backfill is separately ticketed (t-1783198713055) — not in scope here |
| `source` | string | optional | STORED (creation-time only) | **WIRED in v4 (t-1783199066654): discovery provenance** — the canonical `DiscoverySource.id` this job came from. **Writer:** `createJobFolder`, at creation only: `POST /api/discovery/pursue` resolves it (an explicit `sourceId` in the body, else the matching workbook row's `sourceId`/`Source` joined through the same alias index the finds join uses; best-effort, ambiguity → omitted, never blocks the pursue); `POST /api/jobs` accepts a `sourceId` wire field that must resolve in the registry (unresolvable → ignored). Only a canonical registry id is ever written. **Reader:** `toJob` serves it verbatim on every Job payload (feeds the future "which sources convert" insight; not yet in `src/types.ts` — frontend adoption ticketed). **Not in `WRITABLE_FIELDS`** — provenance is a creation-time fact, the dashboard can never rewrite it. **Legacy values** already on disk (free-string names like `Northwind Supply`) are served verbatim and never rewritten |
| `gaps` | string | optional | STORED | An Obsidian wikilink to the gaps note (e.g. `"[[Role gaps|gaps]]"`) — cosmetic for Obsidian; the app instead DERIVES gaps-file presence from a directory listing, so this key is never read by the app |
| `tags` | string[] | optional | STORED | Always `[job]`; coerced to an array on read if a bare scalar |

**Served `Job` object (API shape) — DERIVED overlay on top of the frontmatter table above:**

| Field | Stored/Derived | Meaning |
| --- | --- | --- |
| `id`, `folder` | DERIVED | The folder name |
| `folderPath`, `jobFile`, `jobFileName` | DERIVED | Resolved filesystem paths |
| `trackLabel` | DERIVED | `TRACKS[track] \|\| track \|\| ""` lookup |
| `status` | DERIVED | `STATUSES.includes(d.status) ? d.status : "lead"` — coerced, falls back to `lead` |
| `rawStatus` | DERIVED | The un-coerced on-disk value, verbatim |
| `leadWith` | DERIVED | Regex parse of the body's `**Lead with:**` line |
| `files`, `hasCV`, `hasCoverLetter` | DERIVED | Directory listing + filename/ext sniff (`cv`/`cover` substring + `docx`/`pdf` ext) |
| `gapsAnswered` | DERIVED | `!!(cvFile && gapsFile) && gapsFile.mtime > cvFile.mtime` (strict; the SoT job file itself is excluded from the gaps-file match) |
| `finalizeReady` | DERIVED | `status === "drafted" && hasCV && gapsAnswered` |
| `mtime` | DERIVED | `fs.statSync(jobFile.path).mtimeMs` |

`JobDetail extends Job` adds, read only on `GET /api/jobs/:id` (not the list endpoint, for payload size): `body` (frontmatter-stripped Markdown), `gaps` (gaps-note content, if present), `jobDescription` (job-description-note content, if present).

**Lifecycle:** `lead → queued → drafted → submitted → interview → offer`, with `rejected`/`closed` terminal (canonical table: `docs/blueprint.md` §4.4). Never deleted — "removing" a job is setting `status: closed`.

**Invariants:**
- `applied` is stamped with today's local date the first time a job reaches `submitted` (only if not already present, only if not supplied in the same request) — but **unlike `Task.completed`, it is never cleared** if the job later moves out of `submitted`. This is a real, intentional asymmetry: a job's applied-date is a historical fact, not a "currently in this state" flag.
- `WRITABLE_FIELDS` is the entire boundary for surgical edits — a request body key outside that list is silently dropped, never a 400.
- **Enum write boundary (v4, t-1783199066683): Job enum fields adopt the TASK posture — a present-but-invalid value is silently ignored, not a 400.** Deliberately NOT the Source 400 posture, for two reasons: (1) the Job write path's own established invariant (above) is already silent-drop for unknown keys, so silent-ignore for invalid values is the same philosophy, not a third posture; (2) the pursue path carries values from legacy workbook rows — a loud 400 would make old finds un-triageable, a worse failure than dropping a bogus value. `null`/`""` always pass (clearing a field stays legal). **Tolerant read is unchanged**: legacy on-disk values are served verbatim (plus `status`'s existing read-coercion) — this guard hardens WRITES only, existing vault files are never rewritten by it.
- `updateFrontmatter` never touches the body, preserves the file's original EOL style and any BOM; every other frontmatter line is byte-identical after a write.
- A job folder is never deleted, never auto-submitted, and a folder/file path can never resolve outside `Jobs/` (path containment checks on every write path that accepts a name).

---

### 2.2 Discovery Source + RunRecord + Discovery lead/find

**Purpose:** the managed registry of employer sites and job boards the app scrapes (ADR-016), which the raw leads (finds) JOIN onto by id/alias.

**Storage:** `docs/discovery-sources.yaml`, shape `{ version, updated, sources: Source[] }`. Read/written exactly like `tasks.yaml`: tolerant load (missing/malformed → `{version:1, updated:null, sources:[]}`), atomic write (`writeFileAtomic`, `.tmp` + rename). The leads themselves stay in the `Job Discovery.xlsx` workbook (`Discoveries` sheet) — this file only holds the source registry, never a copy of the leads.

**Writer(s):** `POST` / `PATCH` / `DELETE /api/discovery/sources[/:id]` (source config); `POST /api/discovery/sources/:id/run` + `finalizeSourceRun` (run-history bookkeeping, `lastRunAt`); `POST /api/discovery/run-all-due` (fan-out over all due active sources, stamping each independently); `POST /api/discovery/sources/:id/runs/:runId/report` (v4: the scout's honesty-counter callback — writes only the three counters onto the matching run record); `POST /api/discovery/sources/:id/instruction-proposals` (the scout's callback files a proposal) + `PATCH /api/discovery/sources/:id/instruction-proposals/:proposalId` (owner approve/reject - the only writer of the provenance fields and, on approve, of `instructions`). **Reader note (v4):** `GET /api/discovery/sources/:id` is the single-source read — the registry GET's derived per-source shape (plus `proposeRunId` and the locked degrade), so polling one run no longer fetches the whole registry.

**Field table (Source):**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `id` | string | required | STORED | Canonical join key; auto-slugged or explicit (409 on collision) |
| `name` | string | required | STORED | Display name |
| `type` | enum `employer\|board\|apify` | default `board` | STORED, WRITE-VALIDATED (400) | v5 (t-1783339605935): `apify` is now an accepted, write-validated value, alongside the existing scout-scraped `employer`/`board`. An `apify` source runs deterministically server-side (no scout agent, no `instructions`) and is the only source type that makes an outbound call (§7.2.1). It REQUIRES `actorId` (400 without one); `instructions`/`fetchMode`/`fetchNote`/`outputFields` do not apply to it. See the three apify-only fields below |
| `sector` | enum, 6 values | default `private` | STORED, WRITE-VALIDATED (400) | Same 6-value set as the job `sector` convention — **here it IS enforced** |
| `active` | enum `yes\|maybe\|no` | default `yes` | STORED, WRITE-VALIDATED (400) | Drives the `paused` derived status |
| `urls[]` | string[] | optional | STORED | May be empty (an un-activated source) |
| `cadence` | enum `manual\|daily\|weekly\|monthly` | default `manual` | STORED, WRITE-VALIDATED (400) | Drives `nextRunAt`/`due`/`stale` — see §5 decision 2 |
| `fetchMode` | enum `direct-list\|google-site\|alert-email`, optional | `null` = unclassified | STORED, WRITE-VALIDATED (400); `null`/`""` clears | v4 (t-1783200897663 c): **how postings are actually reached**, formalized out of instruction prose — `direct-list` (listing URL is fetchable, WebFetch it), `google-site` (JS/anti-bot walled; enumerate via Google `site:` queries), `alert-email` (postings arrive via a saved email alert). Feeds a fixed strategy line into the run prompt (`FETCH_MODE_PROMPTS`); unclassified sources rely on prose alone, exactly as before. 33 of the 46 committed sources migrated where the prose was unambiguous (guarded by test); `company-careers`/`crown-corps` (mixed per-target) and the 11 seeded stubs stay unclassified |
| `fetchNote` | string | optional | STORED | v4: free-text companion to `fetchMode` for verified quirks the enum can't carry (University Affairs: "query params are cosmetic — filter client-side"). Rendered into the run prompt when present |
| `instructions` | string | optional | STORED | Read verbatim by the scraping routine. **Wave-2 changes who may write this — see §5 decision 4** |
| `outputFields[]` | string[] | optional | STORED | Default 6: `title, employer, location, deadline, salary, link` |
| `actorId` | string | required for `type:"apify"` (400 otherwise) | STORED, WRITE-VALIDATED (400) | v5 (t-1783339605935), apify-only: the Apify actor in `username~actorName` form (e.g. `misceres~indeed-scraper`). Sanitized to `[A-Za-z0-9_~./-]` at the write boundary because it is interpolated into the request URL path (no `?`/`&`/`#`/whitespace/path-escape). Absent or blank on an apify source is a 400 |
| `input` | object | optional, default `{}` | STORED, WRITE-VALIDATED (400) | v5, apify-only: the actor's run-input JSON (`position`/`query`, `location`, `maxItems`, `country`, and similar). Accepted only if a plain object (else 400); stored verbatim as a nested object. Serialized into the request BODY as JSON, never into a shell, so it is object-validated, not shell-escaped. Any `maxItems`/`maxResults`/`maxPagesPerCrawl` inside it is clamped down to `APIFY_MAX_ITEMS_PER_RUN` at run time. This object is the ONLY source-owned data that leaves the machine (§7.2.1, C1) |
| `fieldMap` | object | optional | STORED, WRITE-VALIDATED (400) | v5, apify-only: per-actor output-field alias overrides for the defensive mapper (e.g. `{ "role":"positionName", "link":"jobUrl" }`). Accepted only if a plain object (else 400). Absent = the mapper's default alias table only |
| `aliases[]` | string[] | optional | STORED | Legacy `Source` label variants, used by the finds join |
| `notes` | string | optional | STORED | Free text |
| `lastRunAt` | ISO string \| absent | — | **SERVER-MANAGED**, unforgeable | Stamped at run **launch**, not close; ignored if sent by a client. **Scrape runs only** — a `propose-instructions` run never stamps it (it is not a scrape; stamping would fake cadence freshness) |
| `lastVisitedAt` | ISO string \| null | optional | STORED, client-settable | Feeds the `newSinceVisit` derivation |
| `runs[]` | `RunRecord[]` | — | **SERVER-MANAGED**, unforgeable | Capped at 20, newest-first. Scrape runs only — never a `propose-instructions` run |
| `instructionProposals[]` | `InstructionProposal[]` | — | STORED, **append-only**, partly SERVER-MANAGED | The instruction-proposal loop's log (§5 decision 4, SHIPPED). Absent on disk when empty; not writable through `POST/PATCH /api/discovery/sources` (`validateSourceInput` never accepts it) — grows only via the dedicated proposal endpoints below. Served newest-first (like `runs`) |
| `instructionsApprovedFrom` | string \| null | — | **SERVER-MANAGED**, unforgeable | Provenance: the `id` of the approved proposal the live `instructions` came from. Set only by an approve; **cleared by a manual `instructions` edit** (see Invariants). Absent/null = never set through the loop |
| `instructionsUpdatedAt` | ISO string \| null | — | **SERVER-MANAGED**, unforgeable | When `instructions` last changed through the loop (= the approving proposal's `resolvedAt`) **or by a manual edit** (re-stamped, with `instructionsApprovedFrom` cleared → reads as "set manually") |

**Field table (InstructionProposal, one entry in `instructionProposals[]`):**

| Field | Type | Stored/Derived | Meaning |
| --- | --- | --- | --- |
| `id` | `ip-<epochms>` | **SERVER-MANAGED** | Generated on file, suffix-deduped within the source; a client-supplied value is ignored |
| `ts` | ISO string | **SERVER-MANAGED** | Filing timestamp; client value ignored |
| `ownerComment` | string | STORED, verbatim | The triggering comment (may be `""` — a new source's first proposal is a legitimate cold start). Same verbatim posture as `IntakeRequest.text` |
| `proposedInstructions` | string | STORED, verbatim | The proposed replacement text; required non-blank at filing (400) |
| `rationale` | string | STORED, verbatim | The scout's justification + what it verified |
| `status` | enum `pending\|approved\|rejected` | STORED, WRITE-VALIDATED | Always `pending` at filing (client value ignored). **One-way**: resolved once, by the owner's PATCH, then immutable (400 on any re-resolve). A hand-edited unknown status degrades to `pending` on read (safe: it only re-offers the proposal for human review) |
| `resolvedAt` | ISO string, optional | **SERVER-MANAGED** | Stamped only on approve/reject |
| `rejectionReason` | string, required iff rejected | STORED (trimmed) | Owner prose; required non-blank to reject (400, mirroring `validComment`). Feeds the next propose run's prompt |

**Field table (RunRecord, one entry in `runs[]`):**

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | string | Unique per launch |
| `startedAt` | ISO string | Server-stamped at launch |
| `durationMs` | number \| null | `null` while `outcome:"running"` |
| `outcome` | enum `succeeded\|failed\|incomplete\|running` | `incomplete` = the run was manually stopped |
| `leadsFound` | number \| null | Total leads currently joined to this source, at close (server-derived from the workbook join) |
| `leadsNew` | number \| null | `leadsFound − sourceBaseline` (baseline captured at launch), floored at 0 (server-derived) |
| `candidatesReviewed` | number \| null | v4 honesty counter (t-1783200897663 a): total postings the scout actually reviewed on the source. **AGENT-REPORTED** via `POST .../runs/:runId/report` (only the scout knows what it reviewed — the server can only count what landed in the workbook); the prompt carries the run's own id and marks the report best-effort. `null` = unreported (pre-v4 runs, or the scout skipped it) — never a fake 0 |
| `alreadyTracked` | number \| null | v4 honesty counter: of those reviewed, how many were skipped as already tracked (an existing find or `Jobs/` folder). Same report path |
| `filteredOut` | number \| null | v4 honesty counter: of those reviewed, how many were set aside as not relevant. Same report path |
| `trigger` | enum `manual\|scheduled\|all-due` | **Note:** the type declares `scheduled`, but only `manual` and `all-due` are emitted by any code path today — see §6 |
| `errorReason` | string, optional | Present only if the launch itself failed |

The report endpoint validates loudly (new-field ADR-016 posture): each counter present must be a finite number ≥ 0 (stored floored to an integer), at least one is required, unknown source/run is a 404. A re-report is last-write-wins (the counters are run telemetry, not SoT), and `finalizeSourceRun`'s close-path read-modify-write preserves them.

**DERIVED, never stored** (served on `GET /api/discovery/sources` as `DerivedSource`, never persisted):

| Field | Derivation |
| --- | --- |
| `status` | `deriveSourceStatus` — first-match precedence: `active:"no"` → `paused`; a `running` run → `running`; newest terminal run `failed` → `failed`; no run and no `lastRunAt` → `never-run`; overdue ≥ 2× the cadence interval → `stale`; overdue ≥ 1× → `due`; else `healthy` |
| `due` | `true` when non-manual and (`lastRunAt` missing, or `now ≥ lastRunAt + 1×interval`) |
| `nextRunAt` | `null` for `manual`; else `lastRunAt + interval` (ISO), `null` if `lastRunAt` is unset |
| `jobCount` | Count of finds joined to this source (by `sourceId` else name/alias match) |
| `newSinceVisit` | Finds joined to this source found after `lastVisitedAt` |
| `pursuedPct` | 0–100, share of this source's finds with `Decision: pursue` |
| `contractGaps[]` | `computeContractGaps(outputFields)` — the required-but-missing scrape-contract concepts (`direct-link`/`deadline`), §5 decision 3a |
| `lastRunSignal` | v4 (t-1783200897663 a): `deriveLastRunSignal(runs)` — classifies the newest terminal **succeeded** run so the health pill can tell a healthy dedup-heavy run from a possibly-broken scrape without reading prose: `leads` (new leads landed) \| `dedup` (0 new but `candidatesReviewed > 0` — the scrape worked, everything was already tracked/filtered: the University Affairs case) \| `quiet` (0 new and a **reported** 0 reviewed — the source genuinely listed nothing) \| `unverified` (0 new, counters unreported — the honest "cannot tell" state) \| `null` (no terminal succeeded scrape run; `status` already tells that story). When the close path could not count leads (locked workbook), the scout's reported counters drive the dedup/quiet split. Server-derived only — the pill component's adoption is a follow-up frontend ticket, not client-side re-derivation |
| `proposeRunId` | The live `propose-instructions` run's id for this source, else `null` — a pure read of the in-memory runs Map (process state, never stored), stamped by the route handlers so the drawer's "reviewing your note" state survives a page reload. Also the server's own 409 guard (one propose run per source at a time) |
| `unassignedCount` / `unassignedSources[]` | Top-level (not per-source): finds matching no source at all, grouped by raw label — the honest "nothing hides" bucket |

**Cadence → interval:** `daily → 1 day`, `weekly → 7 days`, `monthly → 30 days`, `manual → null` (never due, `nextRunAt` always `null`). All four are fully implemented in `cadenceIntervalDays`/`deriveSourceStatus` today — `monthly` is not a stub; it is exercised by the same derivation code as the other three. Only `manual`, `daily`, and `weekly` happen to have a live source instance in `discovery-sources.yaml` today (a data fact, not a code gap) — `monthly` is available in the form `<select>` now.

**Wave-2 additions to this entity — all now BUILT and documented in the tables above:** `tracks[]` (§5 decision 1), `contractGaps[]` (§5 decision 3a), and the instruction-proposal loop — `instructionProposals[]`, `instructionsApprovedFrom`, `instructionsUpdatedAt`, plus the derived `proposeRunId` (§5 decision 4, shipped by t-1783198113775 with two recorded amendments — see the decision's "As-built" note).

**Discovery lead / find** (the `Discovery` type — one row of the `Discoveries` sheet, NOT migrated to YAML): `Date Found, Title, Employer, Sector, Track, Fit, Tailoring, Deadline, Location, Source, Link, Decision (skip|maybe|pursue), Notes, tracked` (DERIVED: a matching `Jobs/` folder exists), `sourceId` (optional, stamped going forward by the source-scoped routine for an exact join). Decisions are written back by `POST /api/discovery/decide` → `discovery.py decide` (an `openpyxl` mutation of the workbook — a different write mechanism from every YAML store above). `Pursue` calls `createJobFolder` (§2.1) and sets `Decision: pursue`.

**Authoring surface — who writes what field (today, before Wave-2):**

| Field(s) | Written by |
| --- | --- |
| `name`, `urls`, `type`, `sector`, `active`, `cadence`, `fetchMode`, `fetchNote`, `aliases`, `notes`, `outputFields`, `actorId`, `input`, `fieldMap` | Owner, via the Sources console form (`POST`/`PATCH`); `actorId`/`input`/`fieldMap` only when `type:"apify"` |
| `runs[].candidatesReviewed` / `alreadyTracked` / `filteredOut` | The scout's end-of-run callback (`POST .../runs/:runId/report`) — the run prompt carries the run's own id; best-effort, a failed report never fails the run |
| `instructions` | **The proposal loop (shipped, §5 decision 4):** normally written only by an APPROVE (`PATCH .../instruction-proposals/:proposalId {status:"approved"}`). The manual escape hatch (`PATCH /api/discovery/sources/:id {instructions}`) still works but clears `instructionsApprovedFrom` and re-stamps `instructionsUpdatedAt`, so provenance always reads honestly ("approved from proposal" vs "set manually") |
| `lastVisitedAt` | Owner (implicitly, on opening a source's detail drawer) |
| `lastRunAt`, `runs[]` | Server only (SCRAPE run launch/close), never client-settable; never touched by a propose run |
| `instructionProposals[]` | Filed by the scout's callback (`POST .../instruction-proposals`, server-stamps `id`/`ts`/`status:pending`); resolved by the owner's PATCH (server-stamps `resolvedAt`, one-way) |
| `instructionsApprovedFrom`, `instructionsUpdatedAt` | Server only: approve side effect, or the manual-edit re-stamp above |

**Lifecycle:** a source is app-managed config, not vault data — `DELETE` removes only the config; a find that was joined to it falls back to the unassigned bucket. Never a vault write.

**Invariants:** every derived field is a pure function of `active` + `runs[]` + `lastRunAt` + the finds join — it cannot drift from what actually ran (the entire point of ADR-016). A present-but-invalid enum on write is a loud 400; an absent one defaults. One SCRAPE run per source at a time (409 on a second launch), and independently one PROPOSE run per source at a time (409) — the two do not block each other and a propose run never touches `lastRunAt`/`runs[]`, so cadence health cannot drift from a non-scrape. `instructionProposals[]` is append-only: filing can never resolve, a resolved proposal is immutable, and a rejected one is never deleted (it is the next run's training context). Provenance honesty: `instructionsApprovedFrom` present ⟹ the live `instructions` ARE that proposal's `proposedInstructions` — enforced by clearing it on any manual `instructions` edit that changes the text (identical re-send is a no-op). An `apify` source additionally requires `actorId` at the write boundary (400 without it) and makes no outbound Apify call unless the owner has both activated the source and set `APIFY_TOKEN`: off by default (§7.2.1).

---

### 2.3 Task + TaskComment + TaskAttachment + ChecklistItem

**Purpose:** the dev/ops ticket board — every unit of work the org (owner + CTO + agents) tracks, including this very ticket.

**Storage:** `docs/tasks.yaml`, shape `{ columns: string[], tasks: Task[] }`. Written via `writeFileAtomic`. **Note:** unlike `requests`/`sources`, `loadTasks` has no try/catch around the read/parse itself — a missing `columns`/`tasks` key defaults, but a hard parse failure is not caught here (see §6).

**Writer(s):** `POST`/`PATCH /api/tasks[/:id]` (the shared `applyTaskFields`); `POST /api/tasks/:id/attachments` (images only); the `work-ticket` / `assess-ticket` routines call back through this same API, never hand-edit the YAML.

**`TASK_WRITE_FIELDS`** — the exact write whitelist, split by treatment:

| Group | Fields | Treatment |
| --- | --- | --- |
| Verbatim text | `title, detail, epic, user_story, acceptance, source` | Copied as-is. `source` is deliberately here (not id-sanitized) because it holds strings like `"review:enablement-reviews/2026-07-01"` that contain `:`/`/` |
| Id refs | `project, milestone, owner, delegated_by, wbs, assignee` | Run through `sanitizeId` (lowercase, trim, strip to `[a-z0-9._-]`, empty → `null`) |
| Closed enums | `priority` (`high\|medium\|low`), `type` (`bug\|feature\|chore\|spike`), `status` (board columns ∪ `EXTENDED_STATUSES`) | Validated inline; an invalid value is **silently ignored** (not a 400) |
| Shape-coerced | `estimate` (number), `labels` (string[]), `checklist` (`ChecklistItem[]`) | `coerceEstimate`/`coerceLabels`/`coerceChecklist`; a `null` result deletes the key |
| Append-only | `comment` (singular, one `{author, body}` per call) | The only way to grow `comments[]` post-creation |

**Field table (Task):**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `id` | string | required | STORED | Stable id |
| `title`, `detail`, `epic` | string | title required | STORED | Core ticket text |
| `priority` | enum | optional (default `medium`-ish behavior on read) | STORED | See enum table above |
| `status` | string | required | STORED | Must be a live board column or `EXTENDED_STATUSES` |
| `created` | `YYYY-MM-DD` | required | STORED | Set at creation, never re-stamped |
| `completed` | `YYYY-MM-DD`, optional | — | **SERVER-MANAGED**, unforgeable | **Precise invariant: present ⟹ `status` is currently `done`; the converse (`done` ⟹ present) holds only for a task that has transitioned INTO `done` on or after 2026-07-03 (the date ADR-013 shipped) — the stamp is applied at the transition EVENT, never backfilled onto tasks already done beforehand.** Real data (W1b audit, `docs/audits/2026-07-04-data-schema-audit.md`): **82 of 126 currently-done tasks predate ADR-013 and legitimately have no `completed`.** Cleared on any move OUT of done (`canceled` also clears it, since it's terminal-but-not-done); re-stamped fresh on the next re-entry into `done` |
| `project`, `milestone` | string, optional | — | STORED (id) | References UP into `portfolio.yaml` — no referential-integrity write gate |
| `owner`, `delegated_by`, `wbs`, `assignee` | string, optional | — | STORED (id) | `agents.yaml` role ids or `"owner"`, by convention |
| `user_story`, `acceptance`, `source` | string, optional | — | STORED (verbatim) | See PM-conventions / addressed-via-tickets join |
| `type` | enum, optional | — | STORED | `bug\|feature\|chore\|spike` |
| `labels[]` | string[], optional | — | STORED | Trimmed, empties filtered; `null`→absent |
| `estimate` | number, optional | — | STORED | `null` if not finite |
| `checklist[]` | `ChecklistItem[]`, optional | — | STORED | `{text, done}`; **defined and write-capable, but zero live instances in `tasks.yaml` today** — see §6 |
| `comments[]` | `TaskComment[]`, optional | — | STORED, append-only | Absent on disk when empty (stripped by `saveTasks`) |
| `attachments[]` | `TaskAttachment[]`, optional | — | **SERVER-MANAGED**, unforgeable | Absent on disk when empty; **zero live instances today** (`docs/attachments/` is empty) — see §6 |

**`TaskComment`:** `{ author: string, ts: string, body: string }`. `validComment` requires non-blank trimmed `author`/`body` (else a **loud 400**, unlike most task-field validation); `ts` is always server-stamped (`new Date().toISOString()`), never client-supplied.

**`TaskAttachment`:** `{ file, name, mime, bytes, ts }`. Written only by `POST /api/tasks/:id/attachments`, an ordered-guard upload path: (1) parent task exists, (2) Content-Type in the image MIME allowlist (`png/jpeg/gif/webp` — **never SVG**), (3) magic-byte sniff must match the claimed MIME, (4) non-empty and `≤ attachmentMaxBytes` (config, default 5 MB), (5) content-hash (`sha256`) filename dedupes idempotently; a genuinely new file needs `< attachmentMaxCount` (config, default 6) already on the ticket, (6) path-containment check under `docs/attachments/<taskId>/`, (7) atomic write. Read back only via the guarded `GET /api/tasks/:id/attachments/:file` (existence-allowlisted against `task.attachments`, never a static file server).

**Lifecycle:** `backlog → todo → in_progress → done` (the live board columns) plus the extended vocabulary (`triage, canceled, in_review, ...`) used by tickets not on the visible board. Never deleted.

**Invariants:** `completed` present ⟹ currently done, always; the reverse only holds going forward from ADR-013's ship date (2026-07-03) — see the precise wording in the field table above, and do not state the universal "present ⟺ done" claim without that qualifier (a real, sizeable minority of done tasks predate the stamp). Comments are append-only — no endpoint replaces or deletes the array. Attachment metadata is unforgeable; a POST/PATCH task body can never set `attachments` or `completed`.

---

### 2.4 Request (intake ledger)

**Purpose:** the ORIGIN node of the orchestration chain (ADR-009) — the verbatim owner/chatbot ask, the CTO's assessment, and everything it spawned.

**Storage:** `docs/requests.yaml`, `{ requests: IntakeRequest[] }`. Tolerant load (missing/unparseable/non-array → `{requests: []}`, wrapped in try/catch). Atomic write.

**Writer(s):** `POST /api/requests` (create); `PATCH /api/requests/:id` (assessment + spawned refs). **Never deleted** — no DELETE endpoint exists.

**Field table:**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `id` | `r-<epochms>` | required | STORED, server-stamped | |
| `text` | string | required, non-blank | STORED, **verbatim** | Never trimmed of content, never sanitized — a `:`/`#`/`"`/newline survives byte-for-byte |
| `source` | enum `session\|chatbot` | — | STORED | Defaults to `session` |
| `created` | `YYYY-MM-DD` | required | STORED, server-stamped | Local date |
| `ts` | ISO string | required | STORED, server-stamped | |
| `assessment` | string, optional | — | STORED | CTO verdict/plan; kept only if non-blank |
| `spawned.tasks[]`, `spawned.projects[]` | string[] | — | STORED, id-sanitized | **Merged + deduped on every PATCH — a union, never a replace, so a link is never lost** |

**Lifecycle:** created once, `assessment`/`spawned` grow over time via PATCH. This is the two-ended edge with `Project.origin_request` — the chain is verifiable from either side.

**Invariants:** `text` is never mutated after creation (only `assessment`/`spawned` are patchable). `spawned` arrays only grow (union), never shrink via the API.

---

### 2.5 Portfolio: Project + ProjectRaci + Stakeholder + Risk + Milestone

**Purpose:** the Execution pillar — the Project → Milestone hierarchy every piece of dev work traces up to (ADR-006), plus PM/RACI/risk fields (ADR-010, ADR-011).

**Storage:** `docs/portfolio.yaml`, `{ version, updated, projects: Project[], milestones: Milestone[] }`.

**Writer(s): none server-side.** Confirmed by direct grep of `server/index.js` — only `GET /api/portfolio` exists (`ensureArrays` normalizes missing `projects`/`milestones` to `[]`, but a hard read/parse failure is a 500, not a soft degrade). **This file is entirely hand-edited.** Referential integrity (an owner/role/project ref pointing at something that doesn't exist) is a read/test invariant, never a write-time gate — because it's hand-edited and may legitimately lag.

**Field table (Project):**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `id`, `name`, `department`, `owner`, `accountable`, `goal`, `status` | string | required | STORED | Core charter fields |
| `target`, `created` | string, optional | — | STORED | `target` is a version string (e.g. `v0.16.0`) that also feeds a completion-date derivation elsewhere (ADR-013) |
| `origin_request` | string \| null, optional | — | STORED | Charter link to `IntakeRequest.id`; `null` if chartered retroactively |
| `sponsor` | string, optional | default `owner` | STORED | Role id or `"owner"` |
| `project_manager` | string, optional | default `= accountable` | STORED | Role id |
| `raci.consulted[]`, `raci.informed[]` | string[] | — | STORED | **Only** the genuinely new, non-duplicative RACI edges — see Invariants |
| `stakeholders[]` | `Stakeholder[]`, optional | — | STORED | Present only when a project has a genuine external human stakeholder |
| `risks[]` | `Risk[]`, optional | — | STORED | Present only when a project has a genuine open risk |

**`ProjectRaci`** deliberately omits two roles that are DERIVED, never stored:
- **Accountable** IS the top-level `accountable` field — never duplicated inside `raci`.
- **Responsible** = the distinct set of task owners under the project, joined at read time from `tasks.yaml` (`project`/`milestone` refs). Storing it would be a second source of truth that could drift from the board.

**`Stakeholder`:** `{ name (required), role?, interest?/influence? (high|medium|low), engagement? (unaware|resistant|neutral|supportive|leading) }`. Carried for display; the app never computes a power/interest grid from it.

**`Risk`:** `{ id?, description (required), likelihood/impact (required, high|medium|low), mitigation?, status? (open|mitigating|closed), owner? }`. **`severity` is DERIVED, never stored** — `riskSeverity(likelihood, impact)` reduces the 3×3 matrix by product (≥6 High, ≥3 Medium, else Low), in `src/lib/statusColors.ts`.

**Field table (Milestone):** `id, project (required, references up), name, definition_of_done, status` (required); `target, created` (optional); `roadmap_phase` (optional, soft-link to a `roadmap.yaml` phase id).

**Lifecycle:** hand-authored; a milestone's `status` (done/in_progress) is what the Roadmap's derivation (§2.6) rolls up from.

**Invariants:** `raci.accountable`, if it ever appears by hand, must equal the top-level `accountable` (never a separate value). Arrays render only when non-empty — an internal-only project omits `stakeholders`/`risks` entirely rather than storing empty ceremony rows.

---

### 2.6 Roadmap: RoadmapPhase (authored) + DerivedPhase/DerivedRoadmap

**Purpose:** the release timeline / stage board (Roadmap tab).

**Storage:** `docs/roadmap.yaml`, `{ product, version, updated, phases: RoadmapPhase[] }`. **Writer: none — `GET /api/roadmap` only** (confirmed: no POST/PATCH route anywhere in `server/index.js`; `ensureArrays` defaults a missing `phases` key). Hand-edited.

**Field table (RoadmapPhase, as stored — the AUTHORED skeleton):**

| Field | Type | Stored/Derived | Meaning |
| --- | --- | --- | --- |
| `id`, `title` | string | STORED | |
| `status` | `PhaseStatus` | STORED — **tolerant fallback only**, see below | shipped\|in_progress\|planned\|later |
| `version`, `shipped` | string, optional | STORED | Authored guess; superseded when release-anchored (below) |
| `summary` | string | STORED | |
| `items[]` | `{text, done}[]` | STORED | The owner's per-item truth — used as a completeness guard by the derivation |

**DERIVED overlay (`src/lib/roadmapDerive.ts`, client-side pure function — ADR-012), never written back to the file:**

| Field | Derivation |
| --- | --- |
| Roadmap `version`/`updated` | Latest released version/date parsed from `docs/changelog.md` — never the stored `roadmap.version` |
| Phase `status` (priority order) | 1) **release-anchored**: `phase.version` is a released changelog version → `shipped` (a cut release can't un-ship — wins even over an in-flight milestone). 2) **milestone rollup**: any linked milestone (`milestone.roadmap_phase === phase.id`) in flight → `in_progress`; all linked done but an authored item still open → `in_progress` (the drift guard); all linked done, no open item → `shipped`. 3) **authored fallback**: no release, no linked milestones → the stored value, unchanged |
| `basis` | Which of the three rules fired: `release \| milestones \| authored` |

**Lifecycle:** phases move `later → planned → in_progress → shipped` (in truth; the stored value may lag). **Invariant:** the board's rendered status can never drift from what actually shipped or what the milestones/changelog say — it is a pure function of files that are themselves the source of truth for their own domain.

---

### 2.7 Agents roster (`docs/agents.yaml`)

**Purpose:** the org chart — every human/orchestrator/agent role, who they report to, what they own.

**Storage:** `docs/agents.yaml`, `{ version, updated, management, groups: OrgGroup[], roles: OrgRole[] }`. **Writer: none — `GET /api/agents` only**, confirmed read-only. Hand-edited.

**Field table (OrgRole):** `id, title, kind (human|orchestrator|agent), group, reports_to, status, agent_file` (required); `playbook, mode, one_liner, owns[], collaborates_with[], skills[]` (optional). `agent_file` points at the untracked `~/.claude/agents/<id>.md` definition for `kind: agent`/`orchestrator`.

**Lifecycle:** roles are added/retired/re-scoped by hand (owned by people-enablement, per `docs/agents.yaml`'s own charter). Every `owner`/`delegated_by`/`sponsor`/`project_manager`/`raci.*` id elsewhere in this schema resolves against a role `id` here — by convention, not a write-time gate.

---

### 2.8 Telemetry event (`docs/usage-telemetry.jsonl`) + TelemetrySummary

**Purpose:** local-only, events-never-content usage log (ADR-017) — what surfaces get opened/used, for the `usage-insights` routine to learn from.

**Storage:** append-only JSONL, one event object per line. **Gitignored — never committed**, unlike every other store in this document.

**Writer:** `POST /api/telemetry` (a fire-and-forget beacon), batch-capped at 50 events per call.

**Field table (one event):**

| Field | Type | Required | Stored/Derived | Meaning |
| --- | --- | --- | --- | --- |
| `ts` | ISO string | — | **SERVER-MANAGED** | Always server-stamped; a client `ts` is never read |
| `sessionId` | string, ≤40 chars | soft-required | STORED, scrubbed | Missing/empty after scrub → event dropped |
| `kind` | enum `view\|action\|run` | required | STORED | Invalid → **hard 400** (the one thing that fails the whole batch) |
| `surface` | closed allowlist, 11 values | soft-required | STORED | `jobs-board, jobs-table, job-detail, discovery-sources, discovery-finds, source-detail, insights, product-hub, chat-capture, notifications, topbar`. Invalid → soft-dropped (just that event) |
| `name` | string, ≤80 chars | soft-required | STORED, scrubbed | The only free-text field; truncated not rejected |
| `journey` | string, optional | — | STORED | Must match `/^J\d{1,2}$/` or is dropped as a field (event still kept) |
| `meta` | object, optional, ≤8 keys | — | STORED, coerced | Values coerced to string(≤60)/number/boolean only; any nested object/array/null value is dropped — **structurally** no document can ride along |
| `durationMs` | number, optional | — | STORED | Kept only if finite and ≥ 0 |

**`GET /api/telemetry/summary` → `TelemetrySummary`** (the ONLY read surface — no raw-event dump): `totalEvents, firstTs, lastTs, byKind` (pre-seeded `{view,action,run}`), `bySurface` (top 15), `byName` (top 20), `malformed` (torn/unparseable lines). All DERIVED by scanning the file per call.

**Invariants:** no field can ever carry a job title, note body, keystroke, or URL — enforced structurally (enum + allowlist + caps), not by convention. A malformed `kind` is the only hard-400 case; everything else degrades to a per-event drop with an honest `{accepted, dropped}` count.

---

### 2.9 Activity log entry (`docs/activity-log.jsonl`)

**Purpose:** the runner/delegation integrity feed (ADR-007) — what the routine runner and Claude Code's own delegation hook actually did. Telemetry, never a source of truth.

**Storage:** append-only JSONL. Tolerant reads (missing file → empty feed; a malformed line is skipped, not fatal).

**Writer(s):** `appendActivity` (server's own writer) on every routine-run start and close; `ops/activity-log-append.mjs` (a Claude Code hook script) on every subagent delegation.

**Field table:**

| Kind | Fields |
| --- | --- |
| `run` (start) | `{ ts, kind:"run", runId, routine, label, jobId, batchId?, status:"running" }` |
| `run` (close) | `{ ts, kind:"run", runId, status: "done"\|"failed"\|"stopped", exitCode, batchId? }` |
| `delegation` | `{ ts, kind:"delegation", ...hook-supplied fields, open-ended }` |
| `auth` (failure) | `{ ts, kind:"auth", event:"login_failed", reason:"bad_passphrase"\|"rate_limited"\|"bad_token", surface?, ip, userAgent, count, windowStart }` — SIM-386; login surface (auth ON) and the SIM-393 sync surface (`surface:"sync"`, `reason:"bad_token"`); **never** carries the attempted passphrase/token or any credential material (whitelisted fields only). **Bounded** (guardian condition): at most 20 failure lines per window per surface reach the log; beyond that only the in-memory counter (and a sampled stdout heartbeat) advances |
| `auth` (alert) | `{ ts, kind:"auth", event:"login_failures_threshold", surface?, count, threshold, windowMs, windowStart }` — appended exactly once per alert window; the notification feed folds these into one `login_failed` bell event per window (count overlaid with the live in-memory total, so it stays exact beyond the durable cap) |

**`batchId`** is stamped on both the start and close line of every run in a fan-out batch (e.g. batch-draft, run-all-due); a batch surfaces as one `wave_done` notification only once every run sharing that id reaches a terminal status. A run with no `batchId` emits its own individual `run_finished` notification.

**Invariants:** append-only; a logging failure is swallowed and never blocks the run it's logging. Read cap: `GET /api/activity` serves the last ~200 lines, newest-first.

---

### 2.10 Notify-state (`docs/notify-state.json`) + Notification feed

**Purpose:** DERIVED notification bell (ADR-007) — no push infrastructure, no event store; the feed is folded from data the app already records.

**Storage:** ONE small JSON file, `{ version, cursor, baseline: {tasks: {id: status}, projects: [id]}, updatedAt }`. Atomic write.

**Writer:** `POST /api/notifications/read` (advances `cursor`, re-snapshots `baseline` to the current task/project state — this is what clears the diff-based events). Seeded automatically on the very first `GET /api/notifications` ever (so pre-existing data never floods the feed as "new").

**Field table:**

| Field | Type | Meaning |
| --- | --- | --- |
| `cursor` | ISO string \| null | The read watermark; **never regresses** |
| `baseline.tasks` | `{id: status}` | Last-seen status per task id |
| `baseline.projects[]` | id[] | Last-seen set of known project ids |

**DERIVED notification types** (never stored — computed per `GET /api/notifications` call):

| Type | Derived from |
| --- | --- |
| `run_finished`, `wave_done` | The activity log (§2.9), folded by `batchId` |
| `task_added` | A task id in the current board not in `baseline.tasks` |
| `task_done` | A task id known at baseline with a non-`done` status, now `done` |
| `project_added` | A project id in `portfolio.yaml` not in `baseline.projects` |

**Invariants:** `task_done`/`project_added` are "since last acknowledge" detections, not timestamped history — `tasks.yaml` has no completion timestamp to preserve for this purpose (that's a separate concern from `Task.completed`, §2.3, which IS timestamped but per-task, not diff-based).

---

### 2.11 Config (`config.json` / `AppConfig`)

**Purpose:** app-level configuration — the vault path, ports, tool allow-lists, caps.

**Storage:** `config.json` at the repo root (`config.local.json` overrides the whole file if present, for a per-machine override that stays out of git).

**Writer: none** — hand-edited only, no API writes it.

**Fields on disk today:** `jobsDir, serverPort, serverHost, weeklyTarget, claudeAllowedTools, claudeBin, maxConcurrentRuns, attachmentMaxBytes, attachmentMaxCount, attachmentMimeAllowlist`.

**`GET /api/config` exposes only 4 of them** (the rest are consumed internally and never leave the server):

| Field | Source |
| --- | --- |
| `jobsDir` | `config.json` (or `JOBHUNT_JOBS_DIR` env override) |
| `statuses` | **Hardcoded constant** in `server/index.js` (`STATUSES`), not config-driven |
| `tracks` | **Hardcoded constant** (`TRACKS`) — the 7 canonical keys: `industry_outreach_focused, higher_ed_generalist_focused, b2b_gtm_focused, operations_leadership_focused, public_sector_focused, aerospace_defence_focused, fire_alarm_focused` |
| `weeklyTarget` | `config.json`, default `5` |

**Internal-only** (read server-side, never served): `serverPort/serverHost` (loopback-only by default), `claudeAllowedTools` (the routine runner's pre-approval tool list, ADR-005), `claudeBin`, `maxConcurrentRuns`, the three `attachment*` caps (ADR-014, env-overridable for tests).

---

## 3. Relations map

```
IntakeRequest (docs/requests.yaml)
     |  spawned.tasks[] / spawned.projects[]      (union-merge, never lost)
     v
Task (docs/tasks.yaml) ------ project/milestone ----> Project (docs/portfolio.yaml)
     |  owner / delegated_by / assignee                    |  owner/accountable/sponsor/
     |  (agents.yaml role id, by convention)                |  project_manager/raci.* (role id)
     v                                                       v
docs/agents.yaml <-------------------------------------- Milestone --- roadmap_phase --> RoadmapPhase
  (org chart, read-only)                                  (portfolio.yaml)   (soft link)   (roadmap.yaml,
                                                                                             status DERIVED
                                                                                             from milestones
                                                                                             + changelog)

DiscoverySource (docs/discovery-sources.yaml)
     |  run-now / run-all-due
     v
RunRecord[] (appended, capped 20)  --------- feeds ---------> derived status/due/nextRunAt
     |
     |  finds JOIN (sourceId, else name/alias)
     v
Discovery lead/find (Job Discovery.xlsx)  -- Pursue --> Job (Jobs/<Role> - <Employer>/<Role>.md)
                                                              |   Job.source = DiscoverySource.id
                                                              |   (v4 provenance: stamped at
                                                              |    creation, read-only after)
                                          shared enums:  track (7 canonical keys)
                                                         sector (6-value set, shared literally
                                                                 with DiscoverySource.sector)

ActivityLog (activity-log.jsonl, append-only) ---\
                                                    +--> Notification feed (derived per request,
Task/Project state (diffed vs notify-state.json)  /       never stored) <-- notify-state.json
                                                             (cursor + baseline snapshot)

Telemetry events (usage-telemetry.jsonl) --> TelemetrySummary (derived aggregate)
                                                  --> usage-insights routine --> files Task(s)

Task.comments[]   -- belongs to --> Task            (append-only, server-stamped ts)
Task.attachments[]-- belongs to --> Task, files at   docs/attachments/<taskId>/<sha256>.<ext>
                                     (server-managed, unforgeable)
```

**Prose summary:**
- **Requests spawn tasks/projects** (the origin edge; verifiable from either side via `spawned.*` and `Project.origin_request`).
- **Tasks reference UP** into milestones/projects (never the reverse) — a project doesn't enumerate its tasks; they point at it.
- **Milestones optionally soft-link a roadmap phase**, which is how the Roadmap board's `status` derives from real delivery work instead of a hand-typed guess.
- **Every role-shaped field across every store** (`owner`, `delegated_by`, `sponsor`, `project_manager`, `raci.*`, `stakeholder.role`, `risk.owner`) is an `agents.yaml` role id **by convention** — referential integrity is a read/test invariant everywhere, never a write gate, because the portfolio/agents files are hand-edited and may legitimately lag.
- **Discovery sources own runs; runs feed derived health; leads join sources; a pursued lead becomes a Job carrying its source's id as provenance** (`Job.source`, v4 — the source→lead→job chain is now traceable end to end). The Job and the DiscoverySource share two literal enums — `track` (7 keys) and `sector` (6 values, one shared array since v4) — both now validated at their write boundaries, with deliberately different failure modes (Source 400s; Job silently drops — §2.1 Invariants).
- **The activity log and the task/project diff are the ONLY two inputs to the notification feed** — there is no third data source and no push mechanism.
- **Telemetry is the one exception to "on-machine, git-tracked, disclosed forever"**: it's gitignored runtime data, reversible by deletion, and feeds exactly one routine (`usage-insights`), which in turn can only ever *file* tasks — it cannot edit any other store.

---

## 4. Governing rules

1. **No new field ships without three things**: (1) an entry in this document, (2) an identifiable writer, (3) an identifiable reader. A field that fails any of the three is removed at the next release, not accumulated. This is the direct fix for the owner's complaint: *"I will never create fields that is all over the place... keep adding new field that won't be used over and over."*
2. **Derive, don't store, anything computable** (ADR-010 through ADR-013, extended by ADR-016/017). If a value is a pure function of other stored data — a status, a health pill, a completion date, a severity, a lead count — it is computed at read time. The only stored dates/flags in this whole schema that are NOT derivable another way are: `Job.applied`, `Task.completed`, comment/attachment `ts`, request `created`/`ts`, and telemetry `ts` — every one of them is server-stamped and unforgeable specifically because nothing else in the system could reconstruct it.
3. **No second source of truth** (ADR-001). A cache or index is only ever rebuilt from the files above; it is never itself authoritative.
4. **Boundary validation should fail loud, not silently coerce** — this is the norm going forward, established by ADR-016's Discovery Source enums (a bad value is a 400) and NOT yet applied to the older Job/Task fields (a bad value there is silently dropped or defaults). New entities/fields adopt the loud posture; §6 flags the older inconsistency for a future pass, not fixed here.
5. **Path and id sanitization at every boundary that touches a filesystem path or a cross-store reference** (`sanitizeId`, `path.relative` containment checks, content-hash filenames) — nothing derived from client input is ever used as a raw path segment.
6. **Referential integrity across hand-edited YAML (portfolio, agents, roadmap) is a read/test invariant, never a write-time gate** — those files may legitimately lag the board; tests catch a dangling reference, a save never rejects one.
7. **This document is re-versioned every release** (see the Update policy banner at the top) and the schema gate is now in the release checklist (`company-os/os/governance-conventions.md` section 3) (§5 of this doc, Deliverable 2).

---

## 5. Wave-2 schema decisions (Discovery Sources v2)

Four decisions are pinned here for the Discovery Sources v2 build. Each follows the derive-not-store discipline (§4 rule 2) wherever a value is computable, and adds nothing that duplicates an existing store.

### Decision 1 — Source → track linkage

**Decision:** add an optional `tracks: string[]` field to `Source`, validated against the same 7 canonical track keys `GET /api/config` already serves (`TRACKS` in `server/index.js`) — the identical enum a Job's `track` frontmatter field uses. **Absent or empty = "all tracks."**

**Rationale:** a generic board (LinkedIn, Indeed, Google Jobs) genuinely serves every track and should not be forced to enumerate all 7 just to exist; only a track-specific source (an aerospace employer's own careers page) sets it. This is authored input, not derivable — no code can infer which tracks a board's postings will actually cover. `tracks` is a **closed enum** (not freeform): validated against the exact 7 keys `GET /api/config` serves, the same way `type`/`sector`/`active`/`cadence` already are — a present-but-invalid entry is a 400 at the write boundary (mirroring ADR-016's precedent, not inventing a new posture).

**Grouping semantics — tag membership, not exclusive assignment:** a source with two or more tracks appears **once per track it lists** when the console groups by track — it is duplicated across every group section it feeds, never forced into a single "primary" track. This matches how `track` already behaves elsewhere in the app (the Jobs track filter, `TrackBadge`) — a source *serves* tracks, it doesn't *belong to* one. A source with `tracks` absent or `[]` appears only in one dedicated "All tracks" grouping, never fanned into all 7 (which would defeat the point of grouping). The Sources console's track filter/group is a pure, stateless predicate over the stored array: `!source.tracks?.length || source.tracks.includes(selectedTrack)` — nothing new to store beyond the authored array itself.

**Alternatives rejected:** a required `tracks[]` on every source (rejected — would force busywork on every generic board, the majority case); a separate `source_tracks.yaml` join table (rejected per ADR-001 — no second store for what one optional array already expresses); inferring tracks from `sector` (rejected — sector and track are orthogonal axes today, e.g. a `private`-sector board can serve all 7 tracks); a single exclusive `primaryTrack` per source (rejected — a real source like a general-purpose employer career page can genuinely feed 2-3 tracks at once; forcing one owner would misrepresent reality and was explicitly the alternative reading flagged and rejected in the parallel W2a design spec, `docs/proposals/2026-07-04-sources-v2-design-spec.md` §7 item 4).

### Decision 2 — `nextRunAt` / `due` derivation (pin, no change; field NAME confirmed)

**Decision:** the existing ADR-016 implementation is **confirmed correct and pinned as the schema of record** — no build is needed here, only formal documentation so a v2 scheduler can consume the same fields with zero migration (which was ADR-016's own stated intent). **The derived field keeps its already-shipped name, `nextRunAt`** (on `DerivedSource`, alongside the boolean `due`) — this document does not introduce a `nextDueAt` field; that name never existed in code and would be pure churn (the parallel W2a design spec's open question #2, `docs/proposals/2026-07-04-sources-v2-design-spec.md` §7, is resolved here: keep `nextRunAt`).

**Per-cadence derivation — all four enum values, all already implemented in `cadenceIntervalDays`/`deriveSourceStatus`:**

| Cadence | Interval | `nextRunAt` | `due` (≥1×) | `stale` (≥2×) |
| --- | --- | --- | --- | --- |
| `manual` | — | always `null` | always `false` | never applies |
| `daily` | 1 day | `lastRunAt + 1d` | `now ≥ lastRunAt + 1d`, or never run | `now ≥ lastRunAt + 2d` |
| `weekly` | 7 days | `lastRunAt + 7d` | `now ≥ lastRunAt + 7d`, or never run | `now ≥ lastRunAt + 14d` |
| `monthly` | 30 days | `lastRunAt + 30d` | `now ≥ lastRunAt + 30d`, or never run | `now ≥ lastRunAt + 60d` |

`daily`/`weekly` have live source instances in `discovery-sources.yaml` today; `monthly` does not yet (a data fact — the code path is identical and already exercised by tests/derivation, not a stub). Both `due` and `stale` require `active !== "no"`, and a `running`/`failed` run pre-empts both (full precedence order in §2.2). `nextRunAt` is `null` whenever `lastRunAt` is unset, regardless of cadence. Counting rule for any UI rollup (e.g. a freshness header): **count by the discrete `status` enum** (`due`, `stale`, `never-run`, `healthy`, …), never by the raw `due` boolean — `due` is `true` for both the `due` and `stale` statuses in the server's derivation, so tallying off the boolean double-counts.

### Decision 3 — Scrape output contract: minimum lead fields, a server-derived `contractGaps` on the source, and a lead-level triage flag

**Decision:** a lead can become a Job with **zero manual re-research** only if it carries: `title` (→ `Job.role`), `employer` (→ `Job.employer`), a **direct posting URL** (→ `Job.link` — must open the actual job-description/apply page, never a search or listing page), and a **deadline** (→ `Job.deadline`, ideally a literal `YYYY-MM-DD`; a free-text deadline like "rolling" is accepted but low-confidence). `location`/`salary` remain nice-to-have; `sector`/`track`/`fit`/`tailoring` are assigned by the agent at pursue time, not required at scrape time. This gap-detection is checked at **two levels**, deliberately not one, because the two questions are different and need different mechanisms:

**(3a) Source-level, config-time — `contractGaps` on `DerivedSource`, SERVER-DERIVED, never client-computed.** A source's declared `outputFields[]` is a freeform tag list (e.g. `[title, employer, location, deadline, salary, link]`) — whether it even INTENDS to capture a direct link or a deadline is knowable before a single lead is scraped. `deriveSources` (server-side, alongside `deriveSourceStatus`) computes:

```
contractGaps: ("direct-link" | "deadline")[]
```

— the subset of the two required-but-freeform concepts NOT present (case-insensitively) in `outputFields`, checked against one canonical alias table (owned server-side, the single place this ever gets guessed):
- **direct link** aliases: `link`, `url`, `posting url`, `direct link`, `apply link`, `job url`
- **deadline** aliases: `deadline`, `closing date`, `application deadline`, `due date`

Empty array = the source's contract is complete. This MUST be computed once, server-side, and served pre-computed on `DerivedSource` — **not** reimplemented as client-side regex/alias-guessing in multiple components (the Sources card, the detail drawer, the form). This resolves, in the affirmative, the open question the parallel W2a design spec raised (`docs/proposals/2026-07-04-sources-v2-design-spec.md` §6.1/§7 item 3, which had shipped a client-side `computeContractGaps` explicitly labeled "fallback only" pending this decision) — the client-side helper is retired once the server field ships; the console renders the server's `contractGaps` array directly.

**(3b) Lead-level, render-time — a presentation rule, not a new stored/derived field.** A lead missing a real direct link or a real deadline is **never silently filed as clean**: today, both `SourceDetailDrawer.tsx`'s Leads tab and `TriageInbox.tsx` simply omit the link anchor / deadline pill when the value doesn't validate (`isRealUrl`/no date match) — a **silent omission**, which this decision closes as a defect, not a feature request. Fix: render an explicit `⚠ no direct link` / `⚠ no deadline` chip instead of nothing, using data **already served** on the `Discovery` object — `isRealUrl` (already in `src/lib/sources.ts`) plus one new equivalent date-validity check. No new field is needed here: unlike (3a), this is a deterministic check on a concrete string value already in hand, not an ambiguous alias-match over a freeform tag list, so it stays a cheap client-side render rule. `Pursue` remains available (never blocking); a pursued lead's gap is inherited by the created Job (a blank `link`/`deadline`), which the shipped age-based needs-attention buckets (v0.18.0, audit F1) then re-surface on their own.

**Alternatives rejected:** rejecting an incomplete lead outright at scrape time (rejected — hides real signal; the owner wants visibility, not silent filtering); making `location`/`salary` mandatory too (rejected — frequently and legitimately absent from real postings, would flag most leads); a single mechanism instead of two (rejected — a source-level config gap and a single bad lead are different failure modes with different fixes: edit the source's `outputFields`/instructions vs. manually complete one lead); computing `contractGaps` client-side (rejected per this decision and per the design spec's own recommendation — one canonical alias table, one place it can drift, server-owned).

### Decision 4 — Instruction-proposal loop (owner-triggered, agent-proposed, owner-approved)

**Context:** the owner will stop hand-editing a source's `instructions` ("the cheatcode to scrape that company"). Going forward: the owner leaves a comment → a scout-agent run probes the source and files a proposal (rewritten instructions + rationale) → the owner approves (replaces `instructions`, with provenance) or rejects with a reason (archived, feeds the next proposal attempt).

**Companion authoring principle:** a **new** source is authored with just `name` + one landing `url` (the board/company careers landing page). This needs no create-time schema change — `POST /api/discovery/sources` already requires only `name`, and `instructions` already defaults to `""` when absent. What changes is process: `instructions` is never hand-typed by the owner, at creation or later — it is set **only** through an approved proposal below.

**New sub-entity — `InstructionProposal`, an append-only array on `Source` (`instructionProposals[]`, optional, absent when empty — the same "stripped when empty" convention as `Task.comments`/`attachments`):**

| Field | Type | Stored/Derived | Meaning |
| --- | --- | --- | --- |
| `id` | `ip-<epochms>` | **SERVER-MANAGED** | Unforgeable, generated on file |
| `ts` | ISO string | **SERVER-MANAGED** | Creation timestamp |
| `ownerComment` | string | STORED, verbatim | The trigger — never trimmed/sanitized, same posture as `IntakeRequest.text` |
| `proposedInstructions` | string | STORED | The agent's proposed replacement text, same free-text shape as `Source.instructions` |
| `rationale` | string | STORED | The agent's prose justification |
| `status` | enum `pending\|approved\|rejected` | STORED, WRITE-VALIDATED | Default `pending`; **one-way transition** — a resolved proposal can never be patched again (400 on an illegal transition) |
| `resolvedAt` | ISO string, optional | **SERVER-MANAGED** | Stamped only on approve/reject |
| `rejectionReason` | string, required iff rejected | STORED | Owner-authored prose; feeds the next `propose-instructions` run's prompt |

**Provenance on `Source` itself** (both SERVER-MANAGED, unforgeable — set only as a side effect of approval, never independently writable): `instructionsApprovedFrom` (the approved proposal's `id`) and `instructionsUpdatedAt` (= that proposal's `resolvedAt`). Absent when the live `instructions` predates this loop (never changed since creation).

**Workflow / writers:**
1. Owner leaves a comment under a source's instructions → `POST /api/discovery/sources/:id/instruction-proposals/propose { ownerComment }` — human-click-gated (ADR-005 posture), launches a new `scope:"source"` routine `propose-instructions`, bound to `job-search-scout`. Its prompt is built from the source's `urls[]` (landing page), current `instructions`, the **full history** of prior proposals (so past `rejectionReason`s feed the next attempt, per the owner's explicit ask), and the new `ownerComment`.
2. On completion, the routine calls back through the app's own API — `POST /api/discovery/sources/:id/instruction-proposals { ownerComment, proposedInstructions, rationale }` — mirroring `assess-ticket`'s "agent writes back through the API, never hand-edits YAML" posture. The server stamps `id`/`ts`/`status:"pending"`.
3. **Approve:** `PATCH /api/discovery/sources/:id/instruction-proposals/:proposalId { status:"approved" }` → stamps `resolvedAt`, and — the one side effect — replaces `Source.instructions` with `proposedInstructions`, stamping `instructionsApprovedFrom`/`instructionsUpdatedAt`.
4. **Reject:** same PATCH shape, `{ status:"rejected", rejectionReason }` (required, non-blank, mirroring `validComment`) → stamps `resolvedAt`; `Source.instructions` is untouched; the rejected proposal is **never deleted** — it's the training context for the next attempt.

**Invariants:** `instructionProposals[]` is append-only — a resolved proposal is never edited again, only read. Exactly one `Source` field (`instructions`) is ever mutated by this loop, and only through an "approved" transition. The full history of every proposal (text + resolution) IS the audit trail — no separate log is needed.

**Rationale:** this mirrors two patterns already proven in this codebase rather than inventing a new one — `assess-ticket`'s "agent proposes, human approves via the app's own API" (ADR-005 addendum) and `Task.completed`/`TaskAttachment`'s "unforgeable, server-managed, appended not replaced" posture (ADR-013/014). Zero new store (still `discovery-sources.yaml`, still atomic); zero drift risk (the live `instructions` value's provenance is always traceable to the one proposal that produced it, or to "unchanged since creation").

**Alternatives rejected:** letting the owner keep hand-editing `instructions` alongside the proposal loop (rejected — reintroduces exactly the drift/quality variance the owner is trying to eliminate); a separate `instruction-proposals.yaml` store (rejected per ADR-001 — the proposal is intrinsically the source's own data, one file, one atomic write); silently auto-applying a proposal without approval (rejected — instructions steer a live scraping agent against a real company's site; an unreviewed bad instruction could waste runs or scrape the wrong thing, and the owner explicitly wants the human gate).

**As-built (2026-07-04, t-1783198113775 server half — software-architect).** Shipped exactly per this decision, with four recorded amendments, each documented in §2.2's tables:
1. **`ownerComment` is optional on the propose trigger** (`""` accepted): a brand-new source's first proposal is a legitimate cold start — requiring prose would block the starting-link flow (create with name + URL, then ask for a first proposal). The prompt states the cold-start case explicitly instead.
2. **A propose run does not touch the scrape bookkeeping**: no `lastRunAt` stamp, no `runs[]` record. Those two fields anchor the cadence derivation (`due`/`stale`/`nextRunAt`); stamping them from a non-scrape would mark a source fresh without one lead fetched — exactly the drift ADR-016 exists to prevent. In-flight state is served instead as the derived `proposeRunId` (process state, never stored), which is also the propose endpoint's own 409 guard.
3. **A manual `instructions` edit clears `instructionsApprovedFrom` and re-stamps `instructionsUpdatedAt`** (the W2a spec's gated escape hatch stays server-legal): without this, the provenance field would keep naming a proposal whose text no longer matches the live instructions — a recorded lie. Provenance now always reads honestly: both fields set = approved from that proposal; `instructionsUpdatedAt` alone = set manually; neither = unchanged since creation.
4. **One new SSE event, `source-proposals-changed { sourceId }`**, emitted on file/approve/reject (the proposal store lives in `docs/`, outside the JOBS_DIR watcher — same reason `tasks-changed` exists). A propose RUN's close is the ordinary `run-finished` event.

Durability caveat, accepted knowingly: the owner's comment is persisted only when the scout files the proposal carrying it (per this decision's step 2). If a propose run dies before filing, the comment survives only in the failed run's prompt/record (visible in the runs panel until pruned) — the owner re-comments. The alternative (a new pending-comment field on `Source`) was judged more schema surface than the failure mode warrants; revisit only if failed propose runs become common.

---

## 6. Known gaps observed while authoring this doc (for the W1b auditor)

These are **observations, not fixes** — flagged here for the CTO / W1b governance audit to verify and triage; nothing below was changed while writing this document, per this ticket's constraints.

1. ~~**`Job.source` frontmatter key is orphaned.**~~ **RESOLVED in v4 (2026-07-04, t-1783199066654): wired as discovery provenance** — writer `createJobFolder` (pursue/create resolution), reader `toJob`, legacy free-string values tolerated verbatim. See §2.1's `source` row. The no-field-without-writer+reader rule is now satisfied for this field.
2. ~~**Job frontmatter enums are unvalidated at the write boundary; Discovery Source enums are.**~~ **RESOLVED in v4 (2026-07-04, t-1783199066683): Job enum fields are now write-guarded** with the Task posture (present-but-invalid silently ignored; tolerant read unchanged) — a deliberate decision, not the Source 400 posture, so legacy workbook rows stay pursuable. Rationale recorded in §2.1's Invariants.
3. **`RunRecord.trigger` declares `"scheduled"` but no code path emits it.** Only `manual` and `all-due` are ever written today; `scheduled` is dead enum surface pending an actual background scheduler.
4. **`Task.checklist[]` and `Task.attachments[]` are fully built (validated write path + types) but have zero live instances.** `docs/attachments/` is an empty directory; no task in `docs/tasks.yaml` carries a `checklist`. Not necessarily wrong (a shipped feature can predate its first real use), but worth the auditor confirming these are still intended to be used rather than dead surface.
5. **`loadTasks` has no try/catch around its own read/parse**, unlike `loadRequests`/`loadSources`/`loadNotifyState` which all degrade tolerantly on a hard parse failure. A malformed `tasks.yaml` would throw rather than degrade — an inconsistency in the tolerant-load posture across the sibling YAML stores.
6. **`GET /api/portfolio`, `/api/roadmap`, `/api/agents` return a 500 on a hard read/parse failure** (only a missing array *key* is defaulted via `ensureArrays`), while `requests`/`sources`/`notify-state` degrade to an empty/default object even on a hard parse failure. Three read-only stores vs three read/write stores land on two different tolerance postures — worth a single documented convention rather than two.
7. **`Job.applied` and `Task.completed` are both "reached-state" stamps but behave asymmetrically:** `Task.completed` is cleared the moment the task leaves the terminal state (ADR-013's explicit invariant, going forward from a transition); `Job.applied` is never cleared once stamped, even if a job's status is later changed away from `submitted`. This may well be the *right* call for each (an application-submitted date is a historical fact; a ticket's completion is a live state) — flagged so the difference is a decision, not an oversight. Relatedly, `Task.completed` was never backfilled onto tasks that reached `done` before ADR-013 shipped (2026-07-03) — 82 of 126 currently-done tasks legitimately lack it (see §2.3's field table for the precise invariant wording, corrected by the W1b audit).

---

## 7. Data contract guarantees (absorbed from `DATA_CONTRACT.md`)

**Doc-topology note (2026-07-04, per the W1b audit and owner ruling):** `DATA_CONTRACT.md` lived at the repo root, outside `docs/`, which made it invisible to the app's own document hub (the hub serves only `docs/` + whitelisted subdirectories) — a governance/spec document the app itself cannot show the owner. The standing rule going forward: **every governance/SOP/spec/schema document lives in the hub.** This section is that content, absorbed into the one canonical, hub-visible data reference; `DATA_CONTRACT.md` at the repo root is now a short pointer to this section (kept at root only for repo-browsing discoverability — a contributor scanning the repo root before finding `docs/` at all). There is exactly one source of truth for these guarantees from now on: this section. Nothing here duplicates content maintained elsewhere — every guarantee below points at the entity section (§2) that carries the full field-level detail; this section states the *policy*, §2 states the *mechanism*.

### 7.0 Data-at-rest disclosure: the private cloud instance (D1 amendment, executed 2026-07-16)

Per the MODE-4 amendment to the kernel contract (`company-os/decisions/2026-07-16-data-contract-amendment-cloud.md`, executed at RC-2 cutover with Simon authorizing as data subject), the real job-hunt dataset has a SECOND authorized data-at-rest location: the **jobhunt-private Railway instance** (project `261ea825`, managed Postgres, private networking, encrypted at rest and in transit). Everything in §2 maps 1:1 onto its Postgres schema through the Store seam (`server/store.js` / `pg-store.js` in the cloud repo); the migration into it is byte-verified through that same seam.

- **Access path (owner decision, 2026-07-16):** a public Railway domain with **required strong auth** — every `/api/*` route 401s without a valid session; login is Argon2id passphrase, rate-limited; TLS + HSTS. No anonymous route to any data.
- **The four guarantees hold there verbatim** — never auto-submits, never deletes, disclosure before departure; "loopback-only" is satisfied by the auth wall + private DB networking instead of the bind address.
- **The local file path is FROZEN, not deleted.** This laptop app keeps reading/writing the data zone exactly as documented below; the cloud instance is a separate deployment over the migrated copy. Neither writes to the other.
- **No Anthropic key, no `claude.exe`, no agent execution on the cloud instance** (D5): agent runs stay laptop-side; the cloud holds only a verify-only sha256 of the runner token.
- **Failed logins are visible, never silent (SIM-386, guardian RR-1).** Every failed attempt against the auth wall is logged to the platform stream and recorded as a `kind:"auth"` activity-log line (§2.9: timestamp, proxy-derived IP, user-agent, reason, rolling count — **never** the attempted passphrase or any credential material); 3+ failures in a 15-min window surface exactly one "N failed login attempts" notification in the app bell, and recent events are readable authed at `GET /api/auth/failed-logins`. No new data leaves the instance — this is in-app + platform-log visibility only.

### 7.0.1 The SIM-393 data-flow lanes between the two authorized stores (mirror half, landed with I6)

Per the SIM-393 design gate (`company-os/audit/2026-07-17-sim393-vault-cloud-dataflow-design.md`, Owner amendment v2) and its guardian delta review (`company-os/audit/2026-07-18-sim393-v24-mirror-delta-review.md`), data moves between the owner's two authorized stores (the private cloud instance of §7.0 and this laptop) over dedicated, least-privilege token lanes. Each lane's disclosure lands in the same wave as its code (contract §6 / guardian GC-5): the ingest half was shipped DORMANT with I1 (the insert-only `/api/sync/*` surface + `SYNC_TOKEN`, activated only at the one-shot transition import, I3); the export-snapshot half lands with I5. **This section is the MIRROR half, landed with I6:**

- **The vault Jobs tree is now a PASSIVE REPLICA (digital twin), by dated owner decision (2026-07-17).** Cloud PG is canonical for everything, including job files. The mirror process is the only writer in the vault Jobs tree going forward; nothing flows vault→cloud after the transition import.
- **The lane:** a laptop-side client (`ops/mirror-vault.mjs`) holds **one standing outbound HTTPS long-poll connection** to the named private instance (`GET /api/mirror/changes`, ~25s hold, reconnect with exponential backoff). Event frames are triggers only — a change counter and timestamp, never names, paths, or content. On a trigger (debounced ≥ 5s, plus an hourly full-manifest safety-net sweep) the client diffs `GET /api/sync/manifest` and pulls only changed bytes through the guarded job-file reader and a raw job-detail read, reconstructing each `<Role>.md` byte-faithfully from its raw frontmatter + body, then writes into the vault Jobs tree. Outbound-only: no listener, pinned host, https-only, redirect-refusing, TLS-bypass-refusing — re-asserted on every reconnect.
- **The credential:** `MIRROR_TOKEN`, a **jobs-domain, GET-only read token** (guardian GC-9) — separate from `SYNC_TOKEN`, `EXPORT_TOKEN`, `RUNNER_TOKEN`, and the passphrase, each independently rotatable; no credential grants another's powers (proven by a cross-auth test matrix). It opens exactly: the change feed, the sync manifest, the raw job-detail read, the guarded file reader, and one bounded report endpoint (`POST /api/mirror/runs` — one structured activity line per writing mirror pass, so unexpected mirror activity is owner-visible in-app). It cannot read chats, tasks, activity, telemetry, or sources, and cannot write anything. The cloud holds only a sha256 verify-hash (`MIRROR_TOKEN_HASH`); the plaintext lives in `~/.ssc-secrets` on the laptop only. The demo instance refuses to boot if any mirror material is present.
- **Overwrite-own-writes ONLY (the recorded owner exception, three-way sha check):** the mirror may create its mirror copies and may update **only bytes it itself wrote** — an update proceeds solely when the current vault bytes' sha256 equals the sha recorded in the local mirror-state manifest (`%LOCALAPPDATA%\ssc\jobhunt-mirror-state.json`, a derived cache, never a source of truth). Anything else — an out-of-band vault edit, a lost state cache, a pre-existing divergent file — is SKIPPED and reported loudly, never clobbered. First run performs an adoption pass: byte-identical pre-existing files are adopted without a write; divergent ones surface in a one-time transition report and are left untouched. Creates are exclusive (fail-if-exists) and case-collision-safe; all writes are atomic (temp + rename) and every cloud-supplied name passes the shared `server/name-safety.js` validation + containment before any write.
- **Absolute no-delete:** the mirror client contains **no delete code path at all** (test-proven, structurally and behaviorally). A file absent from the cloud never causes a vault deletion — absence is not a delete instruction. The named consequence: **stale mirror copies accumulate in the vault** (e.g. when a cloud file is superseded by a dated sibling, the old mirror copy stays). That accumulation is the accepted cost of the never-deletes guarantee, disclosed here so it is never a surprise.
- **What is mirrored:** the Jobs domain only (job files + companion files). Chats, tasks, activity, telemetry, sources, and every other domain are **not** mirrored into OneDrive — they never lived there, and mirroring them would add a storage party for data classes that never resided in the vault (refused by design).
- **Activation is gated:** the lane ships dormant. It runs only after `MIRROR_TOKEN` provisioning GO, the landing-time guardian check, and the decision-log record of the owner amendment (guardian GC-11) are all on file. Vault job-file content is treated as untrusted data — never instructions — by every agent that reads the vault (guardian GC-12 / RR-8), and the mirror itself never renders, executes, or launches anything it writes.

### 7.1 What the app may do

| Guarantee | Mechanism (see §2 for the field-level detail) |
| --- | --- |
| Read every job file under `Jobs/` | §2.1 Job |
| Write targeted, one-line frontmatter changes (`status, fit, track, sector, tailoring, deadline, applied, next_action, next_action_date, link`) | §2.1 Job — `updateFrontmatter` / `WRITABLE_FIELDS` |
| Advance a job's status when the agent run it launched succeeds — `queued -> drafted` after Draft, `drafted -> ready` after Finalize (a rule-based automatic write, not a direct edit; evidence-backed, forward, pre-submission, never submits) | §2.1 Job — `nextStatusAfterRun` (pure rule) / `maybeAutoAdvanceJob` (ADR-022, ext. t-1783481509014) |
| Auto-close expired pre-submission jobs (`lead`/`queued`/`drafted`/`ready`; a rule-based automatic write not triggered by an explicit edit) | §2.1 Job — `sweepExpiredJobs` / `shouldAutoClose` |
| Create a new `Jobs/<Role> - <Employer>/<Role>.md` on "Add lead" or "Pursue" | §2.1 Job — `createJobFolder` |
| Overwrite the gaps / job-description note (a whole-file write, restricted to exactly those two note names, never the `<Role>.md` SoT file) | §2.1 Job — `PUT /api/jobs/:id/file` |
| Open existing files (CV, cover letter, posting) in their OS default app, or reveal the job's own folder in the OS file manager | Not a data write — a local `shell.openPath`-style action (`POST /api/open` for one file; `POST /api/jobs/:id/open-folder` for the containing folder, t-1783481685241). Both build the launch argv via `buildOpenCommand` (execFile argv, never a shell string) and are path-contained to `Jobs/` (a traversal/unknown id 404s before any launch). Only honest when the client IS the server's desktop; a remote client uses the guarded reader below for files, and the drawer hides the folder-reveal button off-desktop (a folder has nothing to stream) |
| Serve a job-folder file read-only to the app's own client (the remote-honest Files path — a phone over the tailnet streams/views the file instead of a silent no-op) | `GET /api/jobs/:id/files/:name` — a guarded reader, not a static server: existence-allowlisted to the folder's own listed direct-child files, path-contained, conservative MIME map (text formats as `text/plain`, scriptable/unmapped as `octet-stream`), `nosniff` + CSP `default-src 'none'` + `no-store` (the ADR-014 reader idiom). Read-only by construction; pinned by `tests/job-file-serve.test.js` |
| Track notifications (derived, no push, no event store) | §2.10 Notify-state + Notification feed |
| Log routine-runner activity | §2.9 Activity log |
| Stamp a task's completion date | §2.3 Task — `completed` (see the precise, non-universal invariant there) |
| Track intake (the request ledger) — verbatim prompt, never sanitized | §2.4 Request |
| Attach a pasted image to a ticket (the app's first binary write-path) | §2.3 Task — `TaskAttachment` |
| Archive dead discovery rows (moved, never deleted, inside the same workbook) | §2.2 Discovery Source / Discovery lead — the `discovery.py prune` step |
| Manage discovery sources (the channel registry) | §2.2 Discovery Source |
| Fetch public job postings from Apify's REST API for an owner-enabled `apify` source (the file bridge's one and only outbound call class; owner-gated, off by default, carries ONLY the source's public search query) | §2.2 Discovery Source (`runApifySource`); full egress disclosure in §7.2.1 |
| Record usage-journey telemetry (events, never content; local-only, gitignored) | §2.8 Telemetry event |

### 7.2 What the app must never do

- **Never deletes** a job, folder, or generated document. "Removing" a job from the pipeline is `status: closed` (a frontmatter change), never a file delete.
- **Never rewrites** the body of a job note, the generated CVs/cover letters, or anything in `ops/facts/`.
- **Never auto-submits** an application. Submitting is always a human action; the app only records that it happened (`Job.applied`).
- **Never touches anything outside the configured `Jobs/` directory.** No vault content, job file, generated document, `ops/facts/` fact, CV or cover letter, discovery find, or credential ever leaves the machine: the file bridge never sends the owner's data off-box. It binds **loopback-only by default** (`127.0.0.1`) and is reachable from another device only when the owner explicitly sets `serverHost` in `config.json` (§2.11). **One scoped, owner-gated exception, off by default:** an owner-enabled `apify` discovery source makes the file bridge's single outbound call class, to `api.apify.com`, carrying ONLY that source's stored public search query (position + location) and never any of the data named above. Disclosed in full in §7.2.1. (Availability of the separate Claude Code runtime paths, Remote Control and push, is disclosed in §7.3.1; those are unchanged here and are not the file bridge.)

### 7.2.1 The one outbound call: Apify discovery egress (owner-gated, off by default)

Introduced in schema v5 with the Apify discovery-source build (t-1783339605935); this disclosure is the condition the security review required IN PLACE before the path is wired live. An `apify` discovery source (§2.2) runs deterministically on the server. When it runs, the file bridge makes a single outbound HTTPS call to `api.apify.com` (Apify's "run actor synchronously and get dataset items" endpoint) to fetch a list of public job postings, then writes the mapped finds through the same local `discovery.py` workbook path every scout run already uses (a local write, not egress). This is the file bridge's first and only outbound call class. It is disclosed here because it is a real, new egress. It is NOT a loosening of the never-leaves-the-machine guarantee for the owner's data.

- **What leaves the machine, and nothing else.** ONLY the running source's own stored public search query leaves: the actor `input` object (position/query, location, and run-shaping params such as `maxItems`/`country`) plus the `actorId` in the request path. This is the load-bearing invariant (C1): the Apify request body is built SOLELY from the source's own `input`/`actorId` fields, never from any vault content, job file, `ops/facts/` fact, CV or cover letter, discovery find, or owner credential. Those never enter the request and never leave the box. The query itself is public information the owner typed into the source form, the same words one would type into a job board's search box.
- **Secret handling.** The call is authenticated with an `Authorization: Bearer <APIFY_TOKEN>` header. The token is read ONLY from `process.env.APIFY_TOKEN`. It is never a `config.json` key (that file is git-tracked), never written to `discovery-sources.yaml`, never logged, and never sent to the client. It rides in the request header, not the URL, so it stays out of any URL logging. The server exposes only a presence boolean (`apifyConfigured`), never the value.
- **Egress is host-allowlisted.** The only host this path ever contacts is `api.apify.com`.
- **Off by default, owner-gated (three conditions).** It ships OFF: `apifyEnabled` is `false` by default (a `config.json` flag that NO code path writes, only the owner), so the file bridge makes zero outbound calls until the owner does all of: (1) sets `apifyEnabled: true` in `config.json`, AND (2) sets `APIFY_TOKEN` in the environment, AND (3) creates + activates an `apify`-type source. The server exposes a presence-only `apifyConfigured = apifyEnabled && Boolean(APIFY_TOKEN)`; token-alone (without the flag) or the flag-alone (without a token) is refused. When not configured, a per-source Run-now returns a friendly 400 BEFORE any run record is written (no fake run, `lastRunAt` untouched, cadence not advanced), and `run-all-due` skips every apify source and reports it as skipped. Setting `apifyEnabled: false`, deleting the source, or unsetting the token returns the file bridge to zero egress.
- **Spend is bounded** (this egress costs money): a per-run item ceiling (`APIFY_MAX_ITEMS_PER_RUN`, default 50, Apify-enforced and input-clamped), a per-sweep run cap (`APIFY_MAX_RUNS_PER_SWEEP`, default 5), and a local monthly run cap (`apifyMonthlyRunCap`, default 100) DERIVED from the existing `runs[]` history (no second store: `run-all-due` filters out apify sources once the current month's apify-run count reaches it). The authoritative dollar limit still belongs on the owner's Apify console as the hard backstop - which also covers the one residual, that a single source running >20 times in a month can under-count locally because `runs[]` is capped at 20/source. Full design: `docs/proposals/2026-07-06-apify-discovery-source.md`.

Net guarantee: nothing about the owner's vault, job files, personal facts, CVs, or credentials leaves the machine on this path. Only the owner's own public search query does, over an owner-gated, host-allowlisted, off-by-default call.

### 7.3 The routine runner is a separate, human-gated path (ADR-005)

These guarantees describe the **file bridge** (the Express API + UI): read, write, create, open — all bounded to `Jobs/` and the app-managed stores in §2. They do **not** describe the routine runner. One-click "Run" buttons launch a scoped Claude agent (`claude -p`) whose working directory is the vault workspace *above* `Jobs/`, with an explicit, config-editable tool list (`config.json` → `claudeAllowedTools`, §2.11) that includes Bash/Write/WebFetch by design — so a routine can read/write across the vault (e.g. `ops/facts/`) and fetch a posting from the web. That path still never auto-submits and every run is visible and stoppable, but it is not confined to `Jobs/` and can reach the network. Two routines are ticket-scoped (`work-ticket`, `assess-ticket`) rather than job-scoped, working from an owner-authored ticket instead of a fixed prompt; `assess-ticket` is additionally comment-only by charter (`--disallowedTools Write,Edit,NotebookEdit`) and writes back only through this app's own task API, never by hand-editing `tasks.yaml`. Each product routine also runs **as its owning `agents.yaml` role** (`--agent`, ADR-015) — a persona binding, verified empirically to never broaden the tool ceiling past `--allowedTools`/`--disallowedTools`. Full decision record: ADR-005 and ADR-015 in `docs/product-decisions.md`.

### 7.3.1 Remote Control availability (ADR-018 stage 0, R1)

As of v0.22.0 the owner may opt the laptop's Claude Code runtime into Remote Control (an Anthropic research-preview feature): sessions running on this machine become visible and steerable from claude.ai/code and the Claude mobile app, signed in under the owner's own Anthropic account. This changes availability, not data flow: execution and file access stay on this machine; the session carries the same content class (prompts, tool output, file excerpts the session reads) to the Anthropic API over outbound-only HTTPS polling that every local session already sends for inference, and it opens no listening socket on any interface (asserted per release with `ops/scripts/assert-rc-no-listener.ps1`; result recorded on ticket t-1783198032014). The file bridge, its loopback-only bind, and every guarantee in 7.1 and 7.2 are unchanged. Disclosed plainly: whoever holds the owner's claude.ai login can steer a session on this machine, so account 2FA is enabled before opt-in and the claude.ai active-session list (claude.ai -> Settings -> Account) is part of the periodic review habit; a remote session is revocable there and from the claude.ai/code session list, and dies with the local process. When native mobile push is enabled, notifications are delivered through Apple (APNs) and Google (FCM) push services: notification text can carry session-derived content (at minimum the session title, which derives from the prompt or conversation), so Apple and Google act as transit parties for that notification text, and for nothing else. Push has no verbosity setting beyond two on/off toggles (push when Claude decides, push when actions required); the only way to remove the push-relay exposure is to leave push off.

### 7.3.2 The per-job assistant chat is read-only and local (Part 4)

The job page's "Ask about this job" chat spawns a scoped Claude agent (`claude -p`) per message whose message text is FREE-FORM owner input - unlike the routine runner's fixed prompts. Safety here is the tool scope, not the prompt: this assistant is spawned with read-only, LOCAL tools only (`--allowedTools Read,Glob,Grep`) plus a hard deny-list (`--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch`) and `--strict-mcp-config` (loads zero MCP servers regardless of the owner's user/workspace config). So it can read the vault to answer, but it has NO file-mutation, exec, delegation, network, or MCP tool: it cannot edit, create, delete, submit, contact anyone, or send anything off-machine - a crafted instruction inside a scraped job posting still hits a process with no egress or write channel. It may only RECOMMEND one of the whitelisted guarded routines (returned as a routine-key `suggestedAction`); nothing runs until the owner clicks the guarded button, which routes through the normal `POST /api/routines/run` path (whitelisted routine + fixed prompt) - the free-form text never reaches the routine runner. Transcripts persist app-side in `docs/job-chats.json` keyed by jobId (an app-managed store, like tasks/requests), never in the job folder. Message, prompt-context, and transcript length are all bounded.

### 7.4 Configuration

The vault path is set in `config.json` → `jobsDir` (§2.11); `config.local.json` overrides the whole file without touching the committed one.

---

## 8. Schema-doc change log

| Version | Date | Change |
| --- | --- | --- |
| 6 | 2026-07-18 | **SIM-393 I6 mirror-lane disclosure (new §7.0.1, mirror half).** The vault Jobs tree is re-designated a passive one-way replica of the cloud (Owner amendment v2, 2026-07-17); the standing cloud→vault mirror lane is disclosed in full: `MIRROR_TOKEN` (jobs-domain GET-only, guardian GC-9), the standing outbound long-poll connection (`GET /api/mirror/changes`, triggers only), overwrite-own-writes-only semantics (three-way sha check against `%LOCALAPPDATA%\ssc\jobhunt-mirror-state.json`), the absolute no-delete rule, and the accepted accumulation of stale mirror copies. Same-wave with the I6 code per contract §6 / GC-5, gated by the guardian delta review `company-os/audit/2026-07-18-sim393-v24-mirror-delta-review.md`; activation additionally requires the GC-11 decision-log record. Ingest half (I1/I3) noted as shipped-dormant; export half lands with I5 |
| 5 | 2026-07-06 | **Apify discovery source disclosed in the schema + data contract (t-1783339605935).** (1) `Source.type` enum extended to `employer\|board\|apify`; `apify` is now an accepted, write-validated type (was reserved, a `{type:"apify"}` write 400'd before). (2) Three apify-only stored fields added to §2.2: `actorId` (required for apify, sanitized, 400 without), `input` (object, default `{}`, run-time clamped to `APIFY_MAX_ITEMS_PER_RUN`), `fieldMap` (object, optional); authoring-surface and invariants rows updated to match. (3) **§7.2 amended + new §7.2.1 added:** the file bridge's blanket "nothing it does leaves the machine" is corrected to a precise, still-strong guarantee (no vault/job/facts/CV/discovery-find/credential data ever leaves) plus one scoped, owner-gated, off-by-default exception: an owner-enabled apify source makes one outbound call to `api.apify.com` carrying ONLY its stored public search query (the C1 invariant: the request body is built solely from the source's own `input`/`actorId`), Bearer-authed from env-only `APIFY_TOKEN` (never committed, never logged), host-allowlisted. §7.1 gains the affirmative "may do" row. This is a scoped exception for the owner's own public query, NOT a loosening of never-leaves-machine for user data. Lands this wave with the concurrent Apify build (`server/index.js` accept + run path, `src/` form); design: `docs/proposals/2026-07-06-apify-discovery-source.md`. Governance ADR fold-in owed on merge (proposal §11); release-manager confirms the app version at cut |
| 4 | 2026-07-04 | Four field-level changes in one window (software-architect). (1) **Run honesty counters** (t-1783200897663 a): `RunRecord.candidatesReviewed`/`alreadyTracked`/`filteredOut` (agent-reported via the new `POST /api/discovery/sources/:id/runs/:runId/report`; prompt carries the run's own id) + derived `lastRunSignal` (`leads\|dedup\|quiet\|unverified\|null`) so a leadsFound-0 run is legible as healthy dedup vs broken scrape. (2) **Single-source read** (t-1783200897663 b): `GET /api/discovery/sources/:id` serves the registry GET's derived per-source shape + `proposeRunId` + locked degrade. (3) **`Source.fetchMode`** (closed enum `direct-list\|google-site\|alert-email`, loud 400, null=unclassified) **+ `fetchNote`** (t-1783200897663 c), fed into the run prompt; 33/46 committed sources migrated from unambiguous instruction prose (test-guarded). (4) **Job write boundary** (t-1783199066683): `track/fit/sector/tailoring/status` enum-guarded on write, Task posture (invalid silently ignored; clears legal; tolerant read unchanged; `SOURCE_SECTORS` now aliases the one `SECTORS` array), and **`Job.source` wired as discovery provenance** (t-1783199066654): writer `createJobFolder` (pursue resolves explicit `sourceId` else the workbook row's join; `POST /api/jobs` accepts a registry-resolvable `sourceId`), reader `toJob` (served verbatim, legacy free-strings tolerated, not PATCH-writable) — §6 gaps 1 and 2 closed. Related non-schema change, same window: per-(routine, jobId) run lock on the routine runner (t-1783198713071, 409 on a duplicate live/queued run) |
| 3 | 2026-07-04 | Instruction-proposal loop SHIPPED (server half, t-1783198113775, §5 decision 4): `Source.instructionProposals[]` (append-only `InstructionProposal` sub-entity, full field table in §2.2), provenance fields `instructionsApprovedFrom`/`instructionsUpdatedAt` (SERVER-MANAGED), derived `proposeRunId`, and the `contractGaps` row added to §2.2's derived table (built earlier in W2b, was documented only in §5). Writers: `POST .../instruction-proposals[/propose]` + `PATCH .../instruction-proposals/:proposalId`; readers: `GET /api/discovery/sources` (drawer UX lands next wave). Four as-built amendments recorded under §5 decision 4 (optional `ownerComment`, no scrape-bookkeeping on propose runs, manual-edit provenance clearing, `source-proposals-changed` SSE event). §2.2 authoring-surface + invariants updated accordingly |
| 2 | 2026-07-04 | ADR-018 stage-0 R1 disclosure (gate condition S0-6): new §7.3.1 discloses Remote Control availability (sessions steerable via claude.ai/code + mobile under the owner's account; availability change, not a data-flow change; no new listening socket, asserted by `ops/scripts/assert-rc-no-listener.ps1`) and names Apple (APNs) / Google (FCM) push relays as transit parties for notification text per the S0-5 accounting (no verbosity setting exists beyond two on/off toggles). Final push-text sentences pending the S0-5 empirical lock-screen check at opt-in; the R2 overlay-reachability paragraph ships with the R2 cut, completing the S0-6 disclosure. If the R1 cut lands as a version other than 0.19.0, release-manager updates the two version references. |
| 1 | 2026-07-04 | Initial publish. All entities in §2 documented against app v0.18.0. Wave-2 decisions (§5) pinned for the Discovery Sources v2 build (not yet implemented as of this publish), reconciled against the parallel W2a design spec (`docs/proposals/2026-07-04-sources-v2-design-spec.md`) so both documents agree on field names and shapes before build starts: `nextRunAt` (not `nextDueAt`) confirmed, all four cadence values (incl. `monthly`) documented, `contractGaps` pinned server-derived on `DerivedSource`, and `tracks[]` pinned as a closed 7-key enum with tag-membership (not exclusive) grouping semantics. Same-day, folded in per the W1b audit (`docs/audits/2026-07-04-data-schema-audit.md`) and owner ruling: (1) `DATA_CONTRACT.md` absorbed into §7 so the guarantee statement lives in the hub-visible canonical doc, root file shrunk to a pointer; (2) `Task.completed`'s invariant corrected to its precise, non-universal form (present ⟹ done always; the converse only holds for transitions on/after ADR-013's 2026-07-03 ship date — 82/126 done tasks predate the stamp); (3) `Job.link` documented as part of the frontmatter contract with the real 61/94-missing gap noted (backfill ticketed separately, t-1783198713055). |
