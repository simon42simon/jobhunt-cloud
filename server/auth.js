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
// 429 cheaply and an operator can retune without a code change.
export function createLoginLimiter(env = process.env) {
  const max = Number(env.JOBHUNT_AUTH_RATELIMIT_MAX) || 10;
  const windowMs = Number(env.JOBHUNT_AUTH_RATELIMIT_WINDOW_MS) || 15 * 60 * 1000;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many login attempts, try again later" },
  });
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
// AFTER express.json (login reads a JSON body) and BEFORE the gate.
export function installAuthRoutes(app, auth, env = process.env) {
  const limiter = createLoginLimiter(env);

  app.post("/api/auth/login", limiter, async (req, res) => {
    const ok = await verifyPassphrase(auth.hash, req.body && req.body.passphrase);
    if (!ok) return res.status(401).json({ error: "invalid passphrase" });
    const token = signSession(auth.secret, { exp: Date.now() + SESSION_TTL_MS });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(req),
      path: "/",
    });
    res.json({ ok: true });
  });

  // Unauthenticated-safe: lets the UI decide whether to show the login screen.
  app.get("/api/auth/status", (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    res.json({ authRequired: true, authenticated: verifySession(auth.secret, token) });
  });
}

// Gate: 401 any /api/* request without a valid session, except the open auth
// paths. Non-/api requests (the static SPA shell + hashed assets) always pass so
// the login screen can render.
export function createAuthGate(auth) {
  return function authGate(req, res, next) {
    if (!req.path.startsWith("/api/")) return next();
    if (isAuthOpenPath(req.path)) return next();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (verifySession(auth.secret, token)) return next();
    return res.status(401).json({ error: "authentication required" });
  };
}
