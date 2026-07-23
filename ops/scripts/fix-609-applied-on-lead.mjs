// SIM-609: one-off cloud-row remediation for the two data-drift findings
// check_consistency.py surfaced during the SIM-597 acceptance pass -
//   C (26 rows): jobs with status "lead" carry an `applied` date. A lead
//     precedes even drafting, so nothing could truthfully have been
//     submitted yet - the fix belongs on the CLOUD rows (cloud is canonical;
//     a vault-only fix would be overwritten by the next sync).
//   D (1 row): a `drafted` job with no gaps note - the first-draft-job run
//     that produced it skipped the required step; finalize is silently
//     stalled for it.
//
// Could not run this from the coding session that wrote it: the Railway
// Postgres TCP proxy is closed by design (jobhunt-vault-cloud-migration
// memory, 2026-07-18), so DATABASE_URL/JOBHUNT_PRIVATE_DATABASE_URL (the
// Railway-internal hostname) is unreachable from outside Railway's network.
// Run this from wherever the internal URL - or an opened public proxy URL -
// IS reachable (mirrors ops/scripts/wipe-target.mjs / ops/migrate-data.mjs's
// own connection posture: plain connectionString off DATABASE_URL, sslmode
// rides on the URL).
//
// DRY-RUN BY DEFAULT - only lists what it found. Pass --apply to actually
// clear the 26 rows' `applied` column (through the SAME two-write shape
// store.updateJobFields uses: the typed column AND the raw_frontmatter jsonb
// key, so the two can never drift apart).
//
// Usage (from the repo root):
//   PowerShell: $env:DATABASE_URL = "<railway-url>"; node ops/scripts/fix-609-applied-on-lead.mjs
//   Apply:      $env:DATABASE_URL = "<railway-url>"; node ops/scripts/fix-609-applied-on-lead.mjs --apply
//
// Finding D (the missing gaps note) is REPORT-ONLY, always - the fix is a
// real first-draft-job redraft for that job (regenerating gaps.md is exactly
// what that routine does), not something this script should ever fabricate.
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('fix-609: DATABASE_URL is not set. In PowerShell: $env:DATABASE_URL = "<url>"');
  process.exit(1);
}

try {
  const u = new URL(url);
  console.log(`fix-609: target host=${u.hostname} port=${u.port || "5432"} db=${u.pathname.slice(1) || "(default)"} mode=${APPLY ? "APPLY" : "dry-run"}`);
} catch {
  console.error("fix-609: DATABASE_URL is not a valid URL.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });

try {
  await client.connect();

  // --- C: status='lead' AND applied is set -----------------------------
  const c = await client.query(
    "select id, applied, raw_frontmatter from jobs where status = 'lead' and applied is not null and applied <> '' order by id",
  );
  console.log(`\nfix-609: C - status='lead' with applied set -> ${c.rows.length} row(s)`);
  for (const r of c.rows) console.log(`  ${r.id}  applied=${r.applied}`);

  if (APPLY && c.rows.length) {
    await client.query("begin");
    try {
      for (const r of c.rows) {
        const rf = { ...(r.raw_frontmatter || {}) };
        delete rf.applied;
        await client.query("update jobs set applied = NULL, raw_frontmatter = $2::jsonb, updated_at = now() where id = $1", [r.id, JSON.stringify(rf)]);
      }
      await client.query("commit");
      console.log(`fix-609: C - cleared applied on ${c.rows.length} row(s).`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  } else if (c.rows.length) {
    console.log("fix-609: C - dry run only, nothing written. Re-run with --apply to clear these rows.");
  }

  // --- D: status='drafted' with no gaps .md file (report-only) ---------
  const d = await client.query(`
    select j.id
    from jobs j
    where j.status = 'drafted'
      and not exists (
        select 1 from job_files f
        where f.job_id = j.id and f.name ilike '%gaps%' and f.name ilike '%.md'
      )
    order by j.id
  `);
  console.log(`\nfix-609: D - status='drafted' with no gaps note -> ${d.rows.length} row(s) (report-only; needs a first-draft-job redraft, not a scripted fix)`);
  for (const r of d.rows) console.log(`  ${r.id}`);
} catch (e) {
  console.error("fix-609: FAILED -", e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  try {
    await client.end();
  } catch {
    /* ignore */
  }
}
