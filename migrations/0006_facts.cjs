/* eslint-disable */
// SIM-544 (JP-1) architecture correction, 2026-07-23 - facts move to Postgres.
//
// ops/facts/*.yaml (resume, professional-experience, cover-letter) previously
// stayed laptop-local under the file-bridge's general "nothing leaves the
// machine" data-sovereignty framing (docs/data-schema.md). Owner correction
// (2026-07-23): that framing does not fit this data - facts are the owner's
// OWN professional content, the substance of a resume/LinkedIn profile,
// already semi-public by nature, with none of the third-party-data concerns
// that framing exists for elsewhere. jobhunt-cloud's own passphrase-protected
// Postgres is the correct home, not a local file. This table is that home.
// Migrating EXISTING ops/facts/*.yaml content into it is a separate one-time
// import (needs laptop vault access this migration does not have) - out of
// scope here, which only creates the destination.
//
// One row per kind (singleton per kind, not per-job) - `doc` is the parsed
// YAML->JSON structure verbatim, so a round-trip through this table is lossless
// against the original file shape. `kind` is a closed 3-value set: this is the
// SAME "facts trio" docs/agent-pipeline.md's draft-stage inputs table names.
//
// VANILLA PG ONLY (the 0001 pin). ORDERING RULE (0003's fixed pattern, see
// 0004/0005): pgm.db.query for immediate, in-order execution - never pgm.sql.
// Re-runnable: CREATE TABLE IF NOT EXISTS.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
  CREATE TABLE IF NOT EXISTS facts (
    kind        text PRIMARY KEY CHECK (kind IN ('resume','professional_experience','cover_letter')),
    doc         jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS facts;`);
};
