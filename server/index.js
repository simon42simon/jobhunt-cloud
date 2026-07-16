// Jobhunt Command Center - local file bridge.
//
// The dashboard never owns job data. The Markdown files in the vault's Jobs/
// folder are the single source of truth (Obsidian + git + the Python pipeline
// all read them). This server only:
//   - reads every Jobs/<folder>/<Role>.md (the file whose frontmatter is `type: job`)
//   - writes targeted, one-line frontmatter changes back (status, fit, etc.)
//   - creates new job folders on request
//   - opens generated files (CV/cover-letter) in their OS default app
//   - streams a "files changed" event so the UI live-reloads
//
// It performs surgical line edits on the frontmatter rather than re-serializing
// the whole file, so a status change is a clean one-line diff in Obsidian/git.

import express from "express";
import helmet from "helmet";
import cors from "cors";
import yaml from "js-yaml";
import chokidar from "chokidar";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  sanitizeForPath,
  isInsideJobsDir,
  sanitizeId,
  buildOpenCommand,
  shouldAutoClose,
  isExpiredDeadline,
  localDateISO,
  AUTO_CLOSE_NOTE,
  nextStatusAfterRun,
  sniffImageMime,
  extFromMime,
  MIME_ALLOWLIST,
  computeInterviewConsistency,
  agentEventToUpdate,
  runDurationHistory,
  medianMs,
} from "./lib.js";
// Boot-time orphaned-run reconcile (SIM-70): the SAME core the standalone CLI
// (ops/activity-log-reconcile.mjs) runs. A restart mid-run orphans the old
// process's "running" records (the in-memory `runs` Map is never rehydrated), so
// on boot we close every dangling running record before accepting new runs.
import { reconcileOrphanedRuns } from "../ops/reconcile-core.mjs";
// Feature-flagged app-level auth (SIM-85 / RC-1, ADR-024). Pure helpers +
// middleware factories; default posture is OFF (see server/auth.js header).
import {
  resolveAuth,
  installAuthRoutes,
  createAuthGate,
  parseCorsOrigins,
  CSP_DIRECTIVES,
} from "./auth.js";
// Storage seam (RC-3 / SIM-87, ADR-025). Every persistent read/write goes through
// `store` so a cloud deployment can swap FileStore for PgStore without touching a
// route handler. Constructed just below, once the injected domain helpers
// (dropInvalidJobEnums, normalizeSource, serializeSource - all hoisted function
// declarations) and the enum vocabularies are in scope.
import { resolveStore } from "./store.js";
// APP_MODE boot gate + demo isolation (RC-3 / SIM-87 I6, guardian MF-8..12). Pure
// helpers; resolveRuntime throws FAIL-CLOSED at boot on a bad APP_MODE or a demo
// that can see anything real. Demo replay/guard modules loaded lazily below.
import { resolveRuntime } from "./app-mode.js";
// Hybrid-runner pure helpers (RC-3 / SIM-87 I7, guardian MF-1..7).
import rateLimit from "express-rate-limit";
import {
  isRunnerKind,
  validateArtifact,
  verifyRunnerToken,
  runnerIdFromToken,
  constantTimeEqualHex,
  RUNNER_ARTIFACT_MAX_BYTES,
} from "./runner-lib.js";
import { loadTranscriptLines } from "../demo/replay.mjs";
import { generate as generateDemoSeed, applySeed as applyDemoSeed } from "../demo/seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- config ---------------------------------------------------------------
function loadConfig() {
  const localPath = path.join(ROOT, "config.local.json");
  const basePath = path.join(ROOT, "config.json");
  const file = fs.existsSync(localPath) ? localPath : basePath;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!cfg.jobsDir) throw new Error("config.json must define jobsDir");
  return cfg;
}
const config = loadConfig();
// JOBHUNT_JOBS_DIR lets tests point the app at a fixture vault.
const JOBS_DIR = path.resolve(process.env.JOBHUNT_JOBS_DIR || config.jobsDir);
// JOBHUNT_PORT lets a SECOND, isolated instance run alongside the owner's live
// server (e.g. a parallel-instance live-verify of an unmerged branch on :8788
// while :8787 keeps serving the concurrent session) without editing the shared
// config.json. Mirrors the JOBHUNT_JOBS_DIR / JOBHUNT_DOCS_DIR seams; default
// unchanged.
// JOBHUNT_PORT wins (a second local instance); else PORT (the platform-injected
// var Railway/containers set, RC-3 / SIM-87 I8 env matrix); else config; else 8787.
const PORT = Number(process.env.JOBHUNT_PORT || process.env.PORT) || config.serverPort || 8787;
// JOBHUNT_UI_PORT: the port the BUILT UI is served on in the stable/built channel
// (JOBHUNT_SERVE_BUILT=1, RFC v2-007 / SIM-66). The SAME app instance also listens
// here, serving dist/ + a same-origin /api, so the browser needs no Vite proxy.
// Mirrors the dev Vite port (5180). Bound ONLY in built mode; the dev path (flag
// unset) never touches it, so its default is byte-for-byte irrelevant to dev.
const UI_PORT = Number(process.env.JOBHUNT_UI_PORT) || config.uiPort || 5180;

// ---- bind host (data-sovereignty gate) ------------------------------------
// The vault API can READ and WRITE job files, so its bind host is a security
// boundary, not a convenience knob. Default to loopback (127.0.0.1): reachable
// only from this machine, matching the "data never leaves the box" data contract
// and the loopback-only Vite UI. LAN/phone access is strictly opt-in: the owner
// must set `serverHost` in config.json (e.g. "0.0.0.0" or a specific LAN IP). No
// code path exposes the write API off-box by default. (LAN feature t-1782799331690)
//
// Extracted as pure, exported helpers so the loopback default is unit-testable
// without opening a socket (see tests/server-host.test.js).
export function resolveServerHost(cfg) {
  // Any non-empty serverHost is an explicit owner opt-in; empty/absent -> loopback.
  return (cfg && cfg.serverHost) || "127.0.0.1";
}
export function isLoopbackHost(host) {
  // Loopback hosts keep the API on-box; used to report bind posture at startup.
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
// JOBHUNT_HOST is the 12-factor env override for the bind host (mirrors the
// JOBHUNT_PORT seam) so a cloud/container deployment can bind without editing
// the committed config.json. Precedence: env > config.serverHost > loopback.
// resolveServerHost keeps the empty-string/absent -> 127.0.0.1 safety guard, so
// an unset or blank JOBHUNT_HOST never silently exposes the write API off-box.
const HOST = resolveServerHost({ serverHost: process.env.JOBHUNT_HOST || config.serverHost });

// ---- docs + live app-data seams (resolved here, before the app block) -------
// Moved above `const app` (was defined further down) so the feature-flagged auth
// middleware can read its out-of-git config from DATA_DIR before any route is
// registered. Behavior of both consts is unchanged.
//
// JOBHUNT_DOCS_DIR lets doc-write tests point the app at a throwaway docs dir so
// they never mutate the committed files (mirrors JOBHUNT_JOBS_DIR). When unset
// the resolved path is the real docs/ folder, so default behavior is unchanged.
const DOCS_DIR = path.resolve(process.env.JOBHUNT_DOCS_DIR || path.join(ROOT, "docs"));

// ---- live app-data seam (ADR-023, RFC v2-006 Phase 3 / SIM-58) -------------
// The LIVE machine-written stores (tasks.yaml, requests.yaml, activity-log.jsonl,
// usage-telemetry.jsonl, notify-state.json, job-chats.json, attachments/) live
// OUTSIDE any git working tree - ssc-brain\data\jobhunt - so no git operation
// can ever touch them (the audit F3 data-loss vector). Precedence:
//   JOBHUNT_DATA_DIR env (explicit override)
//   > when JOBHUNT_DOCS_DIR is set (test mode): follow DOCS_DIR - a hermetic
//     suite keeps data inside its temp docs dir exactly as before this seam
//   > config dataDir (production: ssc-brain\data\jobhunt)
//   > DOCS_DIR (pre-seam back-compat when no dataDir is configured).
// Standalone ops scripts use the same production rule via lib.js resolveDataDir.
// The feature-flagged auth config (auth.json) also lives here, out of git.
// Markdown DOCS (the doc browser, roadmap.yaml, portfolio.yaml, agents.yaml,
// discovery-sources.yaml) intentionally STAY on DOCS_DIR - they are repo content.
const DATA_DIR = path.resolve(
  process.env.JOBHUNT_DATA_DIR ||
    (process.env.JOBHUNT_DOCS_DIR ? DOCS_DIR : config.dataDir || DOCS_DIR),
);

console.log(`[jobhunt] jobs dir: ${JOBS_DIR}`);
if (!fs.existsSync(JOBS_DIR)) {
  console.error(`[jobhunt] WARNING: jobs dir does not exist: ${JOBS_DIR}`);
}

// ---- domain constants -----------------------------------------------------
const STATUSES = [
  "lead",
  "queued",
  "drafted",
  "ready",
  "submitted",
  "interview",
  "offer",
  "rejected",
  "closed",
];

const TRACKS = {
  industry_outreach_focused: "Industry Outreach",
  higher_ed_generalist_focused: "Higher-Ed Generalist",
  b2b_gtm_focused: "B2B GTM",
  operations_leadership_focused: "Operations Leadership",
  public_sector_focused: "Public Sector",
  aerospace_defence_focused: "Aerospace / Defence",
  fire_alarm_focused: "Fire / Life-Safety",
};

// The remaining Job enum vocabularies (docs/data-schema.md §2.1). `sector` is
// THE 6-value set Discovery Sources also enforces - defined once here and
// aliased as SOURCE_SECTORS below, so the two entities can never drift.
const FITS = ["strong", "moderate", "stretch"];
const TAILORINGS = ["light", "heavy"];
const SECTORS = ["private", "municipal", "provincial", "federal", "bps", "nonprofit"];

// ---- Job enum write boundary (t-1783199066683) ------------------------------
// Job track/fit/sector/tailoring/status were accepted as UNVALIDATED free
// strings while the conceptually identical DiscoverySource enums 400 - two
// entities sharing a vocabulary with opposite validation postures (data-schema
// §6 gap 2). This guard closes the gap by adopting the TASK posture (a
// present-but-invalid enum value is SILENTLY IGNORED, exactly like an invalid
// task priority/type/status in applyTaskFields), not the Source 400 posture,
// because (a) the Job write path's own established invariant is already
// silent-drop for unknown KEYS (WRITABLE_FIELDS), and (b) the pursue path
// carries values from legacy workbook rows - a loud 400 would block triaging
// real historical finds, which is a worse failure than dropping a bogus value.
// Clearing stays legal: null/"" pass through (updateFrontmatter removes the
// key). TOLERANT READ IS UNCHANGED - a legacy on-disk value is still served
// verbatim (rawStatus / track passthrough); this hardens WRITES only.
const JOB_ENUM_FIELDS = {
  track: Object.keys(TRACKS),
  fit: FITS,
  sector: SECTORS,
  tailoring: TAILORINGS,
  status: STATUSES,
};
export function dropInvalidJobEnums(updates) {
  const out = { ...updates };
  for (const [key, allowed] of Object.entries(JOB_ENUM_FIELDS)) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === null || v === "") continue; // clearing the field stays legal
    if (typeof v !== "string" || !allowed.includes(v)) delete out[key];
  }
  return out;
}

// ---- storage seam (ADR-025) ------------------------------------------------
// The ONE store instance every persistent read/write goes through. FileStore by
// default (byte-identical to the pre-seam server); STORE_BACKEND=pg selects
// PgStore later (I4). The domain helpers it needs that live here (exported +
// directly tested) are INJECTED so the store module stays free of a circular
// import; normalizeSource / serializeSource / dropInvalidJobEnums are hoisted
// function declarations, so passing them here (before their source-order
// definitions) resolves to the real functions. TRACKS / STATUSES are const and
// defined above.
// The runtime posture (RC-3 / SIM-87 I6). resolveRuntime does the STRICT APP_MODE
// parse (MF-9) and, in demo mode, the fail-closed isolation assertions (MF-8: the
// demo DB is positively marked; MF-9: no RUNNER_TOKEN/APIFY_TOKEN present) BEFORE
// any connection is opened. A bad APP_MODE or a demo that can see anything real
// throws here and the process never boots. Default (no APP_MODE, no STORE_BACKEND)
// -> { appMode:"real", storeBackend:"file" }, byte-identical to the pre-I6 server.
const runtime = resolveRuntime(process.env);
const DEMO_MODE = runtime.demo;
// Store selection. STORE_BACKEND=pg boots the Postgres backend (the cloud/demo
// deployments); PgStore is SYNCHRONOUS via its worker bridge, so this is the ONLY
// async hop - a single awaited construct at boot, not an interface rewrite. All
// route handlers stay synchronous. Every test imports this module with `await
// import(...)`, so the top-level await is transparent to them. Default is
// FileStore (the naked `npm run dev` / laptop path), unchanged.
let store;
if (runtime.storeBackend === "pg") {
  const { createPgStore } = await import("./store.js");
  store = await createPgStore(process.env, {
    docsDir: DOCS_DIR,
    blobDir: process.env.JOBHUNT_BLOB_DIR || undefined,
    deps: { TRACKS, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource },
  });
  console.log(`[jobhunt] store backend: PgStore (APP_MODE=${runtime.appMode})`);
  if (DEMO_MODE) {
    // Seed a fresh demo DB on boot if it is empty (idempotent-ish: applySeed skips
    // colliding job slugs), so a just-provisioned demo instance comes up populated.
    try {
      if (store.listJobs().length === 0) {
        applyDemoSeed(store, generateDemoSeed(process.env.SEED_VERSION || 1));
        console.log("[jobhunt] demo: seeded fictional dataset on boot");
      }
    } catch (e) {
      console.error(`[jobhunt] demo seed on boot failed (non-fatal): ${e && e.message ? e.message : e}`);
    }
  }
} else {
  store = resolveStore(process.env, {
    jobsDir: JOBS_DIR,
    docsDir: DOCS_DIR,
    dataDir: DATA_DIR,
    deps: { TRACKS, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource },
  });
}

// ---- read side ------------------------------------------------------------

// ---- read side (job vault) ---------------------------------------------
// The job-vault read/write primitives (findJobFile, listFolderFiles, toJob /
// the readiness derivation, scanAllJobs, createJobFolder, the artifact-history
// helpers, resolveJobFolder, the guarded reader + note write + regenerate
// backup) all moved behind the storage seam - see server/store.js (FileStore).
// Routes call store.listJobs / getJob / getJobSummary / updateJobFields /
// createJob / writeJobNote / openJobFile / jobFolderPath / backupRoutineOutputs.

// ---- app ------------------------------------------------------------------
const app = express();
// NO CORS middleware - deliberate (t-1783186106119). app.use(cors()) used to
// emit Access-Control-Allow-Origin: * on every response, letting ANY page in
// the owner's browser read this vault API (and preflight into its writes)
// while the app runs; the loopback bind does not stop a malicious page that is
// already inside the browser. Every REAL client is same-origin or not a
// browser: the Vite UI (:5180) and the tailnet URL both reach /api through
// Vite's server-side proxy with relative fetches (src/api.ts), and ops
// scripts/hooks are not browsers, so nothing legitimate ever needs a
// cross-origin grant. Emitting no CORS headers makes the browser's same-origin
// policy the guard: cross-origin reads are blocked, and preflight (mandatory
// for JSON bodies / custom headers) fails closed so cross-origin writes never
// leave the browser. Do NOT re-add cors() "to fix" a blocked request - a
// blocked request means the caller is not going through the app's origin;
// route it through the Vite proxy instead. A future direct-to-bridge browser
// client (e.g. the one-click-capture extension, t-feat-oneclick-capture) must
// take a scoped per-origin decision through security review, never the
// wildcard. Posture pinned by tests/cors-origin.test.js.

// ---- security hardening (feature-flagged; SIM-85 / RC-1, ADR-024) ----------
// DEFAULT POSTURE (no hash configured, JOBHUNT_AUTH unset) is BYTE-IDENTICAL to
// the historical loopback-dev behavior: resolveAuth returns {enabled:false}, so
// helmet, the auth routes, and the gate below are all skipped, and the CORS
// allowlist is empty (no headers). Hardening turns on together only for the
// cloud / LAN-exposed path, when a passphrase hash is present (ops/auth-setup.mjs
// writes it to <DATA_DIR>/auth.json, OUTSIDE the git tree, or JOBHUNT_AUTH_HASH
// provides it) or JOBHUNT_AUTH=required. Gating helmet with auth is deliberate:
// the local fleet reads this bridge cross-origin (product-hub on :8787), and a
// helmet CORP/CSP posture must not land on that on-box path - only on the
// exposed deployment. resolveAuth throws loudly if JOBHUNT_AUTH=required but
// nothing is configured (fail-fast misconfig).
const auth = resolveAuth({ env: process.env, dataDir: DATA_DIR });
if (auth.enabled) {
  // Trust a front proxy's X-Forwarded-* only on explicit opt-in (a cloud TLS
  // terminator) so req.ip (rate-limit key) and secure-cookie detection are
  // correct, without a spoofable default on the loopback path.
  if (process.env.JOBHUNT_TRUST_PROXY) {
    const tp = process.env.JOBHUNT_TRUST_PROXY;
    app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp);
  }
  app.use(helmet({ contentSecurityPolicy: { directives: CSP_DIRECTIVES } }));
  console.log(`[jobhunt] auth ENABLED (hash source: ${auth.source}); helmet + CSP on`);
}
// CORS stays OFF by default (deliberate removal, t-1783186106119). An operator
// may opt SPECIFIC origins back in via JOBHUNT_CORS_ORIGINS (comma-separated)
// for a genuinely cross-origin cloud client; empty => today's no-CORS posture.
const corsOrigins = parseCorsOrigins(process.env.JOBHUNT_CORS_ORIGINS);
if (corsOrigins.length) {
  app.use(cors({ origin: corsOrigins, credentials: true }));
  console.log(`[jobhunt] CORS allowlist enabled: ${corsOrigins.join(", ")}`);
}
// Explicit JSON body-size cap (states the express.json 100kb default outright).
// The image-upload route sets its own multipart cap (ATTACHMENT_MAX_BYTES).
app.use(express.json({ limit: "100kb" }));
if (auth.enabled) {
  installAuthRoutes(app, auth); // POST /api/auth/login (rate-limited) / logout, GET status
}
// The hybrid-runner endpoints (RC-3 / SIM-87 I7) carry their OWN bearer-token auth
// (RUNNER_TOKEN_HASH) and MUST be registered BEFORE the cookie gate, so a tokened
// laptop runner is not blocked by the missing session cookie. Every other /api/*
// (including the owner enqueue route) stays behind the gate. Registered
// unconditionally; the endpoints self-gate on runtime.runnerEnabled + demo (501).
mountRunnerRoutes();
if (auth.enabled) {
  app.use(createAuthGate(auth)); // 401 on any other /api/* without a valid session cookie
}

app.get("/api/config", (req, res) => {
  res.json({
    jobsDir: JOBS_DIR,
    statuses: STATUSES,
    tracks: TRACKS,
    weeklyTarget: config.weeklyTarget || 5,
    appMode: runtime.appMode,
  });
});

// Container liveness probe (RC-3 / SIM-87 I8). NOT under /api/ so it bypasses the
// auth gate - a health prober carries no session cookie. Cheap store round-trip so
// a dead DB connection surfaces as 503, not a false-healthy 200. Used by the
// Dockerfile HEALTHCHECK and the Railway platform probe.
app.get("/healthz", (req, res) => {
  try {
    store.runnerQueueState(); // tolerant + cheap on both backends; proves the store responds
    res.json({ status: "ok", mode: runtime.appMode, store: runtime.storeBackend });
  } catch (e) {
    res.status(503).json({ status: "unhealthy" });
  }
});

// ---- demo nightly reset (RC-3 / SIM-87 I6, guardian MF-10) ------------------
// TRUNCATE all demo tables + re-apply the deterministic fictional seed, so visitor
// edits (the demo is intentionally writable so it feels real) vanish and the demo
// is always pristine. Idempotent.
function resetDemoData() {
  if (typeof store.resetAll !== "function") return;
  store.resetAll();
  applyDemoSeed(store, generateDemoSeed(process.env.SEED_VERSION || 1));
}
// NO anonymous reset surface (MF-10): the endpoint is registered ONLY in demo mode
// AND only when a reset secret is configured, and it requires that secret
// (constant-time compared) even though demo app-auth is off - so a public visitor
// can never hammer a TRUNCATE. The in-process interval (armed at boot below) is the
// primary reset; this endpoint is for an external cron that holds the secret.
if (DEMO_MODE && runtime.resetSecret) {
  app.post("/api/demo/reset", (req, res) => {
    const provided = Buffer.from(String(req.get("x-demo-reset-secret") || ""));
    const expected = Buffer.from(runtime.resetSecret);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      resetDemoData();
      broadcast({ type: "jobs-changed" });
      res.json({ ok: true });
    } catch (e) {
      console.error(`[jobhunt] demo reset failed: ${e && e.message ? e.message : e}`);
      res.status(500).json({ error: "reset failed" });
    }
  });
}

// ---- hybrid agent runner (RC-3 / SIM-87 I7, design section 4, MF-1..7) ------
// The cloud holds an OUTBOUND queue; the laptop runner POLLS it over HTTPS. Every
// arrow originates at the laptop - the cloud opens no connection into it, holds no
// Anthropic key / claude.exe auth, and stores only a VERIFY-ONLY hash of the runner
// token. Payload is DATA keyed to a whitelisted routine, never a command (MF-1);
// the result artifact target derives from the CLAIMED ROW, never the request body
// (MF-4); each kind bounds which artifact kinds it may post (MF-2); size + mime are
// capped (MF-4); the claim nonce is single-use (MF-7); runner-token verify is
// constant-time + failure-rate-limited (MF-5).
const RUNNER_QUEUE_MAX_INFLIGHT = Number(config.runnerQueueMaxInflight) > 0 ? Math.floor(Number(config.runnerQueueMaxInflight)) : 20;
const RUNNER_AUTH_MAX_FAILURES = 20; // per IP per window before a 429 (MF-5)
const RUNNER_AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const runnerAuthFailures = new Map(); // ip -> { count, resetAt }

// Runner bearer-token gate (MF-5): 501 unless the runner is enabled (real mode +
// RUNNER_TOKEN_HASH), constant-time token verify, and a per-IP failure counter so
// /api/runner/jobs/next cannot be used as a brute-force oracle.
function runnerAuth(req, res, next) {
  if (DEMO_MODE) return res.status(501).json({ error: "runner is disabled in demo mode" });
  if (!runtime.runnerEnabled) return res.status(501).json({ error: "runner is not configured on this instance" });
  const ip = req.ip || "unknown";
  const now = Date.now();
  const f = runnerAuthFailures.get(ip);
  if (f && f.resetAt > now && f.count >= RUNNER_AUTH_MAX_FAILURES) {
    return res.status(429).json({ error: "too many failed runner-auth attempts; try again later" });
  }
  const hdr = req.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!verifyRunnerToken(token, process.env.RUNNER_TOKEN_HASH)) {
    const rec = f && f.resetAt > now ? f : { count: 0, resetAt: now + RUNNER_AUTH_FAIL_WINDOW_MS };
    rec.count += 1;
    runnerAuthFailures.set(ip, rec);
    return res.status(401).json({ error: "invalid runner token" });
  }
  runnerAuthFailures.delete(ip); // reset the failure window on a good auth
  req.runnerId = runnerIdFromToken(token);
  next();
}

// Registered BEFORE the cookie auth gate (see the auth block above) so a tokened
// runner is not blocked by the missing session cookie.
function mountRunnerRoutes() {
  // Claim the next queued job (outbound pull). FOR UPDATE SKIP LOCKED in PgStore
  // makes a double-claim structurally impossible; 204 when the queue is empty.
  app.get("/api/runner/jobs/next", runnerAuth, (req, res) => {
    try {
      const claim = store.claimAgentJob(req.runnerId);
      if (!claim) return res.status(204).end();
      res.json(claim); // { id, kind, jobId, payload, nonce, attempts }
    } catch (e) {
      res.status(500).json({ error: "claim failed" });
    }
  });

  // Extend the lease while a long job runs, so it is not spuriously re-queued.
  app.post("/api/runner/jobs/:id/heartbeat", runnerAuth, (req, res) => {
    const r = store.heartbeatAgentJob(req.params.id, req.runnerId);
    if (!r.ok) return res.status(409).json({ error: "job is not claimed by this runner" });
    res.json(r);
  });

  // Append transcript lines for the live run panel (DATA only, never a command).
  app.post("/api/runner/jobs/:id/progress", runnerAuth, (req, res) => {
    const lines = (req.body && Array.isArray(req.body.lines) ? req.body.lines : []).slice(0, 50);
    store.appendAgentJobProgress(req.params.id, req.runnerId, lines);
    res.json({ ok: true });
  });

  // Post ONE generated artifact back. The TARGET job derives from the CLAIMED ROW
  // (MF-4), never the request body; the artifact kind must be a permitted output of
  // the row's routine (MF-2); size + mime are bounded (MF-4); the single-use claim
  // nonce is required (MF-7). Raw binary body (bounded), name/mime via headers.
  app.post(
    "/api/runner/jobs/:id/artifact",
    runnerAuth,
    express.raw({ type: () => true, limit: RUNNER_ARTIFACT_MAX_BYTES + 1024 }),
    (req, res) => {
      const job = store.agentJobById(req.params.id);
      if (!job) return res.status(404).json({ error: "agent job not found" });
      if (job.claimedBy !== req.runnerId) return res.status(409).json({ error: "job is not claimed by this runner" });
      const nonce = req.get("x-runner-nonce") || "";
      if (!job.nonce || !constantTimeEqualHex(job.nonce, nonce)) {
        return res.status(403).json({ error: "nonce mismatch (stale or replayed artifact)" });
      }
      if (!job.jobId) return res.status(400).json({ error: "this agent job has no target job for an artifact" });
      const name = req.get("x-artifact-name") || "";
      // Prefer the explicit artifact-mime header; fall back to the raw body's
      // Content-Type (stripped of any charset) so a runner that sets only the
      // upload Content-Type still validates.
      const mime = (req.get("x-artifact-mime") || req.get("content-type") || "").split(";")[0].trim();
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const v = validateArtifact(job.kind, { name, mime }, body.length);
      if (!v.ok) return res.status(400).json({ error: v.reason });
      try {
        // Target = job.jobId from the row (MF-4). saveJobArtifact contains the write
        // to that job's folder (FileStore) / job_files blob (PgStore).
        const meta = store.saveJobArtifact(job.jobId, path.basename(name), mime, body);
        res.status(201).json({ ok: true, ...meta, kind: v.kind });
      } catch (e) {
        res.status(e.httpStatus || 500).json({ error: e.message });
      }
    },
  );

  // Finalize the job (idempotent, replay-safe). Validates the nonce + claimed-by;
  // a repeat result for a terminal job is a 200 no-op.
  app.post("/api/runner/jobs/:id/result", runnerAuth, (req, res) => {
    const { nonce, status, error } = req.body || {};
    const r = store.completeAgentJob(req.params.id, { runnerId: req.runnerId, nonce, status, error });
    if (r.notFound) return res.status(404).json({ error: r.reason });
    if (!r.ok) return res.status(403).json({ error: r.reason });
    if (r.jobId) broadcast({ type: "jobs-changed" }); // cloud has no watcher; nudge the UI
    res.json({ ok: true, idempotent: !!r.idempotent });
  });
}

// Owner-facing enqueue (MF-3): behind the cookie gate (registered AFTER it), and
// spend-quota + rate-limited so a compromised cloud cannot drive the laptop runner
// to burn the owner's subscription. `kind` must be a whitelisted runner routine;
// payload is DATA (an optional owner note), never a command (MF-1).
const enqueueLimiter = rateLimit({
  windowMs: Number(process.env.JOBHUNT_ENQUEUE_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.JOBHUNT_ENQUEUE_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many enqueue requests; slow down" },
});
app.post("/api/agent-jobs", enqueueLimiter, (req, res) => {
  if (DEMO_MODE) return res.status(501).json({ error: "agent jobs are disabled in demo mode" });
  if (!runtime.runnerEnabled) return res.status(501).json({ error: "runner is not configured on this instance" });
  const { kind, jobId, note } = req.body || {};
  if (!isRunnerKind(kind)) return res.status(400).json({ error: "unknown or non-whitelisted runner kind" });
  if (kind !== "discover-jobs") {
    if (!jobId || !store.getJobSummary(jobId)) return res.status(404).json({ error: "job not found" });
  }
  // Spend quota (MF-3): cap in-flight jobs so a flood cannot run up the bill.
  const st = store.runnerQueueState();
  const inflight = st.counts.queued + st.counts.claimed + st.counts.running;
  if (inflight >= RUNNER_QUEUE_MAX_INFLIGHT) {
    return res.status(429).json({ error: `runner queue is full (${RUNNER_QUEUE_MAX_INFLIGHT} in flight); wait for jobs to drain` });
  }
  const payload = { note: typeof note === "string" ? note.slice(0, 2000) : "" };
  const { id } = store.enqueueAgentJob({ kind, jobId: kind === "discover-jobs" ? null : jobId, payload });
  res.status(201).json({ id });
});

// Owner-facing queue state for the honest laptop-off pending UI (design 4.6).
app.get("/api/runner/state", (req, res) => {
  res.json(store.runnerQueueState());
});

// ---- deadline auto-close (lazy sweep) --------------------------------------
// The ONE rule-based automatic write in the app, disclosed in DATA_CONTRACT.md
// ("What the app may do"): a job still in a pre-application status (lead /
// queued / drafted) whose deadline (a literal YYYY-MM-DD) is strictly before
// today's LOCAL date gets status -> closed plus a provenance note in
// next_action, written through the SAME surgical updateFrontmatter path the UI
// uses - one-line frontmatter diffs, body byte-identical, never a delete, so
// the change is visible in the UI/git and reversible by hand. shouldAutoClose
// (server/lib.js) is the pure rule: submitted / interview / offer / rejected /
// closed and dateless or free-text deadlines are NEVER touched. The
// module-level date guard runs the sweep once per process per day (the first
// job-list load, then again after midnight or a restart) so a polling
// dashboard never re-walks the rule per request; it only writes when a job
// actually needs closing. A failure on one file logs and skips - the sweep can
// never take down the read path.
let lastSweepDate = null; // local YYYY-MM-DD of this process's last sweep

function sweepExpiredJobs(jobs) {
  const today = localDateISO();
  if (lastSweepDate === today) return false;
  lastSweepDate = today;
  let closed = 0;
  for (const job of jobs) {
    if (!shouldAutoClose(job.status, job.deadline, today)) continue;
    try {
      // Surgical one-line frontmatter write via the seam (same updateFrontmatter
      // path the UI uses); byte-identical body, never a delete. A null return
      // means the job vanished between the scan and the write - skip, don't count.
      if (store.updateJobFields(job.id, { status: "closed", next_action: AUTO_CLOSE_NOTE })) {
        closed++;
        console.log(`[jobhunt] auto-closed "${job.id}" (deadline ${job.deadline} passed)`);
      }
    } catch (e) {
      console.error(`[jobhunt] auto-close failed for "${job.id}": ${e.message}`);
    }
  }
  return closed > 0;
}

app.get("/api/jobs", (req, res) => {
  const jobs = store.listJobs();
  // The lazy sweep piggybacks the list read; when it closed anything, re-scan
  // so THIS response already shows the closed statuses (visible immediately,
  // not one refresh later).
  if (sweepExpiredJobs(jobs)) return res.json(store.listJobs());
  res.json(jobs);
});

// DOCS_DIR and DATA_DIR are resolved up top (just after the bind host) so the
// feature-flagged auth middleware can read its out-of-git config from DATA_DIR
// before any route is registered. See there for the full seam rationale.

// ---- ticket image attachments store (ADR-014) -----------------------------
// The app's ONLY binary write path lands here: <DATA_DIR>/attachments/<taskId>/<hash>.<ext>.
// App-managed; since ADR-023 it lives in the data zone (no longer git-tracked -
// the dated OneDrive backup job covers it), alongside tasks.yaml / requests.yaml,
// and OUTSIDE the vault Jobs/ dir. Follows DATA_DIR, so a test pointing
// JOBHUNT_DOCS_DIR at a temp dir is hermetic. The blob path (per-task
// containment + atomic write + guarded read) now lives in the storage seam
// (store.saveAttachmentBlob / store.attachmentFilePath).
// Caps (ADR-014). Config-overridable so the owner can retune without a code
// change (same pattern as claudeAllowedTools); env overrides are the test seam
// (like JOBHUNT_JOBS_DIR/JOBHUNT_DOCS_DIR) so a suite can set a tiny cap cheaply.
function posIntOr(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
const ATTACHMENT_MAX_BYTES =
  posIntOr(process.env.JOBHUNT_ATTACH_MAX_BYTES, config.attachmentMaxBytes) || 5 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = posIntOr(process.env.JOBHUNT_ATTACH_MAX_COUNT, config.attachmentMaxCount) || 6;
const ATTACHMENT_MIME_ALLOWLIST =
  Array.isArray(config.attachmentMimeAllowlist) && config.attachmentMimeAllowlist.length
    ? config.attachmentMimeAllowlist.map((m) => String(m).toLowerCase())
    : Object.keys(MIME_ALLOWLIST);

// One-level subdirectories of docs/ that the browser is allowed to descend
// into, each mapped to the doc-id prefix it produces ("routines/<id>") and the
// sidebar group its docs fall into regardless of filename. Adding a new
// subfolder (like `briefs/`) means one entry here - listDocFiles() and
// resolveDocPath() both drive off this list, so scanning and serving can never
// drift apart on which subdirectories are legal.
const DOC_SUBDIRS = {
  routines: "Routines",
  briefs: "Briefs & Debriefs",
  "enablement-reviews": "Reviews & Logs",
  audits: "Reviews & Logs",
  research: "Reviews & Logs",
  "session-debriefs": "Briefs & Debriefs",
  proposals: "Product",
};

// Coarse sidebar sections for the docs browser, one coherent bucket each:
// Product (core product docs), Org & Agents (living "how we run the org"
// reference), Routines (repeatable playbooks under routines/), Reviews & Logs
// (dated / point-in-time audits and build logs), Briefs & Debriefs (one-off
// session writeups under briefs/), Releases (changelog), then Docs for
// anything uncategorized. DOC_GROUP_ORDER is the sidebar's reading order;
// alphabetical-by-title only breaks ties within a group. Keep in sync with the
// mapping rules below and with CLAUDE.md / the kernel doc map
// (company-os/os/governance-conventions.md section 6) if the doc set's
// shape changes.
const DOC_GROUP_ORDER = ["Product", "Org & Agents", "Routines", "Reviews & Logs", "Briefs & Debriefs", "Releases", "Docs"];
const DOC_GROUP_BY_NAME = {
  changelog: "Releases",
  blueprint: "Product",
  governance: "Product",
  "product-decisions": "Product",
  "operating-model": "Product",
  "product-process": "Product",
  "pm-conventions": "Product",
  "task-lifecycle-sop": "Product",
  "job-status-lifecycle-sop": "Product",
  "dual-track-sop": "Product",
  "competitive-analysis": "Product",
  "management-philosophy": "Org & Agents",
  "agent-onboarding-checklist": "Org & Agents",
  "team-character-sheet-spec": "Org & Agents",
  "agent-roster-audit": "Reviews & Logs",
};

function docGroup(name) {
  const slash = name.indexOf("/");
  if (slash !== -1) {
    const subdir = name.slice(0, slash);
    if (DOC_SUBDIRS[subdir]) return DOC_SUBDIRS[subdir];
  }
  if (name.startsWith("build-log-")) return "Reviews & Logs";
  return DOC_GROUP_BY_NAME[name] || "Docs";
}

// First Markdown H1 in the file, else the filename prettified (kebab-case ->
// Title Case). Every doc we ship today has an H1 (see docs/*.md), so this is
// a safety net for future docs, not the common path.
function docTitle(content, name) {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  const base = name.split("/").pop();
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// Optional YAML frontmatter schema for docs/ Markdown files. All keys are
// optional; parsed by parseFrontmatter (server/lib.js) into a doc's `meta`.
// Authored by hand (or by a routine) - never written by this app. Powers the
// Product Hub IA v2 structured views (docs/product-hub-ia-v2.md sections 4 + 6)
// without a second store:
//   type    : "source" | "review" | "log" | "brief" | "debrief" - what kind of
//             record the doc is; drives which structured view (Reviews & Logs
//             vs Briefs & Debriefs) it feeds.
//   agent   : source agent role id (a docs/agents.yaml `id`, e.g.
//             "people-enablement") - the agent that produced/owns the doc.
//   recs    : integer - how many recommendations/findings THIS doc raised
//             (reviews/logs). Compared against the count of tasks whose
//             `source` is "review:<this-doc-id>" (section 6) to surface
//             untriaged recs; absent means "not declared," not zero.
//   status  : "shipped" | "deferred" | "mixed" - a brief/debrief's overall
//             verdict.
//   date    : "YYYY-MM-DD" - the record's date, when not derivable from the
//             filename.
//   release : e.g. "v0.12.0" - the release a brief/debrief or log ties to.
// A doc's title is ALWAYS the body's H1 (docTitle, below) - never meta - so
// frontmatter can never desync from what the reader displays.
// Note: an earlier draft of the IA v2 spec (product-hub-ia-v2.md section 7 B2)
// used `kind`/`author`; this build settles on `type`/`agent` as the final
// names.

// List every renderable doc under docs/ (top level) and each allow-listed
// subdirectory in DOC_SUBDIRS (one level down: docs/routines/, docs/briefs/).
// Deliberately does NOT touch docs/*.yaml - those back interactive views
// (agents/portfolio/roadmap/tasks), not the Markdown doc browser. Only scans
// directories named in DOC_SUBDIRS, matching the shape resolveDocPath accepts
// below, so anything this lists is also fetchable via GET /api/doc/:name.
function listDocFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => {
      const name = prefix + e.name.slice(0, -3);
      const raw = fs.readFileSync(path.join(dir, e.name), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const doc = { name, title: docTitle(body, name), group: docGroup(name) };
      if (meta) doc.meta = meta;
      return doc;
    });
}

function listDocs() {
  const docs = [
    ...listDocFiles(DOCS_DIR, ""),
    ...Object.keys(DOC_SUBDIRS).flatMap((sub) => listDocFiles(path.join(DOCS_DIR, sub), `${sub}/`)),
  ];
  const rank = (g) => {
    const i = DOC_GROUP_ORDER.indexOf(g);
    return i === -1 ? DOC_GROUP_ORDER.length : i;
  };
  docs.sort((a, b) => rank(a.group) - rank(b.group) || a.title.localeCompare(b.title));
  return docs;
}

// Path-safety for GET /api/doc/:name. `name` is either a bare top-level doc id
// ("governance") or "<subdir>/<id>" for a subdir in DOC_SUBDIRS
// ("routines/<id>", "briefs/<id>") - the only shapes listDocs() produces -
// never a deeper path, never absolute, never containing "..". The regex
// whitelists the character set per segment; the resolved-path containment
// check (isInsideJobsDir, reused generically here - it just tests "is target
// inside base dir") is the authoritative guard, so even a regex mistake can't
// let a request escape docs/. Returns the absolute file path, or null to
// reject (caller maps null to 400).
const DOC_SEGMENT = /^[a-zA-Z0-9._-]+$/;
function resolveDocPath(name) {
  if (typeof name !== "string" || !name) return null;
  const parts = name.split("/");
  let relBase;
  if (parts.length === 1 && DOC_SEGMENT.test(parts[0])) {
    relBase = parts[0];
  } else if (parts.length === 2 && DOC_SUBDIRS[parts[0]] && DOC_SEGMENT.test(parts[1])) {
    relBase = `${parts[0]}/${parts[1]}`;
  } else {
    return null;
  }
  const rel = relBase.endsWith(".md") ? relBase : `${relBase}.md`;
  const full = path.resolve(DOCS_DIR, rel);
  if (!full.endsWith(".md") || !isInsideJobsDir(DOCS_DIR, full)) return null;
  return full;
}

app.get("/api/docs", (req, res) => {
  res.json(listDocs());
});

// Serves any Markdown file inside docs/ or docs/routines/ (replaces the old
// 3-entry whitelist - blueprint/changelog/governance still work, they are just
// docs/<name>.md now like every other doc). `content` is the frontmatter-
// STRIPPED body (so MarkdownDoc renders clean markdown, never a raw YAML
// block); `meta` is the parsed frontmatter object, present only when the doc
// has one (see the schema comment above listDocFiles). A doc with no
// frontmatter is unaffected: content is the raw file, meta is omitted.
app.get("/api/doc/*", (req, res) => {
  const name = req.params[0];
  const full = resolveDocPath(name);
  if (!full) return res.status(400).json({ error: "invalid doc name" });
  try {
    const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
    const doc = { name, content: body };
    if (meta) doc.meta = meta;
    res.json(doc);
  } catch {
    res.status(404).json({ error: "doc not found" });
  }
});

app.get("/api/roadmap", (req, res) => {
  try {
    // Read-only ledger via the seam (store.getRoadmap): ensureArrays normalizes a
    // partial hand-edit that drops `phases:` to [] so the view never throws.
    res.json(store.getRoadmap());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Execution pillar: the project / milestone portfolio (read-only). SoT:
// docs/portfolio.yaml (hand-edited). Tasks reference UP into this via their
// project / milestone fields; integrity is checked by reads/tests, not here.
app.get("/api/portfolio", (req, res) => {
  try {
    // Read-only ledger via the seam (store.getPortfolio). ensureArrays defaults the
    // TOP-LEVEL projects/milestones arrays only; each project's OPTIONAL nested
    // fields (raci, ADR-011 stakeholders[]/risks[]) pass through unchanged (the
    // file is hand-edited; nested-ref integrity is a read/test invariant, not a
    // write gate).
    res.json(store.getPortfolio());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// The AI product-dev org chart + agent roster (read-only). SoT: docs/agents.yaml.
app.get("/api/agents", (req, res) => {
  try {
    // Read-only ledger via the seam (store.getAgents): ensureArrays normalizes a
    // partial hand-edit that drops `groups:`/`roles:` to [] so TeamView never throws.
    res.json(store.getAgents());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- task board (app-managed dev backlog) ---------------------------------
// loadTasks / saveTasks moved behind the storage seam (store.loadTasks /
// store.saveTasks, server/store.js). Read-side comments normalization and the
// strip-empties atomic write are unchanged - byte-identical to the pre-seam SoT.

// ONE write whitelist, shared by POST and PATCH /api/tasks. `text` fields are
// written verbatim; `id` fields are run through sanitizeId so a reference can
// never carry path / YAML-structure characters (and empty -> null). The
// special-shape fields (arrays + numbers) are handled explicitly below - they
// can't go through the scalar copy. Anything not listed here (id, created,
// arbitrary keys) is ignored on write. Writes are TOLERANT of unresolvable refs -
// pointing at a project / milestone / agent that does not exist is NOT a 400;
// referential integrity is a read/test invariant.
// `source` (addressed-via-tickets join, docs/product-hub-ia-v2.md section 6)
// is deliberately in the VERBATIM text set, not the id set: it holds strings
// like "review:enablement-reviews/2026-07-01" that carry ":" and "/", which
// sanitizeId would strip. It joins a doc's `meta` (via the doc-id half after
// "review:") client-side; nothing here validates that the referenced doc
// exists - same read/test-invariant posture as the other refs.
// `priority` and `type` are NOT in the verbatim text set: they are closed enums
// (validated below like status), so a bad value can never be copied through.
// `comments` / `comment` are NOT here either: a whole `comments` array is a
// creation-only field (POST handler, coerceComments), and after creation the
// log grows ONLY through the append-a-`comment` operation (applyTaskFields,
// validComment) - append-only by construction, no whole-array replace on PATCH.
const TASK_WRITE_FIELDS = {
  text: ["title", "detail", "epic", "user_story", "acceptance", "source"],
  id: ["project", "milestone", "owner", "delegated_by", "wbs", "assignee"],
};

// Extended (Linear-style) status set accepted in addition to whatever the board's
// `columns` list defines. A status is valid if it is a real column OR one of these.
const EXTENDED_STATUSES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"];
function isValidStatus(status, columns) {
  return typeof status === "string" && (columns.includes(status) || EXTENDED_STATUSES.includes(status));
}

// The board's terminal "done" column - the completion state that the server-
// stamped `completed` date tracks (ADR-013). SOURCED from the live board columns
// (loadTasks/data.columns), never hard-coded: the real board is
// [backlog, todo, in_progress, done] and "done" is also the canonical terminal
// status in EXTENDED_STATUSES, so we prefer "done" when it is a column, fall back
// to the LAST column if a board ever renamed its terminal column, and finally to
// "done" for an empty/odd columns list. Note "canceled" is terminal but NOT done
// (a task was abandoned, not completed), so it clears `completed` like any other
// non-done status - the invariant is "completed present <=> currently done".
function doneStatus(columns) {
  if (Array.isArray(columns) && columns.includes("done")) return "done";
  if (Array.isArray(columns) && columns.length) return columns[columns.length - 1];
  return "done";
}

// Closed enums mirrored from the TypeScript unions (src/types.ts): Task.priority
// is "high" | "medium" | "low"; Task.type (TaskType) is bug | feature | chore |
// spike. Validated on write the SAME way status is, so a bad value can never
// persist into tasks.yaml and desync from the TS types (the audit flagged
// priority/type being written verbatim). An invalid value is IGNORED, exactly
// like an invalid status; the POST path re-applies the "medium" priority default
// when none survives.
const PRIORITIES = ["high", "medium", "low"];
const TASK_TYPES = ["bug", "feature", "chore", "spike"];
const isValidPriority = (p) => typeof p === "string" && PRIORITIES.includes(p);
const isValidType = (t) => typeof t === "string" && TASK_TYPES.includes(t);

// Coerce the special-shape ticket fields. Each returns a clean value, or null to
// mean "clear the field" (absent, empty, or malformed input never writes a broken
// shape into tasks.yaml). Stored as-is; they round-trip cleanly through yaml.dump.
function coerceEstimate(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function coerceLabels(v) {
  if (!Array.isArray(v)) return null;
  const out = v
    .map((x) => (x === null || x === undefined ? "" : String(x).trim()))
    .filter((x) => x !== "");
  return out.length ? out : null;
}
function coerceChecklist(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const text = item.text === null || item.text === undefined ? "" : String(item.text);
    if (text.trim() === "") continue;
    out.push({ text, done: item.done === true });
  }
  return out.length ? out : null;
}

// A ticket comment is { author, ts, body }: an append-only feedback log on a
// task (the assess-ticket routine's CTO verdicts, and any future thread).
// author and body must be non-empty strings; ts is ALWAYS an ISO-8601 string,
// server-stamped on append (a creation payload may supply its own). Returns
// the trimmed { author, body } pair, or null when the payload is not a plain
// object with both strings present and non-blank.
function validComment(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const author = typeof v.author === "string" ? v.author.trim() : "";
  const body = typeof v.body === "string" ? v.body.trim() : "";
  if (!author || !body) return null;
  return { author, body };
}

// Coerce a whole comments array. Accepted at task CREATION only (see the POST
// handler) - PATCH deliberately has no whole-array write, so comment history
// is append-only by construction after that. Invalid entries are dropped
// (same posture as coerceChecklist); a supplied non-blank string ts is kept,
// anything else is server-stamped; empty -> null so `comments: []` is never
// written.
function coerceComments(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v) {
    const c = validComment(item);
    if (!c) continue;
    const ts = typeof item.ts === "string" && item.ts.trim() ? item.ts.trim() : new Date().toISOString();
    out.push({ author: c.author, ts, body: c.body });
  }
  return out.length ? out : null;
}

// Copy the whitelisted fields present in `body` onto `task`, sanitizing the
// id-typed ones, validating status against the board columns + the extended set,
// and shape-validating the array / number fields. Used by both create and patch
// so the two paths can never drift. A present-but-empty array/number field is
// DELETED (keeps tasks.yaml free of `estimate: null` / `labels: []` noise);
// absent fields are untouched, so a legacy task is byte-preserved.
function applyTaskFields(task, body, columns = []) {
  for (const k of TASK_WRITE_FIELDS.text) if (k in body) task[k] = body[k];
  for (const k of TASK_WRITE_FIELDS.id) if (k in body) task[k] = sanitizeId(body[k]);
  // Status change + server-stamped completion date (ADR-013). `completed` is
  // present IFF the task is currently in the board's terminal "done" column. It
  // is stamped ONLY on the TRANSITION into done (comparing the PRIOR status, so
  // an unrelated PATCH on an already-done task - even one that re-sends
  // status:"done" - never re-stamps or fabricates a date) and cleared on any move
  // OUT of done. Server-managed + UNFORGEABLE: `completed` is not in
  // TASK_WRITE_FIELDS, so a client-supplied value in the body is never copied -
  // the value is always the server's LOCAL date, exactly how `created` and a
  // comment's `ts` are server-stamped and cannot be forged. A task that never
  // touches done is byte-preserved (the `delete` on an absent key is a no-op).
  if ("status" in body && isValidStatus(body.status, columns)) {
    const done = doneStatus(columns);
    const wasDone = task.status === done;
    task.status = body.status;
    const isDone = task.status === done;
    if (isDone && !wasDone) {
      // Local date, not UTC - an evening ET completion must not be stamped
      // tomorrow (same rule as task.created). "IF absent" is belt-and-braces:
      // leaving done clears it, so a genuine re-close re-stamps fresh.
      if (!task.completed) task.completed = localDateISO();
    } else if (!isDone) {
      delete task.completed;
    }
  }
  // priority / type: closed enums, validated like status (invalid -> ignored).
  if ("priority" in body && isValidPriority(body.priority)) task.priority = body.priority;
  if ("type" in body && isValidType(body.type)) task.type = body.type;
  if ("estimate" in body) {
    const n = coerceEstimate(body.estimate);
    if (n === null) delete task.estimate;
    else task.estimate = n;
  }
  if ("labels" in body) {
    const l = coerceLabels(body.labels);
    if (l === null) delete task.labels;
    else task.labels = l;
  }
  if ("checklist" in body) {
    const c = coerceChecklist(body.checklist);
    if (c === null) delete task.checklist;
    else task.checklist = c;
  }
  // Append-comment operation (body key `comment`, singular): the ONLY way to
  // grow a ticket's comment log after creation. The server stamps ts, so a
  // caller can never forge history. A malformed payload is a loud 400 (via
  // .httpStatus, honored by both route handlers' catch) rather than the
  // silent-ignore the enum fields above use: dropping authored prose invisibly
  // would lose data. Nothing persists on rejection - the throw fires before
  // the caller reaches saveTasks.
  if ("comment" in body) {
    const c = validComment(body.comment);
    if (!c) {
      const e = new Error("comment must be an object with non-empty string author and body");
      e.httpStatus = 400;
      throw e;
    }
    const list = Array.isArray(task.comments) ? task.comments : [];
    list.push({ author: c.author, ts: new Date().toISOString(), body: c.body });
    task.comments = list;
  }
  return task;
}

app.get("/api/tasks", (req, res) => {
  try {
    res.json(store.loadTasks());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/tasks", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) return res.status(400).json({ error: "title required" });
    const data = store.loadTasks();
    // Normalize the legacy fields to their defaulted / validated forms, then run
    // ONE shared copy so create and patch share the whitelist. An old caller that
    // sends only title/detail/epic/priority/status gets a byte-identical task
    // (the new optional fields stay absent unless supplied).
    const norm = {
      ...body,
      title: String(body.title).trim(),
      detail: body.detail || "",
      epic: body.epic || "general",
      priority: body.priority || "medium",
    };
    const task = { id: `t-${Date.now()}` };
    // A whole `comments` array is accepted at CREATION only (the chatbot can
    // file a ticket carrying context). After creation the log is append-only
    // via the PATCH `comment` key (applyTaskFields) - there is deliberately no
    // whole-array replace on PATCH, so an update can never rewrite or drop
    // comment history. Set BEFORE applyTaskFields so a `comment` key in the
    // same payload appends after the initial entries.
    if ("comments" in norm) {
      const c = coerceComments(norm.comments);
      if (c) task.comments = c;
    }
    applyTaskFields(task, norm, data.columns);
    if (!task.status) task.status = "backlog"; // default when none supplied / invalid
    if (!task.priority) task.priority = "medium"; // default when none supplied / invalid
    if (!Array.isArray(task.comments)) task.comments = []; // same read shape as loadTasks
    // Local date, not UTC - an evening ET ticket must not be stamped tomorrow.
    task.created = localDateISO();
    data.tasks.push(task);
    store.saveTasks(data);
    // tasks.yaml lives in docs/, OUTSIDE the JOBS_DIR watcher - so a task write is
    // invisible to the file watcher. This typed broadcast is the only live signal
    // the notification bell + chat-capture "My reports" have to refresh on.
    broadcast({ type: "tasks-changed" });
    res.status(201).json(task);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

app.patch("/api/tasks/:id", (req, res) => {
  try {
    const data = store.loadTasks();
    const task = data.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "task not found" });
    applyTaskFields(task, req.body || {}, data.columns);
    store.saveTasks(data);
    broadcast({ type: "tasks-changed" }); // see POST /api/tasks - tasks are outside the file watcher
    res.json(task);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  try {
    const data = store.loadTasks();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.id !== req.params.id);
    if (data.tasks.length === before) return res.status(404).json({ error: "task not found" });
    store.saveTasks(data);
    broadcast({ type: "tasks-changed" }); // see POST /api/tasks - tasks are outside the file watcher
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- ticket image attachments (app-managed binary store, ADR-014) ----------
// The chat capture box may attach pasted/dropped images to the ticket it files.
// This is the app's ONLY binary write-path and ONLY serve-a-file path. Bytes land
// in docs/attachments/<taskId>/<sha256>.<ext> - app-managed, git-tracked, OUTSIDE
// the vault Jobs/ dir, never on the surgical frontmatter path. The attachment
// metadata is SERVER-MANAGED + UNFORGEABLE: it is appended to the task ONLY here
// (never accepted in a POST/PATCH task body, never in TASK_WRITE_FIELDS), the same
// posture as `completed` (ADR-013) and a comment's `ts`.

// Is `mime` an accepted image type? Requires BOTH the config allowlist AND a known
// extension (extFromMime), so a config entry can never enable an ext-less or
// non-raster type; the byte-level sniff is the third, independent gate.
function isAllowedAttachmentMime(mime) {
  const m = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  return ATTACHMENT_MIME_ALLOWLIST.includes(m) && extFromMime(m) !== null;
}

// Strip parameters off a Content-Type header ("image/png; charset=x" -> "image/png").
function bareMime(header) {
  return typeof header === "string" ? header.split(";")[0].trim().toLowerCase() : "";
}

// A display label from the optional X-Attachment-Name header. Display-only: the
// stored PATH never uses it (that is the content hash + the mime-derived ext), so
// this is cosmetic. Basename + sanitize + de-slash defensively anyway.
function attachmentDisplayName(header, ext) {
  let raw = typeof header === "string" ? header : "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep the raw header if it is not valid percent-encoding */
  }
  const cleaned = sanitizeForPath(path.basename(raw))
    .replace(/[\\/]+/g, " ")
    .trim();
  return cleaned || `pasted image.${ext}`;
}

// POST /api/tasks/:id/attachments - raw image bytes in the body (Content-Type is
// the image MIME; X-Attachment-Name an optional display label). express.raw is
// ROUTE-SCOPED so the global express.json (100kb) is untouched and no multipart
// dependency is pulled in; image bodies are not application/json, so express.json
// passes them through to this raw parser. Ordered guards; nothing is written
// until all pass.
app.post(
  "/api/tasks/:id/attachments",
  express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES + 1024 }),
  (req, res) => {
    try {
      // (1) parent task must exist (establishes the target dir + the count context).
      const data = store.loadTasks();
      const task = data.tasks.find((t) => t.id === req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });

      // (2) Content-Type must be an allowlisted image MIME.
      const mime = bareMime(req.headers["content-type"]);
      if (!isAllowedAttachmentMime(mime)) {
        return res
          .status(415)
          .json({ error: "unsupported media type - image/png, image/jpeg, image/gif, or image/webp only" });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      // (3) magic-byte sniff must AGREE with the claimed Content-Type - rejects an
      // HTML/script payload wearing an image MIME.
      if (sniffImageMime(body) !== mime) {
        return res.status(415).json({ error: "file bytes do not match the declared image type" });
      }

      // (4) non-empty and within the per-image byte cap.
      if (body.length === 0) return res.status(400).json({ error: "empty body" });
      if (body.length > ATTACHMENT_MAX_BYTES) {
        return res.status(413).json({ error: `image exceeds the ${ATTACHMENT_MAX_BYTES}-byte limit` });
      }

      // (5) content-addressed filename (ext from the VALIDATED mime, never a client
      // filename). Identical bytes de-dupe idempotently (200, no re-append, no count
      // consumed); the count cap applies only to a genuinely NEW file.
      const ext = extFromMime(mime);
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const file = `${hash}.${ext}`;
      const existing = Array.isArray(task.attachments) ? task.attachments : [];
      const dup = existing.find((a) => a && a.file === file);
      if (!dup && existing.length >= ATTACHMENT_MAX_COUNT) {
        return res
          .status(409)
          .json({ error: `ticket already has the maximum of ${ATTACHMENT_MAX_COUNT} attachments` });
      }

      // (6+7) content-addressed blob write behind the storage seam. The per-task
      // containment guard + the atomic write (stage .tmp -> rename; identical
      // bytes are a safe no-op that self-heals a manually-deleted file) live in
      // store.saveAttachmentBlob, which throws httpStatus 400 "invalid path" on an
      // escape (mapped by the catch below), same status/message as before.
      store.saveAttachmentBlob(task.id, file, body);

      // Idempotent re-paste: file already recorded on the task -> return it, do not
      // append a second metadata record and do not re-save.
      if (dup) return res.status(200).json(dup);

      // (8) append server-managed, unforgeable metadata to the task.
      const meta = {
        file,
        name: attachmentDisplayName(req.headers["x-attachment-name"], ext),
        mime,
        bytes: body.length,
        ts: new Date().toISOString(),
      };
      task.attachments = [...existing, meta];
      store.saveTasks(data);
      broadcast({ type: "tasks-changed" }); // a new attachment changes the ticket (see POST /api/tasks)

      res.status(201).json(meta);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  },
);

// GET /api/tasks/:id/attachments/:file - a GUARDED reader, NOT a static file
// server. Serves a file ONLY if the task references it (existence allowlist),
// reconstructs the path server-side (never trusts the client's), and disables
// content sniffing + scripting on the response so a served blob can never be
// interpreted as HTML/JS. Content-Disposition: inline -> view, never download.
app.get("/api/tasks/:id/attachments/:file", (req, res) => {
  try {
    const data = store.loadTasks();
    const task = data.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "task not found" });

    const base = path.basename(req.params.file); // strip any client dir component
    const record = (Array.isArray(task.attachments) ? task.attachments : []).find((a) => a && a.file === base);
    if (!record) return res.status(404).json({ error: "attachment not found" }); // existence allowlist

    // Per-task containment via the storage seam (null -> escape -> 400), then the
    // existence check (the route reports a missing file, same status/message).
    const target = store.attachmentFilePath(task.id, base);
    if (!target) return res.status(400).json({ error: "invalid path" });
    if (!fs.existsSync(target)) return res.status(404).json({ error: "attachment file missing" });

    res.setHeader("Content-Type", record.mime);
    res.setHeader("Content-Disposition", `inline; filename="${base}"`); // view, never download
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Cache-Control", "private, no-store");
    fs.createReadStream(target).pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- intake ledger (app-managed request / intake store, ADR-009) ----------
// docs/requests.yaml is the ORIGIN node of the orchestration chain: the verbatim
// owner/chatbot prompt, the CTO assessment, and the ids of the tasks/projects it
// spawned (request -> assessment -> spawned tasks/projects -> delegation). It is
// app-managed exactly like tasks.yaml: read NORMALIZED (a missing or partially
// hand-edited file yields { requests: [] } rather than throwing, mirroring the
// portfolio/roadmap/agents read hardening and loadTasks) and written ATOMICALLY
// through writeFileAtomic (.tmp + rename), so a reader never sees a half-written
// file. The request `text` is the VERBATIM prompt - never id-sanitized, never
// trimmed of content - so a ":" / "#" / '"' / newline in the ask survives
// byte-for-byte; only the id-typed spawned refs run through sanitizeId (they
// point UP at real task/project ids, ADR-006 - integrity is a read/test
// invariant, not a write gate). Disclosed in DATA_CONTRACT.md; nothing here
// leaves the machine and a request is never deleted. The requests.yaml path +
// atomic read/write now live in the storage seam (store.loadRequests /
// store.saveRequests).

// Coerce a spawned {tasks, projects} shape into two clean, deduped id lists.
// Each id runs through sanitizeId (shape guard only); blanks and dupes drop. The
// two arrays are ALWAYS present so no reader/writer branches on undefined.
function coerceSpawned(v) {
  const clean = (arr) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      const id = sanitizeId(x);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const s = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return { tasks: clean(s.tasks), projects: clean(s.projects) };
}

// loadRequests / saveRequests (+ the read-side normalizeRequest) moved behind the
// storage seam (store.loadRequests / store.saveRequests). The read still coerces
// spawned refs through the same sanitizeId path (store._coerceSpawned mirrors
// coerceSpawned above), so a hand-edited ledger normalizes byte-identically. The
// WRITE-path coerceSpawned above stays here - the POST/PATCH routes use it to
// clean incoming refs before store.saveRequests.

app.get("/api/requests", (req, res) => {
  try {
    res.json(store.loadRequests());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Create an intake record. `text` is REQUIRED and non-blank; it is stored
// VERBATIM (validated with .trim() but never trimmed on write). The server
// stamps id (r-<epochms>), created (local date), and ts (ISO); source defaults
// to 'session'. Optional assessment + spawned are accepted at creation.
app.post("/api/requests", (req, res) => {
  try {
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    const data = store.loadRequests();
    const request = {
      id: `r-${Date.now()}`,
      text, // VERBATIM - never id-sanitized, never trimmed of content
      source: body.source === "chatbot" ? "chatbot" : "session",
      created: localDateISO(),
      ts: new Date().toISOString(),
    };
    if (typeof body.assessment === "string" && body.assessment.trim()) request.assessment = body.assessment;
    request.spawned = coerceSpawned(body.spawned);
    data.requests.push(request);
    store.saveRequests(data);
    res.status(201).json(request);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

// Update an intake record: set/replace `assessment` (when present) and MERGE +
// dedupe `spawned.tasks` / `spawned.projects` (union with the existing lists,
// never a replace, so a link is never lost). 404 on an unknown id; a request is
// never deleted. Atomic write.
app.patch("/api/requests/:id", (req, res) => {
  try {
    const data = store.loadRequests();
    const request = data.requests.find((r) => r.id === req.params.id);
    if (!request) return res.status(404).json({ error: "request not found" });
    const body = req.body || {};
    if ("assessment" in body) {
      if (typeof body.assessment === "string" && body.assessment.trim()) request.assessment = body.assessment;
      else delete request.assessment;
    }
    if ("spawned" in body) {
      const add = coerceSpawned(body.spawned);
      const merge = (existing, incoming) => {
        const out = Array.isArray(existing) ? [...existing] : [];
        for (const id of incoming) if (!out.includes(id)) out.push(id);
        return out;
      };
      request.spawned = {
        tasks: merge(request.spawned.tasks, add.tasks),
        projects: merge(request.spawned.projects, add.projects),
      };
    }
    store.saveRequests(data);
    res.json(request);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});


// ---- activity log (append-only telemetry feed) ----------------------------
// A newest-first feed of what the system did: routine-runner runs (start/close,
// wired below) and subagent delegations (piped in by ops/activity-log-append.mjs
// via a Claude Code hook). Storage is one JSON object per line in
// docs/activity-log.jsonl (DOCS_DIR so the tasks-test seam covers it too).
//
// Record shape (all records): { ts: ISO8601, kind: string, ... }
//   run start : { ts, kind:"run", runId, routine, label, jobId, status:"running" }
//   run close : { ts, kind:"run", runId, status:"done"|"failed"|"stopped", exitCode }
//   delegation: { ts, kind:"delegation", ...hook-supplied fields }
// The feed is telemetry, never a source of truth: reads tolerate a missing file
// (empty array, not 500) and skip any malformed line rather than failing the read.
// activity-log.jsonl append/read now live in the storage seam
// (store.appendActivity - best-effort, never breaks the caller; and
// store.readActivityText - tolerant, missing file -> "").

app.get("/api/activity", (req, res) => {
  const raw = store.readActivityText(); // tolerant: no file yet -> "" -> empty feed
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const recent = lines.slice(-200); // cap to the last ~200 (file is oldest-first)
  const records = [];
  for (const line of recent) {
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip a torn / malformed line rather than failing the whole read */
    }
  }
  records.reverse(); // newest-first
  res.json(records);
});

// ---- usage-journey telemetry (app-managed, local-only, ADR-017) ------------
// A local-only record of the OWNER'S movements in the app (which views they
// open, which actions they take, which routines they run), so a later insights
// routine can learn from real usage instead of INFERRING it from pipeline state
// (which the 2026-07-04 audits had to). It is EVENTS, NEVER CONTENT by
// construction: an event carries a closed `kind`, a closed `surface` id, and a
// bounded `name` (a view / button / saved-view id) - never a job title, note
// body, keystroke, or URL. Enforced SERVER-SIDE by the enum + allowlist + length
// caps + a scalar-only meta block (so no nested document can ride along), not by
// client convention.
//
// Storage: one JSON object per line in docs/usage-telemetry.jsonl (DOCS_DIR, so
// the docs test seam covers it), GITIGNORED runtime data (never committed).
// Append-only, tolerant read. The server stamps `ts` on write and ignores any
// client-supplied ts (unforgeable). This is a fire-and-forget beacon target:
// fast, never required, best-effort append - it can never slow or break the app.
// usage-telemetry.jsonl append/read now live in the storage seam
// (store.appendTelemetry / store.readTelemetryText).

// Closed enums / caps - the acceptance bar (a guardian review runs after this
// wave). TELEMETRY_KINDS / TELEMETRY_SURFACES / TELEMETRY_MAX_BATCH are exported
// so the frontend hook (Wave 2) and the guard tests build against the SAME
// contract object, never a hand-copied duplicate that can drift.
export const TELEMETRY_KINDS = ["view", "action", "run"];
export const TELEMETRY_SURFACES = [
  "jobs-board",
  "jobs-table",
  "job-detail",
  "discovery-sources",
  "discovery-finds",
  "source-detail",
  "insights",
  "product-hub",
  "chat-capture",
  "notifications",
  "topbar",
];
export const TELEMETRY_MAX_BATCH = 50; // per-request event-count cap (bounded)
const TELEMETRY_NAME_MAX = 80; // bounded free-text id (TRUNCATED, not rejected)
const TELEMETRY_SESSION_MAX = 40;
const TELEMETRY_META_MAX_KEYS = 8;
const TELEMETRY_META_KEY_MAX = 40;
const TELEMETRY_META_VAL_MAX = 60;
const TELEMETRY_JOURNEY_RE = /^J\d{1,2}$/;

// Strip ASCII + C1 control chars (the content-block: no keystrokes, newlines, or
// control sequences ride inside a bounded id), then collapse whitespace + trim.
function scrubTelemetryText(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Coerce a client `meta` into a bounded { string | number | boolean } map: at
// most 8 keys, keys + string values length-capped and control-scrubbed, and any
// NON-scalar value (object / array / null) DROPPED - the structural content-block
// that makes it impossible to smuggle a document through meta. Returns a clean
// object, or null when nothing survives (so no empty `meta:{}` is ever stored).
function coerceTelemetryMeta(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const rawKey of Object.keys(v)) {
    if (n >= TELEMETRY_META_MAX_KEYS) break;
    const key = scrubTelemetryText(rawKey).slice(0, TELEMETRY_META_KEY_MAX);
    if (!key) continue;
    const val = v[rawKey];
    let clean;
    if (typeof val === "string") clean = scrubTelemetryText(val).slice(0, TELEMETRY_META_VAL_MAX);
    else if (typeof val === "number") clean = Number.isFinite(val) ? val : undefined;
    else if (typeof val === "boolean") clean = val;
    else clean = undefined; // object / array / null / undefined -> dropped (content-block)
    if (clean === undefined || clean === "") continue;
    out[key] = clean;
    n++;
  }
  return Object.keys(out).length ? out : null;
}

// Validate + normalize ONE client event into the stored record, with the server
// stamping `ts` (a client-supplied ts is never read). Returns { ok:true, event }
// on success, or { ok:false, hard } on rejection where hard:true marks a
// malformed `kind` (the closed-enum discriminator) - the ONE rejection that makes
// the batch response a loud 400 (the ADR-016 loud-boundary discipline). An
// unknown `surface`, a missing sessionId / name, or a non-object event is a SOFT
// drop (counted, but the batch still returns 200). An invalid OPTIONAL field
// (journey / meta / durationMs) is dropped as a FIELD, never failing the event.
// `ts` is injected so the pure function is deterministic under test.
export function validateTelemetryEvent(raw, ts) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, hard: false };
  // kind: closed enum -> a junk kind is the loud (hard) rejection.
  if (!TELEMETRY_KINDS.includes(raw.kind)) return { ok: false, hard: true };
  // surface: closed allowlist -> unknown is a soft drop.
  if (!TELEMETRY_SURFACES.includes(raw.surface)) return { ok: false, hard: false };
  const sessionId =
    typeof raw.sessionId === "string" ? scrubTelemetryText(raw.sessionId).slice(0, TELEMETRY_SESSION_MAX) : "";
  if (!sessionId) return { ok: false, hard: false };
  const name = typeof raw.name === "string" ? scrubTelemetryText(raw.name).slice(0, TELEMETRY_NAME_MAX) : "";
  if (!name) return { ok: false, hard: false };
  // Server-stamped ts first, then the validated core (client ts is never read).
  const event = { ts: ts || new Date().toISOString(), sessionId, kind: raw.kind, surface: raw.surface, name };
  if (typeof raw.journey === "string" && TELEMETRY_JOURNEY_RE.test(raw.journey)) event.journey = raw.journey;
  const meta = coerceTelemetryMeta(raw.meta);
  if (meta) event.meta = meta;
  if (raw.durationMs !== undefined && raw.durationMs !== null) {
    const d = Number(raw.durationMs);
    if (Number.isFinite(d) && d >= 0) event.durationMs = d;
  }
  return { ok: true, event };
}

// Aggregate the raw jsonl text into the small read model the future insights
// panel consumes. Pure + tolerant: a torn / non-object line is skipped and
// counted in `malformed`, never thrown on. firstTs / lastTs are the min / max
// ISO ts (order-independent - ISO-8601 sorts lexicographically). bySurface /
// byName are top-N descending; byKind is the full (small) enum map, pre-seeded so
// the panel always sees the three kinds. Exported for direct unit testing.
export function summarizeTelemetry(text) {
  const summary = {
    totalEvents: 0,
    firstTs: null,
    lastTs: null,
    byKind: { view: 0, action: 0, run: 0 },
    bySurface: [],
    byName: [],
    malformed: 0,
  };
  const bySurface = new Map();
  const byName = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue; // blank lines are not "malformed"
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      summary.malformed++;
      continue;
    }
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) {
      summary.malformed++;
      continue;
    }
    summary.totalEvents++;
    if (typeof ev.ts === "string" && ev.ts) {
      if (summary.firstTs === null || ev.ts < summary.firstTs) summary.firstTs = ev.ts;
      if (summary.lastTs === null || ev.ts > summary.lastTs) summary.lastTs = ev.ts;
    }
    if (typeof ev.kind === "string" && ev.kind) summary.byKind[ev.kind] = (summary.byKind[ev.kind] || 0) + 1;
    if (typeof ev.surface === "string" && ev.surface) bySurface.set(ev.surface, (bySurface.get(ev.surface) || 0) + 1);
    if (typeof ev.name === "string" && ev.name) byName.set(ev.name, (byName.get(ev.name) || 0) + 1);
  }
  const topN = (map, n, key) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, count]) => ({ [key]: k, count }));
  summary.bySurface = topN(bySurface, 15, "surface");
  summary.byName = topN(byName, 20, "name");
  return summary;
}

// POST /api/telemetry - the fire-and-forget beacon target. Body:
//   { events: [ { sessionId, kind, surface, name, journey?, meta?, durationMs? } ] }
// Envelope guards (hard 400, nothing appended): body not an object, `events` not
// an array, or a batch over the count cap. Then each event is validated; VALID
// events are appended in ONE write for the whole batch (the activity-log jsonl
// pattern - per-line atomicity, append-only, best-effort), invalid ones dropped
// and counted. Response { accepted, dropped }; the status is a loud 400 IFF at
// least one event had a malformed `kind` (otherwise 200, even with soft drops),
// so a broken client is surfaced without discarding the valid events that shipped
// alongside it. Body size is capped by the global express.json 100kb default
// (deliberately not raised).
app.post("/api/telemetry", (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.events)) {
      return res.status(400).json({ error: "events must be an array", accepted: 0, dropped: 0 });
    }
    if (body.events.length > TELEMETRY_MAX_BATCH) {
      return res
        .status(400)
        .json({ error: `batch exceeds ${TELEMETRY_MAX_BATCH} events`, accepted: 0, dropped: body.events.length });
    }
    const ts = new Date().toISOString(); // server receipt time; one stamp per batch
    const valid = [];
    let dropped = 0;
    let hard = false;
    for (const raw of body.events) {
      const r = validateTelemetryEvent(raw, ts);
      if (r.ok) valid.push(r.event);
      else {
        dropped++;
        if (r.hard) hard = true;
      }
    }
    store.appendTelemetry(valid); // one write for the whole batch; no-op on empty
    res.status(hard ? 400 : 200).json({ accepted: valid.length, dropped });
  } catch (e) {
    // A telemetry beacon must never throw into the client - best-effort by charter.
    res.status(500).json({ error: String(e.message || e), accepted: 0, dropped: 0 });
  }
});

// GET /api/telemetry/summary - the small read model for the future insights
// panel. Tolerant: a missing file is an empty summary (never a 500), a malformed
// line is skipped + counted. No raw-event dump endpoint in v1 (the insights
// routine reads docs/usage-telemetry.jsonl directly).
app.get("/api/telemetry/summary", (req, res) => {
  // store.readTelemetryText() is tolerant (missing file -> ""), so summarize is
  // always over a string and this can never 500 on an absent file.
  res.json(summarizeTelemetry(store.readTelemetryText()));
});

// ---- notification feed (derived, no push infra) ---------------------------
// A read-mostly event feed DERIVED from data the app already records - there is
// no push infrastructure and no event store (ADR-007). Sources:
//   run_finished  - a single (non-batch) runner run reached a terminal status,
//                   read from the DURABLE activity log (docs/activity-log.jsonl).
//   wave_done     - every run of a batch reached terminal, folded from the same
//                   log by batchId (the field startRun now stamps on run lines).
//   task_added /  - computed by DIFFING the current tasks.yaml / portfolio.yaml
//   task_done /     ids+statuses against a persisted BASELINE snapshot (there is
//   project_added   no watcher on those files, so a diff is how we detect change).
// The baseline + a read cursor live in ONE small app-managed JSON state file
// (docs/notify-state.json), written atomically. This endpoint is the ONE write
// the feed ever makes, and it writes ONLY that state file - never Jobs/, never
// tasks.yaml, never the workbook. Disclosed in DATA_CONTRACT.md + ADR-007.
//
// Event shape: { id, type, ts, title, ref, unread }. `unread` is true for every
// diff event (a task/project change is unacknowledged until the next read) and,
// for an activity event, when its ts is strictly after the cursor. The returned
// feed is newest-first and capped; `unread` (the count) is over ALL derived
// events, not just the capped slice, so a bell badge reflects everything.
// notify-state.json path + atomic read/write now live in the storage seam
// (store.loadNotifyState / store.saveNotifyState).
const NOTIFY_FEED_CAP = 50; // newest-N events returned (unread count is uncapped)
// Last-N activity lines scanned per request (cheap). ACCEPTED AGING
// (t-1783091385623 item 3, review 2026-07-03): a batch whose start/close lines
// straddle this boundary can compute PARTIAL wave_done counts - fine for a
// derived convenience feed (the durable log itself is complete; the RunPanel /
// batch endpoint stay exact). Raise the tail before reaching for anything
// stateful if this ever bites.
const NOTIFY_ACTIVITY_TAIL = 300;
const TERMINAL_RUN_STATUS = new Set(["done", "failed", "stopped"]);

// loadNotifyState / saveNotifyState moved behind the storage seam
// (store.loadNotifyState / store.saveNotifyState). Uninitialized-shape tolerance
// and the atomic state write are unchanged.

// A literal YYYY-MM-DD (task/project `created`) -> an ISO ts at UTC midnight, so a
// diff event sorts by its real creation day; anything else -> the fallback ts.
function isoFromLocalDate(d, fallback) {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : fallback;
}

// Snapshot the CURRENT task board as id -> status, plus title/created lookups.
// Tolerant: a missing / unreadable tasks.yaml yields empty maps (never throws).
function taskSnapshot() {
  const status = {}, title = {}, created = {};
  try {
    for (const t of store.loadTasks().tasks) {
      if (!t || typeof t !== "object" || !t.id) continue;
      status[t.id] = typeof t.status === "string" ? t.status : "";
      title[t.id] = typeof t.title === "string" && t.title.trim() ? t.title : t.id;
      created[t.id] = typeof t.created === "string" ? t.created : "";
    }
  } catch {
    /* no tasks.yaml -> empty snapshot */
  }
  return { status, title, created };
}

// Snapshot the CURRENT portfolio projects (ids + name/created lookups). Read the
// same way GET /api/portfolio does, normalized so a partial file can't throw.
function projectSnapshot() {
  const name = {}, created = {}, ids = [];
  try {
    const data = store.getPortfolio(); // same ensureArrays-normalized read as GET /api/portfolio
    for (const p of data.projects) {
      if (!p || typeof p !== "object" || !p.id) continue;
      ids.push(p.id);
      name[p.id] = typeof p.name === "string" && p.name.trim() ? p.name : p.id;
      created[p.id] = typeof p.created === "string" ? p.created : "";
    }
  } catch {
    /* no portfolio.yaml -> no projects */
  }
  return { ids, name, created };
}

// Parse the tail of the activity log into records (newest history bounded to
// NOTIFY_ACTIVITY_TAIL lines so per-request work stays cheap). Skips torn lines.
function activityTail() {
  let raw;
  try {
    raw = store.readActivityText();
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/).filter((l) => l.trim()).slice(-NOTIFY_ACTIVITY_TAIL)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

// Fold kind:"run" lines into run_finished (single runs) + wave_done (batches).
// A run's start line carries routine/label/jobId/batchId; its close line carries
// the terminal status + a later ts. Folding by runId keeps the latest of each, so
// a run appears once. Batch members do NOT emit their own run_finished - the
// batch surfaces once, as a single wave_done when ALL its runs are terminal.
function deriveActivityEvents(records) {
  const byRun = new Map();
  for (const r of records) {
    if (!r || r.kind !== "run" || typeof r.runId !== "string") continue;
    const cur = byRun.get(r.runId) || { runId: r.runId, batchId: null };
    if (r.routine != null) cur.routine = r.routine;
    if (r.label != null) cur.label = r.label;
    if (r.jobId !== undefined) cur.jobId = r.jobId;
    if (r.batchId != null) cur.batchId = r.batchId;
    if (r.status != null) cur.status = r.status;
    if (typeof r.ts === "string" && (!cur.ts || r.ts > cur.ts)) cur.ts = r.ts;
    byRun.set(r.runId, cur);
  }
  const events = [];
  const batches = new Map();
  for (const run of byRun.values()) {
    if (run.batchId) {
      const b = batches.get(run.batchId) || { batchId: run.batchId, runs: [], routine: null, label: null };
      b.runs.push(run);
      if (!b.routine && run.routine) b.routine = run.routine;
      if (!b.label && run.label) b.label = run.label;
      batches.set(run.batchId, b);
      continue;
    }
    if (!TERMINAL_RUN_STATUS.has(run.status)) continue;
    events.push({
      id: `run:${run.runId}`,
      type: "run_finished",
      ts: run.ts || null,
      title: `${run.label || run.routine || "Routine"} ${run.status}`,
      ref: { kind: "run", runId: run.runId, routine: run.routine || null, jobId: run.jobId || null, status: run.status },
    });
  }
  for (const b of batches.values()) {
    if (!b.runs.length || !b.runs.every((r) => TERMINAL_RUN_STATUS.has(r.status))) continue;
    const done = b.runs.filter((r) => r.status === "done").length;
    // Count the three terminal outcomes separately (t-1783091385623 item 2):
    // `failed` used to be `total - done`, which lumped USER-STOPPED members in
    // with genuine failures - so a batch the owner deliberately stopped read as
    // "blocked" in the panel tint. `stopped` is its own count now; the client
    // tint (src/lib/notifications.ts) treats failed as attention, stopped as
    // paused.
    const failed = b.runs.filter((r) => r.status === "failed").length;
    const stopped = b.runs.filter((r) => r.status === "stopped").length;
    const ts = b.runs.reduce((m, r) => (r.ts && (!m || r.ts > m) ? r.ts : m), null);
    events.push({
      id: `wave:${b.batchId}`,
      type: "wave_done",
      ts,
      title: `${b.label || b.routine || "Batch"} wave complete (${done}/${b.runs.length})`,
      ref: { kind: "batch", batchId: b.batchId, total: b.runs.length, done, failed, stopped },
    });
  }
  return events;
}

// Diff the current task/project snapshots against the persisted baseline. Every
// event here is a change the user has not acknowledged yet, so all are marked
// _unread; they clear only when POST /api/notifications/read snapshots a new
// baseline. A task unknown at baseline -> task_added; a known task that has newly
// reached "done" -> task_done; a project id unknown at baseline -> project_added.
function deriveDiffEvents(baseline, tasks, projects, nowIso) {
  const events = [];
  for (const id of Object.keys(tasks.status)) {
    const base = baseline.tasks[id];
    if (base === undefined) {
      events.push({
        id: `task-added:${id}`, type: "task_added",
        ts: isoFromLocalDate(tasks.created[id], nowIso),
        title: `New ticket: ${tasks.title[id]}`,
        ref: { kind: "task", id }, _unread: true,
      });
    } else if (base !== "done" && tasks.status[id] === "done") {
      events.push({
        id: `task-done:${id}`, type: "task_done",
        ts: nowIso, // tasks.yaml has no completion timestamp; recency is the useful signal
        title: `Ticket done: ${tasks.title[id]}`,
        ref: { kind: "task", id }, _unread: true,
      });
    }
  }
  const baseProjects = new Set(baseline.projects);
  for (const id of projects.ids) {
    if (baseProjects.has(id)) continue;
    events.push({
      id: `project-added:${id}`, type: "project_added",
      ts: isoFromLocalDate(projects.created[id], nowIso),
      title: `New project: ${projects.name[id]}`,
      ref: { kind: "project", id }, _unread: true,
    });
  }
  return events;
}

// Assemble the full derived feed once (activity + diff), newest-first, tagging
// each event's `unread` and stripping the internal `_unread` marker. Shared by
// GET (returns it) and POST /read (looks up an event's ts by id).
function buildNotifications(state, tasks, projects, records, nowIso) {
  const cursor = state.cursor;
  const raw = [...deriveActivityEvents(records), ...deriveDiffEvents(state.baseline, tasks, projects, nowIso)];
  const events = raw.map((e) => {
    const unread = e._unread === true || (typeof e.ts === "string" && (cursor === null || e.ts > cursor));
    const { _unread, ...rest } = e;
    return { ...rest, unread };
  });
  events.sort((a, b) => (b.ts || "").localeCompare(a.ts || "")); // newest-first; null ts sinks
  return events;
}

app.get("/api/notifications", (req, res) => {
  try {
    const state = store.loadNotifyState();
    const tasks = taskSnapshot();
    const projects = projectSnapshot();
    const records = activityTail();
    const nowIso = new Date().toISOString();
    // First ever call: seed the baseline to CURRENT state and the cursor to now,
    // so we do not flood the feed with every pre-existing task/project/run as if
    // it were brand new. This is the only write GET makes, and only once.
    if (!state.initialized) {
      state.baseline = { tasks: { ...tasks.status }, projects: [...projects.ids] };
      state.cursor = nowIso;
      store.saveNotifyState(state);
    }
    const all = buildNotifications(state, tasks, projects, records, nowIso);
    res.json({
      events: all.slice(0, NOTIFY_FEED_CAP),
      unread: all.reduce((n, e) => n + (e.unread ? 1 : 0), 0),
      cursor: state.cursor,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Mark the feed read up to a watermark: advance the cursor (activity events at
// or before it become read) AND snapshot the current task/project state as the
// new baseline (so the diff events clear). Body: { ts } (explicit watermark) or
// { id } (use that event's ts); with neither, "now". The cursor never moves
// backwards. This is a client-initiated write - nothing here fires on the
// server's own initiative.
app.post("/api/notifications/read", (req, res) => {
  try {
    const body = req.body || {};
    const state = store.loadNotifyState();
    const tasks = taskSnapshot();
    const projects = projectSnapshot();
    const nowIso = new Date().toISOString();
    let cursor = typeof body.ts === "string" && body.ts ? body.ts : null;
    if (!cursor && typeof body.id === "string" && body.id) {
      const hit = buildNotifications(state, tasks, projects, activityTail(), nowIso).find((e) => e.id === body.id);
      cursor = hit && hit.ts ? hit.ts : null;
    }
    if (!cursor) cursor = nowIso;
    if (state.cursor && cursor < state.cursor) cursor = state.cursor; // never regress
    state.cursor = cursor;
    state.baseline = { tasks: { ...tasks.status }, projects: [...projects.ids] };
    store.saveNotifyState(state);
    res.json({ ok: true, cursor: state.cursor });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- routine runner (scoped autonomous agent) -----------------------------
// A "Run" button launches the matching vault routine as a headless Claude Code
// agent, restricted to an explicit, config-editable allow-list of tools
// (config.json -> claudeAllowedTools). It reads/writes the vault files and
// never auto-submits. The agent's work streams back as stream-json events
// (t-1783650926662) which the runner folds into the run record LIVE - a
// readable transcript, the current activity, per-routine milestones, and a
// duration estimate - polled by the UI.
//
// DATA-CONTRACT SCOPE (ADR-005, docs/product-decisions.md): the routine runner is the
// human-click-gated, DELIBERATELY broad-scope path - distinct from the file
// bridge. It spawns the agent with cwd one level ABOVE Jobs/ (WORKSPACE_DIR) and
// a config-editable tool list (Bash/Write/WebFetch) so routines can legitimately
// reach ops/facts/, run scripts, and fetch a posting. The DATA_CONTRACT.md
// "never touches anything outside Jobs/" guarantee scopes ONLY the file bridge
// (read/write/create/open), NOT this runner. The runner still never auto-submits
// and every run is visible + stoppable in the UI. Do NOT remove tools the
// routines need (discover-jobs / first-draft-job / finalize-job run scripts and
// write CVs) - that would break them. The defensive guard below is on the ONE
// filesystem path the runner builds from client input (the job folder).
//
// AGENT BINDING (2026-07-04, ADR-015): each PRODUCT routine now also runs AS its
// owning Career Delivery agent (discover-jobs -> job-search-scout, first-draft-job
// / finalize-job -> application-writer) via the CLI `--agent` flag, so the run
// inherits that agent's persona, guardrails, and model default instead of the
// default agent. This is a PERSONA binding, NOT a permission change: it was
// verified empirically (see ADR-015) that `--agent` does NOT broaden the
// session's tool scope past `--allowedTools` even when the bound agent's own
// frontmatter declares "tools: All tools" - the allow-list / permission-mode gate
// below stays the hard tool ceiling and the agent's tool declaration is
// subordinate to it. The two ticket-scoped routines keep NO agent by design
// (their persona is embedded in the prompt).
const WORKSPACE_DIR = path.dirname(JOBS_DIR);

// Resolve + contain a client-supplied jobId to a real folder INSIDE Jobs/ now
// lives in the storage seam (store.jobFolderPath): a traversal id ("../foo") can
// never aim outside the vault's Jobs/ tree; returns the absolute folder path or
// null to reject.

// Ticket-scope companion to resolveJobFolder, for scope: "ticket" routines
// (work-ticket). A ticket id is a docs/tasks.yaml record key, not a filesystem
// path, so there is no path to traverse out of - existence is a plain equality
// check against the real task ids (loadTasks, defined below in the task-board
// section; a `function` declaration, so it is hoisted and callable here
// regardless of file order). A traversal-shaped or unknown id simply matches no
// task and falls through to false, same as any other unknown id - it is never
// treated as special. Returns a boolean (unlike resolveJobFolder, which returns
// the resolved path other callers still need) because every caller here only
// needs to know whether the id resolves.
function ticketExists(ticketId) {
  if (typeof ticketId !== "string" || !ticketId) return false;
  try {
    return store.loadTasks().tasks.some((t) => t.id === ticketId);
  } catch {
    return false; // tasks.yaml missing/unreadable -> no ticket can resolve
  }
}

// One existence-check dispatcher for /api/routines/run, so adding a scope
// (ticket) is one new branch here rather than a second copy-pasted validation
// block in the route handler. scope: "global" (discover-jobs) carries no id,
// so it always passes; everything downstream of this check (concurrency,
// run tracking, GET /api/routines/run/:runId, activity-log, Stop) is scope-
// agnostic already and needs no change.
function scopeIdExists(scope, id) {
  if (scope === "job") return !!store.jobFolderPath(id);
  if (scope === "ticket") return ticketExists(id);
  return true;
}

function resolveClaude() {
  if (config.claudeBin && fs.existsSync(config.claudeBin)) return config.claudeBin;
  const guess = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
  if (fs.existsSync(guess)) return guess;
  return process.platform === "win32" ? "claude.exe" : "claude";
}
const CLAUDE_BIN = resolveClaude();
const ALLOWED_TOOLS = config.claudeAllowedTools || "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,Bash,Task,TodoWrite";

// Whitelisted routines only - the client never supplies a free-form prompt.
// SAFETY (ticket-scoped routines: work-ticket, assess-ticket): every other
// routine's prompt is a fixed, hand-written string; the two ticket-scoped
// routines are the exception - their instructions point the agent at a TICKET
// (docs/tasks.yaml) whose title/detail/acceptance text originates as the
// user's free-typed chatbot input, not from us. That is a deliberate widening
// of what one prompt asks the agent to DO, not a relaxation of the runner's
// sandbox: `claudeAllowedTools` (ALLOWED_TOOLS below) is unchanged and applies
// to these routines exactly like the others. It stays inside ADR-005's
// existing posture (docs/product-decisions.md, incl. the ticket-scope addendum) - the
// routine runner is already the human-click-gated, broad-scope path, distinct
// from the file bridge. The route is also confirm-gated CLIENT-SIDE (the
// chatbot's "delegate now" requires an explicit user confirm before it ever
// calls POST /api/routines/run) and gated HERE by the ticket-existence check
// below (scopeIdExists) - nothing on the server fires a ticket run on its own.
// work-ticket EXECUTES the ticket; assess-ticket is comment-only BY CHARTER:
// its prompt forbids doing the work, editing code/files, or creating tickets -
// it records one CTO assessment comment back through this app's own task API.
// ROUTINE -> OWNING AGENT (product routines only). docs/agents.yaml is the single
// source of truth for the org chart, and its `owns` lists already declare which
// Career Delivery agent owns each product routine. The runner used to spawn EVERY
// routine as the default agent, so these buttons ran without the persona,
// guardrails, and model default that agents.yaml assigns them - the declaration
// existed but the runtime did not enforce it. The `agent` field below binds each
// product routine to its owner; startRun appends `--agent <id>` so the run
// executes AS that agent (see the AGENT BINDING note above WORKSPACE_DIR, ADR-015):
//   discover-jobs   -> job-search-scout   (owns: Discovery + posting triage)
//   first-draft-job -> application-writer  (owns: CV + cover letter generation)
//   finalize-job    -> application-writer  (owns: ATS optimization + render)
//   merge-application-pdf -> application-writer (owns: the render pipeline's output)
//   draft-follow-up -> application-writer  (owns: candidate-authored outreach)
//   interview-prep  -> interview-offer-coach (owns: STAR + interview readiness)
//   offer-prep      -> interview-offer-coach (owns: negotiation + offer comparison)
// The two ticket-scoped routines deliberately carry NO `agent`: their persona is
// embedded in the prompt itself (assess-ticket is literally "You are the CTO"), so
// the generic agent running that prompt already IS the intended persona; binding
// one would be redundant and is out of scope.
//
// TIERS: each product routine also pins the MODEL + EFFORT its owning agent
// documents, scoped to these button runs (NOT the agent frontmatter, which is
// deliberately left tier-unpinned). application-writer is "Opus at high" for
// employer-facing output -> first-draft-job / finalize-job pin opus/high; its
// documented carve-out drops a large first-draft BATCH to Sonnet, encoded as
// batchModel/batchEffort and applied by startRun only when batchId is set.
// discover-jobs is high-volume triage -> sonnet/medium. See ADR-015 addendum.
const ROUTINES = {
  "discover-jobs": { label: "Discover jobs", scope: "global", agent: "job-search-scout", model: "sonnet", effort: "medium", prompt: () => "run discover-jobs" },
  "first-draft-job": {
    label: "Draft CV + cover letter",
    scope: "job",
    agent: "application-writer",
    model: "opus",
    effort: "high",
    // application-writer's documented carve-out: a large first-draft BATCH (30+
    // jobs) drops the mechanical per-job renders to Sonnet to dodge the session /
    // token-limit hit (the render itself is a deterministic script). Single runs
    // stay on Opus/high for quality. startRun uses batch* only when batchId is set.
    batchModel: "sonnet",
    batchEffort: "medium",
    prompt: (folder) => `run first-draft-job for "${folder}"`,
    // Milestones for the live progress UI (t-1783650926662): the routine's
    // recipe phases (vault ops/routines/first-draft-job.md), each detected from
    // the agent's own tool calls (matchRunStage, server/lib.js). Heuristic and
    // display-only - a missed match never affects the run itself.
    stages: [
      { label: "Read posting + job file", match: { tools: ["Read", "Glob", "Grep", "WebFetch"] } },
      { label: "Read facts", match: { tools: ["Read"], path: /ops[\\/]+facts/i } },
      { label: "Tailor CV + cover letter", match: { tools: ["Write", "Edit"], path: /application-content\.json/i } },
      { label: "Render documents", match: { tools: ["Bash"], path: /render_application/i } },
      {
        label: "Update job file + wrap up",
        match: { tools: ["Write", "Edit"], path: /\.md/i, exclude: /job-description\.md|gaps\.md/i },
      },
    ],
  },
  "finalize-job": {
    label: "Finalize application",
    scope: "job",
    agent: "application-writer",
    model: "opus",
    effort: "high",
    prompt: (folder) => `run finalize-job for "${folder}"`,
    // Milestones per the finalize-job recipe (vault ops/routines/finalize-job.md).
    stages: [
      { label: "Read gaps + current draft", match: { tools: ["Read", "Glob", "Grep"] } },
      { label: "Fold answers into facts", match: { tools: ["Write", "Edit"], path: /ops[\\/]+facts/i } },
      { label: "Re-tailor application content", match: { tools: ["Write", "Edit"], path: /application-content\.json/i } },
      { label: "Render final documents + PDFs", match: { tools: ["Bash"], path: /render_application/i } },
      {
        label: "Update job file + wrap up",
        match: { tools: ["Write", "Edit"], path: /\.md/i, exclude: /job-description\.md|gaps\.md/i },
      },
    ],
  },
  // Merge the rendered cover letter + CV PDFs into ONE submission-ready PDF
  // (ticket t-1783650792067). An OPTIONAL post-finalize convenience, never a
  // required pipeline stage: it neither gates nor advances any status
  // (nextStatusAfterRun ignores it), and the drawer only offers it when the
  // job's mergePdfReady flag says both current PDFs exist. BOUND to the
  // application-writer (the render pipeline and its outputs are that agent's
  // charter) per ADR-015. TIER sonnet/medium, not the writer's opus/high: the
  // work is running ONE deterministic vault script
  // (ops/scripts/merge_application_pdf.py, which orders cover-letter-first,
  // self-verifies the page count, and hard-fails loudly) - zero generative
  // judgment, the same mechanical tier as draft-follow-up. It writes exactly
  // one new file into the job folder and NEVER touches the source PDFs.
  "merge-application-pdf": {
    label: "Merge PDF into one file",
    scope: "job",
    agent: "application-writer",
    model: "sonnet",
    effort: "medium",
    prompt: (folder) =>
      `You are the application-writer merging the rendered application PDFs for the job at "${folder}" into ONE submission-ready PDF (cover letter first, then CV). Merge ONLY - combine the existing rendered files; never regenerate, rewrite, or submit anything. ` +
      `(1) CHECK the job folder "Jobs/${folder}": it must contain a current cover letter PDF and a current CV PDF (dated copies like "... (YYYY-MM-DD).pdf" are history - ignore them). If either PDF is missing, say so and exit cleanly, noting that finalize-job renders the submission PDFs - do NOT render, convert, or invent anything yourself. ` +
      `(2) RUN the deterministic merge script from the workspace root: python ops/scripts/merge_application_pdf.py --job "Jobs/${folder}" . It writes "Simon Kim - Application - <Role>.pdf" into the job folder (overwriting a stale merged PDF is expected - it is a generated artifact) and verifies the merged page count equals cover letter + CV. If the script fails, report its error output and stop - do NOT hand-assemble the PDF another way. ` +
      `(3) VERIFY the merged PDF now exists on disk in the job folder and report its filename and page count. ` +
      `Hard limits (data contract): write ONLY the merged PDF inside the job folder "Jobs/${folder}"; never modify or delete the source PDFs, the job file, or any other file; NEVER submit the application or send anything - local-only; never delete anything; no em dashes.`,
  },
  // Draft a follow-up email (US-6). A scope:"job" product routine BOUND to the
  // application-writer (docs/agents.yaml `application-writer`, kind:"agent"): a
  // check-in note that reaffirms fit is candidate-authored outreach from the
  // facts, so the run inherits that agent's persona/guardrails (generate-from-
  // facts, never auto-submit / human submits, local-only, no em dashes) per
  // ADR-015. It DRAFTS ONLY - the email is NEVER sent; the routine writes a draft
  // file into the job folder for Simon to review and send himself (data
  // contract: edit files only, never submit, never send off-machine). The US-2
  // follow-up bucket (submitted + applied >= 7d) is where this action surfaces.
  // TIER: sonnet/medium, NOT the opus/high the agent file pins for first-draft /
  // finalize. The agent's Opus/high default is justified there as "Simon's real,
  // employer-facing output" carrying the CV/cover-letter JUDGMENT (track mapping,
  // tailoring, cover-letter prose); a short check-in email is low-judgment
  // generate-from-facts outreach - the same routine-prep tier interview-prep
  // takes (sonnet/medium) vs offer-prep's high-stakes opus/high. No batch
  // carve-out (single-action bucket, not a bulk render), mirroring finalize-job.
  "draft-follow-up": {
    label: "Draft follow-up email",
    scope: "job",
    agent: "application-writer",
    model: "sonnet",
    effort: "medium",
    prompt: (folder) =>
      `You are the application-writer drafting a follow-up email for the SUBMITTED job at "${folder}". Draft ONLY - the email is NEVER sent; you write a draft file for Simon to review and send himself. ` +
      `(1) READ the job folder "${folder}" (its <Role>.md job file - role, employer, status, applied date - and the posting) and Simon's real record (ops/facts/*.yaml, wiki/master-profile.md). If the job file or facts are missing, say so and exit cleanly - never invent a fact, a metric, or a detail. ` +
      `(2) WRITE a concise, professional follow-up email as a NEW draft file INSIDE the job folder "${folder}" (e.g. "Follow-up email.md"): a short check-in on the application that politely reaffirms fit for this role in a few tight sentences, grounded ONLY in Simon's real facts and this posting. Do NOT edit the job file, the posting, or any file outside this job folder. ` +
      `Hard limits (data contract): generate FROM facts, never fabricate or inflate; edit files only - NEVER send the email, submit the application, or contact the employer (no email leaves the machine; this is a draft for Simon to send himself); local-only - nothing leaves the machine; never delete anything; no em dashes.`,
  },
  // Late-stage interview + offer prep (US-4 / US-5). Two scope:"job" product
  // routines BOUND to the interview-offer-coach (docs/agents.yaml
  // `interview-offer-coach`, kind:"agent"): once a job hits interview/offer,
  // getting Simon ready is that agent's charter, so the runs inherit its
  // persona/guardrails (ground-in-facts, local-only, personal-Chrome-only,
  // never the maplearmor work browser, no em dashes) per ADR-015. Both READ
  // the job file + ops/facts and WRITE prep materials INTO the job folder;
  // they EDIT FILES ONLY and NEVER submit, send, accept, or decline anything
  // (data contract). TIERS follow what the agent file documents (line: "routine
  // prep is Sonnet at medium; live negotiation strategy and offer analysis are
  // high-stakes reasoning - Opus at high"):
  //   interview-prep -> sonnet/medium (STAR + prep-sheet generation = routine prep)
  //   offer-prep     -> opus/high     (negotiation strategy + offer analysis =
  //                     real compensation on the line, the agent's Opus/high case)
  "interview-prep": {
    label: "Interview prep (STAR)",
    scope: "job",
    agent: "interview-offer-coach",
    model: "sonnet",
    effort: "medium",
    prompt: (folder) =>
      `You are the interview and offer coach preparing Simon for the "${folder}" role. Interview-prep ONLY - generate materials, never submit, send, or contact anyone. ` +
      `(1) READ the job folder "${folder}" (its <Role>.md job file + the posting) and Simon's real record (ops/facts/*.yaml, wiki/master-profile.md). If the job file or facts are missing, say so and exit cleanly - never invent a story, a metric, or an achievement. ` +
      `(2) Reach for the interview-prep-generator skill to build, GROUNDED IN SIMON'S ACTUAL FACTS: STAR stories, a tailored prep sheet, and the likely questions + talking points for this role and employer; prepare references with reference-list-builder if useful. ` +
      `(3) WRITE these prep materials as two files INSIDE the job folder "${folder}": an "Interview prep.md" prep sheet and a "STAR stories.md" bank. Do NOT edit the posting or any file outside this job folder. ` +
      `(4) ALSO write "Interview prep feedback.md" in the same folder - a SHORT review note for Simon in the gaps-note style: a handful of "- [ ]" tick-box CLARIFYING QUESTIONS whose answers would sharpen the prep (e.g. confirm the interview format/panel, a project he wants to foreground, a weak spot to rehearse), plus a "Your comments ->" line for him to flag anything wrong or to change. This note is how Simon steers a later Refine, so keep it tight and specific to this role. ` +
      `Hard limits (data contract): generate FROM facts, never fabricate; edit files only, NEVER submit an application, send a message, or contact the employer; local-only - nothing leaves the machine beyond read-only research; never delete anything; no em dashes.`,
  },
  // Interview-prep REFINE (Part 3): the "finalize" analog for the interview loop.
  // Bound to the interview-offer-coach, same sonnet/medium tier as the draft. It
  // reads the CURRENT prep docs + Simon's feedback note and regenerates the docs
  // IN PLACE incorporating his answers/comments; the runner keeps a dated copy of
  // the prior docs first (Part 2). It never rewrites the feedback note (his input).
  "interview-prep-refine": {
    label: "Refine interview prep",
    scope: "job",
    agent: "interview-offer-coach",
    model: "sonnet",
    effort: "medium",
    prompt: (folder) =>
      `You are the interview and offer coach REFINING Simon's existing interview prep for the "${folder}" role, using his feedback. Refine ONLY - regenerate materials, never submit, send, or contact anyone. ` +
      `(1) READ the job folder "${folder}": the current "Interview prep.md" and "STAR stories.md", the "Interview prep feedback.md" note (Simon's answers to your clarifying questions and his comments on what to change), plus the <Role>.md job file, the posting, and Simon's real record (ops/facts/*.yaml, wiki/master-profile.md). If the prep docs or the feedback note are missing, say so and exit cleanly - never invent anything. ` +
      `(2) REGENERATE "Interview prep.md" and "STAR stories.md" IN PLACE (same filenames), incorporating Simon's feedback and answers - fix anything he flagged as wrong, fold in the details he provided, keep everything GROUNDED IN HIS ACTUAL FACTS. Do NOT rewrite the feedback note (it is his input); do NOT edit the posting or any file outside this job folder. ` +
      `Hard limits (data contract): generate FROM facts, never fabricate; edit files only, NEVER submit an application, send a message, or contact the employer; local-only - nothing leaves the machine beyond read-only research; never delete anything; no em dashes.`,
  },
  "offer-prep": {
    label: "Prep offer / negotiation",
    scope: "job",
    agent: "interview-offer-coach",
    model: "opus",
    effort: "high",
    prompt: (folder) =>
      `You are the interview and offer coach preparing Simon's offer response for the "${folder}" role. Offer-prep ONLY - produce a strategy, never accept, decline, send, or negotiate on Simon's behalf. ` +
      `(1) READ the job folder "${folder}" (its <Role>.md job file, any recorded offer terms, and the posting) and Simon's real record (ops/facts/*.yaml, wiki/master-profile.md). If the offer terms or facts are missing, say so and exit cleanly - never invent an offer, a competing offer, or a number. ` +
      `(2) Reach for salary-negotiation-prep to research market rates (read-only research only) and build a negotiation strategy - state the anchor, target, and walk-away plus a counter script; reach for offer-comparison-analyzer to weigh this against any REAL competing offer on total compensation + fit. ` +
      `(3) WRITE the offer comparison and negotiation strategy as new files INSIDE the job folder "${folder}". Do NOT edit any file outside this job folder. ` +
      `Hard limits (data contract): ground everything in Simon's real facts and researched rates, never fabricate; edit files only, NEVER send, accept, decline, or auto-submit any response; local-only - nothing leaves the machine beyond read-only research; never delete anything.`,
  },
  // Usage-journey insights (ADR-017 Wave 3). A GLOBAL-scope product routine that
  // turns the raw usage telemetry into a dated review + at most 3 triage
  // recommendation tickets. BOUND to the Product Manager (docs/agents.yaml
  // `product-manager`, kind:"agent"): learning from real usage and turning it
  // into scoped, evidence-backed recommendations is PM work, so the run inherits
  // that agent's persona/guardrails (evidence-over-opinion, what/why-not-how,
  // never a second store) per ADR-015. Analysis tier: sonnet/medium - it reads a
  // jsonl, aggregates, writes ONE report, and files <=3 tickets; no employer-facing
  // output, so it does not need Opus. Read-and-recommend ONLY: the prompt forbids
  // editing anything but its own report and forbids deletes.
  "usage-insights": {
    label: "Usage insights",
    scope: "global",
    agent: "product-manager",
    model: "sonnet",
    effort: "medium",
    prompt: () =>
      `You are the product manager running the usage-insights review (docs/routines/usage-insights.md). Analysis and recommendations ONLY - never build, never edit product code. ` +
      `(1) READ docs/usage-telemetry.jsonl (one JSON event per line: kind, surface, name, journey?, meta?, ts). If that file is MISSING or empty, write a short report saying no usage has been recorded yet and exit cleanly - never fabricate data. Also READ docs/user-journeys.md for the canonical J-id set. ` +
      `(2) COMPUTE from the events: most- and least-used surfaces (by count); journey coverage (which J-ids appear vs the full set in user-journeys.md); keyboard-vs-button triage adoption (from meta.via); and funnel drop-offs (the view->action ratio per surface). ` +
      `(3) WRITE a dated report at docs/usage-reviews/YYYY-MM-DD.md (create the docs/usage-reviews/ directory on first run; use today's LOCAL date). Frontmatter must include "type: usage-review" and "date: YYYY-MM-DD". Body: the findings above, each with the numbers behind it. ` +
      `(4) FILE AT MOST 3 recommendation tickets - only genuine, evidence-backed improvements, fewer is better, and none if the data does not support one. Each ticket enters the normal triage flow via: curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"<recommendation>","detail":"<the evidence from the data>","labels":["usage-insight"],"status":"triage"}' http://127.0.0.1:${PORT}/api/tasks . ` +
      `Hard limits: do NOT edit any code or docs except your own docs/usage-reviews/ report; do NOT delete anything; do NOT modify any existing ticket.`,
  },
  "work-ticket": {
    label: "Work ticket",
    scope: "ticket",
    prompt: (ticketId) =>
      `Read ticket "${ticketId}" from docs/tasks.yaml (its title, detail, and acceptance fields) and do the work it describes, following this project's normal conventions and never touching anything outside this app's usual read/write paths. Never hand-edit tasks.yaml directly - when finished (or blocked), record the outcome by calling this app's own API: curl -s -X PATCH -H 'Content-Type: application/json' -d '{"status":"done"}' http://localhost:${PORT}/api/tasks/${ticketId} (use "in_progress" instead of "done" if the work is not complete, and say why).`,
  },
  "assess-ticket": {
    label: "CTO assessment",
    scope: "ticket",
    // Comment-only BY CHARTER: deny the file-mutation tools so the "do NOT edit
    // any code or files" rule is partly ENFORCED, not merely prompted. Bash stays
    // (assess-ticket needs curl to PATCH its comment), so a determined agent could
    // still `echo > file`; this is a bar-raiser / defense-in-depth, not an airtight
    // gate (ADR-005 addendum 2026-07-04). work-ticket keeps the full toolset - it
    // EXECUTES the ticket by design.
    disallowedTools: "Write,Edit,NotebookEdit",
    prompt: (ticketId) =>
      `You are the CTO triaging ticket "${ticketId}" - assessment ONLY, never do the work. ` +
      `First read the ticket through this app's API: curl -s http://localhost:${PORT}/api/tasks and find the task whose id is "${ticketId}" (read its title, detail, and acceptance). ` +
      `Read whatever MINIMAL repo context you need to judge it (source files, docs - read-only). ` +
      `Then record EXACTLY ONE assessment comment on the ticket via the API - never hand-edit docs/tasks.yaml: ` +
      `curl -s -X PATCH -H 'Content-Type: application/json' --data '{"comment":{"author":"cto","body":"<your assessment>"}}' http://localhost:${PORT}/api/tasks/${ticketId} . ` +
      `The comment body must contain: (1) an assessment - is the ticket valid, a duplicate, or needs-info; (2) a concrete plan to address it; (3) the subtasks as a markdown checklist ("- [ ] ..." lines); (4) a suggested owner and priority. ` +
      `If you are confident in the assessment, you may ALSO set the ticket's owner and priority and move its status from triage to todo in the same PATCH body. ` +
      `Hard limits, comment-only by charter: do NOT execute the work, do NOT edit any code or files, do NOT create or modify any other ticket.`,
  },
  // Source-scoped discovery (ADR-016). Launched ONLY by the dedicated
  // POST /api/discovery/sources/:id/run (which appends the optimistic run record
  // and captures the leadsNew baseline); the generic /api/routines/run rejects
  // scope "source", and GET /api/routines hides it, so there is a single
  // bookkeeping path. The prompt is built live from the source's stored
  // instructions/urls.
  "discover-jobs-source": {
    label: "Discover jobs (single source)",
    scope: "source",
    // Same persona + tier binding as the global sweep (ADR-015 discipline): a
    // per-source Run-now is still a discovery run and must carry the scout's
    // pinned guardrails (personal-Chrome-only, never auto-submit) and its
    // cost-appropriate tier - found unbound by the 2026-07-04 governance audit.
    agent: "job-search-scout",
    model: "sonnet",
    effort: "medium",
    // `extra` carries the launch context (runId for the honesty-counter
    // report, sourceId, sourceBaseline) - see startRun.
    prompt: (id, extra) => buildSourceDiscoveryPrompt(id, extra),
  },
  // Instruction-proposal loop (docs/data-schema.md §5 Decision 4, W3
  // t-1783198113775): probe ONE source's landing page and FILE a proposal for
  // new crawl instructions through the app's own API - a research run, never a
  // scrape. Launched ONLY by the dedicated
  // POST /api/discovery/sources/:id/instruction-proposals/propose (the generic
  // /api/routines/run rejects scope "source", GET /api/routines hides it).
  // DELIBERATELY no lastRunAt stamp and no runs[] record: those fields anchor
  // the SCRAPE cadence derivation (due/stale/nextRunAt, ADR-016) and a propose
  // run is not a scrape - stamping them would mark the source fresh without a
  // single lead having been fetched. In-flight state is instead served as the
  // DERIVED proposeRunId (a pure read of the live runs Map, never stored).
  // Owned by job-search-scout (probing a board's fetchability/ATS/listing
  // structure is discovery work); sonnet/medium - no employer-facing output.
  "propose-instructions": {
    label: "Propose crawl instructions",
    scope: "source",
    agent: "job-search-scout",
    model: "sonnet",
    effort: "medium",
    prompt: (id, extra) => buildProposeInstructionsPrompt(id, extra),
  },
};

const runs = new Map(); // runId -> run record (minus the live process handle)
let runSeq = 0;
const MAX_OUTPUT = 200_000;
const MAX_CONCURRENT_RUNS = config.maxConcurrentRuns || 4; // bounded parallelism
const MAX_RUN_HISTORY = 40; // keep memory bounded

// Historical run durations power the determinate progress bar
// (t-1783650926662): each run record carries `expectedMs`, the median of the
// last few SUCCESSFUL durations of the same routine, so the UI can show real
// percent-done instead of an endless sweep. Seeded once from the durable
// activity log (start/close line pairs), then kept current in memory as runs
// close. Telemetry-only: no history -> expectedMs null -> the UI falls back
// to the indeterminate sweep.
const RUN_DURATION_CAP = 8; // recent samples per routine (drifts with model/tier changes)
const runDurations = (() => {
  try {
    return runDurationHistory(store.readActivityText(), RUN_DURATION_CAP);
  } catch {
    return new Map(); // no log yet - estimates simply start unavailable
  }
})();
function noteRunDuration(routine, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const arr = runDurations.get(routine) || [];
  arr.push(ms);
  if (arr.length > RUN_DURATION_CAP) arr.shift();
  runDurations.set(routine, arr);
}
function expectedRunMs(routine) {
  return medianMs(runDurations.get(routine) || null);
}

function runningCount() {
  let n = 0;
  for (const r of runs.values()) if (r.status === "running") n++;
  return n;
}

// ---- per-scope keyed run lock (t-1783198713071) -----------------------------
// One live run per (routine, scopeId) - the generalized read behind BOTH the
// per-job/-ticket duplicate guard on /api/routines/run|batch and the W3
// per-source propose-instructions 409 (activeProposeRun below is this with the
// routine pinned). Evidence for the guard: docs/activity-log.jsonl 2026-07-03
// carries two finalize-job runs against the SAME job overlapping for ~4.5
// minutes (r1783121457664_6 started 23:30:57, r1783121486457_7 started
// 23:31:26, both terminal at ~23:35) - two agents concurrently writing one
// job folder's generated artifacts. Same posture as maxConcurrentRuns: an
// in-memory read of live process state, never stored.
function activeRunFor(routine, scopeId) {
  if (!scopeId) return null;
  for (const r of runs.values()) {
    if (r.routine === routine && r.status === "running" && r.jobId === scopeId) return r;
  }
  return null;
}

// The duplicate check the launch endpoints use: a (routine, scopeId) pair is
// busy while a run is LIVE or an identical item is still QUEUED (a queued
// batch item is a promised launch - without this, "batch queues X, user
// clicks Run on X, queue drains X" still double-runs). Together with the
// run-all-due fan-out's own queued/running filter, this holds the invariant:
// at most one instance of (routine, scopeId) across queue + running runs,
// enforced at every entry point - so the drain path needs no re-check.
function hasPendingOrActiveRun(routine, scopeId) {
  if (!scopeId) return false;
  if (activeRunFor(routine, scopeId)) return true;
  return queue.some((q) => q.routine === routine && q.jobId === scopeId);
}

function pruneRuns() {
  if (runs.size <= MAX_RUN_HISTORY) return;
  const finished = [...runs.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  for (const r of finished.slice(0, runs.size - MAX_RUN_HISTORY)) runs.delete(r.id);
}

const queue = []; // pending batch items: { routine, jobId, batchId } (jobId doubles as sourceId for discover-jobs-source items)
// Slots claimed by source launches still inside their async bookkeeping window
// (launchSourceRun's readDiscovery hop, before startRun registers the run).
// Counted alongside runningCount() so a burst of near-simultaneous close
// events cannot over-drain the queue past MAX_CONCURRENT_RUNS.
let pendingSourceLaunches = 0;

// Spawn one routine agent. Shared by single runs and the batch queue. On close
// it kicks the queue so the next pending item starts (bounded parallelism).
// `jobId` doubles as the generic scope-id (a job folder name for scope:"job",
// a ticket id for scope:"ticket") - kept as `jobId` throughout so the run
// record shape and the wire contract (POST body `{ routine, jobId }`) do not
// fork per scope. Any non-"global" scope's prompt() takes that id.
// Apply the run-completion status automation (t-1783390854845) for a finished
// scope:"job" run. Re-derives the job's CURRENT state (toJob, so draftDone
// reflects the files the run just wrote) and, if the pure rule says to advance,
// writes the new status with the surgical updateFrontmatter path - the same write
// the deadline auto-close sweep uses. Entirely best-effort: any failure (job
// gone, no frontmatter, non-writable) is swallowed so a status-automation hiccup
// can never destabilize the run-close path. The nextStatusAfterRun guard
// (queued + draftDone + exit 0 only) keeps this idempotent and pre-submission.
function maybeAutoAdvanceJob(routine, exitCode, folder) {
  try {
    const job = store.getJobSummary(folder);
    const next = nextStatusAfterRun(routine, exitCode, job);
    if (!next || next === job.status) return;
    store.updateJobFields(folder, { status: next });
  } catch {
    /* best-effort automation; never block run close */
  }
}

// Demo replay pump (design 5.2). Fold each transcript line through the shared
// agentEventToUpdate parser on a small interval so the run animates, then finalize
// the run with the same terminal bookkeeping the real close handler does (activity
// close line, duration note, status auto-advance, run-finished broadcast, queue
// kick). Zero spawn, zero model spend.
const DEMO_REPLAY_STEP_MS = Number(process.env.JOBHUNT_DEMO_REPLAY_STEP_MS) || 350;
function runDemoReplay(run, def, routine) {
  const lines = loadTranscriptLines(routine);
  let sawTranscript = false;
  let i = 0;
  const finish = () => {
    run.currentActivity = null;
    run.exitCode = 0;
    if (run.status === "running") run.status = "done";
    noteRunDuration(routine, Date.now() - Date.parse(run.startedAt));
    store.appendActivity({ kind: "run", runId: run.id, status: run.status, exitCode: 0, batchId: run.batchId || null });
    if (def.scope === "job" && run.jobId) maybeAutoAdvanceJob(routine, 0, run.jobId);
    broadcast({ type: "run-finished", runId: run.id, routine, jobId: run.jobId });
    processQueue();
  };
  const step = () => {
    if (run.status !== "running") return; // a Stop from the UI wins
    if (i >= lines.length) return finish();
    const t = String(lines[i++]).trim();
    if (t.startsWith("{")) {
      let evt = null;
      try {
        evt = JSON.parse(t);
      } catch {
        /* ignore a torn line */
      }
      if (evt) {
        const upd = agentEventToUpdate(evt, def.stages || null, run.stageIndex, sawTranscript);
        if (upd.appendText) {
          run.output = (run.output + upd.appendText).slice(-MAX_OUTPUT);
          sawTranscript = true;
        }
        if (upd.activity !== undefined) run.currentActivity = upd.activity;
        run.stageIndex = upd.stageIndex;
        if (upd.stats) run.stats = upd.stats;
      }
    }
    setTimeout(step, DEMO_REPLAY_STEP_MS).unref?.();
  };
  setTimeout(step, DEMO_REPLAY_STEP_MS).unref?.();
}

function startRun(routine, jobId, batchId = null, extra = {}) {
  const def = ROUTINES[routine];
  // The runId is minted BEFORE the prompt is built so a prompt can address its
  // own run - the source-scoped discovery prompt tells the scout to report its
  // honesty counters to .../runs/<runId>/report (t-1783200897663).
  const runId = `r${Date.now()}_${++runSeq}`;
  // `extra` is launch context: run-record bookkeeping fields (sourceId /
  // sourceBaseline) AND per-launch prompt input (propose-instructions' owner
  // comment; the runId above). Routines whose prompt() ignores a second
  // argument are unaffected.
  const prompt = def.scope !== "global" ? def.prompt(jobId, { ...extra, runId }) : def.prompt();
  const run = {
    id: runId,
    routine,
    label: def.label,
    jobId: jobId || null,
    batchId,
    prompt,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    // Live progress (t-1783650926662), fed by the stream-json event pump below:
    // `currentActivity` is the latest "what it is doing right now" label;
    // `stages`/`stageIndex` are the routine's milestone labels + how far the
    // run has provably gotten (-1 = none yet); `expectedMs` is the median of
    // recent successful durations of this routine (null = no history yet);
    // `stats` lands once from the CLI's terminal `result` event.
    currentActivity: null,
    stages: (def.stages || []).map((s) => s.label),
    stageIndex: -1,
    expectedMs: expectedRunMs(routine),
    stats: null,
    // A source-scoped run carries sourceId + sourceBaseline so the close path
    // (finalizeSourceRun) can flip its run-history record and compute leadsNew.
    ...extra,
  };
  runs.set(runId, run);
  // `batchId` is stamped on BOTH the start and close lines (a new optional field,
  // backward compatible) so the notification feed can derive wave_done - "all runs
  // of a batch reached terminal" - from the DURABLE activity log rather than the
  // memory-only runs Map (see GET /api/notifications + ADR-007). Single (non-batch)
  // runs carry batchId:null and surface as run_finished instead.
  store.appendActivity({ kind: "run", runId, routine, label: def.label, jobId: jobId || null, batchId: batchId || null, status: "running" });
  // DEMO MODE (design 5.2): never spawn claude.exe. Feed a pre-recorded, FICTIONAL
  // stream-json transcript through the SAME agentEventToUpdate fold a real run uses,
  // so the run panel animates (stages, activity, zero cost) with no model spend and
  // no real data. The real-mode spawn path below is untouched.
  if (DEMO_MODE) {
    run._proc = null;
    runDemoReplay(run, def, routine);
    return run;
  }
  // Base argv shared by EVERY routine: `--allowedTools` (ALLOWED_TOOLS) is the
  // config-editable pre-approval tool list and `--permission-mode acceptEdits`
  // is never skip-permissions - both per ADR-005. A PRODUCT routine additionally
  // runs AS its owning agent: when `def.agent` is set we append `--agent <id>` so
  // the run inherits that agent's persona, guardrails, and model default. This is
  // a persona binding, NOT a permission change - it was verified empirically
  // (ADR-015) that the tool posture is identical with and without `--agent`, even
  // when the bound agent's frontmatter declares "tools: All tools" (the agent's
  // tool list is subordinate to the permission-mode + allow/deny gate, never a
  // widening). A wrong/removed agent id fails CLOSED: `claude --agent <unknown>`
  // exits non-zero, so the run surfaces as `failed` here rather than silently
  // falling back to the default agent. (NB `--allowedTools` is a pre-approval
  // list, not a hard ceiling in headless mode; `--disallowedTools` is the
  // hard-deny lever - orthogonal to this binding, see ADR-015.) Ticket-scoped
  // routines leave `def.agent` undefined, so the flag is skipped and they run
  // with their in-prompt persona, unchanged.
  const args = ["-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS];
  // Stream the agent's work as it happens (t-1783650926662): `stream-json`
  // emits one JSON event per line (init, each assistant turn's text + tool
  // calls, the terminal result) instead of text mode's single dump at the very
  // end - the reason a multi-minute run used to look frozen. `--verbose` is
  // required by the CLI for stream-json with -p. Purely an OBSERVABILITY
  // change: same prompt, same tools, same permission posture.
  args.push("--output-format", "stream-json", "--verbose");
  if (def.agent) args.push("--agent", def.agent);
  // Model/effort: pin the tier the owning agent documents (ADR-015 addendum). A
  // routine with a batch carve-out (first-draft-job) uses its lighter batch* tier
  // when this run is part of a batch (batchId set), else the single-run tier.
  const model = (batchId && def.batchModel) || def.model;
  const effort = (batchId && def.batchEffort) || def.effort;
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  // Optional hard deny-list (assess-ticket): strips file-mutation tools to partly
  // enforce a comment-only charter (defense-in-depth; ADR-005 addendum).
  if (def.disallowedTools) args.push("--disallowedTools", def.disallowedTools);
  // Regenerate safety net (Part 2, honors "never delete"): before a JOB routine
  // regenerates its outputs in place, keep a dated copy of each CURRENT output so
  // a re-run never destroys the prior version. No-op on a first run. Copy-only,
  // contained, best-effort - now behind the storage seam
  // (store.backupRoutineOutputs), byte-identical (COPYFILE_EXCL, never clobbers
  // history, every failure swallowed).
  if (def.scope === "job") {
    store.backupRoutineOutputs(jobId, routine);
  }
  let proc;
  try {
    // stdin is IGNORED, not left an open pipe: with a piped stdin the CLI
    // waits 3 seconds for input that never comes ("no stdin data received in
    // 3s" - the warning the owner screenshotted on t-1783650926662), so every
    // run used to start with a silent 3s stall. The prompt travels via -p.
    proc = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    run.status = "failed";
    run.output = `failed to launch claude: ${e.message}`;
    store.appendActivity({ kind: "run", runId, status: "failed", exitCode: null });
    return run;
  }
  run._proc = proc;
  const appendOut = (s) => {
    run.output = (run.output + s).slice(-MAX_OUTPUT);
  };
  // NDJSON event pump: stdout arrives in arbitrary chunks, so buffer to full
  // lines, parse each as a stream-json event, and fold it into the run record
  // (live transcript + currentActivity + milestone stageIndex + finish stats
  // via lib.js agentEventToUpdate). GRACEFUL DEGRADATION: any line that is not
  // a JSON event (a CLI warning, or a future CLI that stops emitting
  // stream-json) passes through to the output verbatim - worst case the panel
  // behaves like the old text mode, never worse.
  let lineBuf = "";
  let sawTranscript = false; // any event-derived text so far (not stderr noise)
  const applyLine = (line) => {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith("{")) {
      let evt = null;
      try {
        evt = JSON.parse(t);
      } catch {
        /* not a JSON event after all - fall through to verbatim append */
      }
      if (evt) {
        const upd = agentEventToUpdate(evt, def.stages || null, run.stageIndex, sawTranscript);
        if (upd.appendText) {
          appendOut(upd.appendText);
          sawTranscript = true;
        }
        if (upd.activity !== undefined) run.currentActivity = upd.activity;
        run.stageIndex = upd.stageIndex;
        if (upd.stats) run.stats = upd.stats;
        return;
      }
    }
    appendOut(t + "\n");
  };
  proc.stdout.on("data", (buf) => {
    lineBuf += buf.toString();
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      applyLine(lineBuf.slice(0, nl));
      lineBuf = lineBuf.slice(nl + 1);
    }
  });
  // stderr is never stream-json (warnings, spawn noise, CLI errors) - verbatim.
  proc.stderr.on("data", (buf) => appendOut(buf.toString()));
  proc.on("error", (e) => {
    run.status = "failed";
    run.output += `\n[spawn error] ${e.message}`;
  });
  proc.on("close", (code) => {
    if (lineBuf) {
      applyLine(lineBuf); // flush a final line that arrived without a newline
      lineBuf = "";
    }
    run.currentActivity = null;
    run.exitCode = code;
    if (run.status === "running") run.status = code === 0 ? "done" : "failed";
    // Only SUCCESSFUL durations feed the estimate - a fast failure or a manual
    // stop says nothing about how long the routine takes when it works.
    if (code === 0) noteRunDuration(routine, Date.now() - Date.parse(run.startedAt));
    run._proc = null;
    // Terminal status is done | failed | stopped (stopped when the UI killed it).
    // Carry batchId on the close line too (see the start-line note above) so the
    // wave_done derivation can pair a batch's runs by batchId across restarts.
    store.appendActivity({ kind: "run", runId, status: run.status, exitCode: code, batchId: run.batchId || null });
    // A source-scoped run updates its source's run-history record on close (which
    // fires its own typed source-run-finished broadcast).
    if (run.sourceId) finalizeSourceRun(run);
    // Run-completion status automation (t-1783390854845): a scope:"job" routine
    // that SUCCEEDED may advance the job's status when the new on-disk state
    // supports it (the pure nextStatusAfterRun rule - only queued->drafted after a
    // real first draft). Best-effort + fully guarded: it must never destabilize
    // run close. The updateFrontmatter write lands inside JOBS_DIR, so the file
    // watcher's own jobs-changed covers the UI refresh (same as any file the run
    // wrote) - no extra broadcast here.
    if (def.scope === "job" && run.jobId) maybeAutoAdvanceJob(routine, code, run.jobId);
    // Typed close event so consumers can react precisely: the RunPanel keys its
    // own poll off GET the run; the notification bell refetches on this. Any job
    // FILE the run wrote is covered by the watcher's jobs-changed, so this does
    // NOT also broadcast jobs-changed.
    broadcast({ type: "run-finished", runId, routine, jobId: run.jobId });
    processQueue();
  });
  return run;
}

function processQueue() {
  while (runningCount() + pendingSourceLaunches < MAX_CONCURRENT_RUNS && queue.length) {
    const item = queue.shift();
    if (item.routine === "discover-jobs-source") {
      // Source items go through launchSourceRun (hoisted, defined with the
      // discovery-source endpoints) for the run-history/lastRunAt bookkeeping
      // the plain startRun path does not do. Its readDiscovery hop is async,
      // so the slot is claimed via pendingSourceLaunches until the run
      // actually exists in `runs` (or the launch is skipped).
      pendingSourceLaunches++;
      launchSourceRun(item.jobId, item.batchId, () => {
        pendingSourceLaunches--;
        processQueue(); // a skipped launch frees its claimed slot - refill
      });
    } else {
      startRun(item.routine, item.jobId, item.batchId);
    }
  }
}

app.get("/api/routines", (req, res) => {
  // Hide scope:"source" routines (launched only via the dedicated per-source
  // run endpoint) and the RETIRED global discover-jobs sweep (replaced by the
  // run-all-due fan-out - see POST /api/discovery/run-all-due).
  res.json(
    Object.entries(ROUTINES)
      .filter(([id, r]) => r.scope !== "source" && id !== "discover-jobs")
      .map(([id, r]) => ({ id, label: r.label, scope: r.scope }))
  );
});

app.post("/api/routines/run", (req, res) => {
  // `jobId` is the generic scope-id on the wire (job folder name for
  // scope:"job", ticket id for scope:"ticket") - named `jobId` so the existing
  // frontend contract (api.ts runRoutine(routine, id) -> { routine, jobId })
  // does not need to change for the new scope.
  const { routine, jobId } = req.body || {};
  const def = ROUTINES[routine];
  if (!def) return res.status(400).json({ error: "unknown routine" });
  // Source-scoped runs have their own endpoint (which does the run-history
  // bookkeeping); refuse to launch one through the generic path.
  if (def.scope === "source") {
    return res.status(400).json({
      error:
        "source-scoped runs use their dedicated endpoint (POST /api/discovery/sources/:id/run or .../instruction-proposals/propose)",
    });
  }
  // The GLOBAL discover-jobs sweep is retired (registry unification,
  // t-1783183576537): driven by the xlsx Config sheet, it could not stamp any
  // source's lastRunAt, so every health pill lied after it ran. Discovery now
  // always runs scoped to ONE source; "sweeping" is the run-all-due fan-out,
  // which reuses the per-source path so health stays honest by construction.
  if (routine === "discover-jobs") {
    return res
      .status(400)
      .json({ error: "the global discover-jobs sweep is retired; use POST /api/discovery/run-all-due or a per-source Run now" });
  }
  if (def.scope !== "global" && !jobId) return res.status(400).json({ error: "jobId required" });
  if (jobId && !scopeIdExists(def.scope, jobId)) {
    return res
      .status(404)
      .json({ error: def.scope === "ticket" ? "ticket not found" : "job folder not found" });
  }
  // Per-scope duplicate guard (t-1783198713071): one live-or-queued run per
  // (routine, jobId) - a double-clicked "Finalize" (or a re-trigger while the
  // first agent is still writing the job folder) is a loud 409, the same
  // posture as the per-source scrape / propose guards. Error precedence
  // matches the per-source endpoint: unknown -> 404, duplicate -> 409,
  // capacity -> 429. Global-scope routines carry no id and are not keyed.
  if (def.scope !== "global" && hasPendingOrActiveRun(routine, jobId)) {
    return res.status(409).json({
      error: `a ${routine} run is already in progress or queued for this ${def.scope === "ticket" ? "ticket" : "job"}`,
    });
  }
  if (runningCount() >= MAX_CONCURRENT_RUNS) {
    return res
      .status(429)
      .json({ error: `too many routines running (max ${MAX_CONCURRENT_RUNS}); wait for one to finish or stop it` });
  }
  pruneRuns();
  // Launch the run and answer 201 (or 500 when the spawn itself failed). Shared
  // by the immediate path and the discover-jobs prune-first path below.
  const launch = () => {
    const run = startRun(routine, jobId);
    if (run.status === "failed") return res.status(500).json({ error: run.output });
    res.status(201).json({ runId: run.id, prompt: run.prompt, label: run.label });
  };
  launch();
});

app.get("/api/routines/run/:runId", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  const { _proc, ...safe } = run;
  res.json(safe);
});

app.post("/api/routines/run/:runId/stop", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  if (run._proc) {
    try {
      run._proc.kill();
    } catch {}
    run.status = "stopped";
  }
  res.json({ ok: true });
});

// Batch: queue a job-scoped routine across many jobs; the queue drains up to
// MAX_CONCURRENT_RUNS at a time (bounded parallelism).
app.post("/api/routines/batch", (req, res) => {
  const { routine, jobIds } = req.body || {};
  const def = ROUTINES[routine];
  if (!def || def.scope !== "job") return res.status(400).json({ error: "batch needs a job-scoped routine" });
  if (!Array.isArray(jobIds) || !jobIds.length) return res.status(400).json({ error: "jobIds required" });
  // Every routine gets the path-containment existence guard. finalize-job ADDS a
  // readiness guard (defense in depth): a job that is not finalizeReady is refused
  // even if the client asks, so a batch can NEVER finalize a job whose gaps note
  // has not been answered. Same finalizeReady rule as the read path (toJob), so
  // the two can never diverge. finalize only regenerates materials - NEVER submits.
  // Duplicates are SKIPPED, not 409'd (t-1783198713071): a job already running
  // or queued for the same routine - or listed twice in this very request - is
  // silently filtered, mirroring run-all-due's posture for sources; the honest
  // `total` in the response reflects what was actually queued.
  const seen = new Set();
  const valid = jobIds.filter((id) => {
    if (seen.has(`${routine}\u0000${id}`)) return false;
    seen.add(`${routine}\u0000${id}`);
    if (!store.jobFolderPath(id)) return false;
    if (hasPendingOrActiveRun(routine, id)) return false;
    if (routine === "finalize-job") {
      const j = store.getJobSummary(id);
      return !!(j && j.finalizeReady);
    }
    return true;
  });
  const batchId = `b${Date.now()}`;
  for (const id of valid) queue.push({ routine, jobId: id, batchId });
  pruneRuns();
  processQueue();
  res.status(201).json({ batchId, total: valid.length, routine, label: def.label });
});

app.get("/api/routines/batch/:batchId", (req, res) => {
  const bid = req.params.batchId;
  const rs = [...runs.values()].filter((r) => r.batchId === bid);
  const queued = queue.filter((q) => q.batchId === bid).length;
  res.json({
    batchId: bid,
    total: rs.length + queued,
    running: rs.filter((r) => r.status === "running").length,
    done: rs.filter((r) => r.status === "done").length,
    failed: rs.filter((r) => r.status === "failed" || r.status === "stopped").length,
    queued,
    runs: rs.map((r) => ({ jobId: r.jobId, status: r.status })),
  });
});

app.get("/api/jobs/:id", (req, res) => {
  // store.getJob reads the full detail (body + gaps + job-description + prep
  // materials + the mtime-derived answered flags + the submitted-materials flag).
  // The pure interview-consistency cross-check stays here (a storage-agnostic
  // derivation over what the store returned); hasSubmitted feeds it but is not
  // itself part of the wire response.
  const detail = store.getJob(req.params.id);
  if (!detail) return res.status(404).json({ error: "job not found" });
  const { hasSubmitted, ...rest } = detail;
  const consistency = computeInterviewConsistency(detail.prep, hasSubmitted);
  res.json({ ...rest, consistency });
});

app.patch("/api/jobs/:id", (req, res) => {
  const folder = req.params.id;
  const rec = store.getJobSummary(folder);
  if (!rec) return res.status(404).json({ error: "job not found" });
  try {
    // Enum write boundary (t-1783199066683): a present-but-invalid
    // track/fit/sector/tailoring/status value is silently dropped (Task
    // posture), so a bad value can never land in the vault; null/"" still
    // clear a field, and every other update in the same body still applies.
    const updates = dropInvalidJobEnums({ ...req.body });
    // Convenience: stamp the applied date when a job first reaches "submitted".
    // rec.applied is the normalized applied value (absent/"" -> null -> falsy),
    // equivalent to the old raw !jobFile.data.applied check.
    if (updates.status === "submitted" && !rec.applied && !updates.applied) {
      // Local date, not UTC - an evening ET submit must not be stamped tomorrow.
      updates.applied = localDateISO();
    }
    res.json(store.updateJobFields(folder, updates)); // surgical write, returns fresh DTO
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Overwrite a whole freeform Markdown note inside a job folder. INTENTIONALLY a
// full-file overwrite (not frontmatter surgery) - but RESTRICTED to the gaps note,
// the job-description note, and the interview-prep FEEDBACK note (Part 3, the
// owner-editable review note). The main <Role>.md (type: job) is the SoT and must
// stay on the surgical PATCH path, so it can NEVER be written here; a dated
// regenerate copy (history) can never be written here either. Guards, in order:
// (1) basename only (strip any client-sent directory), (2) must end in .md,
// (3) must not be the job file, (4) must match the gaps / job-description /
// feedback naming and not be a dated copy, (5) resolved path must stay inside
// THIS job's folder. Anything else is a 400.
app.put("/api/jobs/:id/file", (req, res) => {
  // Request-shape validation stays at the boundary; the storage-safety guards
  // (job-file 404, never-SoT, never-dated-copy, naming allowlist, containment)
  // and the verbatim whole-file write live in store.writeJobNote, which throws
  // .httpStatus-coded errors preserving the exact pre-seam status + messages.
  const { name, content } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
  if (typeof content !== "string") return res.status(400).json({ error: "content must be a string" });
  try {
    res.json(store.writeJobNote(req.params.id, name, content));
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

// --- per-job assistant chat (Part 4) ----------------------------------------
// A READ-ONLY, LOCAL, job-scoped assistant. Distinct from the routine runner
// (which runs whitelisted, FIXED prompts): here the client's message IS free-form,
// so safety comes ENTIRELY from the TOOL SCOPE. The assistant is spawned with only
// local read tools (Read/Glob/Grep) plus a HARD deny-list of every file-mutation /
// exec / delegation tool AND the network tools - so a typed message (or an injected
// instruction inside a scraped job posting) can answer and RECOMMEND a guarded
// action but can never edit, create, delete, submit, or SEND ANYTHING OFF-MACHINE.
// No web tools => no egress channel that could exfiltrate the career facts it is
// told to read (security review M1). The spawn also passes --strict-mcp-config so
// it loads ZERO MCP servers regardless of the owner's user/workspace config, so an
// MCP send/mutate tool (Gmail/Drive/etc.) can never be inherited (L1). The human
// confirms any recommended action via the normal guarded buttons.
const CHAT_ALLOWED_TOOLS = "Read,Glob,Grep";
// Hard deny (the real ceiling in headless mode per ADR-015): strip every write /
// exec / delegation tool AND the network tools so neither the read-only guarantee
// nor the "never leaves the machine" guarantee can be widened by a prompt.
const CHAT_DISALLOWED_TOOLS = "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch";
// The guarded actions the assistant may recommend (must match the ROUTINES keys
// the job page exposes); anything else it proposes is dropped.
const CHAT_SUGGESTABLE = new Set([
  "first-draft-job",
  "finalize-job",
  "merge-application-pdf",
  "interview-prep",
  "interview-prep-refine",
  "offer-prep",
  "draft-follow-up",
]);
// Transcripts are app-managed data (like tasks/requests/activity): stored under
// DOCS_DIR keyed by jobId, so job folders stay about deliverables only.
// job-chats.json read/write moved behind the storage seam (store.loadChats /
// store.saveChats). Tolerant read + atomic write unchanged.

// Pure builder for the read-only assistant's spawn argv. Exported so a unit test
// can PROVE the read-only posture (no write tool pre-approved; every mutation tool
// hard-denied) without spawning anything.
export function readOnlyAssistantArgs(prompt) {
  return [
    "-p",
    prompt,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    CHAT_ALLOWED_TOOLS,
    "--disallowedTools",
    CHAT_DISALLOWED_TOOLS,
    // Load NO MCP servers regardless of the owner's user/workspace config, so the
    // read-only assistant can never inherit an off-machine MCP send/mutate tool.
    "--strict-mcp-config",
    "--model",
    "sonnet",
  ];
}

// Parse the assistant's raw stdout into { reply, suggestedAction }. Convention: to
// recommend a guarded action the assistant ends its reply with a final line
// "ACTION: <routine>"; we strip that marker from the shown reply and surface only a
// RECOGNIZED routine. Exported for the unit test.
export function parseAssistantReply(out) {
  const lines = String(out || "").replace(/\r\n/g, "\n").split("\n");
  let suggestedAction = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue; // skip trailing blank lines
    const m = lines[i].match(/^ACTION:\s*([a-z][a-z0-9-]*)\s*$/i);
    if (m) {
      const routine = m[1].toLowerCase();
      if (CHAT_SUGGESTABLE.has(routine)) suggestedAction = { routine };
      lines.splice(i, 1); // drop the marker line from the shown reply either way
    }
    break; // only the LAST non-blank line may be an ACTION marker
  }
  return { reply: lines.join("\n").trim(), suggestedAction };
}

function buildChatPrompt(job, folder, transcript, message) {
  return (
    `You are the READ-ONLY assistant for Simon's job application "${folder}" (${job.role} at ${job.employer}; status: ${job.status}). ` +
    `Your working directory is his local job-hunt vault. Answer his question GROUNDED IN THIS job's own files. ` +
    `You have READ-ONLY, LOCAL tools (Read/Glob/Grep over the vault) and NO write or network tools: you cannot and must not edit, create, move, or delete any file, submit an application, contact anyone, or fetch anything off-machine. ` +
    `Read as needed from "Jobs/${folder}/" (the <Role>.md job file, the posting, the gaps note, the generated CV + cover letter, the interview prep docs + "Interview prep feedback.md") and Simon's record (ops/facts/*.yaml, wiki/master-profile.md). Never invent a fact, metric, or achievement - if something is not in his files, say so. ` +
    `Simon reruns or fixes generated materials himself via guarded buttons. ONLY if his message clearly asks to (re)generate or fix a deliverable, recommend exactly ONE action by ending your reply with a final line "ACTION: <routine>" where <routine> is one of: first-draft-job (redraft CV + cover letter), finalize-job (re-finalize), merge-application-pdf (merge the rendered cover letter + CV PDFs into one submission PDF; only once both PDFs exist), interview-prep (regenerate prep from scratch), interview-prep-refine (refine prep using his feedback note), offer-prep (offer/negotiation prep), draft-follow-up (follow-up email). Do not invent other routines, and add NO action line when none is needed. If you recommend interview-prep-refine, first tell him to put his fixes in the feedback note. ` +
    (transcript ? `\n\nConversation so far:\n${transcript}\n` : "\n") +
    `\nSimon's new message:\n${message}\n\n` +
    `Answer concisely and specifically to this job. No em dashes.`
  );
}

function runReadOnlyAssistant(prompt) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, readOnlyAssistantArgs(prompt), {
        cwd: WORKSPACE_DIR,
        env: process.env,
        windowsHide: true,
        // stdin ignored, same as the routine runner (t-1783650926662): a piped
        // stdin makes the CLI wait 3s for input that never comes, which was a
        // flat 3s tax on EVERY chat reply. The prompt travels via argv.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }
    let out = "";
    let errbuf = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error("assistant timed out"));
    }, 180_000);
    proc.stdout.on("data", (b) => {
      out += b.toString();
      if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT);
    });
    proc.stderr.on("data", (b) => {
      errbuf = (errbuf + b.toString()).slice(-2000);
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(errbuf.trim() || `assistant exited with code ${code}`));
    });
  });
}

// GET the transcript for one job (empty array when none yet).
app.get("/api/jobs/:id/chat", (req, res) => {
  const folder = req.params.id;
  if (!store.jobFolderPath(folder)) return res.status(404).json({ error: "job not found" });
  const chats = store.loadChats();
  res.json({ messages: Array.isArray(chats[folder]) ? chats[folder] : [] });
});

// POST a message: append it, run the read-only assistant, append the reply, persist.
app.post("/api/jobs/:id/chat", async (req, res) => {
  const folder = req.params.id;
  if (!store.jobFolderPath(folder)) return res.status(404).json({ error: "job not found" });
  const job = store.getJobSummary(folder);
  if (!job) return res.status(404).json({ error: "job not found" });
  const { message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message required" });
  }
  const text = message.trim().slice(0, 4000);
  const chats = store.loadChats();
  const history = Array.isArray(chats[folder]) ? chats[folder] : [];
  const userMsg = { role: "user", content: text, ts: new Date().toISOString() };
  // Bounded transcript context (last ~12 turns) so the prompt stays small.
  const transcript = history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Simon" : "Assistant"}: ${m.content}`)
    .join("\n");
  let out;
  try {
    out = await runReadOnlyAssistant(buildChatPrompt(job, folder, transcript, text));
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  const { reply, suggestedAction } = parseAssistantReply(out);
  const assistantMsg = {
    role: "assistant",
    content: reply || "(no response)",
    ts: new Date().toISOString(),
    ...(suggestedAction ? { suggestedAction } : {}),
  };
  chats[folder] = [...history, userMsg, assistantMsg].slice(-100); // cap stored transcript
  try {
    store.saveChats(chats);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  res.json({ reply: assistantMsg, messages: chats[folder] });
});

app.post("/api/jobs", (req, res) => {
  // Agent-first intake: the form omits track/fit, so the helper writes them blank.
  try {
    const body = req.body || {};
    // Discovery provenance (t-1783199066654): the wire field is `sourceId`
    // (matching Discovery.sourceId); it is written into the `source`
    // frontmatter key ONLY when it resolves in the sources registry
    // (id/name/alias -> canonical id) - an unresolvable value is silently
    // ignored (the same Task-posture the enum guard uses), and a raw
    // client-sent `source` body key is always overridden, so nothing
    // unresolvable can masquerade as provenance.
    res.status(201).json(store.createJob({ ...body, source: resolveRegistrySourceId(body.sourceId) }));
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
});

// ---- discovery (read the workbook + pursue finds) -------------------------
// The app reads the Job Discovery workbook through discovery.py (so it reuses
// the dedup logic and the user never has to open Excel). "Pursue" turns a find
// into a lead folder. "Run discovery" is the routine runner (discover-jobs).
//
// The Python dump costs ~400ms, so we cache it: serve the cached result until
// the workbook's mtime changes OR a job file changes (which affects the
// "tracked" dedup flags). discoveryDirty is set by the chokidar watcher below.
const XLSX_PATH = path.join(WORKSPACE_DIR, "ops", "outputs", "Job Discovery.xlsx");
let discoveryCache = null; // { json, xlsxMtime }
let discoveryDirty = false;

// The autostart launcher (ops/scripts/start-app.cmd, a logon scheduled task)
// can inherit a PATH without the user-profile Python entries; bare "python"
// then resolves to the Microsoft Store redirector stub, which exits non-zero
// with EMPTY stderr - /api/discovery 500'd with no explanation. Resolve a real
// interpreter once at startup: config.pythonPath wins, otherwise the first
// candidate that answers --version (the Store stub fails that probe, real
// installs pass it). Falls back to "python" so nothing changes on machines
// where the probe cannot run at all.
function resolvePython() {
  // JOBHUNT_PYTHON is the test seam (mirrors JOBHUNT_JOBS_DIR / JOBHUNT_DOCS_DIR /
  // JOBHUNT_DISCOVERY_FINDS): the decide round-trip tests point it at the node
  // binary and drop a fake discovery.py into the fixture workspace, so the
  // endpoint's full execFile path runs hermetically - no real python, no xlsx.
  const candidates = [process.env.JOBHUNT_PYTHON, config.pythonPath, "python", "py"].filter(Boolean);
  const installRoot = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python");
  try {
    for (const dir of fs.readdirSync(installRoot).sort().reverse()) {
      if (/^Python3\d+$/i.test(dir)) candidates.push(path.join(installRoot, dir, "python.exe"));
    }
  } catch {
    /* no per-user install root - nothing to add */
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 4000 });
      return candidate;
    } catch {
      /* stub, missing, or broken - try the next one */
    }
  }
  return "python";
}
const PYTHON = resolvePython();
console.log(`[jobhunt] python: ${PYTHON}`);

function xlsxMtime() {
  try {
    return fs.statSync(XLSX_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

// discovery.py exits 4 (its PermissionError guard) or emits a lock signature on
// stderr when Excel holds the workbook open. Detect either so the discovery
// endpoints degrade to a friendly "close Excel" message instead of a hard 500 -
// a workbook the user has open is an expected, benign state, not a server error.
const WORKBOOK_LOCKED_MSG = "Job Discovery.xlsx is open in Excel. Close it, then refresh to continue.";
function isWorkbookLocked(err, stderr) {
  if (err && err.code === 4) return true;
  const s = (stderr || "") + " " + (err && err.message ? err.message : "");
  return /LOCKED|permission denied|errno 13|being used by another process|process cannot access the file|winerror 32/i.test(
    s
  );
}

// discover-jobs prune (ADR-008). Before a discovery run, archive dead rows from
// the workbook via `discovery.py prune` (a REAL deadline strictly before today,
// not decided "pursue", and not already a Jobs/ folder). Reuses the PYTHON
// resolver + the SAME lock detection (isWorkbookLocked / WORKBOOK_LOCKED_MSG) as
// the other discovery endpoints. Prune is best-effort by design: a workbook the
// user has open in Excel is an expected, benign state, so a lock (or any prune
// error, e.g. a missing workbook) is logged and skipped - it NEVER blocks the
// discovery run. On success the workbook changed on disk, so discoveryDirty
// invalidates the read cache exactly like /api/discovery/decide does. `done()`
// runs EXACTLY once (a timeout guards a hung interpreter). This is a function
// declaration (hoisted), so the POST /api/routines/run handler above can call it
// even though PYTHON / isWorkbookLocked / discoveryDirty are defined below it.
function pruneDiscoveriesBeforeDiscover(done) {
  const script = path.join(WORKSPACE_DIR, "ops", "scripts", "discovery.py");
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    done();
  };
  try {
    execFile(
      PYTHON,
      [script, "prune"],
      { cwd: WORKSPACE_DIR, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          if (isWorkbookLocked(err, stderr)) {
            console.log("[jobhunt] discover-jobs: workbook locked, skipping prune (run continues)");
          } else {
            console.error(`[jobhunt] discover-jobs: prune skipped (${stderr || err.message})`);
          }
        } else {
          discoveryDirty = true; // pruned rows changed the workbook -> refresh cache next read
          console.log(`[jobhunt] discover-jobs: prune ok - ${(stdout || "").trim()}`);
        }
        finishOnce();
      }
    );
  } catch (e) {
    console.error(`[jobhunt] discover-jobs: prune could not launch, skipping (${e.message})`);
    finishOnce();
  }
}

// Serve the last good discovery data (so the board does not blank out) plus a
// `locked` flag + message when the workbook is open; empty arrays if no cache yet.
function lockedDiscoveryPayload() {
  const base = discoveryCache ? discoveryCache.json : { config: [], discoveries: [], runLog: [] };
  return { ...base, locked: true, message: WORKBOOK_LOCKED_MSG };
}

// Normalize whatever the workbook dump (or the test seam) hands us into the
// canonical { config, discoveries, runLog } shape, so every consumer can read
// the same fields without branching on the input's precise form.
function normalizeDiscoveryDump(json) {
  if (Array.isArray(json)) return { config: [], discoveries: json, runLog: [] };
  const o = json && typeof json === "object" ? json : {};
  return {
    config: Array.isArray(o.config) ? o.config : [],
    discoveries: Array.isArray(o.discoveries) ? o.discoveries : [],
    runLog: Array.isArray(o.runLog) ? o.runLog : [],
  };
}

// Shared discovery read: serve the cached workbook dump, refresh it via
// discovery.py when the cache is stale (keyed on xlsx mtime + discoveryDirty),
// and DEGRADE to the last-good data + { locked:true } when Excel holds the
// workbook - never a hard failure the caller must special-case. Signature is
// cb(err, dump, { locked }); on a genuine (non-lock) failure it calls cb(err)
// so GET /api/discovery can 500 exactly as before, while the sources join
// treats any error as "finds unavailable" and still serves the source registry.
// JOBHUNT_DISCOVERY_FINDS is the test seam (mirrors JOBHUNT_JOBS_DIR /
// JOBHUNT_DOCS_DIR): a JSON fixture path short-circuits the python/xlsx path so
// the sources endpoints and the join are testable without an interpreter or a
// real workbook. This helper is the ONE place the workbook is read, so
// /api/discovery and the sources join can never drift on caching or lock
// handling.
function readDiscovery(cb) {
  const seam = process.env.JOBHUNT_DISCOVERY_FINDS;
  if (seam) {
    try {
      return cb(null, normalizeDiscoveryDump(JSON.parse(fs.readFileSync(seam, "utf8"))), { locked: false });
    } catch {
      return cb(null, { config: [], discoveries: [], runLog: [] }, { locked: false });
    }
  }
  const mtime = xlsxMtime();
  if (discoveryCache && !discoveryDirty && discoveryCache.xlsxMtime === mtime) {
    return cb(null, discoveryCache.json, { locked: false });
  }
  const script = path.join(WORKSPACE_DIR, "ops", "scripts", "discovery.py");
  execFile(PYTHON, [script, "dump"], { cwd: WORKSPACE_DIR, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      // Workbook open in Excel -> serve the last-good data flagged locked (never a 500).
      if (isWorkbookLocked(err, stderr)) {
        const base = discoveryCache ? discoveryCache.json : { config: [], discoveries: [], runLog: [] };
        return cb(null, base, { locked: true });
      }
      return cb(err);
    }
    try {
      const json = JSON.parse(stdout);
      discoveryCache = { json, xlsxMtime: mtime };
      discoveryDirty = false;
      cb(null, json, { locked: false });
    } catch (e) {
      cb(e);
    }
  });
}

// Audit F1c: the xlsx Run Log sheet passthrough duplicated the per-source run
// history that docs/discovery-sources.yaml now owns (ADR-016's `runs[]`, served
// by GET /api/discovery/sources) - a second, unread store of the same fact.
// DiscoveryData no longer declares `runLog` (src/types.ts) and nothing in src/
// ever read `.runLog` off this response, so retire the field at the read
// boundary: strip it here rather than touch discovery.py's xlsx-side `dump`
// (an owner-local vault script edit is out of scope for a passthrough that is
// dead on the client anyway - one small, safe deletion instead of a vault diff).
app.get("/api/discovery", (req, res) => {
  readDiscovery((err, json, meta) => {
    if (err) {
      return res.status(500).json({
        error: "Could not read the discovery workbook: " + (err.stderr || `${err.message} (exit code ${err.code})`),
      });
    }
    const { runLog, ...rest } = json || {};
    if (meta && meta.locked) return res.json({ ...rest, locked: true, message: WORKBOOK_LOCKED_MSG });
    res.json(rest);
  });
});

// Resolve a client-supplied source reference (id, name, or alias - any case)
// to its canonical registry id, or null. This is the ONLY way a `source` value
// reaches createJobFolder, so provenance on a NEW job is always either a real
// canonical source id or absent - never an unresolvable string. (Legacy values
// already on disk are a read-side concern; see toJob.) Best-effort by design:
// a missing/unreadable registry resolves to null, never throws.
function resolveRegistrySourceId(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase();
  if (!key) return null;
  try {
    const idx = buildAliasIndex(store.loadSources().sources);
    return idx.has(key) ? idx.get(key) : null;
  } catch {
    return null;
  }
}

// Resolve which discovery source a pursued find came from (t-1783199066654),
// best-effort and NEVER blocking the pursue: (1) an explicit body.sourceId that
// resolves in the registry wins; (2) else join the workbook row itself (matched
// by Title, disambiguated by Link when several share it - the same Title+Link
// key discovery.py's `decide` uses) through the finds' own sourceId/name/alias
// resolution. Anything unresolvable (ambiguous title, workbook locked, row
// gone) -> null: the job is simply created without provenance, exactly as
// every job was before this field was wired.
function resolvePursueSourceId({ title, link, sourceId }, cb) {
  const explicit = resolveRegistrySourceId(sourceId);
  if (explicit) return cb(explicit);
  let idx;
  try {
    idx = buildAliasIndex(store.loadSources().sources);
  } catch {
    return cb(null);
  }
  if (!title || idx.size === 0) return cb(null);
  readDiscovery((err, disc) => {
    if (err || !disc || !Array.isArray(disc.discoveries)) return cb(null);
    const t = String(title).trim().toLowerCase();
    const l = link != null ? String(link).trim() : "";
    const byTitle = disc.discoveries.filter(
      (f) => String((f.Title != null ? f.Title : f.title) || "").trim().toLowerCase() === t
    );
    const row =
      (l && byTitle.find((f) => String((f.Link != null ? f.Link : f.link) || "").trim() === l)) ||
      (byTitle.length === 1 ? byTitle[0] : null);
    cb(row ? resolveFindSourceId(row, idx) : null);
  });
}

app.post("/api/discovery/pursue", (req, res) => {
  const { title, employer, track, fit, sector, deadline, link, status, sourceId } = req.body || {};
  // Fast path (ops audit F5, t-1783183576640): the client may request
  // landing straight in "queued" for a strong-fit find instead of the
  // default "lead" - the owner was re-deciding leads into queued by hand
  // anyway (23 leads idle >=4d vs 6 queued at audit time). A present-but-
  // invalid value is tolerated and falls back to "lead" - this is a
  // convenience default, not a validated contract, so it is never a 400.
  const initialStatus = status === "queued" ? "queued" : "lead";
  // Provenance first (async, best-effort - reads the cached workbook dump),
  // then the folder write. A failed resolution never fails the pursue.
  resolvePursueSourceId({ title, link, sourceId }, (srcId) => {
    try {
      // Discovery already assessed track + fit, so carry them onto the job. The
      // workbook Link becomes the job's posting URL (the link to actually apply).
      const job = store.createJob({
        role: title,
        employer,
        track,
        fit,
        status: initialStatus,
        sector,
        deadline,
        link,
        source: srcId,
      });
      res.status(201).json(job);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
});

// Triage a discovery find in place: write skip | maybe | pursue into its Decision
// cell in the workbook (via discovery.py decide, reusing the openpyxl load/save
// logic), or BLANK it with "clear" - the persist-side of undoing a decision whose
// prior state was undecided (t-1783178044080; v1 shipped that undo optimistic-only).
// The row is located by Title + Link. Never a 500 when Excel has the workbook
// open - it returns a graceful { locked: true } so the UI can prompt the user to
// close Excel and retry.
const DISCOVERY_DECISIONS = ["skip", "maybe", "pursue", "clear"];
app.post("/api/discovery/decide", (req, res) => {
  const { title, link, decision } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title required" });
  const dec = String(decision || "").trim().toLowerCase();
  if (!DISCOVERY_DECISIONS.includes(dec)) {
    return res.status(400).json({ error: "decision must be one of: skip, maybe, pursue, clear" });
  }
  const script = path.join(WORKSPACE_DIR, "ops", "scripts", "discovery.py");
  execFile(
    PYTHON,
    [script, "decide", String(title), String(link || ""), dec],
    { cwd: WORKSPACE_DIR, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        if (isWorkbookLocked(err, stderr)) {
          return res.json({ ok: false, locked: true, message: WORKBOOK_LOCKED_MSG });
        }
        if (err.code === 3) {
          return res.status(404).json({ error: "no matching discovery row for that title + link" });
        }
        return res.status(500).json({
          error: "Could not write the decision: " + (stderr || `${err.message} (exit code ${err.code})`),
        });
      }
      // The workbook changed on disk; invalidate the cache so the next read reflects it.
      discoveryDirty = true;
      res.json({ ok: true, title, link: link || "", decision: dec, output: (stdout || "").trim() });
    }
  );
});

// ---- discovery sources (managed channels, ADR-016) ------------------------
// The native source-of-truth for the Discovery console: each employer / job
// board is a MANAGED SOURCE with its own crawl instructions, cadence, run
// history, and a DERIVED health status. Storage is docs/discovery-sources.yaml -
// NOT the xlsx (the workbook stays the finds store) - written through the SAME
// atomic safe path as tasks.yaml / requests.yaml (.tmp + rename, tolerant read).
// The finds still live in the workbook; this file is the registry the finds
// JOIN onto (by name/alias today, by a stamped sourceId going forward). Nothing
// here leaves the machine; a source is app-managed config, so deleting one never
// touches a find, the vault, or the surgical frontmatter path. The
// discovery-sources.yaml path + atomic read/write now live in the storage seam
// (store.loadSources / store.saveSources).

// Closed enums, validated at the write boundary: a present-but-invalid value is
// a loud 400; an absent one falls back to a documented default (create) or is a
// no-op (patch). `type` RESERVES room for a future "apify" scraper source - it
// is documented here but NOT implemented in v1, so it is deliberately NOT an
// accepted value yet (an { type: "apify" } write is a 400 today).
// employer/board sources run via a SPAWNED job-search-scout agent + stored
// instructions; an "apify" source instead runs DETERMINISTICALLY server-side
// (POST api.apify.com run-sync-get-dataset-items -> map dataset -> discovery.py
// add), gated behind the owner's apifyEnabled flag + APIFY_TOKEN (ADR
// 2026-07-06; guardian conditions C1-C10 on ticket t-1783339605935).
export const SOURCE_TYPES = ["employer", "board", "apify"];
// THE 6-value sector vocabulary - literally the same array the Job entity's
// write boundary validates against (SECTORS, defined with the Job constants at
// the top of this file), so the two entities can never drift (t-1783199066683).
export const SOURCE_SECTORS = SECTORS;
export const SOURCE_ACTIVE = ["yes", "maybe", "no"];
export const SOURCE_CADENCES = ["manual", "daily", "weekly", "monthly"];
// How this source's postings are actually reached (t-1783200897663 (c)) - a
// CLOSED enum formalizing what every instruction prose was freeform-encoding:
//   direct-list - the listing URL itself is fetchable (server-rendered);
//                 WebFetch it and enumerate postings from the returned list.
//   google-site - the listing is NOT fetchable (JS app / anti-bot); enumerate
//                 postings via Google `site:` queries on the source's domain,
//                 then WebFetch each detail page.
//   alert-email - postings arrive via a saved email alert; review the alert
//                 email instead of crawling the board.
// OPTIONAL (null = not yet classified: the run prompt then relies on the
// instruction prose alone, exactly as before this field existed). fetchNote is
// its free-text companion for source-specific quirks the mode alone can't
// carry (e.g. University Affairs: "query params are cosmetic, filter
// client-side"). A present-but-invalid mode is a loud 400 at the write
// boundary, same posture as type/sector/active/cadence.
export const SOURCE_FETCH_MODES = ["direct-list", "google-site", "alert-email"];
export const RUN_OUTCOMES = ["succeeded", "failed", "incomplete", "running"];
// Instruction-proposal lifecycle (docs/data-schema.md §5 Decision 4): pending is
// the only writable-at-creation state (server-stamped, a client value is
// ignored); approved/rejected are ONE-WAY transitions applied only by the
// dedicated PATCH endpoint. A resolved proposal is never edited again.
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"];
export const SOURCE_STATUSES = ["never-run", "healthy", "running", "due", "stale", "failed", "paused"];
// Source -> track linkage (data-schema-discovery-v2 Wave-2 Decision 1, docs/data-schema.md
// §5): a CLOSED enum sourced from the same TRACKS map GET /api/config already serves - the
// identical vocabulary a Job's `track` frontmatter uses. Absent/empty = "all tracks" (a
// generic board like LinkedIn/Indeed genuinely serves every track); a present-but-invalid
// entry is a loud 400 at the write boundary, the same posture as type/sector/active/cadence.
export const SOURCE_TRACKS = Object.keys(TRACKS);
const MAX_SOURCE_RUNS = 20; // run-history cap per source (bounded file growth)
const DEFAULT_OUTPUT_FIELDS = ["title", "employer", "location", "deadline", "salary", "link"];

// Case-insensitive alias sets a source's outputFields[] tag list is checked against for the
// scrape-contract warning (docs/data-schema.md §5 Decision 3a). SERVER-OWNED and the ONLY
// place this is ever guessed - deriveSources computes contractGaps from this once; components
// read the derived field, they never reimplement the alias match.
export const CONTRACT_FIELD_ALIASES = {
  directLink: ["link", "url", "posting url", "direct link", "apply link", "job url"],
  deadline: ["deadline", "closing date", "application deadline", "due date"],
};

// The subset of the two required-but-freeform scrape-contract concepts NOT present
// (case-insensitively) in a source's declared outputFields. Empty array = contract complete.
export function computeContractGaps(outputFields) {
  const norm = (Array.isArray(outputFields) ? outputFields : []).map((f) => String(f).trim().toLowerCase());
  const gaps = [];
  if (!CONTRACT_FIELD_ALIASES.directLink.some((a) => norm.includes(a))) gaps.push("direct-link");
  if (!CONTRACT_FIELD_ALIASES.deadline.some((a) => norm.includes(a))) gaps.push("deadline");
  return gaps;
}

// cadence -> projection interval in days a future cron scheduler consumes.
// "manual" has none (never auto-due). Kept as a plain day count so a v2
// scheduler reads the same field with no data migration (ADR-016).
function cadenceIntervalDays(cadence) {
  if (cadence === "daily") return 1;
  if (cadence === "weekly") return 7;
  if (cadence === "monthly") return 30;
  return null; // manual
}

// A stable, path-safe slug id from a display name - the canonical join key
// stamped onto finds. Turn separators into dashes first so "City of Toronto" ->
// "city-of-toronto" (not "cityoftoronto"), then reuse sanitizeId's [a-z0-9._-]
// gate so an id can never carry path / YAML-structure characters (same posture
// as task ids).
export function slugifySourceId(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitizeId(base) || "source";
}

function uniqueSourceId(base, sources) {
  const taken = new Set(sources.map((s) => s.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// Normalize one persisted run-history record to the served shape. Unknown /
// hand-edited outcomes degrade to "incomplete"; numeric fields default to null
// so no reader branches on undefined. The three HONESTY COUNTERS
// (t-1783200897663 (a)) are agent-reported (POST .../runs/:runId/report), so
// a run that predates them - or whose scout never reported - reads as null
// ("unreported"), never as a fake 0.
function normalizeRun(r) {
  const o = {
    startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    outcome: RUN_OUTCOMES.includes(r.outcome) ? r.outcome : "incomplete",
    leadsFound: typeof r.leadsFound === "number" ? r.leadsFound : null,
    leadsNew: typeof r.leadsNew === "number" ? r.leadsNew : null,
    candidatesReviewed: typeof r.candidatesReviewed === "number" ? r.candidatesReviewed : null,
    alreadyTracked: typeof r.alreadyTracked === "number" ? r.alreadyTracked : null,
    filteredOut: typeof r.filteredOut === "number" ? r.filteredOut : null,
    trigger: r.trigger === "scheduled" || r.trigger === "all-due" ? r.trigger : "manual",
  };
  if (typeof r.runId === "string" && r.runId) o.runId = r.runId;
  if (typeof r.errorReason === "string" && r.errorReason) o.errorReason = r.errorReason;
  return o;
}

// Normalize one persisted instruction proposal (tolerant, like normalizeRun).
// CONSERVATIVE by design: saveSources round-trips every source through
// normalizeSource, so anything dropped here would be DELETED from disk on the
// next unrelated write - proposals are append-only and never deleted, so every
// object entry is preserved. A hand-edited unknown status degrades to
// "pending" (the safe state: it only re-offers the proposal for HUMAN review;
// approval always needs an explicit owner click, so nothing can auto-apply). A
// missing id gets a deterministic legacy id (stable across reads, persisted on
// the next write) so the PATCH resolve path can still address it.
function normalizeProposal(raw, i) {
  const p = raw && typeof raw === "object" ? raw : {};
  const o = {
    id: typeof p.id === "string" && p.id.trim() ? p.id.trim() : `ip-legacy-${i}`,
    ts: typeof p.ts === "string" ? p.ts : "",
    ownerComment: typeof p.ownerComment === "string" ? p.ownerComment : "",
    proposedInstructions: typeof p.proposedInstructions === "string" ? p.proposedInstructions : "",
    rationale: typeof p.rationale === "string" ? p.rationale : "",
    status: PROPOSAL_STATUSES.includes(p.status) ? p.status : "pending",
  };
  if (typeof p.resolvedAt === "string" && p.resolvedAt) o.resolvedAt = p.resolvedAt;
  if (typeof p.rejectionReason === "string" && p.rejectionReason) o.rejectionReason = p.rejectionReason;
  return o;
}

// Read-side normalization for ONE source (tolerant, like loadTasks): every field
// arrives in a known shape so no consumer branches on undefined, a bad enum
// degrades to a safe default, and `url` (singular) folds into the canonical
// `urls` list. lastRunAt / runs are SERVER-MANAGED (never client-writable); they
// are preserved here but only the run endpoints / finalize path ever set them.
// instructionProposals / instructionsApprovedFrom / instructionsUpdatedAt are
// equally SERVER-MANAGED (§5 Decision 4): preserved on read, written only by
// the instruction-proposal endpoints (and the manual-edit provenance rule in
// PATCH /api/discovery/sources/:id) - validateSourceInput never accepts them.
// Every stored-source key THIS version of the serializer models. Anything else
// found in the file is version skew - a field written by a NEWER schema (the
// dual-track setup means an older stable binary and a newer dev binary share
// this file) or a hand edit. Those keys are captured verbatim on the reserved
// `_extra` carrier and written back by serializeSource, so a write-back can
// never silently eat a field it does not know (t-1783258133295: a v0.20.0
// visit-stamp write round-tripped the registry through a serializer that
// predated fetchMode and erased it from all 33 sources). `url` (singular) is
// modeled: it folds into `urls` on read.
export const MODELED_SOURCE_KEYS = new Set([
  "id", "name", "type", "sector", "active", "urls", "url", "cadence",
  "fetchMode", "fetchNote", "instructions", "outputFields", "aliases", "tracks",
  "lastRunAt", "lastVisitedAt", "notes", "runs", "instructionProposals",
  "instructionsApprovedFrom", "instructionsUpdatedAt",
  // apify-only (additive, ADR 2026-07-06): serialized ONLY when present so every
  // non-apify source round-trips byte-identically.
  "actorId", "input", "fieldMap",
  "_extra",
]);

export function normalizeSource(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x !== "") : []);
  const urls = Array.isArray(r.urls)
    ? r.urls.map((x) => String(x)).filter(Boolean)
    : r.url
      ? [String(r.url)]
      : [];
  const runs = Array.isArray(r.runs) ? r.runs.filter((x) => x && typeof x === "object").map(normalizeRun) : [];
  const name = typeof r.name === "string" && r.name ? r.name : r.id ? String(r.id) : "";
  const out = {
    id: sanitizeId(r.id) || slugifySourceId(name),
    name,
    type: SOURCE_TYPES.includes(r.type) ? r.type : "board",
    sector: SOURCE_SECTORS.includes(r.sector) ? r.sector : "private",
    active: SOURCE_ACTIVE.includes(r.active) ? r.active : "maybe",
    urls,
    cadence: SOURCE_CADENCES.includes(r.cadence) ? r.cadence : "manual",
    // null = not yet classified (the pre-field state); a hand-edited unknown
    // mode is tolerantly dropped on read, loudly 400'd on write - the same
    // split every other enum here uses.
    fetchMode: SOURCE_FETCH_MODES.includes(r.fetchMode) ? r.fetchMode : null,
    fetchNote: typeof r.fetchNote === "string" ? r.fetchNote : "",
    instructions: typeof r.instructions === "string" ? r.instructions : "",
    outputFields: strArr(r.outputFields),
    aliases: strArr(r.aliases),
    // Absent/empty = "all tracks" (Decision 1); a hand-edited unknown value is
    // tolerantly dropped on read (same posture as a bad enum elsewhere in this
    // function) - the write boundary (validateSourceInput) is where an invalid
    // value is loudly rejected instead.
    tracks: strArr(r.tracks).filter((t) => SOURCE_TRACKS.includes(t)),
    lastRunAt: typeof r.lastRunAt === "string" && r.lastRunAt ? r.lastRunAt : null,
    lastVisitedAt: typeof r.lastVisitedAt === "string" && r.lastVisitedAt ? r.lastVisitedAt : null,
    notes: typeof r.notes === "string" ? r.notes : "",
    runs,
    instructionProposals: Array.isArray(r.instructionProposals)
      ? r.instructionProposals.filter((x) => x && typeof x === "object").map(normalizeProposal)
      : [],
    instructionsApprovedFrom:
      typeof r.instructionsApprovedFrom === "string" && r.instructionsApprovedFrom ? r.instructionsApprovedFrom : null,
    instructionsUpdatedAt:
      typeof r.instructionsUpdatedAt === "string" && r.instructionsUpdatedAt ? r.instructionsUpdatedAt : null,
    // apify-only fields (ADR 2026-07-06). Tolerant READ (like every field here):
    // actorId kept verbatim as a trimmed string (the RUN path re-sanitizes it to
    // the actor-id charset, guardian C2); input/fieldMap kept only when a plain
    // object, else null. A non-apify source carries actorId "" + null objects, and
    // serializeSource writes NONE of them unless truthy, so those sources stay
    // byte-identical on disk. The token is NEVER a source field (guardian C3).
    actorId: typeof r.actorId === "string" ? r.actorId.trim() : "",
    input: r.input && typeof r.input === "object" && !Array.isArray(r.input) ? r.input : null,
    fieldMap: r.fieldMap && typeof r.fieldMap === "object" && !Array.isArray(r.fieldMap) ? r.fieldMap : null,
  };
  // Version-skew passthrough (see MODELED_SOURCE_KEYS): unmodeled keys ride on
  // `_extra` in memory (never served - deriveSources builds explicit objects -
  // and never stored under that name - serializeSource spreads them back as
  // real keys). An already-normalized source re-entering here keeps its cargo.
  const extra = {};
  if (r._extra && typeof r._extra === "object") Object.assign(extra, r._extra);
  for (const k of Object.keys(r)) {
    if (!MODELED_SOURCE_KEYS.has(k)) extra[k] = r[k];
  }
  if (Object.keys(extra).length) out._extra = extra;
  return out;
}

// Read + normalize the registry. A missing / unparseable / partially hand-edited
// file degrades to { version:1, updated:null, sources:[] } rather than throwing -
// the same tolerance as loadTasks / loadRequests / the YAML read endpoints.
// loadSources moved behind the storage seam (store.loadSources). It calls the
// injected normalizeSource (still exported + directly tested here); tolerant read
// unchanged.

// Serialize one run record, dropping null/absent optionals so the file stays
// clean (same strip-empties posture as saveTasks).
function serializeRun(r) {
  const o = { startedAt: r.startedAt, outcome: r.outcome, trigger: r.trigger };
  if (r.runId) o.runId = r.runId;
  if (typeof r.durationMs === "number") o.durationMs = r.durationMs;
  if (typeof r.leadsFound === "number") o.leadsFound = r.leadsFound;
  if (typeof r.leadsNew === "number") o.leadsNew = r.leadsNew;
  if (typeof r.candidatesReviewed === "number") o.candidatesReviewed = r.candidatesReviewed;
  if (typeof r.alreadyTracked === "number") o.alreadyTracked = r.alreadyTracked;
  if (typeof r.filteredOut === "number") o.filteredOut = r.filteredOut;
  if (r.errorReason) o.errorReason = r.errorReason;
  return o;
}

// Serialize one instruction proposal, dropping absent optionals (same
// strip-empties posture as serializeRun). proposedInstructions is always
// written - it is the proposal's payload even when empty after a tolerant read.
function serializeProposal(p) {
  const o = { id: p.id, ts: p.ts, status: p.status, proposedInstructions: p.proposedInstructions || "" };
  if (p.ownerComment) o.ownerComment = p.ownerComment;
  if (p.rationale) o.rationale = p.rationale;
  if (p.resolvedAt) o.resolvedAt = p.resolvedAt;
  if (p.rejectionReason) o.rejectionReason = p.rejectionReason;
  return o;
}

// Serialize one source, dropping empty optionals (lastRunAt / lastVisitedAt /
// notes / runs / instructionProposals / provenance) so a source that never ran,
// was never visited, or never entered the proposal loop stays byte-clean on disk.
// Exported for the round-trip guard tests (tests/sources-serializer.test.js).
export function serializeSource(s) {
  const o = {
    id: s.id,
    name: s.name,
    type: s.type,
    sector: s.sector,
    active: s.active,
    urls: s.urls || [],
    cadence: s.cadence,
    instructions: s.instructions || "",
    outputFields: s.outputFields || [],
    aliases: s.aliases || [],
    tracks: s.tracks || [],
  };
  if (s.fetchMode) o.fetchMode = s.fetchMode;
  if (s.fetchNote) o.fetchNote = s.fetchNote;
  if (s.lastRunAt) o.lastRunAt = s.lastRunAt;
  if (s.lastVisitedAt) o.lastVisitedAt = s.lastVisitedAt;
  if (s.notes) o.notes = s.notes;
  if (Array.isArray(s.runs) && s.runs.length) o.runs = s.runs.map(serializeRun);
  if (Array.isArray(s.instructionProposals) && s.instructionProposals.length) {
    o.instructionProposals = s.instructionProposals.map(serializeProposal);
  }
  if (s.instructionsApprovedFrom) o.instructionsApprovedFrom = s.instructionsApprovedFrom;
  if (s.instructionsUpdatedAt) o.instructionsUpdatedAt = s.instructionsUpdatedAt;
  // apify-only, written ONLY when present so a non-apify source (actorId "",
  // input/fieldMap null/empty) serializes byte-identically to before this field
  // existed. The token is never here (guardian C3).
  if (s.actorId) o.actorId = s.actorId;
  if (s.input && typeof s.input === "object" && Object.keys(s.input).length) o.input = s.input;
  if (s.fieldMap && typeof s.fieldMap === "object" && Object.keys(s.fieldMap).length) o.fieldMap = s.fieldMap;
  // Write the version-skew cargo back as real keys (never as `_extra`) so a
  // field this serializer does not model survives the round-trip untouched.
  // Modeled fields always win a name collision.
  for (const [k, v] of Object.entries(s._extra || {})) {
    if (!(k in o)) o[k] = v;
  }
  return o;
}

// Atomic write (stage .tmp -> rename), same posture as saveTasks / saveRequests:
// discovery-sources.yaml is an app-managed SoT in the docs dir, so an in-place
// write could be read half-written. Stamps `updated` to today's LOCAL date.
// saveSources moved behind the storage seam (store.saveSources). It calls the
// injected normalizeSource + serializeSource (still exported + directly tested by
// tests/sources-serializer.test.js); atomic write + `updated` stamp unchanged.

// Keep only the newest MAX_SOURCE_RUNS runs (bounded history), oldest-first.
function capRuns(runs) {
  const arr = [...runs].sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? -1 : 1));
  return arr.slice(Math.max(0, arr.length - MAX_SOURCE_RUNS));
}

// ---- derived-view helpers (pure; the testable heart of the GET contract) ----

// lowercased(name / alias / id) -> canonical source id. The join index that maps
// a find's messy legacy Source string (or a stamped sourceId) back to a source.
export function buildAliasIndex(sources) {
  const idx = new Map();
  for (const s of sources) {
    idx.set(s.id.toLowerCase(), s.id);
    const name = (s.name || "").trim().toLowerCase();
    if (name) idx.set(name, s.id);
    for (const a of s.aliases || []) {
      const k = String(a).trim().toLowerCase();
      if (k) idx.set(k, s.id);
    }
  }
  return idx;
}

// Resolve ONE find to a source id, or null (the honest unassigned bucket). Prefer
// a stamped canonical sourceId; else fall back to the find's Source string joined
// through the alias index. Case/space-insensitive exact match.
export function resolveFindSourceId(find, idx) {
  const sid = find.sourceId != null ? String(find.sourceId).trim().toLowerCase() : "";
  if (sid && idx.has(sid)) return idx.get(sid);
  const name = find.Source != null ? find.Source : find.source;
  const key = name != null ? String(name).trim().toLowerCase() : "";
  if (key && idx.has(key)) return idx.get(key);
  return null;
}

// A find counts as pursued when the owner decided "pursue" OR it is already
// tracked as a Jobs/ folder (the two signals discovery.py exposes).
function isPursued(find) {
  const dec = (find.Decision != null ? find.Decision : find.decision || "").toString().trim().toLowerCase();
  return dec === "pursue" || find.tracked === true;
}

// Finds strictly newer than the last visit. Never visited -> everything is new
// (the honest "you have not looked at any of these" signal). Day-granularity: a
// find's "Date Found" is a date, compared against the visit timestamp.
function countNewSinceVisit(finds, lastVisitedAt) {
  if (!lastVisitedAt) return finds.length;
  const cut = Date.parse(lastVisitedAt);
  if (!Number.isFinite(cut)) return finds.length;
  let n = 0;
  for (const f of finds) {
    const d = Date.parse(f["Date Found"] != null ? f["Date Found"] : f.date || "");
    if (Number.isFinite(d) && d > cut) n++;
  }
  return n;
}

// Compute { status, due, nextRunAt } for one source. NONE of these are stored -
// they are a pure function of active / the run history / lastRunAt vs the cadence
// window, so the health pill can never drift from reality. Precedence (first
// match wins): paused (active=no) > running (a live run) > failed (last terminal
// run failed) > never-run (no run, no lastRunAt) > stale (overdue by >= 2x the
// cadence interval) > due (overdue by >= 1x) > healthy. `due` is the scheduler
// signal (true also for a never-run scheduled source); manual sources are never
// due and have a null nextRunAt.
export function deriveSourceStatus(source, now = new Date()) {
  const s = normalizeSource(source);
  const nowMs = now.getTime();
  const cadence = s.cadence;
  const interval = cadenceIntervalDays(cadence);
  const lastRunMs = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
  const running = (s.runs || []).some((r) => r && r.outcome === "running");
  const terminal = (s.runs || [])
    .filter((r) => r && r.outcome && r.outcome !== "running")
    .sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? 1 : -1))[0]; // newest terminal
  const nextRunAt =
    cadence === "manual" || interval == null || !Number.isFinite(lastRunMs)
      ? null
      : new Date(lastRunMs + interval * 86400000).toISOString();
  let due = false;
  if (cadence !== "manual" && interval != null) {
    due = !Number.isFinite(lastRunMs) || nowMs >= lastRunMs + interval * 86400000;
  }
  const staleOverdue =
    cadence !== "manual" && interval != null && Number.isFinite(lastRunMs) && nowMs >= lastRunMs + 2 * interval * 86400000;
  let status;
  if (s.active === "no") status = "paused";
  else if (running) status = "running";
  else if (terminal && terminal.outcome === "failed") status = "failed";
  else if (!terminal && !Number.isFinite(lastRunMs)) status = "never-run";
  else if (staleOverdue) status = "stale";
  else if (due) status = "due";
  else status = "healthy";
  return { status, due, nextRunAt };
}

// Classify a source's newest terminal SUCCEEDED run for the health pill
// (t-1783200897663 (a)) - DERIVED server-side, never stored, so the pill can
// distinguish a healthy dedup-heavy run from a possibly-broken scrape without
// reading runLog prose or re-deriving client-side:
//   "leads"      - the run landed new leads (leadsNew > 0; fallback leadsFound).
//   "dedup"      - zero new, but the scout REPORTED reviewing candidates: the
//                  scrape worked; everything was already tracked / filtered
//                  (the University Affairs field-run case - leadsFound 0,
//                  candidatesReviewed 8).
//   "quiet"      - zero new AND the scout reported reviewing 0 candidates: the
//                  source genuinely listed nothing relevant. Healthy.
//   "unverified" - zero new and NO counters reported (a pre-counter run, or
//                  the scout skipped the report): numerically identical to a
//                  broken scrape - the honest "cannot tell" state.
//   null         - no terminal succeeded scrape run to classify (never ran,
//                  still running, or last terminal run failed/incomplete -
//                  the status field already tells that story).
// When the close path could not count leads (workbook locked -> leadsFound
// null), the scout's own reported counters are the best available evidence
// and drive the dedup/quiet split; with neither, "unverified".
export function deriveLastRunSignal(runsArr) {
  const terminal = [...(runsArr || [])]
    .filter((r) => r && r.outcome && r.outcome !== "running")
    .sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? 1 : -1))[0];
  if (!terminal || terminal.outcome !== "succeeded") return null;
  const n =
    typeof terminal.leadsNew === "number"
      ? terminal.leadsNew
      : typeof terminal.leadsFound === "number"
        ? terminal.leadsFound
        : null;
  if (n !== null && n > 0) return "leads";
  const reviewed = typeof terminal.candidatesReviewed === "number" ? terminal.candidatesReviewed : null;
  if (reviewed === null) return "unverified";
  return reviewed > 0 ? "dedup" : "quiet";
}

// The full derived GET payload: each source with its stored fields + derived
// status/jobCount/newSinceVisit/pursuedPct/due/nextRunAt, plus the honest
// unassigned bucket (finds matching no source, grouped by their raw Source
// label). PURE over (doc, finds, now) so the whole contract is unit-testable
// without HTTP, python, or the xlsx.
export function deriveSources(doc, finds = [], now = new Date()) {
  const sources = (doc && Array.isArray(doc.sources) ? doc.sources : []).map(normalizeSource);
  const idx = buildAliasIndex(sources);
  const byId = new Map();
  let unassignedCount = 0;
  const unassignedByLabel = new Map();
  for (const f of finds) {
    const id = resolveFindSourceId(f, idx);
    if (id) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(f);
    } else {
      unassignedCount++;
      const label = (f.Source != null ? f.Source : f.source || "").toString().trim() || "(no source)";
      unassignedByLabel.set(label, (unassignedByLabel.get(label) || 0) + 1);
    }
  }
  const derived = sources.map((s) => {
    const mine = byId.get(s.id) || [];
    const jobCount = mine.length;
    const pursued = mine.filter(isPursued).length;
    const st = deriveSourceStatus(s, now);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      sector: s.sector,
      active: s.active,
      urls: s.urls,
      cadence: s.cadence,
      fetchMode: s.fetchMode || null,
      fetchNote: s.fetchNote || "",
      instructions: s.instructions,
      outputFields: s.outputFields,
      aliases: s.aliases,
      tracks: s.tracks || [],
      // apify-only (served for the J10 Apify form; NEVER the token). Non-apify
      // sources carry the harmless empty defaults.
      actorId: s.actorId || "",
      input: s.input || {},
      fieldMap: s.fieldMap || {},
      lastRunAt: s.lastRunAt,
      lastVisitedAt: s.lastVisitedAt,
      notes: s.notes,
      runs: [...(s.runs || [])].sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? 1 : -1)), // newest-first
      // Instruction-proposal loop (§5 Decision 4): the append-only log, served
      // newest-first like runs, plus the two SERVER-MANAGED provenance fields.
      instructionProposals: [...(s.instructionProposals || [])].sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1)),
      instructionsApprovedFrom: s.instructionsApprovedFrom || null,
      instructionsUpdatedAt: s.instructionsUpdatedAt || null,
      status: st.status,
      due: st.due,
      nextRunAt: st.nextRunAt,
      // Honesty classification of the newest terminal succeeded run (see
      // deriveLastRunSignal): lets the health pill tell dedup-heavy from
      // possibly-broken without re-deriving client-side.
      lastRunSignal: deriveLastRunSignal(s.runs),
      jobCount,
      newSinceVisit: countNewSinceVisit(mine, s.lastVisitedAt),
      pursuedPct: jobCount ? Math.round((pursued / jobCount) * 100) : 0,
      // SERVER-DERIVED (never stored) scrape-contract gap (docs/data-schema.md §5
      // Decision 3a) - components read this directly, never re-guess the alias match.
      contractGaps: computeContractGaps(s.outputFields),
    };
  });
  const unassignedSources = [...unassignedByLabel.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { sources: derived, unassignedCount, unassignedSources };
}

// Close-path doc transform (pure): flip a source's optimistic "running" run
// record to its terminal outcome + duration + lead counts, matched by runId
// (fallback: the running record). Caps history. Exported so the runner's close
// wiring is testable without spawning a real agent.
export function finalizeRunRecord(doc, { sourceId, runId, outcome, durationMs = null, leadsFound = null, leadsNew = null, errorReason = null }) {
  const source = (doc && Array.isArray(doc.sources) ? doc.sources : []).find((s) => s.id === sourceId);
  if (!source) return doc;
  const runs = Array.isArray(source.runs) ? source.runs : [];
  let rec = runs.find((r) => r && r.runId === runId) || runs.find((r) => r && r.outcome === "running");
  if (!rec) return doc;
  rec.outcome = RUN_OUTCOMES.includes(outcome) ? outcome : "incomplete";
  if (typeof durationMs === "number") rec.durationMs = durationMs;
  if (typeof leadsFound === "number") rec.leadsFound = leadsFound;
  if (typeof leadsNew === "number") rec.leadsNew = leadsNew;
  if (errorReason) rec.errorReason = errorReason;
  source.runs = capRuns(runs);
  return doc;
}

// ===========================================================================
// APIFY CONNECTOR (ADR 2026-07-06; guardian conditions C1-C10, ticket
// t-1783339605935). A `type:"apify"` source runs DETERMINISTICALLY server-side:
// POST api.apify.com run-sync-get-dataset-items -> map the dataset to finds ->
// write them through the SAME discovery.py path the scout uses (no second
// store, no agent, no model in the loop). It CANNOT fire unless the owner sets
// apifyEnabled AND provides APIFY_TOKEN (guardian C5a); tests drive it entirely
// through the JOBHUNT_APIFY_* seams, so the suite makes zero network calls and
// spends zero money.
// ===========================================================================

// --- config-derived caps + the owner master switch -------------------------
// All read from the git-tracked config.json (defaults below when absent, so the
// feature ships OFF and cost-capped without any config edit). NONE is a secret;
// the token is the ONLY secret and it lives in process.env.APIFY_TOKEN alone.
// The JOBHUNT_APIFY_* env vars are the hermetic TEST seams (mirroring
// JOBHUNT_DISCOVERY_FINDS / JOBHUNT_PYTHON) - owner-launch overrides that an
// agent can never set on the already-running server process.
const APIFY_MAX_ITEMS_PER_RUN = Number(config.apifyMaxItemsPerRun) > 0 ? Math.floor(Number(config.apifyMaxItemsPerRun)) : 50;
const APIFY_MAX_RUNS_PER_SWEEP = Number(config.apifyMaxRunsPerSweep) > 0 ? Math.floor(Number(config.apifyMaxRunsPerSweep)) : 5;
const APIFY_MONTHLY_RUN_CAP = Number(config.apifyMonthlyRunCap) > 0 ? Math.floor(Number(config.apifyMonthlyRunCap)) : 100;
const APIFY_RUN_TIMEOUT_SEC = 110; // the ?timeout= actor-run duration cap (guardian C5e)
const APIFY_HTTP_TIMEOUT_MS = 120_000; // AbortController hard client timeout (> the run cap)

function apifyMaxItemsPerRun() {
  const s = Number(process.env.JOBHUNT_APIFY_MAX_ITEMS);
  return Number.isFinite(s) && s > 0 ? Math.floor(s) : APIFY_MAX_ITEMS_PER_RUN;
}
function apifyMaxRunsPerSweep() {
  const s = Number(process.env.JOBHUNT_APIFY_MAX_SWEEP);
  return Number.isFinite(s) && s > 0 ? Math.floor(s) : APIFY_MAX_RUNS_PER_SWEEP;
}
function apifyMonthlyRunCap() {
  const s = Number(process.env.JOBHUNT_APIFY_MONTHLY_CAP);
  return Number.isFinite(s) && s >= 0 ? Math.floor(s) : APIFY_MONTHLY_RUN_CAP;
}
// The owner's master switch (guardian C5a): NOT a secret, lives in config.json
// (default false), read-only - no route or agent path ever writes it. Separate
// from token presence ON PURPOSE: a token alone must never be enough to spend.
function apifyEnabled() {
  // Demo mode NEVER runs live Apify egress (design 5.4 / MF-9). This is a second
  // layer over the boot assertion that a demo carries no APIFY_TOKEN: even if the
  // config flag/test seam said yes, demo forces it off.
  if (DEMO_MODE) return false;
  if (process.env.JOBHUNT_APIFY_ENABLED === "1") return true; // hermetic test seam
  if (process.env.JOBHUNT_APIFY_ENABLED === "0") return false;
  return config.apifyEnabled === true;
}
// The single gate + the client-facing signal. apifyConfigured === (owner enabled
// AND a token is present). Token-present-alone is deliberately NOT enough.
// Exposes only presence/enablement, NEVER the token value (guardian C4).
export function apifyConfigured() {
  return apifyEnabled() && Boolean(process.env.APIFY_TOKEN);
}

// --- pure, exported helpers (unit-testable without a server boot) -----------

// Validate an actorId to the actor-id charset (guardian C2). REJECTS (returns "")
// anything carrying a URL scheme, query/fragment, whitespace, backslash, a path
// escape ("..") or an empty segment ("//"), or a leading/trailing slash - so a
// full URL from the source record can never become the request host/path, and
// no cross-host reach is possible. `misceres~indeed-scraper` and
// `username/actorName` pass; `https://evil.com/x` -> "".
export function sanitizeActorId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  if (/[\s?#&:\\]/.test(s)) return "";
  if (s.includes("//") || s.includes("..")) return "";
  if (!/^[A-Za-z0-9_~.\/-]+$/.test(s)) return "";
  if (s.startsWith("/") || s.endsWith("/")) return "";
  return s;
}

// Clamp one item-count value DOWN to the per-run ceiling (guardian C5b). Absent/
// non-positive/non-finite -> the ceiling itself (the hard cap is authoritative).
export function clampMaxItems(value, ceiling = APIFY_MAX_ITEMS_PER_RUN) {
  const c = Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : 1;
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return c;
  return Math.min(Math.floor(v), c);
}

// Build the Apify actor RUN INPUT solely from the source record (guardian C1):
// the ONLY argument is `source`, so it structurally cannot read a Jobs/ file,
// ops/facts, the CV, owner identity, or any vault content. It is a verbatim copy
// of source.input with any item-count knob clamped down to the ceiling; nothing
// is injected. For a fixed source the output is byte-stable and carries only the
// owner-typed search keys.
export function buildApifyInput(source, ceiling = APIFY_MAX_ITEMS_PER_RUN) {
  const raw = source && source.input && typeof source.input === "object" && !Array.isArray(source.input) ? source.input : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v;
  for (const key of ["maxItems", "maxResults", "maxPagesPerCrawl"]) {
    if (key in out) out[key] = clampMaxItems(out[key], ceiling);
  }
  return out;
}

// xlsx formula-injection guard (guardian C9). Apify items are UNTRUSTED external
// data; a cell value that leads with = + - @ (or a tab/CR/LF that can smuggle a
// formula onto a new line) is quote-prefixed so Excel stores it as literal text,
// never evaluates it. The codebase had no prior guard (grepped) - this is it.
export function sanitizeCell(value) {
  if (value == null) return "";
  const s = String(value);
  return /^[=+\-@\t\r\n]/.test(s) ? "'" + s : s;
}

// Map ONE dataset item -> a discovery.py "add" find, or null when unusable.
// Alias-driven + defensive: first present (case-insensitive) alias per field,
// overridable by source.fieldMap. track/fit are DELIBERATELY blank (a
// deterministic API run fabricates no per-posting judgment); sector/source/
// sourceId come from the source record (provenance). EVERY untrusted string is
// run through sanitizeCell before it can reach the workbook (C9). An item
// missing BOTH title and link is unusable -> null.
export function mapApifyItem(source, item, today = localDateISO()) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const fmap = source && source.fieldMap && typeof source.fieldMap === "object" && !Array.isArray(source.fieldMap) ? source.fieldMap : {};
  const ci = {};
  for (const [k, v] of Object.entries(item)) ci[String(k).toLowerCase()] = v;
  const pick = (aliases) => {
    for (const a of aliases) {
      if (!a) continue;
      const v = ci[String(a).toLowerCase()];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
  const title = pick([fmap.title, fmap.role, "positionName", "title", "jobTitle", "position", "name"]);
  const employer = pick([fmap.employer, "company", "companyName", "employer"]);
  const link = pick([fmap.link, "url", "jobUrl", "link", "externalApplyLink", "applyUrl"]);
  const location = pick([fmap.location, "location", "formattedLocation", "jobLocation", "city"]);
  const deadline = pick([fmap.deadline, "deadline", "closingDate", "expiryDate"]);
  const salary = pick([fmap.salary, "salary", "salaryText", "formattedSalary"]);
  if (!title && !link) return null; // unusable -> skip (counted)
  const find = {
    date: today,
    title,
    employer,
    sector: (source && source.sector) || "",
    track: "",
    fit: "",
    deadline,
    location,
    source: (source && source.name) || "",
    link,
    notes: salary ? `Salary: ${salary}` : "",
    sourceId: (source && source.id) || "",
  };
  // Guard every field that carries scraped (untrusted) data (C9). date/sector/
  // source/sourceId/track/fit are server- or owner-owned, not scraped.
  for (const k of ["title", "employer", "deadline", "location", "link", "notes"]) find[k] = sanitizeCell(find[k]);
  return find;
}

// Map a whole dataset -> { finds, skipped }. Unusable items are skipped+counted;
// within-batch duplicate links are dropped (a belt - discovery.py still dedups
// on title+employer against the whole workbook + Jobs/).
export function mapApifyDataset(source, items, today = localDateISO()) {
  const finds = [];
  const seen = new Set();
  let skipped = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const f = mapApifyItem(source, it, today);
    if (!f) { skipped++; continue; }
    // Past-deadline guard (t-1783422051088): a posting whose application deadline
    // is a real calendar date already before today is dead - it can no longer be
    // applied to, so never file it as a fresh lead. discovery.py's cmd_add is the
    // authoritative single-write-path backstop (it also covers the scout path);
    // dropping it HERE keeps the deterministic apify honesty counters truthful -
    // an expired item lands in filteredOut, not a silent skip at write time.
    // Free-text ("rolling") and absent deadlines are never judged (isExpiredDeadline).
    if (isExpiredDeadline(f.deadline, today)) { skipped++; continue; }
    const key = f.link ? f.link.toLowerCase() : "";
    if (key && seen.has(key)) { skipped++; continue; }
    if (key) seen.add(key);
    finds.push(f);
  }
  return { finds, skipped };
}

// Monthly run cap DERIVED from the existing runs[] history (guardian C5c) - NO
// new store (ADR-001). Counts apify-source runs whose recorded startedAt falls
// in the current LOCAL month across every apify source. Residual: runs[] is
// capped at MAX_SOURCE_RUNS (20) per source, so a source that ran > 20 times in
// one month under-counts here - the Apify-console account limit is the hard
// backstop for that edge (parked for the owner).
export function countApifyRunsThisMonth(sources, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  let n = 0;
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || s.type !== "apify") continue;
    for (const r of Array.isArray(s.runs) ? s.runs : []) {
      const t = r && r.startedAt ? new Date(r.startedAt) : null;
      if (t && !Number.isNaN(t.getTime()) && t.getFullYear() === y && t.getMonth() === m) n++;
    }
  }
  return n;
}

// Choose which due apify sources a sweep may launch (guardian C5c + C5d):
// most-overdue-first (oldest lastRunAt; never-run counts as most overdue), and
// bounded by BOTH the per-sweep fan-out cap AND the room left under the monthly
// cap, so one sweep can never spawn unbounded paid runs and can never cross the
// monthly ceiling mid-drain. Returns { launch, skippedBudget } as source arrays;
// at/over the monthly cap, launch is empty and ALL are filtered out.
export function selectApifySweepTargets(dueApify, { perSweepCap = APIFY_MAX_RUNS_PER_SWEEP, monthlyCount = 0, monthlyCap = APIFY_MONTHLY_RUN_CAP } = {}) {
  const list = Array.isArray(dueApify) ? [...dueApify] : [];
  const remaining = Math.max(0, monthlyCap - monthlyCount);
  const budget = Math.min(Number.isFinite(perSweepCap) ? perSweepCap : 0, remaining);
  const sorted = list.sort((a, b) => {
    const ta = a && a.lastRunAt ? Date.parse(a.lastRunAt) : -Infinity; // never-run = most overdue
    const tb = b && b.lastRunAt ? Date.parse(b.lastRunAt) : -Infinity;
    return ta - tb;
  });
  if (budget <= 0) return { launch: [], skippedBudget: sorted };
  return { launch: sorted.slice(0, budget), skippedBudget: sorted.slice(budget) };
}

// --- the run path (registered in the SAME runs Map; no _proc, no agent) -----

// Friendly, TOKEN-FREE terminal reason for a failed apify run (guardian C4 +
// C10). Built from the HTTP status / error kind only - the token, URL, and
// headers are never interpolated, so they cannot leak into the run record, the
// activity log, or any error string. No retry: a failure is terminal.
function apifyErrorReason(e) {
  if (e && e.name === "AbortError") return "Apify unreachable or timed out";
  const code = e && e.httpStatus;
  if (code === 401 || code === 403) return "APIFY_TOKEN rejected by Apify";
  if (code && code >= 400 && code < 500) return `Apify rejected the request (HTTP ${code})`;
  if (code && code >= 500) return "Apify unreachable or timed out";
  return "Apify unreachable or timed out";
}

// Fetch the dataset items for one run. TEST SEAMS come first so the suite never
// touches the network or spends: JOBHUNT_APIFY_STATUS drives the error branches
// (a status code, "timeout", or "bad-shape"); JOBHUNT_APIFY_FIXTURE supplies
// canned items. The REAL path sends the token as an Authorization: Bearer HEADER
// (never ?token=, guardian C4), pins the host to api.apify.com (C2), refuses
// cross-host redirects, caps the run via ?maxItems + ?timeout, and hard-aborts
// at APIFY_HTTP_TIMEOUT_MS (C5e). Returns the parsed body (array on success).
async function fetchApifyDataset(source, actorId, ceiling) {
  const statusSeam = process.env.JOBHUNT_APIFY_STATUS;
  if (statusSeam) {
    if (statusSeam === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    if (statusSeam === "bad-shape") return { notAnArray: true };
    const code = Number(statusSeam);
    if (Number.isFinite(code) && code >= 400) { const e = new Error(`http ${code}`); e.httpStatus = code; throw e; }
  }
  const fixture = process.env.JOBHUNT_APIFY_FIXTURE;
  if (fixture) return JSON.parse(fs.readFileSync(fixture, "utf8"));

  const token = process.env.APIFY_TOKEN;
  const url =
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items` +
    `?maxItems=${ceiling}&timeout=${APIFY_RUN_TIMEOUT_SEC}&format=json`;
  const body = JSON.stringify(buildApifyInput(source, ceiling));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), APIFY_HTTP_TIMEOUT_MS);
  let resp;
  try {
    resp = await globalThis.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
      redirect: "error", // never follow a redirect to another host (C2)
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) { const e = new Error(`http ${resp.status}`); e.httpStatus = resp.status; throw e; }
  return await resp.json();
}

// Write one mapped find via `discovery.py add` (the SAME single write path the
// scout uses - so dedup, the sector->tailoring rule, and the Jobs/ tracked-skip
// all stay inside discovery.py; the server never reimplements them). Argv array
// (never a shell string), so a value is never re-parsed as shell syntax.
function apifyAddFind(find) {
  return new Promise((resolve, reject) => {
    const script = path.join(WORKSPACE_DIR, "ops", "scripts", "discovery.py");
    const args = [
      script, "add",
      find.date, find.title, find.employer, find.sector, find.track, find.fit,
      find.deadline, find.location, find.source, find.link, find.notes, find.sourceId,
    ];
    execFile(PYTHON, args, { cwd: WORKSPACE_DIR, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        if (isWorkbookLocked(err, stderr)) { const e = new Error("locked"); e.locked = true; return reject(e); }
        return reject(new Error(stderr || err.message));
      }
      resolve((stdout || "").trim());
    });
  });
}

// Write the mapped finds SEQUENTIALLY (await each before the next): each add
// does its own openpyxl load/save, so parallel calls would race and lose rows
// (the ADR's zero-vault-change fallback). Returns how many discovery.py reported
// as already-tracked DUPs (an honesty counter). A workbook lock rejects the
// batch cleanly with a token-free, friendly reason.
async function writeApifyFinds(finds) {
  let dup = 0;
  for (const f of finds) {
    const out = await apifyAddFind(f);
    if (/^DUP\b/.test(out || "")) dup++;
  }
  return { dup };
}

// The async body of an apify run: fetch -> map -> write. Sets run.status +
// run.errorReason; NEVER throws into the caller (finishApifyRun runs the close
// tail regardless). A zero-result run reads as `quiet`, never a fake success.
async function runApifyFlow(source, run) {
  const ceiling = apifyMaxItemsPerRun();
  const actorId = sanitizeActorId(source.actorId);
  if (!actorId) return failApifyRun(run, "invalid actorId (must be like username~actorName)");
  let items;
  try {
    items = await fetchApifyDataset(source, actorId, ceiling);
  } catch (e) {
    return failApifyRun(run, apifyErrorReason(e));
  }
  if (!Array.isArray(items)) return failApifyRun(run, "unexpected Apify response shape");
  const { finds, skipped } = mapApifyDataset(source, items, localDateISO());
  let dup = 0;
  try {
    ({ dup } = await writeApifyFinds(finds));
  } catch (e) {
    return failApifyRun(run, e && e.locked ? WORKBOOK_LOCKED_MSG : "could not write finds to the workbook");
  }
  run.status = "done";
  run.exitCode = 0;
  // Honesty counters (best-effort, same posture as the scout callback): reviewed
  // = items returned, filteredOut = unusable/within-batch dups, alreadyTracked =
  // discovery.py DUPs. Written onto the run record by finalizeSourceRun.
  run._apifyReport = { candidatesReviewed: items.length, filteredOut: skipped, alreadyTracked: dup };
}

function failApifyRun(run, reason) {
  run.status = "failed";
  run.exitCode = 1;
  run.errorReason = reason; // already token-free
}

// Register an apify run in the SAME runs Map (status running, no _proc) so it
// counts toward runningCount()/MAX_CONCURRENT_RUNS, appears in the Run panel,
// and finalizes through finalizeSourceRun exactly like a scout run. On
// completion it runs the IDENTICAL close tail startRun runs on proc.close.
function startApifyRun(source, extra = {}) {
  const runId = `r${Date.now()}_${++runSeq}`;
  const run = {
    id: runId,
    routine: "discover-jobs-apify",
    label: "Discover jobs (Apify)",
    jobId: source.id,
    batchId: extra.batchId || null,
    prompt: null,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    sourceId: extra.sourceId,
    sourceBaseline: extra.sourceBaseline,
  };
  runs.set(runId, run);
  store.appendActivity({ kind: "run", runId, routine: run.routine, label: run.label, jobId: source.id, batchId: run.batchId || null, status: "running" });
  // Deterministic server-side flow (no spawn). Any unexpected throw still ends
  // the run cleanly as failed - never a crash, never a fake success.
  Promise.resolve()
    .then(() => runApifyFlow(source, run))
    .catch((e) => failApifyRun(run, apifyErrorReason(e)))
    .finally(() => finishApifyRun(run));
  return run;
}

// The shared close tail for an apify run - mirrors startRun's proc.close.
function finishApifyRun(run) {
  if (run.status === "running") run.status = "failed"; // defensive: never leave it hung
  run._proc = null;
  store.appendActivity({ kind: "run", runId: run.id, status: run.status, exitCode: run.exitCode, batchId: run.batchId || null });
  if (run.sourceId) finalizeSourceRun(run);
  broadcast({ type: "run-finished", runId: run.id, routine: run.routine, jobId: run.jobId });
  processQueue();
}

// Validate + coerce a write body into the fields that may be set on a source.
// Closed enums are LOUD (present-but-invalid -> 400); absent enums default on
// create and are a no-op on patch. `url`/`urls` fold into a clean urls list.
// lastRunAt / runs are NOT accepted here (server-managed, unforgeable, same
// posture as task `completed` / attachments). Throws with .httpStatus 400 on a
// bad enum so both route handlers' catch maps it to a 400.
function assertEnumField(body, key, allowed) {
  if (!(key in body) || body[key] === undefined) return undefined;
  const v = body[key];
  if (typeof v === "string" && allowed.includes(v)) return v;
  const e = new Error(`${key} must be one of: ${allowed.join(", ")}`);
  e.httpStatus = 400;
  throw e;
}
function coerceStrArrayField(body, key) {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (!Array.isArray(v)) {
    const e = new Error(`${key} must be an array of strings`);
    e.httpStatus = 400;
    throw e;
  }
  return v.map((x) => (x == null ? "" : String(x).trim())).filter((x) => x !== "");
}
// Like assertEnumField, but for an array field where EVERY entry must be one of
// the allowed values (tracks: a closed 7-key enum, docs/data-schema.md §5 Decision
// 1) - a present-but-invalid entry is a loud 400, same posture as a bad scalar enum.
function assertEnumArrayField(body, key, allowed) {
  if (!(key in body) || body[key] === undefined) return undefined;
  const v = body[key];
  if (!Array.isArray(v)) {
    const e = new Error(`${key} must be an array of strings`);
    e.httpStatus = 400;
    throw e;
  }
  const out = v.map((x) => String(x).trim()).filter((x) => x !== "");
  const bad = out.find((x) => !allowed.includes(x));
  if (bad !== undefined) {
    const e = new Error(`${key} values must be one of: ${allowed.join(", ")} (got "${bad}")`);
    e.httpStatus = 400;
    throw e;
  }
  return out;
}
function coerceUrlsField(body) {
  if ("urls" in body) {
    const v = body.urls;
    if (!Array.isArray(v)) {
      const e = new Error("urls must be an array of strings");
      e.httpStatus = 400;
      throw e;
    }
    return v.map((x) => (x == null ? "" : String(x).trim())).filter((x) => x !== "");
  }
  if ("url" in body && body.url != null && String(body.url).trim()) return [String(body.url).trim()];
  return undefined;
}
function validateSourceInput(body, { create = false, existing = null } = {}) {
  const out = {};
  if ("name" in body) {
    const n = typeof body.name === "string" ? body.name.trim() : "";
    if (n) out.name = n;
  }
  const t = assertEnumField(body, "type", SOURCE_TYPES);
  if (t !== undefined) out.type = t;
  const sec = assertEnumField(body, "sector", SOURCE_SECTORS);
  if (sec !== undefined) out.sector = sec;
  const act = assertEnumField(body, "active", SOURCE_ACTIVE);
  if (act !== undefined) out.active = act;
  const cad = assertEnumField(body, "cadence", SOURCE_CADENCES);
  if (cad !== undefined) out.cadence = cad;
  // fetchMode: closed enum, loud 400 on a bad value; null/"" explicitly CLEARS
  // it back to "not classified" (it is an optional classification, unlike the
  // always-present enums above, so it needs a way back to absent).
  if ("fetchMode" in body && (body.fetchMode === null || body.fetchMode === "")) {
    out.fetchMode = null;
  } else {
    const fm = assertEnumField(body, "fetchMode", SOURCE_FETCH_MODES);
    if (fm !== undefined) out.fetchMode = fm;
  }
  if ("fetchNote" in body) out.fetchNote = typeof body.fetchNote === "string" ? body.fetchNote : "";
  const urls = coerceUrlsField(body);
  if (urls !== undefined) out.urls = urls;
  if ("instructions" in body) out.instructions = typeof body.instructions === "string" ? body.instructions : "";
  const of = coerceStrArrayField(body, "outputFields");
  if (of !== undefined) out.outputFields = of;
  const al = coerceStrArrayField(body, "aliases");
  if (al !== undefined) out.aliases = al;
  const trk = assertEnumArrayField(body, "tracks", SOURCE_TRACKS);
  if (trk !== undefined) out.tracks = trk;
  // apify-only fields (ADR 2026-07-06). actorId is stored SANITIZED to the
  // actor-id charset (guardian C2); a value that sanitizes to "" (e.g. a URL) is
  // caught by the effective-type check below. input/fieldMap accept a plain JSON
  // object only (they become the actor RUN INPUT body / mapper overrides).
  if ("actorId" in body) out.actorId = sanitizeActorId(body.actorId);
  const assertPlainObject = (key) => {
    if (!(key in body)) return undefined;
    const v = body[key];
    if (v == null) return {};
    if (typeof v !== "object" || Array.isArray(v)) {
      const e = new Error(`${key} must be a JSON object`);
      e.httpStatus = 400;
      throw e;
    }
    return v;
  };
  const inp = assertPlainObject("input");
  if (inp !== undefined) out.input = inp;
  const fmp = assertPlainObject("fieldMap");
  if (fmp !== undefined) out.fieldMap = fmp;
  // When the EFFECTIVE type resolves to apify, a non-empty sanitized actorId is
  // REQUIRED (guardian C2 / ADR §3). Effective type = the incoming type, else
  // the stored type on patch, else the create default (board).
  const effectiveType = out.type !== undefined ? out.type : existing ? existing.type : "board";
  if (effectiveType === "apify") {
    const effectiveActorId = "actorId" in body ? out.actorId : existing ? existing.actorId : "";
    if (!effectiveActorId) {
      const e = new Error("actorId is required for an apify source (a valid actor id like username~actorName, never a URL)");
      e.httpStatus = 400;
      throw e;
    }
  }
  if ("notes" in body) out.notes = typeof body.notes === "string" ? body.notes : "";
  if ("lastVisitedAt" in body) {
    const v = body.lastVisitedAt;
    out.lastVisitedAt = v === null || v === "" ? null : String(v);
  }
  if (create) {
    if (out.type === undefined) out.type = "board";
    if (out.sector === undefined) out.sector = "private";
    if (out.active === undefined) out.active = "yes";
    if (out.cadence === undefined) out.cadence = "manual";
    if (out.urls === undefined) out.urls = [];
    if (out.instructions === undefined) out.instructions = "";
    if (out.outputFields === undefined) out.outputFields = [...DEFAULT_OUTPUT_FIELDS];
    if (out.aliases === undefined) out.aliases = [];
  }
  return out;
}

// The live propose-instructions run for a source, if any - a pure read of the
// in-memory runs Map (process state, never stored) via the generalized
// (routine, scopeId) lock read, activeRunFor (t-1783198713071). This is both
// the 409 guard (one propose run per source at a time) and the source of the
// DERIVED proposeRunId the GET payload carries, so the drawer's "Reviewing
// your note..." state survives a page reload instead of living only in the
// client.
function activeProposeRun(sourceId) {
  return activeRunFor("propose-instructions", sourceId);
}
// Overlay the derived (never-stored) proposeRunId onto a served source. Applied
// by the route handlers, not deriveSources - the pure function stays pure over
// (doc, finds, now); this reads live process state.
function stampProposeRun(derived) {
  if (!derived) return derived;
  const r = activeProposeRun(derived.id);
  derived.proposeRunId = r ? r.id : null;
  return derived;
}

// Respond with the SAME derived shape GET returns, for the single mutated
// source. Reads finds best-effort (never blocks the response on the workbook).
function respondOneSource(res, data, id, status = 200) {
  readDiscovery((err, disc) => {
    const finds = !err && disc && Array.isArray(disc.discoveries) ? disc.discoveries : [];
    const one = deriveSources(data, finds).sources.find((s) => s.id === id);
    res.status(status).json(stampProposeRun(one));
  });
}

app.get("/api/discovery/sources", (req, res) => {
  let data;
  try {
    data = store.loadSources();
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  const now = new Date();
  readDiscovery((err, disc, meta) => {
    const finds = !err && disc && Array.isArray(disc.discoveries) ? disc.discoveries : [];
    const payload = deriveSources(data, finds, now);
    // Presence/enablement signal for the J10 Apify card + Run-now gate (guardian
    // C5a). NEVER the token value (C4) - only whether the owner enabled apify AND
    // a token is present. Read live (process env + config), so it is not part of
    // the pure deriveSources contract. Overlaid per-source (like proposeRunId) so
    // the single-source GET's element stays identical to the list element, AND
    // surfaced top-level (like `locked`) for a single convenient read.
    const cfg = apifyConfigured();
    payload.apifyConfigured = cfg;
    payload.sources.forEach((s) => {
      s.apifyConfigured = cfg;
    });
    payload.sources.forEach(stampProposeRun); // in-flight propose runs (derived, process state)
    // Honest degrade: when the workbook is locked (or finds are otherwise
    // unavailable) the source registry still serves; the counts reflect the
    // last-good finds (or 0), flagged so the UI can say so.
    if (meta && meta.locked) {
      payload.locked = true;
      payload.message = WORKBOOK_LOCKED_MSG;
    }
    res.json(payload);
  });
});

// Single-source read (t-1783200897663 (b)): polling one source's run state no
// longer means fetching the whole registry. EXACTLY the registry GET's derived
// per-source shape (deriveSources element + the derived proposeRunId - the
// same object POST/PATCH already respond with via respondOneSource), plus the
// registry GET's honest locked degrade: when Excel holds the workbook the
// joined counts reflect the last-good finds and the payload says so.
app.get("/api/discovery/sources/:id", (req, res) => {
  let data;
  try {
    data = store.loadSources();
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  if (!data.sources.some((s) => s.id === req.params.id)) {
    return res.status(404).json({ error: "source not found" });
  }
  readDiscovery((err, disc, meta) => {
    const finds = !err && disc && Array.isArray(disc.discoveries) ? disc.discoveries : [];
    const one = deriveSources(data, finds).sources.find((s) => s.id === req.params.id);
    stampProposeRun(one);
    one.apifyConfigured = apifyConfigured(); // presence/enablement only, never the token (C4)
    if (meta && meta.locked) {
      one.locked = true;
      one.message = WORKBOOK_LOCKED_MSG;
    }
    res.json(one);
  });
});

// Run honesty counters (t-1783200897663 (a)) - the scout's callback at the end
// of a scrape run: how many candidate postings it actually REVIEWED, how many
// it skipped as ALREADY TRACKED, how many it FILTERED OUT as not relevant.
// These are the numbers that make a leadsFound:0 run legible (healthy dedup vs
// broken scrape - see deriveLastRunSignal). Agent-REPORTED by design: only the
// scout knows what it reviewed, so unlike leadsFound/leadsNew (server-derived
// from the workbook join at close) these arrive through the app's own API,
// mirroring the instruction-proposal callback posture. Loud validation (new
// field, ADR-016 posture): each counter present must be a finite number >= 0
// (stored floored to an integer), at least one must be present, and an unknown
// source/run is a 404. Last-write-wins on a re-report (counters are telemetry,
// not SoT). Best-effort from the scout's side - the prompt tells it a failed
// report must never fail the run.
app.post("/api/discovery/sources/:id/runs/:runId/report", (req, res) => {
  try {
    const body = req.body || {};
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    const rec = (source.runs || []).find((r) => r && r.runId === req.params.runId);
    if (!rec) return res.status(404).json({ error: "run not found for this source" });
    const COUNTERS = ["candidatesReviewed", "alreadyTracked", "filteredOut"];
    const updates = {};
    for (const key of COUNTERS) {
      if (!(key in body) || body[key] === undefined || body[key] === null) continue;
      const v = body[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return res.status(400).json({ error: `${key} must be a non-negative number` });
      }
      updates[key] = Math.floor(v);
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: `at least one counter required: ${COUNTERS.join(", ")} (non-negative numbers)`,
      });
    }
    Object.assign(rec, updates);
    store.saveSources(data);
    res.json({ ok: true, runId: req.params.runId, run: normalizeRun(rec) });
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

app.post("/api/discovery/sources", (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: "name required" });
    const fields = validateSourceInput(body, { create: true });
    const data = store.loadSources();
    let id;
    if (body.id) {
      // An explicit id the caller asked for: sanitize + reject a collision (409),
      // rather than silently renaming what they requested.
      id = sanitizeId(body.id);
      if (!id) return res.status(400).json({ error: "invalid id" });
      if (data.sources.some((s) => s.id === id)) {
        return res.status(409).json({ error: "a source with that id already exists" });
      }
    } else {
      id = uniqueSourceId(slugifySourceId(fields.name), data.sources);
    }
    const source = normalizeSource({ id, ...fields, runs: [], lastRunAt: null, lastVisitedAt: fields.lastVisitedAt || null });
    data.sources.push(source);
    store.saveSources(data);
    respondOneSource(res, data, id, 201);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

app.patch("/api/discovery/sources/:id", (req, res) => {
  try {
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    const fields = validateSourceInput(req.body || {}, { create: false, existing: source });
    // Provenance honesty (§5 Decision 4): a manual edit that CHANGES the live
    // instructions (the gated escape hatch - the normal path is an approved
    // proposal) means they no longer came from the recorded proposal, so the
    // link is cleared and the edit is stamped ("set manually <now>"). The
    // invariant this preserves: instructionsApprovedFrom present implies the
    // live instructions ARE that proposal's text. Re-sending the identical
    // string is a no-op and keeps the approval provenance.
    if ("instructions" in fields && fields.instructions !== source.instructions) {
      source.instructionsApprovedFrom = null;
      source.instructionsUpdatedAt = new Date().toISOString();
    }
    Object.assign(source, fields);
    const i = data.sources.indexOf(source);
    data.sources[i] = normalizeSource(source); // keep the on-disk shape consistent
    store.saveSources(data);
    respondOneSource(res, data, req.params.id);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/discovery/sources/:id", (req, res) => {
  try {
    const data = store.loadSources();
    const before = data.sources.length;
    data.sources = data.sources.filter((s) => s.id !== req.params.id);
    if (data.sources.length === before) return res.status(404).json({ error: "source not found" });
    // Deleting a source removes only its managed config: its finds are untouched
    // in the workbook and simply fall back into the honest unassigned bucket.
    store.saveSources(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Per-source "Run now": launch the discover-jobs routine SCOPED to this one
// source, and append an optimistic "running" run record IMMEDIATELY (the
// runner's close path flips it to the terminal outcome + lead counts via
// finalizeSourceRun). One run per source at a time (409 otherwise). The baseline
// find count is captured before launch so leadsNew is the honest delta on close.
// Launch ONE source-scoped discovery run with full bookkeeping: fresh find
// baseline, optimistic run record, lastRunAt cadence anchor. Shared by the
// per-source endpoint and the run-all-due fan-out (queue drain). Sources are
// (re)loaded INSIDE the readDiscovery callback on purpose: readDiscovery can
// shell out to python for seconds, and a snapshot taken before it (as this
// endpoint used to) was saved back stale - silently clobbering any
// finalizeSourceRun that landed in that window (the write race behind
// stuck-"running" health pills). Loading fresh here makes every sources
// read-modify-write atomic on the event loop. cb(err, result): err is
// { httpStatus, error }, result is { runId, source } with the derived source.
function launchSourceRun(sourceId, batchId, cb) {
  readDiscovery((err, disc) => {
    const finds = !err && disc && Array.isArray(disc.discoveries) ? disc.discoveries : [];
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === sourceId);
    if (!source) return cb({ httpStatus: 404, error: "source not found" });
    if ((source.runs || []).some((r) => r && r.outcome === "running")) {
      return cb({ httpStatus: 409, error: "a run is already in progress for this source" });
    }
    const idx = buildAliasIndex(data.sources.map(normalizeSource));
    const baseline = finds.filter((f) => resolveFindSourceId(f, idx) === source.id).length;
    // apify sources run server-side (no agent spawn). The spend gate is enforced
    // HERE, BEFORE any optimistic record is written - so a disabled/token-less
    // source produces NO fake run and its cadence is NOT falsely advanced
    // (guardian C5a). This is the single choke point both the per-source endpoint
    // and the run-all-due drain funnel through.
    if (source.type === "apify") {
      if (!apifyConfigured()) {
        return cb({ httpStatus: 400, error: "Configure APIFY_TOKEN and enable Apify to run this source" });
      }
      // Derived monthly cap (guardian C5c): refuse once this month's apify runs
      // across all apify sources reach the cap. No separate ledger (ADR-001).
      if (countApifyRunsThisMonth(data.sources) >= apifyMonthlyRunCap()) {
        return cb({ httpStatus: 429, error: `Apify monthly run cap reached (${apifyMonthlyRunCap()}); it resets next month` });
      }
      const arun = startApifyRun(source, { sourceId: source.id, sourceBaseline: baseline, batchId });
      const arec = {
        runId: arun.id,
        startedAt: arun.startedAt,
        durationMs: null,
        outcome: "running",
        leadsFound: null,
        leadsNew: null,
        trigger: batchId ? "all-due" : "manual",
      };
      source.runs = capRuns([...(source.runs || []), arec]);
      source.lastRunAt = arun.startedAt; // cadence anchor: it ran now
      store.saveSources(data);
      const aone = deriveSources(data, finds).sources.find((s) => s.id === source.id);
      return cb(null, { runId: arun.id, source: aone });
    }
    // startRun spawns asynchronously, so the optimistic record we append+save
    // right after ALWAYS lands before the process 'close' event can fire (I/O is
    // queued past this synchronous stack) - finalizeSourceRun then finds it.
    const run = startRun("discover-jobs-source", source.id, batchId, { sourceId: source.id, sourceBaseline: baseline });
    const optimistic = run.status === "running";
    const record = {
      runId: run.id,
      startedAt: run.startedAt,
      durationMs: optimistic ? null : 0,
      outcome: optimistic ? "running" : "failed",
      leadsFound: null,
      leadsNew: null,
      // Provenance: a fan-out launch stays distinguishable from a hand-clicked
      // per-source Run now in the source's run history.
      trigger: batchId ? "all-due" : "manual",
    };
    if (!optimistic) record.errorReason = "failed to launch";
    source.runs = capRuns([...(source.runs || []), record]);
    source.lastRunAt = run.startedAt; // cadence anchor: it ran now
    store.saveSources(data);
    const one = deriveSources(data, finds).sources.find((s) => s.id === source.id);
    cb(null, { runId: run.id, source: one });
  });
}

app.post("/api/discovery/sources/:id/run", (req, res) => {
  // Pre-checks kept here (not only inside launchSourceRun) to preserve the
  // endpoint's error precedence: unknown source -> 404, already running ->
  // 409, cap -> 429. launchSourceRun re-checks against a FRESH load before
  // mutating, so a pre-check going stale can never corrupt state.
  const data = store.loadSources();
  const source = data.sources.find((s) => s.id === req.params.id);
  if (!source) return res.status(404).json({ error: "source not found" });
  if ((source.runs || []).some((r) => r && r.outcome === "running")) {
    return res.status(409).json({ error: "a run is already in progress for this source" });
  }
  if (runningCount() >= MAX_CONCURRENT_RUNS) {
    return res
      .status(429)
      .json({ error: `too many routines running (max ${MAX_CONCURRENT_RUNS}); wait for one to finish or stop it` });
  }
  launchSourceRun(req.params.id, null, (err, result) => {
    if (err) return res.status(err.httpStatus).json({ error: err.error });
    res.status(201).json(result);
  });
});

// Run all due: fan out per-source runs over every DUE active source. This is
// the registry-unification replacement (t-1783183576537) for the retired
// global discover-jobs sweep: the global pass was driven by the xlsx Config
// sheet and could not stamp any source's lastRunAt, so every health pill lied
// after it ran. The fan-out reuses the ONE honest code path - each launch
// stamps its own source AT LAUNCH time (not enqueue), and the shared queue
// bounds concurrency at MAX_CONCURRENT_RUNS. Dead discovery rows are pruned
// first, best-effort, exactly as the global sweep used to (ADR-008: a locked
// workbook or prune failure never blocks the runs). DELIBERATE ordering
// tradeoff, kept on review (t-1783091385623 item 1): the response waits for
// prune (execFile timeout 60s, so a hung interpreter can delay the click up
// to a minute) because the per-run leadsNew baselines are captured from the
// PRUNED finds right below - answering first and pruning async would let the
// archive race the baseline capture and corrupt every wave's leadsNew delta.
app.post("/api/discovery/run-all-due", (req, res) => {
  pruneDiscoveriesBeforeDiscover(() => {
    const data = store.loadSources();
    readDiscovery((err, disc) => {
      const finds = !err && disc && Array.isArray(disc.discoveries) ? disc.discoveries : [];
      const derived = deriveSources(data, finds).sources;
      const queuedIds = new Set(queue.filter((q) => q.routine === "discover-jobs-source").map((q) => q.jobId));
      const eligible = derived.filter(
        (s) =>
          // NOT s.active: that field is a 3-state string enum ("yes"/"maybe"/
          // "no"), so a truthy check let PAUSED sources (active:"no") through and
          // the fan-out launched them, defeating the pause control (QA
          // t-1783203025251). deriveSourceStatus maps active:"no" -> "paused"
          // with top precedence, so the derived status is the honest gate.
          s.status !== "paused" &&
          s.due &&
          !queuedIds.has(s.id) &&
          !(s.runs || []).some((r) => r && r.outcome === "running")
      );
      // Agent (employer/board) targets are unaffected by the paid-run guards.
      const nonApify = eligible.filter((s) => s.type !== "apify");
      const apify = eligible.filter((s) => s.type === "apify");
      // Apify is a PAID fan-out: it fires only behind the spend gate (guardian
      // C5). Disabled/token-less -> skip ALL apify (reported, cadence untouched).
      // Otherwise select most-overdue-first under BOTH the per-sweep cap and the
      // derived monthly cap; the rest STAY due for a later sweep.
      let apifyLaunch = [];
      let apifySkippedBudget = [];
      let apifySkippedNoToken = [];
      if (apify.length) {
        if (!apifyConfigured()) {
          apifySkippedNoToken = apify.map((s) => s.id);
        } else {
          const monthlyCount = countApifyRunsThisMonth(data.sources);
          const sel = selectApifySweepTargets(apify, {
            perSweepCap: apifyMaxRunsPerSweep(),
            monthlyCount,
            monthlyCap: apifyMonthlyRunCap(),
          });
          apifyLaunch = sel.launch;
          apifySkippedBudget = sel.skippedBudget.map((s) => s.id);
        }
      }
      const toQueue = [...nonApify, ...apifyLaunch];
      if (!toQueue.length) {
        return res.json({
          batchId: null,
          total: 0,
          label: "Run all due",
          targets: [],
          apifyLaunched: [],
          apifySkippedBudget,
          apifySkippedNoToken,
        });
      }
      const batchId = `b${Date.now()}`;
      for (const s of toQueue) queue.push({ routine: "discover-jobs-source", jobId: s.id, batchId });
      pruneRuns();
      processQueue();
      res.status(201).json({
        batchId,
        total: toQueue.length,
        label: "Run all due",
        targets: toQueue.map((s) => s.id),
        apifyLaunched: apifyLaunch.map((s) => s.id),
        apifySkippedBudget,
        apifySkippedNoToken,
      });
    });
  });
});

// ---- instruction proposals (docs/data-schema.md §5 Decision 4, W3) ---------
// The owner stops hand-editing a source's crawl instructions. Loop: the owner
// comments (the propose trigger) -> the scout probes the landing page and FILES
// a proposal through the callback endpoint -> the owner approves (instructions
// replaced, provenance stamped) or rejects with a reason (archived; the reason
// feeds the next run's prompt). Proposals are append-only and unforgeable:
// id/ts/status/resolvedAt are SERVER-stamped, exactly the task-comment /
// attachment posture, and a resolved proposal can never change again.

// A unique proposal id within one source ("ip-<epochms>", suffix-deduped like
// uniqueSourceId - two proposals filed in the same millisecond stay distinct).
function uniqueProposalId(source) {
  const taken = new Set((source.instructionProposals || []).map((p) => p.id));
  const base = `ip-${Date.now()}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// The owner's comment endpoint AND run trigger, one human-click-gated action
// (ADR-005 posture): recording the comment IS asking the scout to act on it.
// The comment travels in the launch context (the run's prompt) and is persisted
// on the proposal the scout files back; ownerComment may be empty - a brand-new
// source's first proposal is a legitimate cold start (study the landing page).
// No lastRunAt / runs[] bookkeeping here ON PURPOSE - see the ROUTINES entry.
app.post("/api/discovery/sources/:id/instruction-proposals/propose", (req, res) => {
  try {
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    const ownerComment = typeof (req.body || {}).ownerComment === "string" ? req.body.ownerComment : "";
    if (activeProposeRun(source.id)) {
      return res.status(409).json({ error: "a propose-instructions run is already in progress for this source" });
    }
    if (runningCount() >= MAX_CONCURRENT_RUNS) {
      return res
        .status(429)
        .json({ error: `too many routines running (max ${MAX_CONCURRENT_RUNS}); wait for one to finish or stop it` });
    }
    pruneRuns();
    const run = startRun("propose-instructions", source.id, null, { ownerComment });
    if (run.status === "failed") return res.status(500).json({ error: run.output });
    res.status(201).json({ runId: run.id, ownerComment });
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

// The scout's callback: file ONE pending proposal. Mirrors assess-ticket's
// "the agent writes back through the app's own API, never hand-edits YAML".
// Content fields (ownerComment / proposedInstructions / rationale) are stored
// verbatim (ownerComment same posture as IntakeRequest.text); id / ts / status
// are SERVER-stamped and a client-supplied value is ignored (unforgeable) -
// filing can never approve, resolve, or touch the live instructions.
app.post("/api/discovery/sources/:id/instruction-proposals", (req, res) => {
  try {
    const body = req.body || {};
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    const proposedInstructions = typeof body.proposedInstructions === "string" ? body.proposedInstructions : "";
    if (!proposedInstructions.trim()) {
      return res.status(400).json({ error: "proposedInstructions required (non-empty string)" });
    }
    const proposal = {
      id: uniqueProposalId(source),
      ts: new Date().toISOString(),
      ownerComment: typeof body.ownerComment === "string" ? body.ownerComment : "",
      proposedInstructions,
      rationale: typeof body.rationale === "string" ? body.rationale : "",
      status: "pending",
    };
    source.instructionProposals = [...(source.instructionProposals || []), proposal];
    store.saveSources(data);
    // Typed signal so the drawer/card can refresh the pending-proposal badge
    // live (discovery-sources.yaml lives in docs/, outside the JOBS_DIR watcher).
    broadcast({ type: "source-proposals-changed", sourceId: source.id });
    res.status(201).json(proposal);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

// Resolve a pending proposal - the owner's approve / reject click. ONE-WAY:
// pending -> approved | rejected, anything else (or a re-resolve) is a loud
// 400. Approve performs the loop's single side effect: the source's live
// instructions become the proposal's text, with provenance stamped
// (instructionsApprovedFrom = the proposal id, instructionsUpdatedAt = its
// resolvedAt). Reject requires a non-blank rejectionReason (mirroring
// validComment - dropping owner prose silently would lose data); the rejected
// proposal is ARCHIVED, never deleted - it is the training context the next
// propose run's prompt reads. Responds with the full derived source (the
// caller needs the updated instructions + log in one shot).
app.patch("/api/discovery/sources/:id/instruction-proposals/:proposalId", (req, res) => {
  try {
    const body = req.body || {};
    const data = store.loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: "source not found" });
    const proposal = (source.instructionProposals || []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    if (body.status !== "approved" && body.status !== "rejected") {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }
    if (proposal.status !== "pending") {
      return res
        .status(400)
        .json({ error: `proposal is already ${proposal.status}; a resolved proposal can never be changed` });
    }
    if (body.status === "rejected") {
      const reason = typeof body.rejectionReason === "string" ? body.rejectionReason.trim() : "";
      if (!reason) return res.status(400).json({ error: "rejectionReason required (non-empty) to reject a proposal" });
      proposal.rejectionReason = reason;
    }
    proposal.status = body.status;
    proposal.resolvedAt = new Date().toISOString();
    if (proposal.status === "approved") {
      source.instructions = proposal.proposedInstructions;
      source.instructionsApprovedFrom = proposal.id;
      source.instructionsUpdatedAt = proposal.resolvedAt;
    }
    store.saveSources(data);
    broadcast({ type: "source-proposals-changed", sourceId: source.id });
    respondOneSource(res, data, source.id);
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
  }
});

// How each fetch mode translates into marching orders for the scout - keyed by
// the SOURCE_FETCH_MODES enum so the prompt and the stored flag can never
// disagree on what a mode means.
const FETCH_MODE_PROMPTS = {
  "direct-list":
    "Fetch mode: direct-list - the listing URL itself is fetchable. WebFetch the target URL(s) directly and enumerate current postings from the returned list; only fall back to search if the fetch genuinely fails.",
  "google-site":
    "Fetch mode: google-site - the listing page is NOT directly fetchable (JS app / anti-bot). Do not burn time fetching the board itself: enumerate postings via Google `site:` queries scoped to this source's domain (per the crawl instruction), then WebFetch each posting's detail page.",
  "alert-email":
    "Fetch mode: alert-email - postings for this source arrive via a saved email alert. Review the alert email(s) for new postings per the crawl instruction rather than crawling the board.",
};

// Build the scoped prompt for a single-source discovery run. Loads the source
// live at prompt time (so an edit to its instructions/urls takes effect on the
// next run); a vanished source falls back to the plain global routine. Exported
// (pure over the on-disk registry) so the scrape-contract wording below is
// directly unit-testable without spawning a real agent. `extra` carries the
// launch context startRun builds: runId (for the honesty-counter report
// below), sourceId, sourceBaseline.
export function buildSourceDiscoveryPrompt(id, extra = {}) {
  let s = null;
  try {
    s = store.loadSources().sources.find((x) => x.id === id) || null;
  } catch {
    /* fall through to the generic prompt */
  }
  if (!s) return "run discover-jobs";
  const urls = (s.urls || []).filter(Boolean).join(", ") || "(see the crawl instruction)";
  const out = (s.outputFields || []).join(", ");
  const runId = typeof extra.runId === "string" && extra.runId ? extra.runId : null;
  return [
    "Run the discover-jobs routine SCOPED to a single source. Scan ONLY this source; do not sweep the others.",
    `Source id: "${s.id}"  |  name: "${s.name}"  |  type: ${s.type}  |  sector: ${s.sector}.`,
    `Target URL(s): ${urls}.`,
    // The formalized fetch strategy (t-1783200897663 (c)): the closed enum
    // drives HOW to reach postings; the free-text note carries the source's
    // verified quirks. Unclassified sources rely on the instruction prose
    // alone, exactly as before the field existed.
    s.fetchMode ? FETCH_MODE_PROMPTS[s.fetchMode] : "",
    s.fetchNote ? `Fetch note (a verified quirk of this source - respect it): ${s.fetchNote}` : "",
    `Crawl / extraction instruction (follow verbatim): ${s.instructions || "(none provided)"}.`,
    out ? `For each lead capture these fields: ${out}.` : "",
    // Scrape-contract enforcement (docs/data-schema.md §5 Decision 3): the two
    // fields a lead needs to become a Job with zero manual re-research are a
    // DIRECT posting URL and a deadline - both are REQUIRED, not best-effort.
    `REQUIRED on every lead: (1) Link MUST be the direct posting page for that ONE role - the actual job-description/apply page - never a search-results page, a category/listing page, or the board's homepage; (2) Deadline MUST be set (a literal YYYY-MM-DD when the posting states one, else a short free-text note like "rolling" only when the posting itself says so - never leave it blank because you didn't check). Do NOT silently drop or skip a real opening just because one of these is hard to confirm: still record the lead, and if you truly cannot resolve a direct link or a deadline after checking, say so plainly in Notes (e.g. "could not resolve a direct link - only a search page found" / "no deadline posted") so it is flagged for triage attention, never filed as if it were complete.`,
    // Expired-posting guard (t-1783422051088): an already-closed posting cannot be
    // applied to, so recording it just clutters the queue. This is a belt in front
    // of discovery.py's cmd_add, which rejects a past-deadline find outright.
    `SKIP any posting whose application deadline has ALREADY PASSED - a real calendar date strictly before today's date (${localDateISO()}). Do NOT fetch it into a lead and do NOT call discovery.py add for it; an expired posting is dead. Only a still-open posting becomes a find: its deadline is today or later, OR it is genuinely rolling / "until filled" / has no stated deadline (per the REQUIRED rule above). This skip is ONLY for a deadline you can SEE has already passed - when a deadline is unstated or unclear, treat the posting as open and record it (noting the unknown in Notes), never guess it closed. The workbook is also swept for finds that expire after being added, so you never need to remove old rows yourself - just do not add a fresh one that is already dead.`,
    `On every NEW find you record, call discovery.py add with the Source column set EXACTLY to "${s.name}" AND the source_id argument set to "${s.id}" (its canonical id in the Sources registry - discovery.py's "add" now takes an optional trailing source_id after notes) so the find's provenance survives even if this source is later renamed - never rely on the Source name/alias match alone. Use the project's normal discovery write path; never leave the machine and never auto-submit.`,
    // Run honesty counters (t-1783200897663 (a)): a run that reviewed plenty
    // but added nothing new must be distinguishable from a broken scrape
    // without reading prose - the scout reports its own counts against THIS
    // run's id before exiting.
    runId
      ? `FINALLY, when you have finished scanning (as your last step before you exit), report this run's honesty counters through the app's own API: curl -s -X POST -H 'Content-Type: application/json' --data '{"candidatesReviewed":<N>,"alreadyTracked":<N>,"filteredOut":<N>}' http://127.0.0.1:${PORT}/api/discovery/sources/${s.id}/runs/${runId}/report where candidatesReviewed = the total postings you actually looked at on this source, alreadyTracked = how many of those you skipped because they are already tracked (an existing discovery row or Jobs/ folder), filteredOut = how many you reviewed and set aside as not relevant. Report honestly even when a count is 0 - a run that reviewed candidates but added nothing new is healthy dedup, and these counters are how the dashboard tells that apart from a broken scrape. This report is best-effort: if the call fails, mention it in your summary and finish normally - never fail the run over it.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Build the propose-instructions prompt (§5 Decision 4 step 1). Inputs: the
// source's landing URL(s), its CURRENT instructions, the owner's comment (the
// trigger, passed in the launch context - empty on a cold start), and the past
// rejection reasons from the stored proposal history, so every rejected attempt
// demonstrably steers the next one. Loaded live at prompt time like
// buildSourceDiscoveryPrompt; exported for direct unit-testing.
export function buildProposeInstructionsPrompt(id, extra = {}) {
  let s = null;
  try {
    s = store.loadSources().sources.find((x) => x.id === id) || null;
  } catch {
    /* fall through */
  }
  // The endpoint checks existence synchronously before launching, so this only
  // fires on a genuine race; fail safe - an explicit no-op, never a guess.
  if (!s) return `The discovery source "${id}" no longer exists. Do nothing and exit.`;
  const ownerComment = typeof extra.ownerComment === "string" ? extra.ownerComment.trim() : "";
  const urls = (s.urls || []).filter(Boolean).join(", ");
  const history = [...(s.instructionProposals || [])].sort((a, b) => (String(a.ts) < String(b.ts) ? 1 : -1));
  const rejections = history
    .filter((p) => p.status === "rejected" && p.rejectionReason)
    .slice(0, 5)
    .map((p) => `[${p.resolvedAt || p.ts || "earlier"}] ${p.rejectionReason}`);
  return [
    "You are proposing CRAWL INSTRUCTIONS for one discovery source - a research-and-propose run, NOT a scraping run: do not run discovery, do not add/decide/prune any lead.",
    `Source id: "${s.id}"  |  name: "${s.name}"  |  type: ${s.type}  |  sector: ${s.sector}.`,
    urls
      ? `Landing URL(s): ${urls}.`
      : "Landing URL(s): none on file - locate this source's official careers/job-board landing page by name first, and include it as the starting URL in your proposal.",
    s.instructions
      ? `CURRENT instructions (what you are improving): ${s.instructions}`
      : "CURRENT instructions: none yet - this is the source's first proposal.",
    ownerComment
      ? `OWNER'S COMMENT (what to fix - address it directly): ${ownerComment}`
      : "OWNER'S COMMENT: none - study the landing page and propose the best first instructions for this source.",
    rejections.length
      ? `PAST REJECTION REASONS - earlier proposals were rejected for these; your proposal MUST resolve every one of them: ${rejections.join(" | ")}`
      : "",
    "PROBE before writing anything, and only claim what you actually verified:",
    "(1) Fetchability - WebFetch the landing page(s): does the job LISTING render server-side, or is it a JS app? If JS-only, find a workaround that yields real postings (an underlying JSON/API endpoint, a server-rendered variant, or the Google `site:` search fallback pattern existing sources use).",
    "(2) Platform/ATS - identify it (Workday, Taleo, SuccessFactors, iCIMS, Njoyn, custom, ...): it determines how detail pages and deadlines are reached.",
    "(3) Listing structure - how to enumerate current postings and reach each posting's DIRECT job-detail URL and its deadline. Sample at least 2 posting links and verify each opens the actual job-description/apply page for ONE role, never a search or category page.",
    `Then FILE EXACTLY ONE PROPOSAL through this app's own API - never hand-edit docs/discovery-sources.yaml and never modify the source yourself: curl -s -X POST -H 'Content-Type: application/json' --data '{"ownerComment":"<the owner's comment above, echoed verbatim>","proposedInstructions":"<the full new instructions>","rationale":"<why this changes + what you verified>"}' http://127.0.0.1:${PORT}/api/discovery/sources/${s.id}/instruction-proposals (escape the JSON strings properly).`,
    "proposedInstructions must follow the standard crawl-instruction format the sources in docs/discovery-sources.yaml use: the starting/landing URL, then concrete how-to-scan steps that yield DIRECT job-detail URLs and deadlines for every current posting, including any fetch workaround you verified and how to read the deadline off a posting.",
    "rationale must state what you changed and the evidence: which pages you fetched, the ATS you identified, which sample links you checked and what each opened.",
    "Hard limits: file exactly one proposal via the API above; do not edit any file; do not create or modify any source, lead, job, or ticket; never auto-submit anything; never leave the machine beyond fetching this source's own pages and the search needed to probe them.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Close-path wiring for a source-scoped run (called from startRun's proc.close
// when run.sourceId is set). Best-effort: re-read the finds for the leadsNew
// delta, flip the optimistic record to its terminal outcome, persist. Never
// throws into the close handler (the run's own status is already recorded).
function finalizeSourceRun(run) {
  const durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
  const outcome = run.status === "stopped" ? "incomplete" : run.status === "done" ? "succeeded" : "failed";
  readDiscovery((err, disc) => {
    try {
      const data = store.loadSources();
      let leadsFound = null;
      let leadsNew = null;
      if (!err && disc && Array.isArray(disc.discoveries)) {
        const idx = buildAliasIndex(data.sources.map(normalizeSource));
        const after = disc.discoveries.filter((f) => resolveFindSourceId(f, idx) === run.sourceId).length;
        leadsFound = after;
        leadsNew = typeof run.sourceBaseline === "number" ? Math.max(0, after - run.sourceBaseline) : null;
      }
      finalizeRunRecord(data, {
        sourceId: run.sourceId,
        runId: run.id,
        outcome,
        durationMs,
        leadsFound,
        leadsNew,
        // apify runs carry a token-free terminal reason (guardian C4/C10); the
        // agent path leaves this undefined, so its behaviour is unchanged.
        errorReason: run.errorReason || null,
      });
      // apify honesty counters (server-computed, since there is no scout to POST
      // the report callback): merge them onto the finalized record so the health
      // pill classifies leads/dedup/quiet identically to a scout run.
      if (run._apifyReport) {
        const src = data.sources.find((s) => s.id === run.sourceId);
        const rec = src && (src.runs || []).find((r) => r && r.runId === run.id);
        if (rec) {
          rec.candidatesReviewed = run._apifyReport.candidatesReviewed;
          rec.alreadyTracked = run._apifyReport.alreadyTracked;
          rec.filteredOut = run._apifyReport.filteredOut;
        }
      }
      store.saveSources(data);
      // Typed: the discovery view (source registry + finds) refreshes on this,
      // not on the job-file watcher (sources live in docs/, outside JOBS_DIR).
      broadcast({ type: "source-run-finished", sourceId: run.sourceId });
    } catch (e) {
      console.error(`[jobhunt] finalize source run failed: ${e.message}`);
    }
  });
}

// ---- job-folder file reader (remote-honest Files buttons, t-1783201094679) --
// GET /api/jobs/:id/files/:name - a GUARDED reader for the files a job folder
// already lists (CV, cover letter, posting), NOT a static file server. POST
// /api/open below shell-opens the file on the machine RUNNING the server; from
// a phone over the tailnet that is a silent no-op (and pops a window on the
// desktop at home), so a remote client needs the bytes streamed to it instead.
// Same idiom as the ADR-014 attachment reader, adapted to the vault:
//   - existence allowlist: the name must be a DIRECT child file the job listing
//     (listFolderFiles) already serves - never a probe path;
//   - path containment: resolveJobFolder + path.relative re-check, so a
//     traversal name can never escape the job's own folder;
//   - read-only: createReadStream, no write path exists here (the vault
//     read-only posture for generated documents is untouched);
//   - un-scriptable response: the served MIME comes from a CONSERVATIVE
//     extension map (md/txt/json/csv are text/plain, never text/html;
//     html/svg/anything unmapped fall to application/octet-stream), plus
//     nosniff + CSP default-src 'none' + Cache-Control private,no-store -
//     a served blob can never execute in the app's origin;
//   - reachability: same as every /api route - loopback + the owner's tailnet
//     serve (R2 posture); no CORS grant exists, so a foreign origin cannot
//     read it from a browser.
const JOB_FILE_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8", // application-content.json: viewable, never scriptable
  csv: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

app.get("/api/jobs/:id/files/:name", (req, res) => {
  try {
    // store.openJobFile does the folder resolution + existence allowlist + path
    // containment (a discriminated result preserving the exact pre-seam
    // status/messages). The route owns the response headers.
    const r = store.openJobFile(req.params.id, req.params.name);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const base = r.name;
    // Content-Disposition must stay Latin1-safe: non-ASCII names (the vault can
    // carry them) ride in the RFC 5987 filename* param, percent-encoded.
    const asciiName = base.replace(/"/g, "'").replace(/[^\x20-\x7e]/g, "_");
    res.setHeader("Content-Type", JOB_FILE_MIME[r.ext] || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Cache-Control", "private, no-store");
    r.stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Open a file (CV, cover letter, posting) in its OS default application - on
// the machine RUNNING the server. Only meaningful when the client IS that
// machine; a remote client uses the guarded reader above instead (the UI picks
// per client, src/components/JobDetail.tsx).
app.post("/api/open", (req, res) => {
  const { path: rel, id } = req.body || {};
  if (!rel || !id) return res.status(400).json({ error: "id and path required" });
  // store.resolveOpenTarget does the id/rel containment + existence gate (null ->
  // 400 "invalid path"), same status/message as before.
  const target = store.resolveOpenTarget(id, rel);
  if (!target) return res.status(400).json({ error: "invalid path" });
  // Launch via execFile with an argv array (buildOpenCommand), never exec + a
  // shell string: the target is a standalone argument, so cmd.exe / the shell
  // never re-parses the path as shell syntax. Matches the routine runner's
  // spawn+argv posture. The existsSync + containment gate above still stands.
  const { cmd, args } = buildOpenCommand(process.platform, target);
  execFile(cmd, args, (err) => {
    if (err) return res.status(500).json({ error: String(err.message || err) });
    res.json({ ok: true });
  });
});

// Reveal a job's own folder in the OS file manager (Explorer / Finder / the
// desktop's file browser) - on the machine RUNNING the server. Sibling to POST
// /api/open above: that opens ONE file in its default app; this opens the
// CONTAINING folder so the owner can see every artifact at once and reach files
// the Files list does not surface (t-1783481685241). Same posture as /api/open -
// a local shell-open, honest ONLY when the client IS the server's desktop, so
// the drawer shows the button on loopback only (a remote client has no local
// folder to reveal; opening one would be a surprise window at home, the same
// dishonesty the per-file buttons already avoid). resolveJobFolder does the id ->
// path containment + existence gate (a traversal or unknown id 404s before any
// launch); buildOpenCommand builds the execFile argv (never a shell string), so
// a job-folder name with shell metacharacters is passed verbatim as one arg.
app.post("/api/jobs/:id/open-folder", (req, res) => {
  const folderPath = store.jobFolderPath(req.params.id);
  if (!folderPath) return res.status(404).json({ error: "job folder not found" });
  const { cmd, args } = buildOpenCommand(process.platform, folderPath);
  execFile(cmd, args, (err) => {
    if (err) return res.status(500).json({ error: String(err.message || err) });
    res.json({ ok: true });
  });
});

// ---- live reload (Server-Sent Events) -------------------------------------
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// Push one TYPED event to every connected SSE client. Every event is a JSON
// object carrying a discriminant `type`; the client (src/hooks/useEventStream.ts)
// parses it and fans out to per-type subscribers. The vocabulary:
//   jobs-changed         - a job .md file changed (the JOBS_DIR watcher)
//   run-finished         - a routine run reached a terminal state { runId, routine, jobId }
//   source-run-finished  - a source-scoped run's history was finalized { sourceId }
//   source-proposals-changed - a source's instruction-proposal log changed:
//                          filed / approved / rejected { sourceId } (a propose
//                          RUN's close is the generic run-finished with
//                          routine "propose-instructions")
//   tasks-changed        - tasks.yaml was written (POST/PATCH/DELETE /api/tasks, attachments)
// Wire format is deliberately simple (one JSON object per `data:` frame) so a new
// event type is additive and an old client that ignored the payload still works.
function broadcast(event) {
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

// ---- built-asset serving (RFC v2-007 / SIM-66: the stable channel) --------
// The STABLE channel serves the pre-built Vite bundle (dist/) instead of running
// the dev server. Gated by JOBHUNT_SERVE_BUILT=1 so the dev path (flag unset) is
// byte-for-byte unchanged: nothing below registers and no extra port is bound.
// Mounted HERE - AFTER every /api route, BEFORE the error handler - so the API
// always wins: Express matches layers in registration order, so any /api/* GET
// was already answered above and never reaches this static/SPA layer, and a
// non-existent /api/* still falls through to Express's default 404 (the SPA
// fallback below explicitly skips /api/), never the HTML shell.
const SERVE_BUILT = process.env.JOBHUNT_SERVE_BUILT === "1";
const DIST_DIR = path.join(ROOT, "dist");
const DIST_INDEX = path.join(DIST_DIR, "index.html");
// distReady is the single gate for BOTH the static mount here and the UI-port
// bind below. A missing build is a loud, non-fatal condition: log and serve the
// API only (the stable launcher falls back to the dev channel when dist/ is
// absent, so this guard only fires on a manual JOBHUNT_SERVE_BUILT=1 run).
const distReady = SERVE_BUILT && fs.existsSync(DIST_INDEX);
if (SERVE_BUILT && !distReady) {
  console.error(
    "[jobhunt] ============================================================\n" +
      `[jobhunt] JOBHUNT_SERVE_BUILT=1 but no built UI at ${DIST_INDEX}\n` +
      "[jobhunt] Run 'npm run build' first. Serving the API only; the UI port\n" +
      "[jobhunt] will NOT be bound. (The stable launcher falls back to the dev\n" +
      "[jobhunt] channel when dist/ is absent, so promoted stable is unaffected.)\n" +
      "[jobhunt] ============================================================",
  );
}
if (distReady) {
  // Serve hashed assets + any real file under dist/. index:false so a bare GET /
  // falls through to the SPA handler below (one code path for the app shell).
  app.use(express.static(DIST_DIR, { index: false }));
  // SPA fallback: serve the app shell for client-side routes so deep links and a
  // refresh on a sub-route resolve. Restricted to GET/HEAD, to non-/api/ paths,
  // and to paths that do NOT look like a file (no extension) - express.static
  // already served every real file, so a request that reaches here with an
  // extension is a MISSING asset and must 404 (never the HTML shell, which would
  // mask the broken reference). Registered before the 4-arg error handler.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || path.extname(req.path)) return next();
    res.sendFile(DIST_INDEX);
  });
  console.log(`[jobhunt] serving built UI from ${DIST_DIR}`);
}

// ---- JSON body-parse error handling (t-1783192842197) ---------------------
// A malformed request body (e.g. `{bad json`) throws inside express.json()
// (registered at the very top, line 297) and, with no error-handling
// middleware anywhere in the chain, fell through to EXPRESS'S OWN default
// error handler: a full HTML page with a raw stack trace, including absolute
// local filesystem paths (…\node_modules\body-parser\lib\types\json.js:92:19).
// Every route in this file already wraps its own logic in try/catch and
// answers with a clean JSON {error}, so this was the one gap - a parse
// failure short-circuits straight out of express.json() via next(err) and
// never reaches a route handler at all.
//
// A 4-arg Express error-handling middleware is matched by ARITY, not
// position: Express walks forward through the whole remaining stack for the
// next error handler when next(err) fires, skipping ordinary (3-arg)
// middleware/routes along the way. So registering this once, here, after
// every route (but still before app.listen, and unconditionally - so tests
// importing `app` under JOBHUNT_TEST=1 get it too) still catches the
// express.json() failure from the top of the file.
//
// Narrowly scoped to the body-parser signature (SyntaxError flagged with
// `.type === "entity.parse.failed"`) so a genuine application bug is never
// mislabeled as a client input error; anything else still gets a clean JSON
// 500 - never Express's default HTML+stack-trace page - matching the
// error-response contract every other endpoint in this file already follows.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  console.error(`[jobhunt] unhandled error: ${err && err.stack ? err.stack : err}`);
  res.status((err && err.status) || (err && err.statusCode) || 500).json({ error: "internal server error" });
});

// Skip the watcher + port bind when imported by tests (JOBHUNT_TEST=1).
if (process.env.JOBHUNT_TEST !== "1") {
  // Boot-time orphaned-run reconcile (SIM-70), BEFORE any run can be accepted.
  // A restart mid-run leaves the old process's "running" records with no
  // terminal (the `runs` Map that closes them is memory-only, never rehydrated).
  // This fresh process owns NO runs, so every dangling "running" record is an
  // orphan regardless of age (inflightToleranceMs:0 - no in-flight window to
  // respect, unlike the standalone CLI running against a live server). Each is
  // closed with a single appended "stopped" terminal via the sanctioned
  // appendJsonl. Best-effort: telemetry reconciliation must never block startup.
  try {
    const { closed } = reconcileOrphanedRuns(store.activityFile, { inflightToleranceMs: 0 });
    if (closed.length) {
      console.log(`[jobhunt] reconciled ${closed.length} orphaned run(s) on boot`);
    }
  } catch (e) {
    console.error(`[jobhunt] boot reconcile failed (non-fatal): ${e && e.message ? e.message : e}`);
  }

  // Demo nightly reset via an in-process interval (design 5.3 / MF-10): no endpoint
  // needed, no anonymous surface. DEMO_RESET_INTERVAL_MS (e.g. 86400000 for daily)
  // arms it; unset leaves it off.
  if (DEMO_MODE) {
    const ms = Number(process.env.DEMO_RESET_INTERVAL_MS);
    if (Number.isFinite(ms) && ms > 0) {
      setInterval(() => {
        try {
          resetDemoData();
          broadcast({ type: "jobs-changed" });
          console.log("[jobhunt] demo: nightly reset applied");
        } catch (e) {
          console.error(`[jobhunt] demo interval reset failed: ${e && e.message ? e.message : e}`);
        }
      }, ms).unref();
    }
  }

  let debounce = null;
  // Ignore Office lock / temp files (`~$*`, `*.tmp`, `mso*`) so a transient EBUSY
  // on e.g. `~$Cover Letter.docx` or `mso1A2B.tmp` never reaches the watcher and
  // never triggers a spurious reload. Matched on the basename.
  const isTempLock = (p) => {
    const b = path.basename(p).toLowerCase();
    return b.startsWith("~$") || b.startsWith("mso") || b.endsWith(".tmp");
  };
  const watcher = chokidar.watch(JOBS_DIR, {
    ignoreInitial: true,
    depth: 2,
    ignored: isTempLock,
  });
  // A transient Windows lock (EBUSY/EPERM) on an Office temp file emits an `error`
  // event. With NO listener, an EventEmitter `error` throws and crashes the whole
  // bridge (the load-bearing write path). Log it and keep serving.
  watcher.on("error", (err) => {
    console.error(`[jobhunt] watcher error (ignored, server stays up): ${err && err.message ? err.message : err}`);
  });
  watcher.on("all", (evt, file) => {
    if (!file.toLowerCase().endsWith(".md")) return;
    discoveryDirty = true; // a job file changed -> discovery "tracked" flags may be stale
    clearTimeout(debounce);
    debounce = setTimeout(() => broadcast({ type: "jobs-changed" }), 250);
  });

  app.listen(PORT, HOST, () => {
    const posture = isLoopbackHost(HOST)
      ? "loopback only: set serverHost in config.json to expose on LAN"
      : "LAN-EXPOSED: reachable from other devices on this network";
    console.log(`[jobhunt] file bridge listening on ${HOST}:${PORT} (${posture})`);
  });

  // Built/stable channel (RFC v2-007 / SIM-66): the SAME app instance also listens
  // on the UI port, serving dist/ + a same-origin /api so the browser needs no Vite
  // proxy. The API port above stays bound so external consumers (product-hub reads
  // the board on :8787) keep working unchanged. Bound only when the build is present
  // (distReady); a missing dist/ logged loudly above and serves the API only. Same
  // HOST as the API port, so the loopback-vs-LAN posture is identical on both ports.
  if (distReady) {
    app.listen(UI_PORT, HOST, () => {
      console.log(`[jobhunt] built UI listening on ${HOST}:${UI_PORT} (serving dist/, same-origin /api)`);
    });
  }
}

// ROUTINES is exported so the guard test (tests/routine-agents.test.js) checks
// the EXACT table startRun consumes - every scope:"job"/"global" product routine
// must declare an `agent` that resolves to a real docs/agents.yaml id. Exporting
// the runtime object (not a copy) means the guard can never drift from what runs.
export { app, ROUTINES };
