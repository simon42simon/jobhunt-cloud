// RC-3 / SIM-87 I6 - APP_MODE boot gate + demo isolation (ADR-025, guardian
// MF-8/MF-9/MF-10). PURE + importable: every gate here is a plain function tests
// exercise WITHOUT a socket or a database, exactly like server/auth.js.
//
// THE FIVE-AXIS DEMO ISOLATION (design 5.4) is enforced here at boot, FAIL-CLOSED:
//   - MF-9  APP_MODE is parsed STRICTLY: the process refuses to boot unless it is
//           exactly "real" or "demo" (an absent/blank value defaults to "real",
//           the private/laptop posture). A typo ("Demo", "DEMO", "prod") is not
//           silently coerced to real-mode behaviour on a demo box - it throws.
//   - MF-8  Demo asserts POSITIVELY that its database is the demo DB via an
//           allowlist marker (DEMO_DB_ASSERT must be present AND appear inside
//           DATABASE_URL). It never tries to enumerate/blacklist the private URL
//           (which would force the demo to KNOW the private URL and break on
//           rotation). If the marker is absent or does not match, boot throws.
//   - MF-9  The runner + Apify egress are disabled on TOKEN-ABSENCE as well as on
//           mode: runnerEnabled/apifyEnabled require real mode AND the token, so a
//           mode misread cannot re-enable them (defence in depth). Demo also
//           refuses to boot if a RUNNER_TOKEN or APIFY_TOKEN is present at all -
//           "the demo refuses to start if it can see anything real."
//   - MF-10 The nightly reset never exposes an anonymous surface: an in-process
//           interval is the default, and the optional reset ENDPOINT requires a
//           shared secret (resetSecret) even when app auth is off. Enforced by the
//           route in index.js; the secret is resolved here.
//
// Nothing here reads real data or opens a connection - it only inspects env.

const VALID_MODES = ["real", "demo"];

function present(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Strict APP_MODE parse (MF-9). Unset/blank -> "real" (the laptop/private default,
// matching the 12-factor matrix where private leaves APP_MODE unset). Any other
// value is a hard, fail-closed boot error - never coerced.
export function resolveAppMode(env = {}) {
  const raw = env.APP_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "real";
  const mode = String(raw).trim();
  if (!VALID_MODES.includes(mode)) {
    const err = new Error(
      `APP_MODE must be exactly "real" or "demo" (got ${JSON.stringify(raw)}); ` +
        "refusing to boot to avoid running real-mode behaviour on a mis-tagged deployment",
    );
    err.code = "APP_MODE_INVALID";
    throw err;
  }
  return mode;
}

// True only when the runner queue may run: REAL mode AND the verify-only runner-token
// hash is present (MF-9 second layer). The cloud holds ONLY sha256(token) as
// RUNNER_TOKEN_HASH, never the reusable plaintext (which lives in the laptop's
// ~/.ssc-secrets). Demo can never satisfy this - it carries no runner material and
// the mode gate blocks it regardless.
export function runnerEnabled(env = {}) {
  return resolveAppMode(env) === "real" && present(env.RUNNER_TOKEN_HASH);
}

// True only when the vault->cloud SYNC ingest surface may run: REAL mode AND the
// verify-only SYNC_TOKEN_HASH is present (SIM-393 I1, mirroring runnerEnabled). The
// cloud holds ONLY sha256(token) as SYNC_TOKEN_HASH; the reusable plaintext lives on
// the laptop (~/.ssc-secrets). Demo can never satisfy this - it carries no sync
// material and, per GC-3, the isolation gate refuses to boot if it can see any.
export function syncEnabled(env = {}) {
  return resolveAppMode(env) === "real" && present(env.SYNC_TOKEN_HASH);
}

// True only when Apify egress may run: REAL mode AND an APIFY token is present. In
// demo mode this is always false (the token is also asserted-absent at boot). The
// owner's own `apifyEnabled` config flag still gates it further in index.js; this
// is the mode/token floor.
export function apifyModeAllows(env = {}) {
  return resolveAppMode(env) === "real" && present(env.APIFY_TOKEN);
}

// The reset secret (MF-10). Present only in demo; the reset endpoint requires it
// even when app auth is off, so there is never an anonymous TRUNCATE button.
export function demoResetSecret(env = {}) {
  return present(env.DEMO_RESET_SECRET) ? String(env.DEMO_RESET_SECRET).trim() : null;
}

// The full runtime posture, computed once at boot. Throws (fail-closed) on any
// demo-isolation violation (MF-8/MF-9). The returned object is what index.js reads
// to decide the store backend, whether to enable the runner/Apify, and whether to
// arm the demo reset + replay paths.
export function resolveRuntime(env = {}) {
  const appMode = resolveAppMode(env); // MF-9 strict parse (throws on garbage)
  const storeBackend = env.STORE_BACKEND === "pg" ? "pg" : "file";
  const demo = appMode === "demo";

  if (demo) {
    // --- MF-8: allowlist-shaped demo-DB assertion (NOT a private-URL blacklist) ---
    if (storeBackend !== "pg") {
      throw isoErr("demo mode requires STORE_BACKEND=pg (the demo runs on its own Postgres)");
    }
    if (!present(env.DATABASE_URL)) {
      throw isoErr("demo mode requires DATABASE_URL (the demo Postgres connection string)");
    }
    if (!present(env.DEMO_DB_ASSERT)) {
      throw isoErr(
        "demo mode requires DEMO_DB_ASSERT (a marker that must appear in DATABASE_URL, " +
          "positively identifying the DEMO database - never a blacklist of the private URL)",
      );
    }
    if (!String(env.DATABASE_URL).includes(String(env.DEMO_DB_ASSERT).trim())) {
      throw isoErr(
        "DEMO_DB_ASSERT does not appear in DATABASE_URL: refusing to boot demo against a database " +
          "that is not positively marked as the demo DB (MF-8 allowlist assertion failed)",
      );
    }
    // --- MF-9: the demo must not be able to SEE anything real. Fail closed if a
    // real-data secret is present in the demo env. ---
    if (present(env.RUNNER_TOKEN) || present(env.RUNNER_TOKEN_HASH)) {
      throw isoErr("demo mode must not carry any runner material (RUNNER_TOKEN / RUNNER_TOKEN_HASH); the demo has no runner and cannot reach the laptop");
    }
    if (present(env.APIFY_TOKEN)) {
      throw isoErr("demo mode must not carry APIFY_TOKEN (the demo uses seed finds, never live Apify egress)");
    }
    // GC-3 (SIM-393): the sync/export credentials join the "demo refuses to start if
    // it can see anything real" clause. The route-level 501 stays as a backstop, but
    // a demo that can even SEE the sync verify-hash must not boot.
    if (present(env.SYNC_TOKEN) || present(env.SYNC_TOKEN_HASH)) {
      throw isoErr("demo mode must not carry any sync material (SYNC_TOKEN / SYNC_TOKEN_HASH); the demo has no vault->cloud sync lane");
    }
  }

  return {
    appMode,
    demo,
    storeBackend,
    runnerEnabled: runnerEnabled(env),
    syncEnabled: syncEnabled(env),
    apifyModeAllows: apifyModeAllows(env),
    resetSecret: demo ? demoResetSecret(env) : null,
  };
}

function isoErr(message) {
  const err = new Error(`demo isolation gate: ${message}`);
  err.code = "DEMO_ISOLATION";
  return err;
}
