// Feature-flagged app-level auth for the jobhunt file bridge (SIM-85 / RC-1).
//
// Design contract (see ADR-024 in docs/governance.md):
//   - DEFAULT OFF. With no passphrase hash configured and JOBHUNT_AUTH unset,
//     resolveAuth() returns {enabled:false} and index.js wires NOTHING - the app
//     behaves byte-identically to the historical loopback-dev posture. This is
//     the "auth off = today's behavior" regression guarantee.
//   - Turns ON when a hash is present (JOBHUNT_AUTH_HASH env, or an auth.json
//     written OUTSIDE the git tree under DATA_DIR by ops/auth-setup.mjs) or when
//     JOBHUNT_AUTH=required. JOBHUNT_AUTH=off force-disables (escape hatch).
//   - Sessions are STATELESS, HMAC-SHA256-signed cookies (no session store, no
//     extra dependency). The signing secret lives beside the hash, out of git;
//     an env-only deployment with no secret derives a stable one from the hash
//     so tokens survive restarts. Logout clears the cookie (no server denylist -
//     acceptable for a single-operator app; noted in the ADR).
//   - The load-bearing write path, the board stores, and the DATA_DIR seam are
//     untouched: this module only gates HTTP requests before they reach routes.
//
// Everything here is pure/importable so tests exercise it without a socket.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import rateLimit from "express-rate-limit";

export const SESSION_COOKIE = "jobhunt_sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// helmet CSP tuned for the BUILT Vite bundle: hashed JS/CSS are same-origin
// ('self'); Vite/marked emit some inline styles and data: images, so style-src
// allows 'unsafe-inline' and img/font-src allow data:. No remote origins - the
// app is fully self-contained, matching the "data never leaves the box" contract.
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
};

// ---- security-headers hardening (pure, testable) --------------------------
// G10 (RC-4): browser/transport hardening is DECOUPLED from auth so it lands on
// EVERY deployment surface - local loopback (harmless), private cloud (auth on),
// and the PUBLIC DEMO (auth off but internet-facing, where it is essential and was
// previously absent because helmet was gated on auth.enabled). Only the
// CROSS-ORIGIN ISOLATION headers (COOP/CORP) stay OFF: they would break the on-box
// fleet's legitimate cross-origin reads (the original reason helmet was auth-gated)
// and are NOT part of the demo threat model - which is XSS (-> CSP), clickjacking
// (-> frame-ancestors 'none' + X-Frame-Options DENY) and MIME-sniff (-> nosniff).

// True when a TLS terminator sits in front, so HSTS becomes meaningful. Either an
// explicit JOBHUNT_TLS truthy flag, or the JOBHUNT_TRUST_PROXY opt-in a cloud TLS
// front sets. On plain loopback (neither set) HSTS is omitted so we never pin
// localhost to https.
export function isBehindTls(env = {}) {
  const tls = String(env.JOBHUNT_TLS || "").trim().toLowerCase();
  if (tls === "1" || tls === "true" || tls === "on" || tls === "yes") return true;
  const tp = String(env.JOBHUNT_TRUST_PROXY || "").trim().toLowerCase();
  return tp !== "" && tp !== "0" && tp !== "false";
}

// Build the helmet options. Pure so tests assert the posture without a socket.
// CSP uses the Vite-proven directives (preserved verbatim); frame protection is
// DENY (stricter than helmet's SAMEORIGIN default) and mirrored by frameAncestors
// 'none' in the CSP; COOP/CORP are disabled (on-box cross-origin reads); HSTS is
// applied only under TLS.
export function buildHelmetOptions({ behindTls = false } = {}) {
  return {
    contentSecurityPolicy: { directives: CSP_DIRECTIVES },
    frameguard: { action: "deny" },
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: behindTls ? { maxAge: 15552000, includeSubDomains: true } : false,
  };
}

// ---- auth config resolution (pure) ----------------------------------------

// Read <dataDir>/auth.json if present. Returns the parsed record only when it
// carries a non-empty hash; any read/parse failure (absent file, bad JSON) is
// treated as "no file auth" so a missing config never crashes boot.
export function loadAuthFile(dataDir) {
  if (!dataDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, "auth.json"), "utf8"));
    if (j && typeof j.hash === "string" && j.hash.trim()) return j;
  } catch {
    /* absent / unreadable / malformed -> no file auth */
  }
  return null;
}

// Deterministically derive a session-signing secret from the passphrase hash so
// a 12-factor deployment that sets only JOBHUNT_AUTH_HASH (no explicit secret)
// still issues STABLE tokens across restarts. The hash is itself a secret value
// (never sent to clients), so this is a reasonable KDF input.
export function deriveSecret(hash) {
  return crypto
    .createHmac("sha256", "jobhunt/session-secret/v1")
    .update(String(hash))
    .digest("hex");
}

// Resolve the effective auth posture. Precedence for the hash: env
// JOBHUNT_AUTH_HASH > auth.json under dataDir. Throws (fail-loud) only on the
// genuine misconfig JOBHUNT_AUTH=required-with-nothing-to-check-against.
export function resolveAuth({ env = {}, dataDir } = {}) {
  const mode = String(env.JOBHUNT_AUTH || "").toLowerCase();
  if (mode === "off") {
    return { enabled: false, reason: "disabled by JOBHUNT_AUTH=off" };
  }
  const envHash = env.JOBHUNT_AUTH_HASH && env.JOBHUNT_AUTH_HASH.trim();
  const file = loadAuthFile(dataDir);
  const hash = envHash || (file && file.hash) || null;

  if (mode === "required" && !hash) {
    const err = new Error(
      "JOBHUNT_AUTH=required but no passphrase hash configured " +
        "(set JOBHUNT_AUTH_HASH or run `node ops/auth-setup.mjs`)",
    );
    err.code = "AUTH_MISCONFIGURED";
    throw err;
  }
  if (!hash) {
    return { enabled: false, reason: "no hash configured (loopback dev default)" };
  }
  const secret =
    (env.JOBHUNT_AUTH_SECRET && env.JOBHUNT_AUTH_SECRET.trim()) ||
    (file && file.secret) ||
    deriveSecret(hash);
  return { enabled: true, hash, secret, source: envHash ? "env" : "file" };
}

// ---- CORS allowlist parsing (pure) ----------------------------------------
// Default (unset/empty) => [] => index.js emits NO CORS headers, preserving the
// deliberate no-CORS posture (t-1783186106119). Only an explicit, operator-set
// allowlist opts specific cross-origin cloud clients back in.
export function parseCorsOrigins(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- stateless signed session tokens (pure) -------------------------------

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

// token = base64url(JSON{exp}) + "." + base64url(HMAC-SHA256(payload)).
export function signSession(secret, { exp } = {}) {
  const payload = b64url(JSON.stringify({ exp }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// Verify signature (timing-safe) AND expiry. Any malformed input -> false.
export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  return !!data && typeof data.exp === "number" && data.exp > now;
}

// ---- cookie helpers (pure) -------------------------------------------------
// Read cookies without pulling in cookie-parser (setting cookies uses Express's
// built-in res.cookie, which needs no dependency).
export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw value if it is not valid percent-encoding */
    }
    out[k] = v;
  }
  return out;
}

// Secure cookie flag only over TLS: req.secure, or a trusted X-Forwarded-Proto
// (honoured only when `trust proxy` is set, which index.js does on explicit opt-in).
export function isSecureRequest(req) {
  if (req && req.secure) return true;
  const xf = req && req.headers && req.headers["x-forwarded-proto"];
  return typeof xf === "string" && xf.split(",")[0].trim() === "https";
}

export function sessionCookieOptions(req, ttlMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
    maxAge: ttlMs,
  };
}

// ---- passphrase verification ----------------------------------------------
// Never logs the passphrase; a malformed hash or bad input yields false, never a throw.
export async function verifyPassphrase(hash, passphrase) {
  if (typeof passphrase !== "string" || !passphrase) return false;
  try {
    return await argon2.verify(hash, passphrase);
  } catch {
    return false;
  }
}

// ---- rate limiter for the login route -------------------------------------
// Defaults: 10 attempts / 15 min per IP. Env-overridable so a test can drive the
// 429 cheaply and an operator can retune without a code change. `onLimited`
// (SIM-386) lets the failed-login monitor count attempts the limiter swallows -
// a brute-forcer who has hit the cap is STILL a failed-login signal, so those
// 429s must not go dark. The 429 body is unchanged (pinned by auth.test.js).
export function createLoginLimiter(env = process.env, { onLimited = null } = {}) {
  const max = Number(env.JOBHUNT_AUTH_RATELIMIT_MAX) || 10;
  const windowMs = Number(env.JOBHUNT_AUTH_RATELIMIT_WINDOW_MS) || 15 * 60 * 1000;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      if (onLimited) {
        try {
          onLimited(req);
        } catch {
          /* visibility is telemetry - never let it break the 429 */
        }
      }
      res.status(429).json({ error: "too many login attempts, try again later" });
    },
  });
}

// ---- demo write rate limiter (SIM-388) --------------------------------------
// The public demo is intentionally writable with auth OFF, which made its write
// routes an unthrottled anonymous write surface (the SIM-392 load probe put 150
// rapid POST /api/tasks through with zero 429s). This limiter caps WRITE verbs
// (POST/PUT/PATCH/DELETE) per IP per minute; reads are NEVER limited (skip), so
// browsing the demo stays unthrottled. Mounted by index.js ONLY in demo mode -
// the real instance's writes sit behind the auth gate + login limiter already,
// and double-limiting an authenticated owner would be a regression.
//
// IP extraction rides the SAME trust decision as the login limiter: index.js
// sets Express `trust proxy` from the explicit JOBHUNT_TRUST_PROXY opt-in, so
// req.ip (the limiter's default key) is the X-Forwarded-For CLIENT address only
// behind the declared terminator and the raw socket peer otherwise - never a
// raw XFF read.
//
// Defaults: 60 writes / 1 min per IP. Env-overridable so a test can drive the
// 429 cheaply and an operator can retune without a code change. The 429 body is
// pinned by tests/demo-write-limit.test.js.
export const DEMO_WRITE_LIMIT_BODY = {
  error: "demo rate limit: too many writes from this address - try again in a minute",
};
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createDemoWriteLimiter(env = process.env) {
  const max = Number(env.JOBHUNT_DEMO_WRITE_RATELIMIT_MAX) || 60;
  const windowMs = Number(env.JOBHUNT_DEMO_WRITE_RATELIMIT_WINDOW_MS) || 60 * 1000;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Reads (GET/HEAD/OPTIONS) are never limited AND never counted.
    skip: (req) => !WRITE_METHODS.has(req.method),
    handler: (req, res) => {
      res.status(429).json(DEMO_WRITE_LIMIT_BODY);
    },
  });
}

// ---- failed-login visibility (SIM-386, guardian RR-1) -----------------------
// Every failed login attempt (bad passphrase AND rate-limited) is recorded three
// ways, none of which ever carries credential material:
//   1. stdout - one structured line per failure (the always-on Railway log stream).
//   2. the durable activity log via store.appendActivity (kind:"auth" lines; the
//      seam stamps ts and works identically on FileStore and PgStore).
//   3. the notification bell - when failures cross the threshold inside one
//      window the monitor appends ONE extra "login_failures_threshold" line,
//      which index.js's feed derivation folds into a single login_failed
//      notification per window (no notify-spam).
// The event is built ONLY from the whitelisted fields below - never from
// req.body - so the attempted passphrase can never leak into any record.

export const FAILED_LOGIN_ALERT_THRESHOLD = 3; // failures per window before the bell fires
export const FAILED_LOGIN_FEED_CAP = 50;
// Guardian condition 1 (SIM-386 review, 2026-07-17): durable appendActivity
// calls are BOUNDED per window. Without this, every post-rate-limit request
// appended a permanent activity_log row - an unbounded, unauthenticated,
// attacker-controlled write primitive into a never-deletes store on a public
// domain. Cap = the login limiter's default max (10) + margin; beyond it the
// in-memory rolling counter and the threshold latch keep counting EXACTLY
// (the bell count stays true via the live snapshot overlay in index.js), but
// nothing further is persisted for that window.
export const FAILED_LOGIN_DURABLE_CAP = 20;
// Beyond the durable cap, stdout keeps a SAMPLED heartbeat (every Nth failure,
// with the true count in the line) instead of one line per request - the
// platform log stream stays an always-on record without becoming a flood amp.
export const FAILED_LOGIN_STDOUT_SAMPLE = 10;

// Proxy-aware client IP. index.js sets Express `trust proxy` from the explicit
// JOBHUNT_TRUST_PROXY opt-in (Railway sets it to 1 hop), so req.ip is already
// the X-Forwarded-For CLIENT address behind the platform proxy and the raw
// socket peer on plain loopback - the same trust decision the rate limiter
// keys on. Never read X-Forwarded-For directly here: without the trust-proxy
// opt-in that header is attacker-controlled.
export function clientIp(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || "";
  return String(ip).slice(0, 64) || "unknown";
}

function userAgentOf(req) {
  const ua = req && req.headers && req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 200) : "";
}

// Stateful per-process monitor. Window semantics: the FIRST failure opens a
// window; failures accumulate until the window expires, then the next failure
// opens a fresh one. The threshold line is appended exactly once per window
// (the `alerted` latch), so the derived notification cannot spam. In-memory by
// design - the durable per-failure lines live in the activity log regardless,
// so a restart only resets the alert latch, never the record.
//
// Guardian condition 1: durable writes are CAPPED per window (durableCap; at
// most durableCap login_failed lines + the one threshold line per window can
// ever reach the store, no matter how many requests arrive). The rolling count
// and the threshold latch are untouched by the cap - snapshot() exposes the
// TRUE current-window count so the bell stays accurate beyond it.
//
// `surface` / `defaultReason` / `windowMs` options let OTHER token-auth lanes
// (the SIM-393 sync surface) reuse this exact bounded pipeline instead of
// growing their own unbounded one: their lines carry surface:"sync" and
// reason:"bad_token" but flow through the same cap, latch, and feed.
export function createFailedLoginMonitor({
  store = null,
  env = process.env,
  now = Date.now,
  log = console.warn,
  surface = null,
  defaultReason = "bad_passphrase",
  windowMs: windowMsOverride = null,
  durableCap = FAILED_LOGIN_DURABLE_CAP,
} = {}) {
  const threshold = Number(env.JOBHUNT_AUTH_ALERT_THRESHOLD) || FAILED_LOGIN_ALERT_THRESHOLD;
  const windowMs = windowMsOverride || Number(env.JOBHUNT_AUTH_RATELIMIT_WINDOW_MS) || 15 * 60 * 1000;
  let windowStartMs = -Infinity;
  let count = 0;
  let alerted = false;

  function record(req, reason) {
    const t = now();
    if (t - windowStartMs >= windowMs) {
      windowStartMs = t;
      count = 0;
      alerted = false;
    }
    count += 1;
    const windowStart = new Date(windowStartMs).toISOString();
    const durable = count <= durableCap; // guardian condition 1: bounded persistence
    // Whitelisted fields ONLY - timestamp (seam-stamped), source, agent, counts.
    // No req.body access anywhere in this function: no credential material.
    const evt = {
      kind: "auth",
      event: "login_failed",
      reason: reason === "rate_limited" ? "rate_limited" : defaultReason,
      ...(surface ? { surface } : {}),
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      count,
      windowStart,
    };
    if (store && durable) store.appendActivity(evt); // best-effort by contract; both backends
    if (durable || count % FAILED_LOGIN_STDOUT_SAMPLE === 0) {
      log(`[jobhunt] auth: FAILED LOGIN ${JSON.stringify({ ts: new Date(t).toISOString(), ...evt, durable })}`);
    }
    let thresholdCrossed = false;
    if (!alerted && count >= threshold) {
      alerted = true;
      thresholdCrossed = true;
      // Exactly once per window (the latch), so this line is bounded by construction.
      const alert = {
        kind: "auth",
        event: "login_failures_threshold",
        ...(surface ? { surface } : {}),
        count,
        threshold,
        windowMs,
        windowStart,
      };
      if (store) store.appendActivity(alert);
      log(`[jobhunt] auth: FAILED-LOGIN THRESHOLD CROSSED ${JSON.stringify({ ts: new Date(t).toISOString(), ...alert })}`);
    }
    return { ...evt, thresholdCrossed, durable };
  }

  // The TRUE in-memory state of the current (or last-active) window - what the
  // durable log cannot say beyond the cap. index.js overlays this onto the
  // notification fold so the bell count stays exact during a flood.
  function snapshot() {
    if (count === 0) return null;
    return { windowStart: new Date(windowStartMs).toISOString(), count, alerted };
  }

  return { record, snapshot, threshold, windowMs, durableCap };
}

// Pure read-side fold for GET /api/auth/failed-logins: the kind:"auth" lines out
// of the raw activity-log text, newest-first, capped. Tolerant of torn lines
// (same posture as every other activity-log consumer).
export function parseFailedLogins(rawText, cap = FAILED_LOGIN_FEED_CAP) {
  const out = [];
  for (const line of String(rawText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.kind === "auth" && (r.event === "login_failed" || r.event === "login_failures_threshold")) {
        out.push(r);
      }
    } catch {
      /* skip a torn line */
    }
  }
  out.reverse(); // append-only log -> reverse = newest-first
  return out.slice(0, cap);
}

// ---- routes + gate ---------------------------------------------------------

// Paths reachable WITHOUT a session so the login flow itself works.
export function isAuthOpenPath(reqPath) {
  return (
    reqPath === "/api/auth/login" ||
    reqPath === "/api/auth/logout" ||
    reqPath === "/api/auth/status"
  );
}

// Register the login (rate-limited) / logout / status endpoints. Must be mounted
// AFTER express.json (login reads a JSON body) and BEFORE the gate. `store`
// (SIM-386) is the storage seam the failed-login monitor records through; when
// absent the monitor still logs to stdout but persists nothing.
// `secondFactor` (SIM-394) is the OPTIONAL WebAuthn second-factor adapter built
// by server/webauthn.js createSecondFactorGate. Default null = the flag is off =
// every handler below is BYTE-IDENTICAL to its pre-SIM-394 body (the no-op
// guarantee); auth.js deliberately does NOT import webauthn.js, so the flag-off
// dependency graph is unchanged too.
export function installAuthRoutes(app, auth, env = process.env, { store = null, secondFactor = null } = {}) {
  const monitor = createFailedLoginMonitor({ store, env });
  const limiter = createLoginLimiter(env, {
    onLimited: (req) => monitor.record(req, "rate_limited"),
  });

  app.post("/api/auth/login", limiter, async (req, res) => {
    const ok = await verifyPassphrase(auth.hash, req.body && req.body.passphrase);
    if (!ok) {
      monitor.record(req, "bad_passphrase");
      return res.status(401).json({ error: "invalid passphrase" });
    }
    // SIM-394: when the WebAuthn flag is on AND >=2 passkeys are enrolled
    // (secondFactor.required() - the anti-lockout rule lives in webauthn.js),
    // a correct passphrase does NOT issue the session; it issues the short-
    // lived pending cookie and tells the client a passkey step is owed. Below
    // the 2-credential floor (enrollment mode) and with the flag off, this
    // branch never runs and login behaves exactly as before.
    if (secondFactor && secondFactor.required()) {
      secondFactor.issuePending(req, res);
      return res.json({ ok: true, webauthnRequired: true });
    }
    const token = signSession(auth.secret, { exp: Date.now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));
    res.json({ ok: true });
  });

  // SIM-386: the authenticated read surface for failed-login events. Routes
  // registered here run BEFORE the createAuthGate middleware (index.js mounts
  // the gate after installAuthRoutes), so this endpoint must verify the session
  // itself - it is deliberately NOT in isAuthOpenPath, and this inline check is
  // the same verifySession the gate performs. With auth off the endpoint does
  // not exist at all (installAuthRoutes is only called when auth.enabled).
  app.get("/api/auth/failed-logins", (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!verifySession(auth.secret, token)) {
      return res.status(401).json({ error: "authentication required" });
    }
    const events = parseFailedLogins(store ? store.readActivityText() : "");
    // `live` = the true in-memory count for the current window (guardian
    // condition 1: durable lines cap out, this never does). Null when quiet.
    res.json({ events, threshold: monitor.threshold, windowMs: monitor.windowMs, live: monitor.snapshot() });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(req),
      path: "/",
    });
    // SIM-394: also drop any half-finished second-factor state. No-op when the
    // flag is off (secondFactor null -> logout is byte-identical to before).
    if (secondFactor) secondFactor.clearPending(req, res);
    res.json({ ok: true });
  });

  // Unauthenticated-safe: lets the UI decide whether to show the login screen.
  // SIM-394: with the WebAuthn flag ON the body gains a `webauthn` object
  // (enabled/enforced/enrolling - what the two-step login UI + enrollment nag
  // key on); flag off -> statusFields is never called and the body is unchanged.
  app.get("/api/auth/status", (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    res.json({
      authRequired: true,
      authenticated: verifySession(auth.secret, token),
      ...(secondFactor ? secondFactor.statusFields() : {}),
    });
  });

  // Hand the monitor back so index.js can overlay its live snapshot onto the
  // notification fold (guardian condition 1: bell accuracy beyond the cap).
  return { monitor };
}

// Gate: 401 any /api/* request without a valid session, except the open auth
// paths. Non-/api requests (the static SPA shell + hashed assets) always pass so
// the login screen can render.
// SIM-466: default-deny on case - matched case-insensitively against the /api/
// prefix so a case-variant path (e.g. /API/config) is recognized as an API
// request and gated (401) rather than slipping through as "not an API path"
// while index.js's now-case-sensitive routing (app.set) keeps it off the real
// handler.
export function createAuthGate(auth) {
  return function authGate(req, res, next) {
    if (!req.path.toLowerCase().startsWith("/api/")) return next();
    if (isAuthOpenPath(req.path)) return next();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (verifySession(auth.secret, token)) return next();
    return res.status(401).json({ error: "authentication required" });
  };
}
