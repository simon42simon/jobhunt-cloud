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

## Measured-baseline gaps (for the implementation Rodeo)

- Draft-stage **per-section regenerated-identically evidence** is not yet measured: the two
  baseline runs predate section instrumentation. Next batch must diff artifacts across jobs of
  the SAME track to measure the identical-block share (the number that proves the track-pack
  saving; target ≥30% cheaper at owner-confirmed equal quality — SIM-420 acceptance).
- Draft/final **token counts** are not captured on the runner path (the local path's
  stream-json `stats` event has no runner twin yet) — cross-stage rule 3 closes this.
- The measured A/B (codified vs full run) stays gated on the owner's 2026-07-21 decision:
  real-data cloud production runs only, no local/demo stopgap.
