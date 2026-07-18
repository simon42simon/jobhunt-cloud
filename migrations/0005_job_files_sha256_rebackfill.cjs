/* eslint-disable */
// SIM-393 I3 unblock - re-run the job_files.sha256 backfill.
//
// Found at the attended transition-import dry-run (2026-07-18): every one of the
// private instance's 645 job_files rows carries sha256 NULL, so the sync client
// reported the whole overlap as false "bytes-differ" conflicts (the guardian W5
// safe direction - wrong SKIP, never wrong overwrite). Cause: migration 0003 was
// recorded APPLIED at a moment when its backfill had nothing (or not everything)
// to fill relative to the real-data import, and an applied migration never
// re-runs. This migration is the same WHERE-sha256-IS-NULL backfill as 0003,
// under a new id so the runner executes it once more. Re-runnable by
// construction (a re-run only fills what is still missing); rows written by the
// current code (every write path populates sha256) are untouched.
//
// Same constraints as 0003: vanilla PG only (no pgcrypto - the 0001 pin), JS
// hashing via pgm.db.query so both statements execute immediately and in order.

const crypto = require("node:crypto");

exports.shorthands = undefined;

exports.up = async (pgm) => {
  const { rows } = await pgm.db.query("SELECT id, bytes FROM job_files WHERE sha256 IS NULL");
  for (const r of rows) {
    const buf = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
    const hex = crypto.createHash("sha256").update(buf).digest("hex");
    await pgm.db.query("UPDATE job_files SET sha256 = $1 WHERE id = $2", [hex, r.id]);
  }
};

exports.down = () => {
  // Nothing to undo: the column belongs to 0003; this migration only fills
  // missing values, and removing computed hashes would only recreate the bug.
};
