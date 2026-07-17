/* eslint-disable */
// SIM-393 I1 - job_files.sha256 column for the vault<->cloud sync manifest.
//
// The GET /api/sync/manifest surface exposes a per-file sha256 so the laptop client
// can diff its vault inventory against the cloud WITHOUT the manifest re-hashing
// every blob per call (design B2). This migration:
//   1. ADDS a nullable `sha256 text` column (nullable so the ALTER is instant and
//      the backfill is a separate, resumable step), and
//   2. BACKFILLS it from the stored `bytes` bytea for every existing row.
//
// The backfill is computed in JS (crypto.createHash) via pgm.db.query, NOT with
// pgcrypto's digest() in SQL: migrations/0001_init.cjs pins "VANILLA PG ONLY - NO
// extensions - not even pgcrypto", so the schema restores unchanged on any Postgres
// 12+. Every write path (PgStore._upsertJobFile and the new addJobFileIfAbsent)
// populates sha256 going forward, so post-migration every row carries its hash.
//
// Safe direction (guardian W5): a wrong hash can only cause a wrong SKIP (a false
// no-op / false conflict) - never a wrong overwrite, because no overwrite path
// exists on the sync surface. Re-runnable: ADD COLUMN IF NOT EXISTS + a WHERE
// sha256 IS NULL backfill, so a re-run only fills what is still missing.

const crypto = require("node:crypto");

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // ORDERING FIX (found via the embedded-pg test leg, 2026-07-17): pgm.sql only
  // COLLECTS a statement - the runner executes collected statements AFTER this
  // async body resolves - while pgm.db.query executes IMMEDIATELY. With the
  // ALTER on pgm.sql, the backfill SELECT below ran first and every `migrate up`
  // died with `column "sha256" does not exist` (boot-blocking for start:prod on
  // any pg deployment). The ALTER therefore goes through pgm.db.query too, so
  // the two statements run in the order written. Still re-runnable (IF NOT
  // EXISTS + WHERE sha256 IS NULL).
  await pgm.db.query(`ALTER TABLE job_files ADD COLUMN IF NOT EXISTS sha256 text;`);
  // The escape-hatch pgm.db.query lets us backfill row-by-row from the stored
  // bytea. Datasets here are small (per-owner job artifacts), so a simple
  // loop is fine and keeps the migration dependency-free.
  const { rows } = await pgm.db.query("SELECT id, bytes FROM job_files WHERE sha256 IS NULL");
  for (const r of rows) {
    const buf = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
    const hex = crypto.createHash("sha256").update(buf).digest("hex");
    await pgm.db.query("UPDATE job_files SET sha256 = $1 WHERE id = $2", [hex, r.id]);
  }
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE job_files DROP COLUMN IF EXISTS sha256;`);
};
