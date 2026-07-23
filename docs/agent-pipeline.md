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
| **Inputs** | the posting (job-description) + the chosen track + the facts trio (`ops/facts/resume.yaml`, `professional-experience.yaml`, `cover-letter.yaml`) — facts stay laptop-local by design |
| **Outputs** | 4 artifacts: CV `.docx`, cover letter `.docx`, `gaps.md`, `job-description.md`; `queued → drafted` |
| **Dispatch** | runner path (proven live on prod 2026-07-22: enqueue → `agent-runner.mjs` → artifacts → `job_files`) |
| **Baseline** | 2 runs · ~23 min and ~13 min wall (token stats not yet captured per-section — see gaps) |

**The module split (facts-stable vs posting-tailored):**

*Facts-stable blocks — generate ONCE per `(track, facts-version)` as a cached "track pack",
reuse across every job on that track:* CV skeleton (title line, summary base, technical
expertise, languages, education, training, involvement — all per-track fields in
`resume.yaml`); the per-track achievement pool (`professional-experience.yaml` buckets +
`hero_stats` + the Maple Armor `status_note`); cover-letter openings, the three paragraph
blocks, closing, hero phrases (`cover-letter.yaml`). Cache key = hash of the facts files +
track id; a facts edit (profile-refresh) invalidates exactly the affected packs.

*Posting-tailored blocks — the ONLY per-job NLP spend:* keyword/ATS alignment against the
posting; summary tailoring sentences; achievement **selection and ordering** from the pool
(not re-writing); the cover letter's posting-specific middle; addressee/meta.

### 2 · Gap (gaps.md)

Runs with the draft (no extra dispatch). **Inputs:** posting requirements diffed against the
facts. **Outputs:** the questions only Simon can answer. **Stable:** the gap taxonomy/format.
**Codified rule — a gap answered once becomes a fact:** every answer propagates into
`ops/facts/*.yaml` via profile-refresh so the same gap is never asked twice; recurring gaps
across jobs of one track are a facts-coverage bug, not a per-job question.

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
`jobhunt-cloud` — with two honest, flagged gaps where the work crosses this lane's fence
(`server/`, `src/`, `tests/`, `docs/agent-pipeline.md` only — never `ops/`, migrations, or
another repo). Routed to the integrator/a follow-up lane rather than worked around.

**SIM-544 — track-pack cache (`server/track-pack-lib.js`, `server/store.js`,
`server/pg-store.js`, `GET`/`PUT /api/track-packs/:cacheKey`):**

- Cache key is exactly `<track>:<factsHash>` (`buildTrackPackCacheKey`) — the CALLER (the
  application-writer skill, which alone can see `ops/facts/*.yaml`) computes `factsHash` off
  the facts files' bytes and PUTs the resulting stable blocks; this cloud store never sees
  facts content, only the caller-computed hash. A facts edit produces a new hash → a new key →
  the OLD key's pack simply goes unreachable — invalidation is implicit in the hash, never an
  explicit delete, exactly the "cache key = hash of facts + track id" rule above.
- **`styleDigest` (the ticket title's "style-digest threading") has no prior art anywhere in
  this repo or company-os** — the ticket body and this doc never define it beyond the title.
  Implemented as an opaque, caller-computed string threaded alongside the content hash,
  inferred to mean a fingerprint of the VOICE/tone choices baked into a pack's blocks (not the
  facts themselves) — **this is inference, not confirmed spec; flag it with the ticket author
  before a real caller depends on the distinction** (`server/track-pack-lib.js` header has the
  full reasoning).
- **FileStore is fully live** (`track-packs.json`, content-addressed). **PgStore deliberately
  does NOT implement it yet** — a durable cloud cache needs a new `track_packs` table, and
  `migrations/` is not in this lane's writable allowlist. `server/pg-store.js` carries the
  exact `CREATE TABLE` this needs, ready for the integrator/a migration-authorized lane. Until
  it lands, `GET`/`PUT /api/track-packs/*` answer an honest `501 TRACK_PACK_STORE_UNAVAILABLE`
  on the cloud (capability-probed via `typeof store.getTrackPack === "function"`, the exact
  SIM-547 `STORE_FINDS` pattern) rather than a silent no-op.
- **Wiring the `first-draft-job` skill (company-os) to actually CALL this cache is separate,
  cross-repo work** — tracked as its own ticket (SIM-597, JP-5: re-home jobhunt product skills)
  precisely because a jobhunt-cloud lane cannot carry a company-os + vault change. This lane
  built the machinery the skill will call into; it did not touch the skill itself.

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
