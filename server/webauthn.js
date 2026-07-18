// Feature-flagged WebAuthn/passkey SECOND factor for the private instance
// (SIM-394; TIER-0 auth code, guardian-reviewed before deploy).
//
// Design contract (mirrors ADR-024's flag discipline and the SIM-386 no-op
// standard; break-glass + runbook in DEPLOYMENT.md, storage in data-schema.md
// section 2.12):
//   - DEFAULT OFF. JOBHUNT_WEBAUTHN absent/off => resolveWebauthn returns
//     {enabled:false}, index.js wires NOTHING, and the app is byte-identical to
//     current behavior: no /api/webauthn/* endpoint exists, POST /api/auth/login
//     issues the session on the passphrase alone, and the /api/auth/status body
//     is unchanged. Pinned by tests/webauthn-endpoints.test.js.
//   - The PASSPHRASE STAYS THE FIRST FACTOR, unchanged. WebAuthn is only ever a
//     second step after verifyPassphrase succeeds.
//   - ANTI-LOCKOUT CORE (the >=2 rule): enforcement refuses to arm below
//     MIN_CREDENTIALS_FOR_ENFORCEMENT stored credentials. JOBHUNT_WEBAUTHN=on
//     with <2 credentials is ENROLLMENT MODE - a correct passphrase issues the
//     full session exactly as with the flag off (the UI nags to finish
//     enrollment); only at >=2 credentials does login switch to the two-step
//     flow. Deleting the last credential while the flag is on is refused
//     server-side (409), so the store can never be emptied under an armed flag.
//   - Break-glass is the env flip: JOBHUNT_WEBAUTHN=off restores passphrase-only
//     login with zero migration (the credential rows are inert while off).
//   - rpID/origin come from env (JOBHUNT_WEBAUTHN_RPID / _ORIGIN), never
//     hardcoded; the flag on with either missing fails the boot loudly, as does
//     the misconfig "second factor without a first" (auth disabled).
//
// STATELESS-SESSION DEPARTURE (documented deliberately): ceremony challenges are
// held in a SERVER-SIDE in-memory TTL map, unlike the app's stateless
// HMAC-cookie sessions. A WebAuthn challenge is single-use, must be unpredictable
// and must be consumed by the verify step, so a server-held nonce is the correct
// primitive; signing it into a cookie would allow replay within its TTL. The map
// is bounded (MAX_PENDING_CHALLENGES) and entries expire (default 2 min). STATED
// ASSUMPTION: the private instance runs as a SINGLE process/instance (true on
// Railway today) - a multi-instance deployment would need a shared challenge
// store, and a restart mid-ceremony just means retrying the login.
//
// Everything here is pure/importable so tests exercise it without a socket.

import crypto from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
  verifySession,
  signSession,
  sessionCookieOptions,
  isSecureRequest,
  createLoginLimiter,
  createFailedLoginMonitor,
} from "./auth.js";

// The short-lived "passphrase ok, passkey pending" cookie (the mid-login state).
export const MFA_COOKIE = "jobhunt_mfa";
export const MFA_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the second step
export const CHALLENGE_TTL_MS = 2 * 60 * 1000; // default ceremony challenge lifetime
export const MAX_PENDING_CHALLENGES = 100; // hard bound on the in-memory map
// The anti-lockout floor: enforcement never arms below this many credentials.
export const MIN_CREDENTIALS_FOR_ENFORCEMENT = 2;
export const CREDENTIAL_LABEL_MAX = 64;
// Single-owner app: one fixed WebAuthn user identity.
export const OWNER_USER = { id: "owner", name: "owner", displayName: "Owner" };

// ---- flag resolution (pure, fail-loud) -------------------------------------
// Strict parse, same posture as APP_MODE: on|1|true => on; off|0|false|"" =>
// off; anything else throws so a typo can never silently disable the second
// factor an operator believes is armed.
export function resolveWebauthn({ env = {}, auth = null } = {}) {
  const raw = String(env.JOBHUNT_WEBAUTHN || "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "false") {
    return { enabled: false };
  }
  if (raw !== "on" && raw !== "1" && raw !== "true") {
    const e = new Error(
      `JOBHUNT_WEBAUTHN must be "on" or "off" (got ${JSON.stringify(raw)})`,
    );
    e.code = "WEBAUTHN_MISCONFIGURED";
    throw e;
  }
  if (!auth || !auth.enabled) {
    const e = new Error(
      "JOBHUNT_WEBAUTHN=on requires auth to be enabled (a second factor needs a first: " +
        "set JOBHUNT_AUTH_HASH / auth.json, or turn the flag off)",
    );
    e.code = "WEBAUTHN_MISCONFIGURED";
    throw e;
  }
  const rpID = (env.JOBHUNT_WEBAUTHN_RPID || "").trim();
  const origin = (env.JOBHUNT_WEBAUTHN_ORIGIN || "").trim();
  if (!rpID || !origin) {
    const e = new Error(
      "JOBHUNT_WEBAUTHN=on requires JOBHUNT_WEBAUTHN_RPID and JOBHUNT_WEBAUTHN_ORIGIN " +
        "(the private instance's domain + https origin - never hardcoded)",
    );
    e.code = "WEBAUTHN_MISCONFIGURED";
    throw e;
  }
  const challengeTtlMs =
    Number(env.JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS) > 0
      ? Math.floor(Number(env.JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS))
      : CHALLENGE_TTL_MS;
  return {
    enabled: true,
    rpID,
    origin,
    rpName: (env.JOBHUNT_WEBAUTHN_RPNAME || "").trim() || "Jobhunt Command Center",
    challengeTtlMs,
  };
}

// ---- MFA pending token (pure) ----------------------------------------------
// Signed with a key DERIVED from the session secret via a distinct HMAC context,
// so a pending token can NEVER pass verifySession at the auth gate (and a session
// token can never pass the pending check). Same token format as sessions
// (payload.exp + HMAC-SHA256), reusing the timing-safe verifier.
export function deriveMfaSecret(secret) {
  return crypto
    .createHmac("sha256", "jobhunt/webauthn-mfa-pending/v1")
    .update(String(secret))
    .digest("hex");
}
export function signMfaToken(secret, { exp } = {}) {
  return signSession(deriveMfaSecret(secret), { exp });
}
export function verifyMfaToken(secret, token, now = Date.now()) {
  return verifySession(deriveMfaSecret(secret), token, now);
}

// ---- server-held single-use ceremony challenges ----------------------------
// remember(challenge, type) after generating options; take(challenge, type)
// exactly once at verify - a second take (replay), an expired entry, or a
// type-mismatch (registration challenge answered on the login lane) all fail.
export function createChallengeStore({ ttlMs = CHALLENGE_TTL_MS, now = Date.now, max = MAX_PENDING_CHALLENGES } = {}) {
  const pending = new Map(); // challenge -> { type, expiresAt }

  function sweep(t) {
    for (const [k, v] of pending) {
      if (v.expiresAt <= t) pending.delete(k);
    }
  }

  return {
    remember(challenge, type) {
      const t = now();
      sweep(t);
      pending.set(String(challenge), { type, expiresAt: t + ttlMs });
      // Bounded by construction (checked AFTER the insert): beyond the cap,
      // evict oldest-inserted first so an options-endpoint flood can never
      // grow this map without limit.
      while (pending.size > max) {
        pending.delete(pending.keys().next().value);
      }
    },
    // Single-use: the entry is deleted on ANY take attempt that finds it.
    take(challenge, type) {
      const t = now();
      const rec = pending.get(String(challenge));
      if (!rec) return false;
      pending.delete(String(challenge));
      return rec.type === type && rec.expiresAt > t;
    },
    size() {
      return pending.size;
    },
  };
}

// ---- enforcement state (pure over the store) -------------------------------
// The exact anti-lockout semantics, in one place:
//   flag off                     -> nothing exists (routes not registered)
//   flag on, credentials <  2    -> ENROLLMENT MODE (enforced:false, enrolling:true)
//   flag on, credentials >= 2    -> ENFORCED (two-step login)
export function enforcementState(webauthn, store) {
  if (!webauthn || !webauthn.enabled) return { enabled: false, enforced: false, enrolling: false, credentials: 0 };
  const credentials = store.countWebauthnCredentials();
  const enforced = credentials >= MIN_CREDENTIALS_FOR_ENFORCEMENT;
  return { enabled: true, enforced, enrolling: !enforced, credentials };
}

// Display-only label: string, trimmed, bounded, control chars stripped.
export function sanitizeLabel(raw) {
  if (typeof raw !== "string") return "passkey";
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, CREDENTIAL_LABEL_MAX);
  return clean || "passkey";
}

// The whitelisted credential shape served to the client (never publicKey/counter).
export function toCredentialMeta(c) {
  return { id: c.id, label: c.label || "passkey", created: c.created || null, transports: Array.isArray(c.transports) ? c.transports : [] };
}

// Pull the base64url challenge out of a ceremony response's clientDataJSON so
// the verify step can look it up in the challenge store. Tolerant: any
// malformed input -> null (the caller rejects).
export function challengeOfResponse(response) {
  try {
    const cd = JSON.parse(
      Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"),
    );
    return typeof cd.challenge === "string" ? cd.challenge : null;
  } catch {
    return null;
  }
}

// ---- the login-route adapter (what auth.js sees) ---------------------------
// installAuthRoutes takes this OBJECT (default null = flag off = byte-identical
// login/status/logout) instead of importing this module - keeps auth.js free of
// any webauthn import so the flag-off dependency graph is unchanged.
export function createSecondFactorGate({ webauthn, auth, store }) {
  return {
    // Is the second factor required RIGHT NOW? (the >=2 rule, live per request)
    required() {
      return enforcementState(webauthn, store).enforced;
    },
    // Passphrase verified but a passkey is still owed: set the short-lived
    // pending cookie instead of the session cookie.
    issuePending(req, res) {
      const token = signMfaToken(auth.secret, { exp: Date.now() + MFA_TTL_MS });
      res.cookie(MFA_COOKIE, token, sessionCookieOptions(req, MFA_TTL_MS));
    },
    clearPending(req, res) {
      res.clearCookie(MFA_COOKIE, {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureRequest(req),
        path: "/",
      });
    },
    // Extra fields /api/auth/status carries while the flag is on (absent when
    // off - the byte-identical guarantee).
    statusFields() {
      const s = enforcementState(webauthn, store);
      return { webauthn: { enabled: true, enforced: s.enforced, enrolling: s.enrolling } };
    },
  };
}

// ---- routes ----------------------------------------------------------------
// Registered by index.js ONLY when webauthn.enabled (flag off -> none of these
// paths exist). All are registered BEFORE the auth gate, so each route carries
// its own explicit auth (same pattern as GET /api/auth/failed-logins):
//   - register/options, register/verify, credentials GET/DELETE: a FULL session
//     (you must be logged in with the passphrase to touch enrollment).
//   - login/options, login/verify: a valid MFA PENDING token (passphrase already
//     verified this attempt) - and both are rate-limited like the login route,
//     with failures feeding the SIM-386 monitor under surface:"webauthn".
export function installWebauthnRoutes(app, { auth, webauthn, store, env = process.env } = {}) {
  const challenges = createChallengeStore({ ttlMs: webauthn.challengeTtlMs });
  const monitor = createFailedLoginMonitor({
    store,
    env,
    surface: "webauthn",
    defaultReason: "bad_assertion",
  });
  const limiter = createLoginLimiter(env, {
    onLimited: (req) => monitor.record(req, "rate_limited"),
  });
  const gate = createSecondFactorGate({ webauthn, auth, store });

  const hasSession = (req) =>
    verifySession(auth.secret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  const hasPending = (req) =>
    verifyMfaToken(auth.secret, parseCookies(req.headers.cookie)[MFA_COOKIE]);
  const denySession = (res) => res.status(401).json({ error: "authentication required" });
  // One uniform failure for the assertion lane: no oracle distinguishing
  // unknown-credential / expired-challenge / bad-signature to an attacker.
  const denyAssertion = (req, res, recordFailure = true) => {
    if (recordFailure) monitor.record(req, "bad_assertion");
    return res.status(401).json({ error: "second factor failed" });
  };

  // -- enrollment: create the registration challenge (session-authed) --------
  app.post("/api/webauthn/register/options", async (req, res) => {
    if (!hasSession(req)) return denySession(res);
    const creds = store.listWebauthnCredentials();
    const options = await generateRegistrationOptions({
      rpName: webauthn.rpName,
      rpID: webauthn.rpID,
      userID: new TextEncoder().encode(OWNER_USER.id),
      userName: OWNER_USER.name,
      userDisplayName: OWNER_USER.displayName,
      attestationType: "none", // no attestation chain wanted - single-owner enrollment over an authed session
      excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    challenges.remember(options.challenge, "registration");
    res.json(options);
  });

  // -- enrollment: verify + persist the new credential (session-authed) ------
  app.post("/api/webauthn/register/verify", async (req, res) => {
    if (!hasSession(req)) return denySession(res);
    const response = req.body && req.body.response;
    if (!response || typeof response !== "object") {
      return res.status(400).json({ error: "response is required" });
    }
    const challenge = challengeOfResponse(response);
    if (!challenge || !challenges.take(challenge, "registration")) {
      return res.status(400).json({ error: "challenge expired or unknown - restart enrollment" });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: webauthn.origin,
        expectedRPID: webauthn.rpID,
        requireUserVerification: false,
      });
    } catch {
      return res.status(400).json({ error: "registration verification failed" });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "registration verification failed" });
    }
    const { credential } = verification.registrationInfo;
    let rec;
    try {
      rec = store.createWebauthnCredential({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports:
          (Array.isArray(response.response && response.response.transports) &&
            response.response.transports) ||
          credential.transports ||
          [],
        label: sanitizeLabel(req.body.label),
      });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.message });
    }
    const s = enforcementState(webauthn, store);
    res.json({ ok: true, credential: toCredentialMeta(rec), enforced: s.enforced, enrolling: s.enrolling });
  });

  // -- enrollment surface: list (whitelisted meta only; session-authed) ------
  app.get("/api/webauthn/credentials", (req, res) => {
    if (!hasSession(req)) return denySession(res);
    const s = enforcementState(webauthn, store);
    res.json({
      credentials: store.listWebauthnCredentials().map(toCredentialMeta),
      enforced: s.enforced,
      enrolling: s.enrolling,
      minCredentials: MIN_CREDENTIALS_FOR_ENFORCEMENT,
    });
  });

  // -- enrollment surface: delete-by-id, with the last-credential guard ------
  // Refusing to delete the LAST credential while the flag is on is the server-
  // side half of the anti-lockout rule (the client mirrors it): 2 -> 1 is
  // allowed (drops back to enrollment mode, passphrase-only login still works);
  // 1 -> 0 under an armed flag is refused. Turning the flag off (break-glass)
  // removes these routes entirely, at which point the rows are inert anyway.
  app.delete("/api/webauthn/credentials/:id", (req, res) => {
    if (!hasSession(req)) return denySession(res);
    const id = String(req.params.id || "");
    const existing = store.getWebauthnCredential(id);
    if (!existing) return res.status(404).json({ error: "credential not found" });
    if (store.countWebauthnCredentials() <= 1) {
      return res.status(409).json({
        error:
          "refusing to delete the last passkey while JOBHUNT_WEBAUTHN=on - " +
          "add another passkey first, or break-glass with JOBHUNT_WEBAUTHN=off",
      });
    }
    store.deleteWebauthnCredential(id);
    const s = enforcementState(webauthn, store);
    res.json({ ok: true, enforced: s.enforced, enrolling: s.enrolling });
  });

  // -- login step 2: assertion options (pending-token-authed, rate-limited) --
  app.post("/api/webauthn/login/options", limiter, async (req, res) => {
    if (!hasPending(req)) return denyAssertion(req, res, false); // no pending passphrase step - not a failed assertion
    const creds = store.listWebauthnCredentials();
    const options = await generateAuthenticationOptions({
      rpID: webauthn.rpID,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
      userVerification: "preferred",
    });
    challenges.remember(options.challenge, "authentication");
    res.json(options);
  });

  // -- login step 2: verify the assertion -> issue the REAL session ----------
  app.post("/api/webauthn/login/verify", limiter, async (req, res) => {
    if (!hasPending(req)) return denyAssertion(req, res, false);
    const response = req.body && req.body.response;
    if (!response || typeof response !== "object") return denyAssertion(req, res);
    const cred = store.getWebauthnCredential(String(response.id || ""));
    if (!cred) return denyAssertion(req, res);
    const challenge = challengeOfResponse(response);
    // Single-use take: an expired challenge or a REUSED one (replay) fails here.
    if (!challenge || !challenges.take(challenge, "authentication")) {
      return denyAssertion(req, res);
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: webauthn.origin,
        expectedRPID: webauthn.rpID,
        credential: {
          id: cred.id,
          publicKey: Buffer.from(cred.publicKey, "base64url"),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: false,
      });
    } catch {
      // Includes the library's own counter-regression throw - recorded + 401.
      return denyAssertion(req, res);
    }
    if (!verification.verified) return denyAssertion(req, res);
    const newCounter = verification.authenticationInfo.newCounter;
    // Belt-and-braces counter check (the library also enforces this): a counter
    // that fails to advance while counters are in use is the cloned-
    // authenticator signal - reject and record it.
    if ((cred.counter > 0 || newCounter > 0) && newCounter <= cred.counter) {
      return denyAssertion(req, res);
    }
    store.updateWebauthnCredentialCounter(cred.id, newCounter);
    // Both factors done: swap the pending cookie for the real session cookie.
    const token = signSession(auth.secret, { exp: Date.now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));
    gate.clearPending(req, res);
    res.json({ ok: true });
  });

  return { monitor, challenges };
}
