// RC-3 / SIM-87 I3+I4 test infrastructure - an EPHEMERAL real Postgres for the
// PgStore contract + differential suites, with NO Docker and NO system Postgres.
//
// Uses `embedded-postgres` (real PG binaries, throwaway cluster per test run). The
// whole thing is DEV-ONLY (devDependency; `npm run lint:audit` runs --omit=dev, so
// it never touches the production audit surface).
//
// SKIPS CLEANLY (never fails the gate) when the cluster cannot be provisioned:
//   - the binary download failed (offline CI), OR
//   - Windows refuses to run postgres.exe under an ADMINISTRATIVE token (the guard
//     "Execution of PostgreSQL by a user with administrative permissions is not
//     permitted"). On an elevated dev shell this is expected; run the suite from a
//     NON-elevated (medium-integrity) context to exercise PgStore. See
//     tests/helpers/README-pg.md for the de-elevated scheduled-task recipe.
// In either case the provisioners return { available:false, reason }, the caller
// omits the PgStore backend, and `npm run check` stays green everywhere.
//
// EXCEPT under REQUIRE_EMBEDDED_PG=1 (guardian deploy-gate re-check, 2026-07-17):
// on a runner that is SUPPOSED to exercise the PG legs (CI, a de-elevated local
// shell), a silent describe.skip made every PG suite vacuously green while a
// broken migration shipped. With the flag set, a provisioning failure THROWS
// instead - the suites provision at module top-level, so the throw hard-fails
// the suite file loudly. Local elevated shells simply leave the flag unset and
// keep the clean-skip behavior.

import EmbeddedPostgres from "embedded-postgres";
import { runner } from "node-pg-migrate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { PgStore } from "../../server/pg-store.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// A free TCP port on loopback (embedded PG binds it for the test cluster).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Boot a throwaway cluster + migrate up. Resolves to a low-level handle or
// { available:false, reason } - NEVER throws (a provisioning failure is a clean
// skip, not a suite error).
// Never let a hung embedded-postgres call freeze the suite: race any lifecycle
// promise against a timeout. A start() that neither resolves nor rejects (or a
// stop() on a server that never came up - which pg_ctl can hang on) becomes a clean
// timeout instead of a frozen `npm run check`.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
  ]);
}

// The one place the "unavailable" outcome is decided (exported for its unit
// test). Default: the historical clean skip ({ available:false, reason }).
// REQUIRE_EMBEDDED_PG=1: throw, so the PG legs can never go vacuously green on
// a runner that must execute them (see header).
export function pgUnavailable(reason, env = process.env) {
  if (env.REQUIRE_EMBEDDED_PG === "1") {
    throw new Error(
      `REQUIRE_EMBEDDED_PG=1 but the embedded Postgres could not be provisioned: ${reason}`,
    );
  }
  return { available: false, reason };
}

export async function startCluster() {
  let pg = null;
  let dir = null;
  let started = false;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-pgtest-"));
    const port = await freePort();
    const password = "jobhunt_test";
    pg = new EmbeddedPostgres({
      databaseDir: path.join(dir, "db"),
      user: "postgres",
      password,
      port,
      persistent: false,
      authMethod: "password",
      onLog: () => {},
      onError: () => {},
    });
    await withTimeout(pg.initialise(), 60000, "pg.initialise");
    await withTimeout(pg.start(), 30000, "pg.start");
    started = true;
    await pg.createDatabase("jobhunt");
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/jobhunt`;
    await runMigration(url, "up");
    const stop = async () => {
      try {
        await withTimeout(pg.stop(), 20000, "pg.stop");
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    return { available: true, url, stop, cluster: pg };
  } catch (e) {
    // CRITICAL: only stop() a cluster that actually STARTED. pg.stop() (pg_ctl stop)
    // on a server that never came up - the elevated-token refusal path - hangs, which
    // was freezing collection. When not started, just delete the temp data dir.
    if (started && pg) {
      try {
        await withTimeout(pg.stop(), 20000, "pg.stop");
      } catch {
        /* ignore */
      }
    }
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const reason =
      e === undefined
        ? "postgres process exited early (likely an elevated/administrative token - run de-elevated)"
        : String((e && e.message) || e);
    return pgUnavailable(reason);
  }
}

// Run node-pg-migrate programmatically. direction "up" | "down".
export async function runMigration(url, direction, count) {
  return runner({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction,
    count: count === undefined ? (direction === "down" ? 1 : Infinity) : count,
    migrationsTable: "pgmigrations",
    log: () => {},
    noLock: false,
  });
}

// High-level provisioner for the contract suite: boot + migrate + build ONE shared
// PgStore, and hand back a backend registry entry whose make() TRUNCATE-resets the
// schema so each contract test starts clean (vitest runs a file's tests serially).
// Returns { available, reason?, backend?, stopAll? }.
export async function provisionPgBackend(deps) {
  const cluster = await startCluster();
  if (!cluster.available) return { available: false, reason: cluster.reason };

  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-pgdocs-"));
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-pgblob-"));
  let store;
  try {
    store = new PgStore({ url: cluster.url, docsDir, blobDir, deps });
  } catch (e) {
    await cluster.stop();
    return pgUnavailable(String((e && e.message) || e));
  }

  const backend = {
    name: "PgStore",
    make() {
      store.truncateAllForTests();
      return { store, cleanup: () => {}, _fileRoot: null };
    },
  };

  const stopAll = async () => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    await cluster.stop();
    try {
      fs.rmSync(docsDir, { recursive: true, force: true });
      fs.rmSync(blobDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { available: true, url: cluster.url, store, backend, stopAll };
}
