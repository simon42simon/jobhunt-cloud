import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import {
  resolveAuth,
  deriveSecret,
  signSession,
  verifySession,
  parseCookies,
  parseCorsOrigins,
  isAuthOpenPath,
  isBehindTls,
  buildHelmetOptions,
  CSP_DIRECTIVES,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../server/auth.js";

// SIM-85 / RC-1: feature-flagged app-level auth. Two postures are pinned here:
//   - auth OFF (no hash, JOBHUNT_AUTH unset) => today's behavior: endpoints
//     reachable, no 401, no login required (the regression guarantee).
//   - auth ON (JOBHUNT_AUTH_HASH set) => /api/* is 401 without a session, the
//     login flow issues a session cookie, the rate limiter fires, and helmet
//     headers are present.
// Red-checked: before server/index.js wires resolveAuth/createAuthGate, every
// "auth ON" assertion below fails (200 instead of 401, no CSP header), proving
// the gate - not the import - is what enforces the posture.

const PASSPHRASE = "correct-horse-battery";
const TEST_SECRET = "test-fixed-secret-do-not-use-in-prod";

// Fresh app instance with a controlled env. index.js reads env at import time,
// so we reset the module registry and re-import per posture.
async function loadApp(envOverrides = {}) {
  vi.resetModules();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-auth-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  // Clean base: hermetic dirs, no auth unless an override sets it.
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  for (const k of [
    "JOBHUNT_AUTH",
    "JOBHUNT_AUTH_HASH",
    "JOBHUNT_AUTH_SECRET",
    "JOBHUNT_CORS_ORIGINS",
    "JOBHUNT_AUTH_RATELIMIT_MAX",
    "JOBHUNT_AUTH_RATELIMIT_WINDOW_MS",
    "JOBHUNT_TLS",
    "JOBHUNT_TRUST_PROXY",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, envOverrides);
  const mod = await import("../server/index.js");
  return { app: mod.app, tmpRoot };
}

// ---------------------------------------------------------------------------
describe("auth pure helpers", () => {
  it("signSession / verifySession round-trips and rejects tampering + expiry", () => {
    const tok = signSession(TEST_SECRET, { exp: Date.now() + 10_000 });
    expect(verifySession(TEST_SECRET, tok)).toBe(true);
    expect(verifySession("other-secret", tok)).toBe(false); // wrong key
    expect(verifySession(TEST_SECRET, tok + "x")).toBe(false); // tampered sig
    expect(verifySession(TEST_SECRET, "garbage")).toBe(false);
    const expired = signSession(TEST_SECRET, { exp: Date.now() - 1 });
    expect(verifySession(TEST_SECRET, expired)).toBe(false);
  });

  it("parseCookies reads the session cookie out of a Cookie header", () => {
    const jar = parseCookies(`a=1; ${SESSION_COOKIE}=abc.def; b=2`);
    expect(jar[SESSION_COOKIE]).toBe("abc.def");
    expect(parseCookies(undefined)).toEqual({});
  });

  it("parseCorsOrigins defaults to an empty allowlist (no-CORS posture preserved)", () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins("")).toEqual([]);
    expect(parseCorsOrigins("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("isAuthOpenPath whitelists exactly the login/logout/status endpoints", () => {
    expect(isAuthOpenPath("/api/auth/login")).toBe(true);
    expect(isAuthOpenPath("/api/auth/logout")).toBe(true);
    expect(isAuthOpenPath("/api/auth/status")).toBe(true);
    expect(isAuthOpenPath("/api/config")).toBe(false);
  });

  it("resolveAuth: OFF by default, ON with a hash, force-off, and fail-loud on required-without-hash", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-auth-cfg-"));
    // default: nothing configured
    expect(resolveAuth({ env: {}, dataDir: emptyDir }).enabled).toBe(false);
    // env hash present -> enabled, stable derived secret
    const on = resolveAuth({ env: { JOBHUNT_AUTH_HASH: "$argon2id$fake" }, dataDir: emptyDir });
    expect(on.enabled).toBe(true);
    expect(on.source).toBe("env");
    expect(on.secret).toBe(deriveSecret("$argon2id$fake"));
    // force off wins even with a hash
    expect(
      resolveAuth({ env: { JOBHUNT_AUTH: "off", JOBHUNT_AUTH_HASH: "$argon2id$fake" }, dataDir: emptyDir })
        .enabled,
    ).toBe(false);
    // required but nothing to check -> throw
    expect(() => resolveAuth({ env: { JOBHUNT_AUTH: "required" }, dataDir: emptyDir })).toThrow(
      /required but no passphrase hash/i,
    );
  });

  it("isBehindTls: false on plain loopback, true on JOBHUNT_TLS or a trust-proxy opt-in", () => {
    expect(isBehindTls({})).toBe(false);
    expect(isBehindTls({ JOBHUNT_TLS: "1" })).toBe(true);
    expect(isBehindTls({ JOBHUNT_TLS: "true" })).toBe(true);
    expect(isBehindTls({ JOBHUNT_TRUST_PROXY: "1" })).toBe(true);
    expect(isBehindTls({ JOBHUNT_TRUST_PROXY: "loopback" })).toBe(true);
    expect(isBehindTls({ JOBHUNT_TRUST_PROXY: "0" })).toBe(false);
    expect(isBehindTls({ JOBHUNT_TRUST_PROXY: "false" })).toBe(false);
  });

  it("buildHelmetOptions: Vite CSP + frame DENY always; COOP/CORP off; HSTS only under TLS", () => {
    const off = buildHelmetOptions({ behindTls: false });
    expect(off.contentSecurityPolicy.directives).toBe(CSP_DIRECTIVES);
    expect(off.frameguard).toEqual({ action: "deny" });
    expect(off.crossOriginOpenerPolicy).toBe(false);
    expect(off.crossOriginResourcePolicy).toBe(false);
    expect(off.hsts).toBe(false); // no HSTS without TLS (never pin localhost to https)
    const on = buildHelmetOptions({ behindTls: true });
    expect(on.hsts).toMatchObject({ maxAge: expect.any(Number) });
    expect(on.hsts.maxAge).toBeGreaterThan(0);
  });

  it("loadAuthFile is read from DATA_DIR and feeds resolveAuth (file source)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-auth-file-"));
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ algo: "argon2id", hash: "$argon2id$filehash", secret: "file-secret" }),
    );
    const r = resolveAuth({ env: {}, dataDir: dir });
    expect(r.enabled).toBe(true);
    expect(r.source).toBe("file");
    expect(r.secret).toBe("file-secret");
  });
});

// ---------------------------------------------------------------------------
describe("auth OFF (default) = today's behavior (regression)", () => {
  let app;
  let tmpRoot;
  beforeAll(async () => {
    ({ app, tmpRoot } = await loadApp());
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/config is 200 with no auth gate and no login required", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statuses");
  });

  it("no auth endpoints exist (login gate stays feature-flagged off)", async () => {
    const status = await request(app).get("/api/auth/status");
    expect(status.status).toBe(404);
  });

  it("still emits security headers with auth off (G10: hardening is decoupled from the auth gate)", async () => {
    // Pre-G10 this asserted the CSP header was ABSENT with auth off; that left the
    // public demo (auth off, internet-facing) unprotected. Hardening now always on.
    const cfg = await request(app).get("/api/config");
    expect(cfg.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(cfg.headers["x-frame-options"]).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------
// G10 (RC-4): security-headers hardening is DECOUPLED from auth. The PUBLIC DEMO
// runs with auth OFF but is internet-facing, so helmet/CSP/frame protection MUST
// be present even when auth is off. RED-CHECKED: against the old auth-gated
// mounting (helmet inside `if (auth.enabled)`) every assertion in this block fails
// (no CSP / X-Frame-Options / nosniff header when auth is off), proving the
// decoupling - not the import - is what protects the demo surface.
describe("security headers hardening (auth OFF = the public-demo surface)", () => {
  let app;
  let tmpRoot;
  beforeAll(async () => {
    ({ app, tmpRoot } = await loadApp()); // no auth, no TLS - the local/demo default
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("emits the Vite-tuned CSP even with auth off", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200); // no auth gate - the demo stays anonymously reachable
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  });

  it("emits anti-clickjacking (X-Frame-Options DENY) + nosniff + referrer-policy with auth off", async () => {
    const res = await request(app).get("/api/config");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
  });

  it("omits HSTS when not behind TLS (loopback/local) but keeps the rest", async () => {
    const res = await request(app).get("/api/config");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("leaves cross-origin isolation (COOP/CORP) OFF so on-box fleet cross-origin reads are unaffected", async () => {
    const res = await request(app).get("/api/config");
    expect(res.headers["cross-origin-resource-policy"]).toBeUndefined();
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real public-demo topology: auth OFF (a public demo cannot require login) but
// behind a TLS terminator (Railway). HSTS becomes meaningful and must appear WHILE
// auth stays off and the surface stays anonymously reachable.
describe("security headers hardening (auth OFF, behind TLS = public demo on Railway)", () => {
  let app;
  let tmpRoot;
  beforeAll(async () => {
    ({ app, tmpRoot } = await loadApp({ JOBHUNT_TLS: "1" }));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("adds HSTS under TLS while auth stays off and the demo stays reachable", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200); // still no auth gate
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------
describe("auth ON (JOBHUNT_AUTH_HASH set)", () => {
  let app;
  let tmpRoot;
  let hash;

  beforeAll(async () => {
    hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("blocks /api/config with 401 when there is no session", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
  });

  it("emits helmet security headers (CSP + nosniff)", async () => {
    const res = await request(app).get("/api/auth/status");
    expect(res.headers["content-security-policy"]).toBeTruthy();
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects a wrong passphrase with 401 and sets no cookie", async () => {
    const res = await request(app).post("/api/auth/login").send({ passphrase: "wrong" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("full login flow: correct passphrase -> httpOnly session cookie -> gated route unlocks -> logout", async () => {
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieStr = setCookie.join(";");
    expect(cookieStr).toMatch(new RegExp(`${SESSION_COOKIE}=`));
    expect(cookieStr.toLowerCase()).toMatch(/httponly/);
    expect(cookieStr.toLowerCase()).toMatch(/samesite=lax/);

    // Extract just the session cookie for the follow-up request.
    const jar = setCookie.map((c) => c.split(";")[0]).join("; ");
    const authed = await request(app).get("/api/config").set("Cookie", jar);
    expect(authed.status).toBe(200);
    expect(authed.body).toHaveProperty("statuses");

    const status = await request(app).get("/api/auth/status").set("Cookie", jar);
    expect(status.body).toEqual({ authRequired: true, authenticated: true });

    // Logout clears the cookie.
    const logout = await request(app).post("/api/auth/logout").set("Cookie", jar);
    expect(logout.status).toBe(200);
    const cleared = logout.headers["set-cookie"].join(";");
    expect(cleared).toMatch(new RegExp(`${SESSION_COOKIE}=`)); // cleared cookie has empty value + expiry in the past
  });

  it("a forged/tampered session cookie is rejected (401)", async () => {
    const forged = signSession("attacker-secret", { exp: Date.now() + SESSION_TTL_MS });
    const res = await request(app).get("/api/config").set("Cookie", `${SESSION_COOKIE}=${forged}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("login rate limiting", () => {
  let app;
  let tmpRoot;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_AUTH_RATELIMIT_MAX: "3",
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("fires a 429 after the configured attempt cap", async () => {
    let last;
    for (let i = 0; i < 4; i++) {
      last = await request(app).post("/api/auth/login").send({ passphrase: "wrong" });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: "too many login attempts, try again later" });
  });
});
