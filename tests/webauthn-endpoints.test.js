// SIM-394 - integration coverage for the WebAuthn second factor over the real
// Express app (FileStore backend; the PgStore ceremony leg lives in
// tests/webauthn-pg.test.js and the credential CRUD contract in
// tests/store-contract.test.js). Pins, in order:
//
//   1. FLAG OFF = BYTE-IDENTICAL NO-OP (the SIM-386 standard): no
//      /api/webauthn/* endpoint exists, login issues the session on the
//      passphrase alone with the EXACT pre-feature body, and the status body
//      carries no webauthn key.
//   2. ENROLLMENT MODE (flag on, <2 credentials): passphrase-only login still
//      works (anti-lockout), status nags (enrolling:true), registration
//      ceremonies round-trip and are session-authed.
//   3. ENFORCED (>=2 credentials): login returns webauthnRequired + a pending
//      cookie instead of the session; the assertion ceremony converts it; the
//      pending token can NEVER pass the auth gate.
//   4. Attack-shaped paths: challenge reuse, challenge expiry, counter
//      regression (cloned-authenticator signal), unknown credential, missing
//      pending token - all 401/400 and all feed the SIM-386 monitor under
//      surface:"webauthn" with NO credential material in any recorded line.
//   5. The last-credential deletion refusal (server-side 409).
//   6. Rate limiting on the assertion lane, consistent with the login limiter.
//
// RED-CHECKED: with the SIM-394 code stashed (server/webauthn.js + the auth.js/
// index.js wiring), blocks 2-6 fail on their first request (404 endpoints) and
// block 1's assertions are what KEEPS passing - which is exactly the no-op
// guarantee. See the SIM-394 build report for the recorded run.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import { SESSION_COOKIE } from "../server/auth.js";
import { MFA_COOKIE } from "../server/webauthn.js";
import { createAuthenticator, attestationResponse, assertionResponse } from "./helpers/webauthn-mock.mjs";

const PASSPHRASE = "correct-horse-battery";
const TEST_SECRET = "test-fixed-secret-do-not-use-in-prod";
const RP_ID = "localhost";
const ORIGIN = "https://localhost";

const WEBAUTHN_ENV_KEYS = [
  "JOBHUNT_WEBAUTHN",
  "JOBHUNT_WEBAUTHN_RPID",
  "JOBHUNT_WEBAUTHN_ORIGIN",
  "JOBHUNT_WEBAUTHN_RPNAME",
  "JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS",
];

// Fresh app instance with a controlled env (the auth.test.js loader, extended
// with the webauthn keys + an explicit DATA_DIR so activity-log assertions can
// read the durable monitor lines).
async function loadApp(envOverrides = {}) {
  vi.resetModules();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-webauthn-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  const dataDir = path.join(tmpRoot, "data");
  for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DATA_DIR = dataDir;
  for (const k of [
    "JOBHUNT_AUTH",
    "JOBHUNT_AUTH_HASH",
    "JOBHUNT_AUTH_SECRET",
    "JOBHUNT_AUTH_RATELIMIT_MAX",
    "JOBHUNT_AUTH_RATELIMIT_WINDOW_MS",
    "JOBHUNT_AUTH_ALERT_THRESHOLD",
    "JOBHUNT_TLS",
    "JOBHUNT_TRUST_PROXY",
    ...WEBAUTHN_ENV_KEYS,
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, envOverrides);
  const mod = await import("../server/index.js");
  return { app: mod.app, tmpRoot, dataDir };
}

// Env hygiene: webauthn env must never leak into suites that run later in this
// worker (a leaked JOBHUNT_WEBAUTHN=on without auth would fail THEIR boots).
function cleanupEnv() {
  for (const k of [...WEBAUTHN_ENV_KEYS, "JOBHUNT_DATA_DIR"]) delete process.env[k];
}

const cookieOf = (res, name) => {
  const set = res.headers["set-cookie"] || [];
  const hit = set.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(";")[0] : null;
};

const readActivity = (dataDir) => {
  try {
    return fs.readFileSync(path.join(dataDir, "activity-log.jsonl"), "utf8");
  } catch {
    return "";
  }
};
const webauthnAuthLines = (dataDir) =>
  readActivity(dataDir)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "auth" && r.surface === "webauthn");

// Drive the register ceremony end-to-end for an already-authed session.
async function register(app, sessionCookie, auth, label) {
  const opt = await request(app)
    .post("/api/webauthn/register/options")
    .set("Cookie", sessionCookie);
  expect(opt.status).toBe(200);
  const att = attestationResponse(auth, { challenge: opt.body.challenge, origin: ORIGIN });
  return request(app)
    .post("/api/webauthn/register/verify")
    .set("Cookie", sessionCookie)
    .send({ response: att, label });
}

// ---------------------------------------------------------------------------
// 1. FLAG OFF (auth on) = byte-identical current behavior.
// ---------------------------------------------------------------------------
describe("JOBHUNT_WEBAUTHN off/absent = byte-identical no-op (auth on)", () => {
  let app, tmpRoot;
  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
    }));
  });
  afterAll(() => {
    cleanupEnv();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("no /api/webauthn/* endpoint exists at all (404 behind a valid session; plain gate-401 without)", async () => {
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    const session = cookieOf(login, SESSION_COOKIE);
    for (const [method, p] of [
      ["post", "/api/webauthn/register/options"],
      ["post", "/api/webauthn/register/verify"],
      ["get", "/api/webauthn/credentials"],
      ["delete", "/api/webauthn/credentials/x"],
      ["post", "/api/webauthn/login/options"],
      ["post", "/api/webauthn/login/verify"],
    ]) {
      // With a session: the route simply does not exist (Express 404).
      const authed = await request(app)[method](p).set("Cookie", session);
      expect(authed.status, `${method} ${p} (session)`).toBe(404);
      // Without: the generic auth gate answers, exactly like any other /api path
      // (the pre-feature behavior for an unknown route).
      const anon = await request(app)[method](p);
      expect(anon.status, `${method} ${p} (anon)`).toBe(401);
      expect(anon.body).toEqual({ error: "authentication required" });
    }
  });

  it("login issues the session on the passphrase alone with the EXACT pre-feature body", async () => {
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true }); // no webauthnRequired key - deep equality
    expect(cookieOf(login, SESSION_COOKIE)).toBeTruthy();
    expect(cookieOf(login, MFA_COOKIE)).toBeNull(); // no pending cookie exists in this world
  });

  it("status body is EXACTLY the pre-feature shape (no webauthn key)", async () => {
    const res = await request(app).get("/api/auth/status");
    expect(res.body).toEqual({ authRequired: true, authenticated: false });
  });
});

// ---------------------------------------------------------------------------
// 2+3+4+5. FLAG ON: enrollment mode -> enforced -> ceremonies + attacks.
// One app instance; state (the FileStore credential file) carries forward
// through the block in dependency order.
// ---------------------------------------------------------------------------
describe("JOBHUNT_WEBAUTHN=on: enrollment mode -> enforcement -> ceremonies", () => {
  let app, tmpRoot, dataDir;
  let sessionJar; // full-session cookie from the enrollment-mode login
  const authnr1 = createAuthenticator({ rpId: RP_ID });
  const authnr2 = createAuthenticator({ rpId: RP_ID });
  let cred1Id;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot, dataDir } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_WEBAUTHN: "on",
      JOBHUNT_WEBAUTHN_RPID: RP_ID,
      JOBHUNT_WEBAUTHN_ORIGIN: ORIGIN,
      // Headroom: this block makes many auth-lane calls; the rate-limit path
      // has its own dedicated block below with a tight cap.
      JOBHUNT_AUTH_RATELIMIT_MAX: "50",
    }));
  });
  afterAll(() => {
    cleanupEnv();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("ENROLLMENT MODE (0 credentials): status says enrolling, passphrase-only login still works", async () => {
    const status = await request(app).get("/api/auth/status");
    expect(status.body.webauthn).toEqual({ enabled: true, enforced: false, enrolling: true });

    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true }); // NOT webauthnRequired - the anti-lockout core
    sessionJar = cookieOf(login, SESSION_COOKIE);
    expect(sessionJar).toBeTruthy();

    // The session opens the gate exactly as before.
    const cfg = await request(app).get("/api/config").set("Cookie", sessionJar);
    expect(cfg.status).toBe(200);
  });

  it("enrollment is session-authed: no session -> 401 on every enrollment surface", async () => {
    expect((await request(app).post("/api/webauthn/register/options")).status).toBe(401);
    expect((await request(app).post("/api/webauthn/register/verify").send({ response: {} })).status).toBe(401);
    expect((await request(app).get("/api/webauthn/credentials")).status).toBe(401);
    expect((await request(app).delete("/api/webauthn/credentials/x")).status).toBe(401);
  });

  it("registers the FIRST passkey (full ceremony round-trip); still enrollment mode at 1", async () => {
    const res = await register(app, sessionJar, authnr1, "laptop-touchid");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.credential.label).toBe("laptop-touchid");
    expect(res.body.enforced).toBe(false); // 1 < 2: the floor holds
    expect(res.body.enrolling).toBe(true);
    cred1Id = res.body.credential.id;

    // The list serves whitelisted meta only - never key material.
    const list = await request(app).get("/api/webauthn/credentials").set("Cookie", sessionJar);
    expect(list.body.credentials).toHaveLength(1);
    expect(list.body.minCredentials).toBe(2);
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey|public_key|counter/);

    // Login is STILL passphrase-only with 1 credential.
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.body).toEqual({ ok: true });
  });

  it("a registration challenge is single-use (replaying the same attestation 400s)", async () => {
    const opt = await request(app).post("/api/webauthn/register/options").set("Cookie", sessionJar);
    const extra = createAuthenticator({ rpId: RP_ID });
    const att = attestationResponse(extra, { challenge: opt.body.challenge, origin: ORIGIN });
    const first = await request(app)
      .post("/api/webauthn/register/verify")
      .set("Cookie", sessionJar)
      .send({ response: att, label: "temp" });
    expect(first.status).toBe(200);
    const replay = await request(app)
      .post("/api/webauthn/register/verify")
      .set("Cookie", sessionJar)
      .send({ response: att, label: "temp2" });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/challenge/i);
    // remove the throwaway credential again (2 present, delete is allowed)
    const del = await request(app)
      .delete(`/api/webauthn/credentials/${encodeURIComponent(first.body.credential.id)}`)
      .set("Cookie", sessionJar);
    expect(del.status).toBe(200);
  });

  it("registers the SECOND passkey -> ENFORCEMENT ARMS (>=2)", async () => {
    const res = await register(app, sessionJar, authnr2, "phone");
    expect(res.status).toBe(200);
    expect(res.body.enforced).toBe(true);
    expect(res.body.enrolling).toBe(false);

    const status = await request(app).get("/api/auth/status");
    expect(status.body.webauthn).toEqual({ enabled: true, enforced: true, enrolling: false });
  });

  let mfaJar; // pending cookie from the enforced login
  it("ENFORCED: a correct passphrase issues the PENDING cookie, not the session", async () => {
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true, webauthnRequired: true });
    expect(cookieOf(login, SESSION_COOKIE)).toBeNull(); // NO session yet
    mfaJar = cookieOf(login, MFA_COOKIE);
    expect(mfaJar).toBeTruthy();
  });

  it("the pending token can NEVER pass the auth gate (key separation, end-to-end)", async () => {
    const mfaValue = mfaJar.split("=").slice(1).join("=");
    // as the pending cookie itself
    expect((await request(app).get("/api/config").set("Cookie", mfaJar)).status).toBe(401);
    // smuggled into the session cookie slot
    expect(
      (await request(app).get("/api/config").set("Cookie", `${SESSION_COOKIE}=${mfaValue}`)).status,
    ).toBe(401);
    // and it does not open the enrollment surface either
    expect((await request(app).get("/api/webauthn/credentials").set("Cookie", mfaJar)).status).toBe(401);
  });

  it("login/options requires the pending token (no passphrase step -> 401)", async () => {
    expect((await request(app).post("/api/webauthn/login/options")).status).toBe(401);
    expect((await request(app).post("/api/webauthn/login/verify").send({ response: {} })).status).toBe(401);
  });

  let usedAssertion; // kept for the replay test below
  it("full two-step login: assertion ceremony converts the pending cookie into the session", async () => {
    const opt = await request(app).post("/api/webauthn/login/options").set("Cookie", mfaJar);
    expect(opt.status).toBe(200);
    expect(opt.body.challenge).toBeTruthy();
    usedAssertion = assertionResponse(authnr1, { challenge: opt.body.challenge, origin: ORIGIN, counter: 1 });
    const verify = await request(app)
      .post("/api/webauthn/login/verify")
      .set("Cookie", mfaJar)
      .send({ response: usedAssertion });
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ ok: true });
    const session = cookieOf(verify, SESSION_COOKIE);
    expect(session).toBeTruthy();
    // the fresh session opens the gate
    expect((await request(app).get("/api/config").set("Cookie", session)).status).toBe(200);
  });

  it("challenge REUSE is rejected (replaying the exact spent assertion 401s + is recorded)", async () => {
    const before = webauthnAuthLines(dataDir).length;
    const replay = await request(app)
      .post("/api/webauthn/login/verify")
      .set("Cookie", mfaJar)
      .send({ response: usedAssertion });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "second factor failed" });
    expect(webauthnAuthLines(dataDir).length).toBeGreaterThan(before);
  });

  it("COUNTER REGRESSION (cloned-authenticator signal) is rejected + recorded", async () => {
    const before = webauthnAuthLines(dataDir).length;
    const opt = await request(app).post("/api/webauthn/login/options").set("Cookie", mfaJar);
    // authnr1's stored counter is now 1 (advanced by the successful login);
    // a clone reporting counter 1 again must be rejected.
    const cloned = assertionResponse(authnr1, { challenge: opt.body.challenge, origin: ORIGIN, counter: 1 });
    const res = await request(app)
      .post("/api/webauthn/login/verify")
      .set("Cookie", mfaJar)
      .send({ response: cloned });
    expect(res.status).toBe(401);
    const lines = webauthnAuthLines(dataDir);
    expect(lines.length).toBeGreaterThan(before);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({ kind: "auth", event: "login_failed", surface: "webauthn", reason: "bad_assertion" });
  });

  it("an UNKNOWN credential id is rejected + recorded; no credential material in any line", async () => {
    const stranger = createAuthenticator({ rpId: RP_ID });
    const opt = await request(app).post("/api/webauthn/login/options").set("Cookie", mfaJar);
    const res = await request(app)
      .post("/api/webauthn/login/verify")
      .set("Cookie", mfaJar)
      .send({ response: assertionResponse(stranger, { challenge: opt.body.challenge, origin: ORIGIN, counter: 5 }) });
    expect(res.status).toBe(401);
    // NO recorded line ever carries key/signature material or the passphrase.
    const raw = readActivity(dataDir);
    expect(raw).not.toContain(PASSPHRASE);
    expect(raw).not.toContain("publicKey");
    expect(raw).not.toContain("signature");
  });

  it("failed webauthn attempts surface on GET /api/auth/failed-logins (SIM-386 feed)", async () => {
    const res = await request(app).get("/api/auth/failed-logins").set("Cookie", sessionJar);
    expect(res.status).toBe(200);
    const webauthnEvents = res.body.events.filter((e) => e.surface === "webauthn");
    expect(webauthnEvents.length).toBeGreaterThan(0);
    // both the per-failure lines and (once >=3 failures) the threshold line ride the feed
    expect(webauthnEvents.some((e) => e.event === "login_failed" && e.reason === "bad_assertion")).toBe(true);
  });

  it("deleting down to 1 credential is allowed and DROPS BACK to enrollment mode", async () => {
    const del = await request(app)
      .delete(`/api/webauthn/credentials/${encodeURIComponent(cred1Id)}`)
      .set("Cookie", sessionJar);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, enforced: false, enrolling: true });
    // login is passphrase-only again - shrinking below the floor NEVER locks out
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.body).toEqual({ ok: true });
    expect(cookieOf(login, SESSION_COOKIE)).toBeTruthy();
  });

  it("deleting the LAST credential is refused server-side (409, anti-lockout)", async () => {
    const list = await request(app).get("/api/webauthn/credentials").set("Cookie", sessionJar);
    expect(list.body.credentials).toHaveLength(1);
    const lastId = list.body.credentials[0].id;
    const del = await request(app)
      .delete(`/api/webauthn/credentials/${encodeURIComponent(lastId)}`)
      .set("Cookie", sessionJar);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/last passkey/i);
    // and it is still there
    const after = await request(app).get("/api/webauthn/credentials").set("Cookie", sessionJar);
    expect(after.body.credentials).toHaveLength(1);
  });

  it("deleting an unknown credential 404s", async () => {
    const res = await request(app).delete("/api/webauthn/credentials/does-not-exist").set("Cookie", sessionJar);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4b. Challenge EXPIRY (its own app: a 1ms TTL makes expiry deterministic).
// ---------------------------------------------------------------------------
describe("challenge expiry (JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS=1)", () => {
  let app, tmpRoot;
  let sessionJar;
  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_WEBAUTHN: "on",
      JOBHUNT_WEBAUTHN_RPID: RP_ID,
      JOBHUNT_WEBAUTHN_ORIGIN: ORIGIN,
      JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS: "1",
    }));
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    sessionJar = cookieOf(login, SESSION_COOKIE); // 0 credentials -> enrollment mode
  });
  afterAll(() => {
    cleanupEnv();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("an expired registration challenge is rejected", async () => {
    const opt = await request(app).post("/api/webauthn/register/options").set("Cookie", sessionJar);
    await new Promise((r) => setTimeout(r, 10)); // > 1ms TTL
    const auth = createAuthenticator({ rpId: RP_ID });
    const att = attestationResponse(auth, { challenge: opt.body.challenge, origin: ORIGIN });
    const res = await request(app)
      .post("/api/webauthn/register/verify")
      .set("Cookie", sessionJar)
      .send({ response: att, label: "late" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/challenge/i);
    // and nothing was stored
    const list = await request(app).get("/api/webauthn/credentials").set("Cookie", sessionJar);
    expect(list.body.credentials).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Rate limiting on the assertion lane (same knobs as the login limiter),
// with the 429s feeding the monitor as surface:"webauthn" rate_limited.
// ---------------------------------------------------------------------------
describe("webauthn assertion lane rate limiting (JOBHUNT_AUTH_RATELIMIT_MAX=3)", () => {
  let app, tmpRoot, dataDir;
  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot, dataDir } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_WEBAUTHN: "on",
      JOBHUNT_WEBAUTHN_RPID: RP_ID,
      JOBHUNT_WEBAUTHN_ORIGIN: ORIGIN,
      JOBHUNT_AUTH_RATELIMIT_MAX: "3",
    }));
  });
  afterAll(() => {
    cleanupEnv();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("fires a 429 after the configured cap and records rate_limited under surface webauthn", async () => {
    let last;
    for (let i = 0; i < 4; i++) {
      last = await request(app).post("/api/webauthn/login/verify").send({ response: {} });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: "too many login attempts, try again later" });
    const lines = webauthnAuthLines(dataDir);
    expect(lines.some((l) => l.reason === "rate_limited" && l.surface === "webauthn")).toBe(true);
  });
});
