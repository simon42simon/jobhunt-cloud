// RC-3 / SIM-87 I6 - boot gate + demo isolation (guardian MF-8/MF-9). Pure, no
// socket, no DB: exercises server/app-mode.js directly.

import { describe, it, expect } from "vitest";
import {
  resolveAppMode,
  resolveRuntime,
  runnerEnabled,
  syncEnabled,
  exportEnabled,
  apifyModeAllows,
  demoResetSecret,
} from "../server/app-mode.js";

// A minimal VALID demo env: pg backend + a DATABASE_URL positively marked by
// DEMO_DB_ASSERT + no real-data tokens.
const validDemoEnv = () => ({
  APP_MODE: "demo",
  STORE_BACKEND: "pg",
  DATABASE_URL: "postgresql://u:p@demo-db.internal:5432/jobhunt_demo",
  DEMO_DB_ASSERT: "jobhunt_demo",
});

describe("resolveAppMode (MF-9 strict parse)", () => {
  it("defaults an unset / blank APP_MODE to real (the private/laptop posture)", () => {
    expect(resolveAppMode({})).toBe("real");
    expect(resolveAppMode({ APP_MODE: "" })).toBe("real");
    expect(resolveAppMode({ APP_MODE: "   " })).toBe("real");
  });

  it("accepts exactly real or demo", () => {
    expect(resolveAppMode({ APP_MODE: "real" })).toBe("real");
    expect(resolveAppMode({ APP_MODE: "demo" })).toBe("demo");
  });

  it("FAILS CLOSED on any other value (typo, case-mismatch, prod)", () => {
    for (const bad of ["Demo", "DEMO", "prod", "production", "Real", "test", "staging"]) {
      expect(() => resolveAppMode({ APP_MODE: bad })).toThrow(/APP_MODE must be exactly/);
    }
  });
});

describe("resolveRuntime demo isolation (MF-8 allowlist, MF-9 token-absence)", () => {
  it("accepts a well-formed demo env", () => {
    const rt = resolveRuntime(validDemoEnv());
    expect(rt.demo).toBe(true);
    expect(rt.appMode).toBe("demo");
    expect(rt.storeBackend).toBe("pg");
    expect(rt.runnerEnabled).toBe(false);
    expect(rt.apifyModeAllows).toBe(false);
  });

  it("refuses demo without STORE_BACKEND=pg", () => {
    const env = validDemoEnv();
    delete env.STORE_BACKEND;
    expect(() => resolveRuntime(env)).toThrow(/requires STORE_BACKEND=pg/);
  });

  it("refuses demo without DATABASE_URL", () => {
    const env = validDemoEnv();
    delete env.DATABASE_URL;
    expect(() => resolveRuntime(env)).toThrow(/requires DATABASE_URL/);
  });

  it("refuses demo without the DEMO_DB_ASSERT allowlist marker", () => {
    const env = validDemoEnv();
    delete env.DEMO_DB_ASSERT;
    expect(() => resolveRuntime(env)).toThrow(/requires DEMO_DB_ASSERT/);
  });

  it("refuses demo when DEMO_DB_ASSERT does not appear in DATABASE_URL (allowlist fails)", () => {
    const env = validDemoEnv();
    env.DEMO_DB_ASSERT = "not_the_demo_marker";
    expect(() => resolveRuntime(env)).toThrow(/does not appear in DATABASE_URL/);
  });

  it("FAILS CLOSED if the demo can see a RUNNER_TOKEN (anything real)", () => {
    const env = validDemoEnv();
    env.RUNNER_TOKEN = "should-not-be-here";
    expect(() => resolveRuntime(env)).toThrow(/must not carry/);
  });

  it("FAILS CLOSED if the demo can see a RUNNER_TOKEN_HASH (verify-only material)", () => {
    const env = validDemoEnv();
    env.RUNNER_TOKEN_HASH = "abc123";
    expect(() => resolveRuntime(env)).toThrow(/must not carry/);
  });

  it("FAILS CLOSED if the demo can see an APIFY_TOKEN", () => {
    const env = validDemoEnv();
    env.APIFY_TOKEN = "apify_xxx";
    expect(() => resolveRuntime(env)).toThrow(/must not carry APIFY_TOKEN/);
  });

  it("GC-3: FAILS CLOSED if the demo can see a SYNC_TOKEN (anything real)", () => {
    const env = validDemoEnv();
    env.SYNC_TOKEN = "should-not-be-here";
    expect(() => resolveRuntime(env)).toThrow(/must not carry any sync material/);
  });

  it("GC-3: FAILS CLOSED if the demo can see a SYNC_TOKEN_HASH (verify-only material)", () => {
    const env = validDemoEnv();
    env.SYNC_TOKEN_HASH = "abc123";
    expect(() => resolveRuntime(env)).toThrow(/must not carry any sync material/);
  });

  it("GC-3 (I5): FAILS CLOSED if the demo can see an EXPORT_TOKEN (anything real)", () => {
    const env = validDemoEnv();
    env.EXPORT_TOKEN = "should-not-be-here";
    expect(() => resolveRuntime(env)).toThrow(/must not carry any export material/);
  });

  it("GC-3 (I5): FAILS CLOSED if the demo can see an EXPORT_TOKEN_HASH (verify-only material)", () => {
    const env = validDemoEnv();
    env.EXPORT_TOKEN_HASH = "abc123";
    expect(() => resolveRuntime(env)).toThrow(/must not carry any export material/);
  });

  it("SIM-614: the retired MIRROR lane is no longer gated at all - a leftover MIRROR_TOKEN_HASH in the env does NOT block demo boot (the axis was removed, not just disabled)", () => {
    const env = validDemoEnv();
    env.MIRROR_TOKEN_HASH = "leftover-from-before-the-retirement";
    expect(() => resolveRuntime(env)).not.toThrow();
    expect(resolveRuntime(env)).not.toHaveProperty("mirrorEnabled");
  });
});

describe("real-mode runtime + gates", () => {
  it("default (unset) env is real + file backend, runner + apify off (byte-identical posture)", () => {
    const rt = resolveRuntime({});
    expect(rt).toEqual({
      appMode: "real",
      demo: false,
      storeBackend: "file",
      runnerEnabled: false,
      syncEnabled: false,
      exportEnabled: false,
      apifyModeAllows: false,
      resetSecret: null,
    });
  });

  it("runnerEnabled requires real mode AND a RUNNER_TOKEN_HASH (MF-9 second layer)", () => {
    expect(runnerEnabled({ RUNNER_TOKEN_HASH: "h" })).toBe(true);
    expect(runnerEnabled({})).toBe(false);
    // demo can never enable the runner even if material somehow leaked past the gate
    expect(runnerEnabled({ APP_MODE: "demo", RUNNER_TOKEN_HASH: "h" })).toBe(false);
  });

  it("syncEnabled requires real mode AND a SYNC_TOKEN_HASH (SIM-393 I1, mirrors runnerEnabled)", () => {
    expect(syncEnabled({ SYNC_TOKEN_HASH: "h" })).toBe(true);
    expect(syncEnabled({})).toBe(false);
    // demo can never enable the sync surface even if material somehow leaked past the gate
    expect(syncEnabled({ APP_MODE: "demo", SYNC_TOKEN_HASH: "h" })).toBe(false);
  });

  it("exportEnabled requires real mode AND an EXPORT_TOKEN_HASH (SIM-393 I5, mirrors syncEnabled)", () => {
    expect(exportEnabled({ EXPORT_TOKEN_HASH: "h" })).toBe(true);
    expect(exportEnabled({})).toBe(false);
    // demo can never enable the export surface even if material somehow leaked past the gate
    expect(exportEnabled({ APP_MODE: "demo", EXPORT_TOKEN_HASH: "h" })).toBe(false);
  });

  it("apifyModeAllows requires real mode AND an APIFY_TOKEN", () => {
    expect(apifyModeAllows({ APIFY_TOKEN: "t" })).toBe(true);
    expect(apifyModeAllows({})).toBe(false);
    expect(apifyModeAllows({ APP_MODE: "demo", APIFY_TOKEN: "t" })).toBe(false);
  });

  it("demoResetSecret reads DEMO_RESET_SECRET, else null", () => {
    expect(demoResetSecret({ DEMO_RESET_SECRET: "s3cret" })).toBe("s3cret");
    expect(demoResetSecret({})).toBeNull();
  });
});
