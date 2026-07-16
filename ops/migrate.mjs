// RC-3 / SIM-87 I8 - in-platform migration runner (design 3.3). Runs the
// node-pg-migrate `up` step BEFORE the server boots, so a fresh Railway/Postgres
// deployment self-migrates (this is how I5's file->pg migration executes in-platform
// later, and how every schema change lands on deploy).
//
// FileStore deployments (the laptop, a naked container) have no DATABASE_URL and no
// STORE_BACKEND=pg: this script then NO-OPS cleanly, so one image serves all three
// deployments (12-factor). Fail-fast: a real migration error exits non-zero so the
// container's release step fails visibly rather than booting an unmigrated DB.

import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  const usePg = process.env.STORE_BACKEND === "pg";
  if (!usePg || !url) {
    console.log("[migrate] STORE_BACKEND!=pg or no DATABASE_URL - skipping (FileStore deployment)");
    return;
  }
  const { runner } = await import("node-pg-migrate");
  console.log("[migrate] running node-pg-migrate up ...");
  const applied = await runner({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction: "up",
    count: Infinity,
    migrationsTable: "pgmigrations",
  });
  console.log(`[migrate] up complete (${applied.length} migration(s) applied/verified)`);
}

main().catch((e) => {
  console.error(`[migrate] FAILED: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
