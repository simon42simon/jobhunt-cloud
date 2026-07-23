/* eslint-disable */
// SIM-544 (JP-1) - the track-pack cache's durable cloud home. Content-addressed
// by `<track>:<factsHash>` (server/track-pack-lib.js buildTrackPackCacheKey,
// server/facts-lib.js computeFactsHash) - once facts move to Postgres
// (migrations/0006_facts.cjs, same architecture correction), the server
// computes factsHash itself from its own stored facts, so this table's key is
// always self-consistent with the CURRENT facts, never a caller's claim.
//
// One row per cache key; a facts edit produces a new factsHash -> a new key ->
// the OLD key's row simply goes unreferenced (implicit invalidation, no
// explicit delete needed - docs/agent-pipeline.md's cross-stage rule 1).
//
// VANILLA PG ONLY (the 0001 pin). ORDERING RULE (0003's fixed pattern, see
// 0004/0005/0006): pgm.db.query for immediate, in-order execution - never
// pgm.sql. Re-runnable: CREATE TABLE IF NOT EXISTS.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
  CREATE TABLE IF NOT EXISTS track_packs (
    cache_key     text PRIMARY KEY,
    track         text NOT NULL,
    facts_hash    text NOT NULL,
    style_digest  text NOT NULL DEFAULT '',
    blocks        jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS track_packs_track_idx ON track_packs (track);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS track_packs;`);
};
