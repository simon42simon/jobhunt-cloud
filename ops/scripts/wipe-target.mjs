// One-off: wipe the target Postgres before a `migrate-data.mjs` full-replace cutover.
// psql-free equivalent of the TRUNCATE hint that migrate-data prints. Connects the
// SAME way migrate-data does (plain connectionString from DATABASE_URL, no extra ssl
// handling — any sslmode rides on the url), so if the import can reach the DB, so can this.
//
// Usage (from the repo root, with DATABASE_URL set in the same shell):
//   PowerShell:  $env:DATABASE_URL = "<railway-public-url>"; node ops/scripts/wipe-target.mjs
//
// It is DESTRUCTIVE: it empties every table migrate-data owns so the importer's
// non-empty-target preflight passes. Only run it when you intend a full replace.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('wipe-target: DATABASE_URL is not set. In PowerShell: $env:DATABASE_URL = "<url>"');
  process.exit(1);
}

// The exact table set migrate-data.mjs owns (its MIGRATED_TABLES + board_config).
const TABLES = [
  "jobs", "job_files", "tasks", "task_attachments", "requests",
  "activity_log", "telemetry_events", "notify_state", "job_chats",
  "discovery_sources", "discovery_meta", "discovery_finds", "agent_jobs",
];
const sql =
  `truncate ${TABLES.join(", ")}, board_config restart identity cascade; ` +
  `insert into board_config (id) values (1);`;

// Show the target host/port (NO credentials) so a connection failure is diagnosable.
try {
  const u = new URL(url);
  console.log(`wipe-target: target host=${u.hostname} port=${u.port || "5432"} db=${u.pathname.slice(1) || "(default)"} sslmode=${u.searchParams.get("sslmode") || "(none)"}`);
} catch {
  console.error("wipe-target: DATABASE_URL is not a valid URL.");
  process.exit(1);
}

function dumpErr(err, indent = "  ") {
  if (!err) { console.error(indent + "(empty error object)"); return; }
  console.error(indent + "message: " + (err.message || "(none)"));
  if (err.code) console.error(indent + "code: " + err.code);
  if (err.address) console.error(indent + "address: " + err.address + (err.port ? ":" + err.port : ""));
  if (Array.isArray(err.errors)) {
    console.error(indent + "underlying errors (AggregateError):");
    err.errors.forEach((se) => dumpErr(se, indent + "  "));
  }
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
client.on("error", (e) => { console.error("wipe-target: client 'error' event —"); dumpErr(e); });
try {
  await client.connect();
  await client.query(sql);
  console.log(`wipe-target: OK — truncated ${TABLES.length} tables + board_config. Now run migrate-data.mjs.`);
} catch (e) {
  console.error("wipe-target: FAILED —");
  dumpErr(e);
  process.exitCode = 1;
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
