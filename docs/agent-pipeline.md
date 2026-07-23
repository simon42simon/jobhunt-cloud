# The agent-action pipeline, stage by stage (SIM-420)

Codification of record for the jobhunt agent pipeline — **discovery → draft → gap → final** —
on the 2026-07-22 instrumentation baseline (SIM-531 ops batch; raw data
`ssc-brain/data/jobhunt/sim-531-ops-batch/instrumentation-2026-07-22.json`). The operating
principle, per the owner directive (2026-07-21): **stable stages generate once and are reused;
NLP spend concentrates only where tailoring actually happens.** Implementation of the reuse
mechanics is a later Rodeo; this doc fixes the per-stage contract they build against.

## Stage contracts

### 0 · Discovery (source-scoped scrape → qualify → file)

| | |
|---|---|
| **Owner / tier** | job-search-scout · sonnet / medium |
| **Inputs** | ONE source-registry record (urls, fetchMode, fetchNote, crawl `instructions`), the already-tracked link index, the scrape contract (direct-link rule + `DEADLINE_CONTRACT_RULE` — stated-date-or-rolling, `server/runner-lib.js`) |
| **Outputs** | finds `{title, employer, link, deadline, track, fit, sector, status}` filed as jobs with `source` provenance; honesty counters `{candidatesReviewed, alreadyTracked, filteredOut}`; run record (`outcome, durationMs, leadsFound, leadsNew`) |
| **Dispatch** | local spawn where an agent binary exists; runner-routed (`discover-jobs-source` kind) on pg instances — SIM-535 |
| **Baseline** | 22 sources · 928 reviewed → 73 filed · ~2.32M tokens (~105k/source) · ~35 min wall (parallel) |

**What is stable (reuse, no NLP):** the crawl instructions — 20/22 sources ran them verbatim;
corrections flow through the instruction-proposal loop, never ad-hoc. The fetch itself is
deterministic wherever the board allows it: Taleo RSS read the whole board in ONE fetch
(best-in-class); the `apify` type is the fully deterministic precedent (no model in the loop).

**Where NLP belongs:** qualify/triage only (fit, track mapping, dedup judgment) — not fetching.

**Codified routing rules (from baseline obs #3):** prefer structured endpoints (RSS / JSON
APIs) over page scraping; `google-site` fallback costs 2–3× the time for a fraction of the
yield (linkedin 16 min → 2; gc-jobs 22 min → 0) — audit those sources for structured
alternatives before re-running; bot-walled portals (`ops`, `gc-jobs`, Oracle-Cloud
`metrolinx`) route to the browser-driven scout, never the fetch scout.

### 1 · Draft (first-draft-job)

| | |
|---|---|
| **Owner / tier** | application-writer (batch carve-out tier when batched) |
| **Inputs** | the posting (job-description) + the chosen track + the facts trio (`resume`, `professional_experience`, `cover_letter` — `GET /api/facts/:kind`, `jobhunt-cloud`'s own Postgres as of 2026-07-23; see the architecture-correction note below) |
| **Outputs** | 4 artifacts: CV `.docx`, cover letter `.docx`, `gaps.md`, `job-description.md`; `queued → drafted` |
| **Dispatch** | runner path (proven live on prod 2026-07-22: enqueue → `agent-runner.mjs` → artifacts → `job_files`) |
| **Baseline** | 2 runs · ~23 min and ~13 min wall (token stats not yet captured per-section — see gaps) |

**Architecture correction (2026-07-23, owner decision):** facts previously stayed laptop-local
(`ops/facts/*.yaml`) under the file-bridge's general "nothing leaves the machine"
data-sovereignty framing (`docs/data-schema.md`). That framing does not fit this data — it is
the owner's own semi-public professional content (the substance of a resume/LinkedIn profile),
not third-party data under someone else's policy — so it now lives in `jobhunt-cloud`'s own
passphrase-protected Postgres (`server/facts-lib.js`, `migrations/0006_facts.cjs`), the same
home every other piece of job state already has. The generation SKILL (`company-os`) still
reads `ops/facts/*.yaml` off local disk today — rewiring it to call the API instead is
cross-repo work, out of this repo's fence; see SIM-597 and its handoff brief.

**The module split (facts-stable vs posting-tailored):**

*Facts-stable blocks — generate ONCE per `(track, facts-version)` as a cached "track pack",
reuse across every job on that track:* CV skeleton (title line, summary base, technical
expertise, languages, education, training, involvement — all per-track fields in the `resume`
facts kind); the per-track achievement pool (the `professional_experience` facts kind's buckets
+ `hero_stats` + the Maple Armor `status_note`); cover-letter openings, the three paragraph
blocks, closing, hero phrases (the `cover_letter` facts kind). Cache key = hash of the facts +
track id, computed by `jobhunt-cloud` itself (`server/facts-lib.js` `computeFactsHash`) from
whatever it currently has stored — a facts edit (`PUT /api/facts/:kind`) changes the hash on
the very next request, so the affected track's pack goes unreachable with no explicit
invalidation step.

*Posting-tailored blocks — the ONLY per-job NLP spend:* keyword/ATS alignment against the
posting; summary tailoring sentences; achievement **selection and ordering** from the pool
(not re-writing); the cover letter's posting-specific middle; addressee/meta.

### 2 · Gap (gaps.md)

Runs with the draft (no extra dispatch). **Inputs:** posting requirements diffed against the
facts. **Outputs:** the questions only Simon can answer. **Stable:** the gap taxonomy/format.
**Codified rule — a gap answered once becomes a fact:** every answer propagates into the facts
store (`PUT /api/facts/:kind`, formerly `ops/facts/*.yaml` via profile-refresh — see the
architecture-correction note above) so the same gap is never asked twice; recurring gaps across
jobs of one track are a facts-coverage bug, not a per-job question.

### 3 · Final (finalize-job)

**Inputs:** the draft artifacts + Simon's gap answers/feedback. **Outputs:** final CV + cover
(ATS-optimized render). **Codified rule:** finalize integrates answers and runs the ATS pass —
it never regenerates facts-stable blocks (they were correct at draft time or the facts are
wrong; fix the facts). Finalize/submit stays Simon-gated (charter).

## Cross-stage rules

1. **Generate-once-and-reuse keys on content hashes** of a stage's inputs (facts files, crawl
   instructions), never on wall-clock — reuse is invalidated by an input change, not by time.
2. **NLP spend map:** discovery-qualify · draft tailor-delta · final integrate. Everything
   else (fetching, rendering, bookkeeping, status flips) is deterministic code.
3. **Every run reports its own economics** — the SIM-535 result lane (counters today) is the
   hook: extend the result payload with `{tokens, wallMs}` per run so the per-stage baseline
   updates itself instead of needing another instrumented batch.
4. **Every run emits one observation** about what to codify next (owner directive) — the
   discovery baseline's source-registry corrections are the model.

## Implementation status (jp-pipeline lane, SIM-544 → SIM-574 → SIM-596, 2026-07-23)

The reuse machinery, self-reporting, and nightly scheduler are now real code in
`jobhunt-cloud`. One honest, flagged gap remains where the work crosses this repo's boundary
into `company-os` (the generation skill) — routed to SIM-597 and its handoff brief rather than
worked around.

**SIM-544 — facts store + track-pack cache (`server/facts-lib.js`, `server/track-pack-lib.js`,
`server/store.js`, `server/pg-store.js`, `migrations/0006_facts.cjs`,
`migrations/0007_track_packs.cjs`, `GET`/`PUT /api/facts/:kind`, `GET`/`PUT
/api/track-packs/:track`):**

- **Facts moved into `jobhunt-cloud`'s own Postgres** (the architecture-correction note under
  stage 1, above) — a straightforward owner-data CRUD surface, no different in kind from
  `/api/jobs` or `/api/tasks`. Both FileStore (`facts.json`, local/dev parity) and PgStore (the
  `facts` table) implement it fully.
- Track-pack cache key is exactly `<track>:<factsHash>` (`buildTrackPackCacheKey`) —
  **`factsHash` is computed by `jobhunt-cloud` itself** (`server/facts-lib.js`
  `computeFactsHash`, over whatever it currently has stored), never trusted from a caller. This
  is strictly better than the cache's first draft (which briefly trusted a caller-supplied hash,
  back when facts still lived outside this server's reach) — the key can never drift from the
  facts it actually describes. A facts edit produces a new hash on the very next request → a
  new key → the OLD key's pack simply goes unreachable — invalidation is implicit, never an
  explicit delete, exactly the "cache key = hash of facts + track id" rule above.
- **`styleDigest` (the ticket title's "style-digest threading") has no prior art anywhere in
  this repo or company-os** — the ticket body and this doc never define it beyond the title.
  Implemented as an opaque, caller-computed string threaded alongside the content hash,
  inferred to mean a fingerprint of the VOICE/tone choices baked into a pack's blocks (not the
  facts themselves) — **this is inference, not confirmed spec; flag it with the ticket author
  before a real caller depends on the distinction** (`server/track-pack-lib.js` header has the
  full reasoning).
- **Both FileStore and PgStore fully implement the track-pack cache** (`track-packs.json` /
  the `track_packs` table) — verified end to end against a real (embedded) Postgres, migrations
  included. The capability probe (`STORE_TRACK_PACKS`/`STORE_FACTS`, the SIM-547 `STORE_FINDS`
  pattern) stays as defense-in-depth for a future backend that might omit either, not because
  either gap is open today.
- **What is still NOT done, and cannot be done from this repo:** the `first-draft-job` /
  `finalize-job` / `profile-refresh` skills (`company-os`) still read `ops/facts/*.yaml` off
  local disk and never call `GET`/`PUT /api/track-packs/*` or `GET`/`PUT /api/facts/*` at all —
  so today, this machinery produces zero actual reuse or cost savings. That rewiring is SIM-597,
  explicitly escalated (owner decision, 2026-07-23) rather than left to grooms-on-pull, with a
  standalone execution-ready brief for whoever picks it up.

**SIM-574 — run-economics self-reporting (`server/lib.js` `agentEventToUpdate`,
`server/runner-lib.js` `validateRunEconomics`, the `POST /api/runner/jobs/:id/result` route):**

- `tokens`/`wallMs` are DERIVED server-side from the run's own durable `agent_jobs.progress` —
  the SAME terminal stream-json `result` event the runner already relays verbatim
  (`ops/agent-runner.mjs`'s existing relay, untouched) — never trusted from the request body.
  Honest capture: an absent `usage` block yields `tokens: null`, never a fabricated number.
- `reuseHitRate`/`cacheKeyProvenance` come from the track-pack routes above: a GET/PUT tagged
  with `?agentJobId=` accumulates a per-run hit/miss signal, folded into the result the moment
  it completes. Real numbers the instant the SIM-597 skill wiring starts calling the cache —
  `undefined` (never a fake `0`) until then, since there is nothing to report yet.
- Lands in the EXISTING SIM-535 result lane (`agent_jobs.result` jsonb) — no migration, no
  parallel reporting path, per the lane directive.

**SIM-596 — nightly auto-draft scheduler (`server/lib.js` `todayET`/
`msUntilNextAutoDraftFire`/`selectAutoDraftCandidates`, `server/index.js`
`runAutoDraftScheduler`, `POST /api/auto-draft/fire`):**

- Selection is 100% deterministic: `status="queued"` AND `hasCV=false` AND a literal
  `YYYY-MM-DD` deadline within `[today, today+3]` ET AND `sector != "private"` (v1 scope:
  deadline-driven public jobs only). Dedupe against an already-pending `first-draft-job`
  happens BEFORE the nightly cap (10), never after — an already-queued job must never occupy a
  cap slot a fresh job could use. Overflow past the cap is a logged count, never a silent drop.
- ET timezone math (`todayET`, `msUntilNextAutoDraftFire`) is built on `Intl.DateTimeFormat`,
  **deliberately NOT the `Temporal` API** — available on a developer's local Node, but the
  Dockerfile pins `node:20-bookworm-slim` for the actual deployment, where `Temporal` does not
  exist; using it would pass every local test and throw in production. Self-rearming
  (`setTimeout` chain, each firing recomputing the next 2am ET fresh) rather than a fixed
  `setInterval`, so a DST transition self-corrects the next night instead of drifting.
- **SHIP DARK**: the nightly timer only arms behind `AUTO_DRAFT_ENABLED=1` — it must not fire
  on a real schedule until SIM-598 (the fail-closed generation-quality gate) lands, so an
  unattended run can never scale an unenforced 2-page cap. The secret-gated manual-fire
  endpoint (`X-Auto-Draft-Fire-Secret`, constant-time compare, mirrors the demo-reset endpoint
  exactly) works regardless, for staging proof.
- Enqueues at the batch tier (`ROUTINES["first-draft-job"].batchModel`/`batchEffort` —
  sonnet/medium) via `agent_jobs.payload.{tier,model,effort}` — **but this is INTENT ONLY on
  the runner-queue path today.** `ops/agent-runner.mjs` (out of this lane's fence) does not yet
  read a tier field off the payload and append `--model`/`--effort` the way the LOCAL-spawn
  path's `startRun` does; only `--agent` is applied runner-side. Threading the field now costs
  nothing and makes the follow-up (teaching `ops/agent-runner.mjs` to honor it) additive, not a
  payload-shape change — until that lands, an auto-drafted job runs at whatever tier the
  runner's own defaults give `first-draft-job`.
- Never touches finalize/submit — the only kind this ever enqueues is `first-draft-job`.

## Measured-baseline gaps (for the implementation Rodeo)

- Draft-stage **per-section regenerated-identically evidence** is not yet measured: the two
  baseline runs predate section instrumentation. Next batch must diff artifacts across jobs of
  the SAME track to measure the identical-block share (the number that proves the track-pack
  saving; target ≥30% cheaper at owner-confirmed equal quality — SIM-420 acceptance). Blocked
  on SIM-597 (the skill actually calling the SIM-544 cache) — the machinery alone produces no
  reuse data to measure.
- ~~Draft/final **token counts** are not captured on the runner path~~ **CLOSED by SIM-574** —
  see "Implementation status" above.
- The measured A/B (codified vs full run, SIM-575/JP-3) stays gated on the owner's 2026-07-21
  decision: real-data cloud production runs only, no local/demo stopgap. Also now gated on
  SIM-596 producing enough auto-drafted volume to compare against, and on SIM-598 (quality
  gate) landing first so neither arm of the A/B is measuring an unenforced 2-page violation.
