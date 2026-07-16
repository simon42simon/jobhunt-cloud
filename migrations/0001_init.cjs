/* eslint-disable */
// RC-3 / SIM-87 I3 - initial Postgres schema for PgStore (ADR-025).
//
// VANILLA PG ONLY (PoR risk 4, portability-by-construction): text, text[], jsonb,
// bytea, timestamptz, bigserial, integer, boolean. NO extensions - not even
// pgcrypto/uuid: every id is application-generated (the job slug, the task id, a
// sha256 attachment name), so the schema restores unchanged on any Postgres 12+
// (Railway/Azure/AWS/DO). Proven up->down->up against a real cluster (embedded
// PostgreSQL 17.10) by tests/helpers/embedded-pg.mjs.
//
// SHAPE NOTE (documented deviation D3 from design section 3.1): the JOBS domain
// keeps the design's TYPED frontmatter columns (the relational frontmatter story
// is the portfolio centerpiece and readiness is derived from these rows + the
// job_files blobs). The DATA_DIR document stores that FileStore treats as OPAQUE
// serialized docs (tasks, requests, discovery_sources, notify_state, job_chats)
// are stored as a single `doc jsonb` per row, MIRRORING FileStore's
// serialize->store->parse round-trip exactly. That guarantees the byte-equivalent
// domain round-trip the contract suite + FileStore/PgStore differential require,
// with no risk of a missed column silently dropping a field (the exact failure the
// discovery-sources `_extra` carrier was built to prevent). Sub-arrays that live
// INLINE in the file world (task comments, source runs, instruction proposals)
// stay inline in the parent `doc` - identical to today. The append streams
// (activity, telemetry) and true blobs (job_files, task_attachments) DO get real
// relational/bytea rows. agent_jobs is created now; its /api/runner/* endpoints
// land at I7 (design section 4).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
  -- ============================ JOBS (JOBS_DIR) ============================
  -- One row per job folder. Typed frontmatter columns for the modeled keys +
  -- raw_frontmatter jsonb for FULL fidelity (legacy/unmodeled keys included, so a
  -- laptop->cloud migration and any re-export round-trips faithfully). Deadlines
  -- and applied stay TEXT (never coerced to date - the JSON_SCHEMA no-Date-coercion
  -- invariant; "1-yr contract" must survive verbatim).
  CREATE TABLE jobs (
    id                 text PRIMARY KEY,
    role               text NOT NULL,
    employer           text NOT NULL,
    type               text,
    status             text,
    fit                text,
    track              text,
    sector             text,
    tailoring          text,
    deadline           text,
    applied            text,
    next_action        text,
    next_action_date   text,
    link               text,
    source             text,
    tags               text[] NOT NULL DEFAULT '{}',
    body               text NOT NULL DEFAULT '',
    raw_frontmatter    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
  );

  -- Companion notes + generated artifacts (CV/cover/gaps/job-description/
  -- application-content). ON DELETE RESTRICT - never cascade-delete (contract:
  -- the app never deletes a job's data). Content-addressed by (job_id, name).
  CREATE TABLE job_files (
    id          bigserial PRIMARY KEY,
    job_id      text NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
    name        text NOT NULL,
    mime        text,
    kind        text,
    bytes       bytea NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, name)
  );

  -- ============================ TASK BOARD (DATA_DIR) =====================
  -- doc jsonb = the whole task object (title/status/detail/epic/priority/...,
  -- labels[], checklist, comments[] INLINE - exactly as tasks.yaml stores it), so
  -- the save->load round-trip is identical to FileStore's YAML round-trip.
  -- "seq" preserves board ORDER across a DELETE-all + re-INSERT save (the file
  -- world keeps YAML array order; ORDER BY seq reproduces it).
  CREATE TABLE tasks (
    id          text PRIMARY KEY,
    seq         bigserial NOT NULL,
    doc         jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );

  -- The board columns (a single-row config; tasks.yaml keeps this at top level).
  CREATE TABLE board_config (
    id       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    columns  text[] NOT NULL DEFAULT ARRAY['backlog','todo','in_progress','done']
  );
  INSERT INTO board_config (id) VALUES (1);

  -- Content-addressed task attachment blobs (dedup PK = sha256 filename).
  CREATE TABLE task_attachments (
    task_id     text NOT NULL,
    file        text NOT NULL,
    name        text,
    mime        text,
    bytes_len   integer,
    blob        bytea NOT NULL,
    ts          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, file)
  );

  -- ============================ INTAKE LEDGER (DATA_DIR) ==================
  -- doc jsonb = the verbatim request (text preserved byte-for-byte, spawned refs
  -- inline). ts kept as a queryable column for future ordering.
  CREATE TABLE requests (
    id    text PRIMARY KEY,
    seq   bigserial NOT NULL,
    doc   jsonb NOT NULL,
    ts    text
  );

  -- ============================ APPEND STREAMS (DATA_DIR) =================
  -- Activity log + usage telemetry: append-only, one jsonb record per row, ordered
  -- by the serial id (insertion order == on-disk JSONL order). readActivityText /
  -- readTelemetryText reassemble the JSONL text these consumers parse.
  CREATE TABLE activity_log (
    id    bigserial PRIMARY KEY,
    ts    timestamptz NOT NULL DEFAULT now(),
    line  jsonb NOT NULL
  );
  CREATE INDEX activity_log_id_idx ON activity_log (id);

  CREATE TABLE telemetry_events (
    id    bigserial PRIMARY KEY,
    ts    timestamptz NOT NULL DEFAULT now(),
    event jsonb NOT NULL
  );

  -- ============================ NOTIFY STATE (DATA_DIR) ===================
  -- Single row (id=1). NOT seeded: an ABSENT row is the "uninitialized" state
  -- (loadNotifyState returns initialized:false), exactly like a missing
  -- notify-state.json. saveNotifyState upserts the row.
  CREATE TABLE notify_state (
    id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    doc         jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );

  -- ============================ PER-JOB CHATS (DATA_DIR) ==================
  CREATE TABLE job_chats (
    job_id      text PRIMARY KEY,
    transcript  jsonb NOT NULL
  );

  -- ============================ DISCOVERY (DOCS_DIR + xlsx) ===============
  -- doc jsonb = serializeSource(normalizeSource(s)) output (modeled fields +
  -- runs[] + instructionProposals[] inline + the _extra version-skew cargo), so
  -- loadSources/saveSources round-trips through the SAME injected
  -- normalizeSource/serializeSource pair FileStore uses. sector/active/type
  -- mirrored into columns for future SQL filtering (deriveSources runs in JS today).
  CREATE TABLE discovery_sources (
    id       text PRIMARY KEY,
    seq      bigserial NOT NULL,
    sector   text,
    active   text,
    type     text,
    doc      jsonb NOT NULL
  );

  -- Registry-level header (the version + updated stamp discovery-sources.yaml
  -- carries at the top). Single row; NOT seeded, so an empty registry reports
  -- updated:null exactly like an absent file.
  CREATE TABLE discovery_meta (
    id       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version  integer NOT NULL DEFAULT 1,
    updated  text
  );

  -- Discovery FINDS - replaces the xlsx in cloud (design 3.1). The FileStore path
  -- still shells discovery.py; PgStore reads/writes this table. "tracked" stays a
  -- DERIVED join against jobs, never stored.
  CREATE TABLE discovery_finds (
    id           bigserial PRIMARY KEY,
    date_found   text,
    title        text,
    employer     text,
    sector       text,
    track        text,
    fit          text,
    tailoring    text,
    deadline     text,
    location     text,
    source       text,
    link         text,
    decision     text,
    notes        text,
    source_id    text
  );

  -- ============================ HYBRID RUNNER QUEUE (I7) ==================
  -- Created now (parcel scope); the /api/runner/* endpoints land at I7 (design
  -- section 4). The cloud holds an OUTBOUND queue the laptop polls; every field
  -- here is DATA, never a command (T9/G8). nonce is single-use (replay guard);
  -- FOR UPDATE SKIP LOCKED on claim makes double-claim structurally impossible.
  CREATE TABLE agent_jobs (
    id                text PRIMARY KEY,
    kind              text NOT NULL,
    job_id            text,
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            text NOT NULL DEFAULT 'queued',
    nonce             text,
    claimed_by        text,
    claimed_at        timestamptz,
    lease_expires_at  timestamptz,
    attempts          integer NOT NULL DEFAULT 0,
    result            jsonb,
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX agent_jobs_status_created_idx ON agent_jobs (status, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
  DROP TABLE IF EXISTS agent_jobs;
  DROP TABLE IF EXISTS discovery_finds;
  DROP TABLE IF EXISTS discovery_meta;
  DROP TABLE IF EXISTS discovery_sources;
  DROP TABLE IF EXISTS job_chats;
  DROP TABLE IF EXISTS notify_state;
  DROP TABLE IF EXISTS telemetry_events;
  DROP TABLE IF EXISTS activity_log;
  DROP TABLE IF EXISTS requests;
  DROP TABLE IF EXISTS task_attachments;
  DROP TABLE IF EXISTS board_config;
  DROP TABLE IF EXISTS tasks;
  DROP TABLE IF EXISTS job_files;
  DROP TABLE IF EXISTS jobs;
  `);
};
