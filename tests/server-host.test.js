import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T1 (t-1783121051955): the vault read/WRITE API must bind loopback by default
// and only reach the LAN on an explicit owner opt-in. These are pure unit tests
// over the host-resolution + posture helpers exported from the real server
// module. JOBHUNT_TEST=1 skips the watcher + port bind, so importing index.js
// never opens a socket (we must NEVER bind :8787 - let alone off-box - in tests).
let resolveServerHost, isLoopbackHost;

beforeAll(async () => {
  process.env.JOBHUNT_TEST = "1";
  // Point at a throwaway dir so the import does not depend on the real vault.
  process.env.JOBHUNT_JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jh-host-"));
  ({ resolveServerHost, isLoopbackHost } = await import("../server/index.js"));
});

describe("resolveServerHost (loopback-by-default data-sovereignty gate)", () => {
  it("defaults to loopback when serverHost is unset", () => {
    expect(resolveServerHost({})).toBe("127.0.0.1");
  });

  it("defaults to loopback for null/undefined config (never throws, never exposes)", () => {
    expect(resolveServerHost(null)).toBe("127.0.0.1");
    expect(resolveServerHost(undefined)).toBe("127.0.0.1");
  });

  it("defaults to loopback when serverHost is an empty string (no silent exposure)", () => {
    expect(resolveServerHost({ serverHost: "" })).toBe("127.0.0.1");
  });

  it("honours an explicit 0.0.0.0 LAN opt-in", () => {
    expect(resolveServerHost({ serverHost: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("honours an explicit specific-IP LAN opt-in", () => {
    expect(resolveServerHost({ serverHost: "192.168.1.50" })).toBe("192.168.1.50");
  });
});

describe("isLoopbackHost (startup bind-posture reporting)", () => {
  it("flags loopback hosts as on-box", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("flags 0.0.0.0 and LAN IPs as NOT loopback (LAN-exposed posture)", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
  });
});
