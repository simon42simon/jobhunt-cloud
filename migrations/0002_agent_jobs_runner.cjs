/* eslint-disable */
// RC-3 / SIM-87 I7 - hybrid runner columns on agent_jobs (design section 4).
//
// The agent_jobs QUEUE table landed in 0001_init; the /api/runner/* endpoints land
// here at I7 and need two more fields the queue lifecycle uses:
//   - progress jsonb: appended transcript lines for the live run panel (data only,
//     never a command). Default '[]'.
//   - last_heartbeat_at timestamptz: set on claim + each heartbeat, so the honest
//     laptop-off pending state (design 4.6) can tell "the runner is polling" from
//     "the laptop is offline and jobs are just sitting queued".
//
// Vanilla PG only (portability-by-construction). Idempotent guards via IF NOT
// EXISTS so a re-run is safe.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
  ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS last_heartbeat_at;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS progress;
  `);
};
