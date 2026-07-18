// SIM-394 - guardian mirror condition M3 (cloud-repo pin): DEMO MODE (auth off
// by design) with JOBHUNT_WEBAUTHN=on - the env var CORRECTLY SPELLED, so this
// can never pass vacuously on a typo'd name - REFUSES TO BOOT. The
// on-without-auth rule in resolveWebauthn already implies this ("a second
// factor needs a first"), but the public demo is the surface an env accident
// would hit, so the demo posture is pinned explicitly here rather than left to
// implication.
//
// Structure (the app-mode.test.js precedent for boot-refusal pins, plus one
// real end-to-end boot rejection):
//   1. The demo env sequence, exactly as server/index.js runs it at module
//      scope: resolveRuntime passes the demo isolation gate, resolveAuth
//      resolves OFF (the demo carries no auth material), and resolveWebauthn
//      then THROWS WEBAUTHN_MISCONFIGURED - the boot cannot complete.
//   2. A static pin that index.js calls resolveWebauthn UNCONDITIONALLY at
//      module top level (outside every auth.enabled / DEMO_MODE guard), so
//      that throw IS a boot refusal on every deployment surface.
//   3. A real full-boot check: importing server/index.js with auth off and
//      JOBHUNT_WEBAUTHN=on rejects with WEBAUTHN_MISCONFIGURED (file backend -
//      demo's own pg requirement is why leg 1 is the pure sequence; the
//      auth-off premise is identical on both).

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntime } from "../server/app-mode.js";
import { resolveAuth } from "../server/auth.js";
import { resolveWebauthn } from "../server/webauthn.js";

// The public demo's env shape (APP_MODE=demo satisfies the MF-8/MF-9 isolation
// gate; no JOBHUNT_AUTH_HASH - the demo is auth-off by design) PLUS the flag,
// correctly spelled, with rpID/origin present so the ONLY failing check is
// on-without-auth - the exact accident this pin guards.
const DEMO_ENV = {
  APP_MODE: "demo",
  STORE_BACKEND: "pg",
  DATABASE_URL: "postgres://demo:demo@127.0.0.1:5432/demo_marker_db",
  DEMO_DB_ASSERT: "demo_marker_db",
  JOBHUNT_WEBAUTHN: "on",
  JOBHUNT_WEBAUTHN_RPID: "demo.example.test",
  JOBHUNT_WEBAUTHN_ORIGIN: "https://demo.example.test",
};

const emptyDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jh-m3-"));

describe("M3: demo mode (auth off) with JOBHUNT_WEBAUTHN=on refuses to boot", () => {
  it("the demo env passes the isolation gate and resolves auth OFF - the premise is real", () => {
    const runtime = resolveRuntime(DEMO_ENV);
    expect(runtime.demo).toBe(true); // not rejected earlier for an unrelated reason
    const auth = resolveAuth({ env: DEMO_ENV, dataDir: emptyDataDir() });
    expect(auth.enabled).toBe(false); // the demo has no first factor
  });

  it("resolveWebauthn then throws WEBAUTHN_MISCONFIGURED - the boot sequence cannot complete", () => {
    const auth = resolveAuth({ env: DEMO_ENV, dataDir: emptyDataDir() });
    let err = null;
    try {
      resolveWebauthn({ env: DEMO_ENV, auth });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe("WEBAUTHN_MISCONFIGURED");
    expect(err.message).toMatch(/requires auth/);
  });

  it("index.js calls resolveWebauthn unconditionally at module scope, so the throw IS a boot refusal", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../server/index.js", import.meta.url)),
      "utf8",
    );
    // Column-0 `const` = module top level (inside any if-block it would be
    // indented), and it must run on every boot - before, and regardless of,
    // the auth.enabled route wiring.
    expect(src).toMatch(/^const webauthn = resolveWebauthn\(\{ env: process\.env, auth \}\);/m);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end leg: a REAL module boot with auth off + the flag on rejects.
// ---------------------------------------------------------------------------
describe("full boot with JOBHUNT_WEBAUTHN=on and auth off rejects (end to end)", () => {
  let tmpRoot;
  const TOUCHED = [
    "JOBHUNT_WEBAUTHN",
    "JOBHUNT_WEBAUTHN_RPID",
    "JOBHUNT_WEBAUTHN_ORIGIN",
    "JOBHUNT_AUTH",
    "JOBHUNT_AUTH_HASH",
    "JOBHUNT_AUTH_SECRET",
    "JOBHUNT_JOBS_DIR",
    "JOBHUNT_DOCS_DIR",
    "JOBHUNT_DATA_DIR",
  ];

  afterAll(() => {
    for (const k of TOUCHED) delete process.env[k];
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("import of server/index.js rejects with WEBAUTHN_MISCONFIGURED", async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-m3-boot-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    const dataDir = path.join(tmpRoot, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = dataDir;
    // Auth OFF (no hash anywhere - the fresh dataDir has no auth.json), flag ON.
    for (const k of ["JOBHUNT_AUTH", "JOBHUNT_AUTH_HASH", "JOBHUNT_AUTH_SECRET"]) {
      delete process.env[k];
    }
    process.env.JOBHUNT_WEBAUTHN = "on";
    process.env.JOBHUNT_WEBAUTHN_RPID = "demo.example.test";
    process.env.JOBHUNT_WEBAUTHN_ORIGIN = "https://demo.example.test";

    await expect(import("../server/index.js")).rejects.toMatchObject({
      code: "WEBAUTHN_MISCONFIGURED",
    });
  });
});
