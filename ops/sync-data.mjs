// SIM-393 I2 - the LAPTOP-SIDE vault->cloud sync client (design section B,
// audit/2026-07-17-sim393-vault-cloud-dataflow-design.md).
//
// WHAT IT DOES (one run):
//   1. STRICT, READ-ONLY read of the vault jobs domain (ops/vault-read.mjs - the
//      migrate-data reader, extracted; readdir/readFile/stat ONLY, guardian GC-6).
//   2. Hashes the inventory through a local (path,size,mtimeMs)->sha256 cache
//      OUTSIDE the vault (%LOCALAPPDATA%\ssc\jobhunt-sync-cache.json) so unchanged
//      OneDrive placeholders are never re-hydrated (design B7).
//   3. Diffs against GET /api/sync/manifest (content-addressed: rowSha per job,
//      sha256 per file) and pushes ONLY what is missing: insert-only job POSTs,
//      then insert-only file PUTs (design B4 layer 1; the server's
//      on-conflict-do-nothing store methods are layer 2).
//   4. CONFLICTS (same path, different bytes / frontmatter drift on an existing
//      cloud-owned job) are SKIPPED - the cloud copy is never touched - and
//      reported LOUDLY: in the console summary, in the exit code, and in the
//      POST /api/sync/runs summary line that lands in the app's activity feed.
//   5. Re-fetches the manifest and verifies SUBSET CONTAINMENT (design B5): every
//      vault byte-set is now cloud-side (under its own name or a dated resolution
//      copy) OR in this run's conflict list. Containment failure exits non-zero.
//
// DRY-RUN IS THE DEFAULT; --push writes. The design (section G, I2 row) names the
// `--dry-run` flag but never states the default; per the I2 build brief this
// client takes the conservative reading: a bare `node ops/sync-data.mjs` plans and
// prints (one manifest GET, zero cloud writes, zero run-summary line) and only
// `--push` performs the sync. The B7 scheduled task (I6) will simply run --push.
//
// EXIT CODES (distinguish clean / conflicts / errors, per the I2 brief; refines
// design B5's "conflicts alone exit 0" so an operator or scheduled task can tell
// the three states apart without parsing output):
//   0  clean (also: a second concurrent instance yielding to the lock)
//   2  conflicts reported, everything else clean (reported state, not an error)
//   1  errors (unreadable vault, auth/transport failure, containment failure)
//
// OWNER CONFLICT RESOLUTION (design B3): re-run with
//   --resolve "<jobId>/<name>=import-as-copy"
// which uploads the VAULT bytes under a dated sibling name (the app's
// _datedCopyName convention, e.g. "CV - Acme (2026-07-17).docx"). Both byte-sets
// then exist; nothing is overwritten - there is deliberately NO overwrite mode.
// A later run finds the vault bytes present cloud-side under the dated copy and
// counts the pair as resolved (no repeated conflict), statelessly.
//
// SECURITY POSTURE (guardian GC-6, binding I2 DoD):
//   - Reuses the runner's assertOutboundUrl (https-only, pinned to the ONE
//     configured host) + assertTlsNotBypassed from server/runner-lib.js.
//   - Every fetch carries { redirect: "error" } - a redirect anywhere is refused.
//   - Bearer SYNC_TOKEN comes from the ENVIRONMENT ONLY (the caller exports it);
//     this script never opens ~/.ssc-secrets, secrets.env, or any secrets file.
//     The token is never logged.
//   - READ-ONLY on the vault BY CONSTRUCTION: the only module that touches the
//     vault is ops/vault-read.mjs (readdir/readFile/stat only). Every write this
//     client performs goes through writeStateFile()/appendStateFile() below,
//     which resolveInside-contain the target to the state dir
//     (%LOCALAPPDATA%\ssc\ - cache, log, lock). No other fs write call exists in
//     this file.
//   - No listener: this process opens no server socket, ever (outbound fetch only;
//     prove with ops/scripts/assert-rc-no-listener.ps1 snapshot/diff).
//   - TEST SEAM: SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK=1 permits plain http to
//     LOOPBACK hosts only, so the integration suite can boot the real app on
//     127.0.0.1. Any non-loopback URL still goes through the https-only guard
//     even with the seam set; production runs never set the seam.
//
// Run:   SYNC_TOKEN=... node ops/sync-data.mjs --jobs-dir "<vault>\Jobs" \
//          --cloud-url https://<private-instance> [--push] [--resolve ...]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutboundUrl, assertTlsNotBypassed } from "../server/runner-lib.js";
import { isSafeName, resolveInside } from "../server/name-safety.js";
import { rowShaOf, sha256Hex } from "../server/sync-lib.js";
import { isDatedCopy, localDateStamp } from "../server/store-helpers.js";
import { readJobsDomain, VaultReadError } from "./vault-read.mjs";

export const CLIENT_VERSION = "sync-data/1";
export const EXIT_CLEAN = 0;
export const EXIT_ERRORS = 1;
export const EXIT_CONFLICTS = 2;

const CACHE_FILE = "jobhunt-sync-cache.json";
const LOG_FILE = "jobhunt-sync.log";
const LOCK_FILE = "jobhunt-sync.lock";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class SyncError extends Error {}
const fail = (msg) => {
  throw new SyncError(msg);
};

// ---- URL guard (GC-6) -------------------------------------------------------
// The runner's https-only pinned-host guard, with ONE explicitly-scoped test
// seam: plain http is allowed IFF the env opts in AND the host is loopback (the
// integration tests boot the real app on 127.0.0.1; loopback never leaves the
// machine, so the outbound-only posture is intact). Everything else - including
// a non-loopback http URL WITH the seam set - falls through to assertOutboundUrl.
export function assertSyncUrl(rawUrl, { requireHost, env = process.env } = {}) {
  if (env.SYNC_CLIENT_TEST_ALLOW_HTTP_LOOPBACK === "1") {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new Error(`sync: invalid cloud URL: ${rawUrl}`);
    }
    if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) {
      if (requireHost && u.hostname !== requireHost) {
        throw new Error(`sync: host ${u.hostname} does not match the pinned host ${requireHost}`);
      }
      return u;
    }
  }
  return assertOutboundUrl(rawUrl, { requireHost });
}

// ---- options ----------------------------------------------------------------
export function resolveOptions(argv = [], env = process.env) {
  const opts = {
    jobsDir: env.SYNC_JOBS_DIR || env.JOBHUNT_JOBS_DIR || null,
    cloudUrl: env.SYNC_CLOUD_URL || null,
    stateDir: env.SYNC_STATE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ssc"),
    push: false, // DRY-RUN by default (see header)
    resolves: [], // [{ jobId, name }] - mode is always import-as-copy (no other exists)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const grab = () => {
      const eq = a.indexOf("=");
      if (eq !== -1) return a.slice(eq + 1);
      i++;
      if (i >= argv.length) fail(`flag ${a} needs a value`);
      return argv[i];
    };
    if (a === "--push") opts.push = true;
    else if (a === "--dry-run") opts.push = false;
    else if (a.startsWith("--jobs-dir")) opts.jobsDir = grab();
    else if (a.startsWith("--cloud-url")) opts.cloudUrl = grab();
    else if (a.startsWith("--state-dir")) opts.stateDir = grab();
    else if (a.startsWith("--resolve")) opts.resolves.push(parseResolve(grab()));
    else fail(`unknown argument: ${a}`);
  }
  if (!opts.jobsDir) fail("missing vault jobs dir: pass --jobs-dir or set SYNC_JOBS_DIR / JOBHUNT_JOBS_DIR");
  if (!opts.cloudUrl) fail("missing cloud URL: pass --cloud-url or set SYNC_CLOUD_URL");
  opts.jobsDir = path.resolve(opts.jobsDir);
  opts.stateDir = path.resolve(opts.stateDir);
  return opts;
}

// "<jobId>/<name>=import-as-copy" (design B3's owner-resolution flow, verbatim).
// jobId and name are single path components (they cannot legally contain "/"),
// so the FIRST "/" splits them and the LAST "=" carries the mode.
export function parseResolve(spec) {
  const eq = String(spec).lastIndexOf("=");
  if (eq === -1) fail(`--resolve needs "<jobId>/<name>=import-as-copy" (got: ${spec})`);
  const mode = spec.slice(eq + 1);
  if (mode !== "import-as-copy") {
    fail(`--resolve mode must be "import-as-copy" (got: ${mode}). There is deliberately no overwrite mode.`);
  }
  const target = spec.slice(0, eq);
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) {
    fail(`--resolve needs "<jobId>/<name>=import-as-copy" (got: ${spec})`);
  }
  return { jobId: target.slice(0, slash), name: target.slice(slash + 1) };
}

// ---- contained state-dir writes (the client's ONLY writes) -------------------
function writeStateFile(stateDir, name, text) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveInside(stateDir, name), text);
}
function appendStateFile(stateDir, name, text) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(resolveInside(stateDir, name), text);
}
function removeStateFile(stateDir, name) {
  try {
    fs.rmSync(resolveInside(stateDir, name));
  } catch {
    /* already gone */
  }
}

// ---- lockfile (design B7: overlap-safe; second instance exits 0) -------------
function acquireLock(stateDir) {
  const lockPath = resolveInside(stateDir, LOCK_FILE);
  try {
    const prev = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (prev && Number.isInteger(prev.pid)) {
      try {
        process.kill(prev.pid, 0); // liveness probe only - signal 0 sends nothing
        return { acquired: false, holder: prev };
      } catch {
        /* stale lock (holder is gone) - take over */
      }
    }
  } catch {
    /* no lock / unreadable lock -> take it */
  }
  writeStateFile(stateDir, LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { acquired: true };
}

// ---- hash cache (design B7) ---------------------------------------------------
// A derived performance artifact keyed (path,size,mtimeMs)->sha256; its loss costs
// one slow (fully-hydrating) run, never wrong behavior (design B4: no client-side
// state is load-bearing). Lives in the state dir - OUTSIDE the vault, outside any
// repo. Updated on every run including dry-runs (it holds no cloud state).
function loadCache(stateDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(resolveInside(stateDir, CACHE_FILE), "utf8"));
    if (doc && doc.version === 1 && doc.entries && typeof doc.entries === "object") return doc.entries;
  } catch {
    /* absent / corrupt -> full re-hash, by design */
  }
  return {};
}
const cacheKey = (f) => `${f.path}|${f.size}|${f.mtimeMs}`;

// ---- the run -----------------------------------------------------------------
// opts: from resolveOptions. hooks (tests): { env, log }.
export async function runSync(opts, { env = process.env, log = (m) => console.log(m) } = {}) {
  assertTlsNotBypassed(env); // GC-6: refuse a global TLS bypass outright
  const token = env.SYNC_TOKEN || "";
  if (!token) fail("no SYNC_TOKEN in the environment (the caller exports it; this script reads no secrets file)");

  const pinned = assertSyncUrl(opts.cloudUrl, { env }); // https-only (or the loopback test seam)
  const pinnedHost = pinned.hostname; // every subsequent request re-asserts this host
  const req = (pathPart, init = {}) => {
    const url = assertSyncUrl(new URL(pathPart, opts.cloudUrl).toString(), { requireHost: pinnedHost, env });
    return fetch(url, {
      ...init,
      redirect: "error", // GC-6: a redirect anywhere is refused
      headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  };
  const getManifest = async (label) => {
    const r = await req("/api/sync/manifest");
    if (r.status !== 200) fail(`${label}: GET /api/sync/manifest -> ${r.status} (${await safeText(r)})`);
    return r.json();
  };

  const mode = opts.push ? "PUSH" : "DRY-RUN (default; pass --push to write)";
  log(`[sync-data] vault jobs dir: ${opts.jobsDir}`);
  log(`[sync-data] cloud:          ${pinned.origin} (pinned host: ${pinnedHost})`);
  log(`[sync-data] state dir:      ${opts.stateDir}`);
  log(`[sync-data] mode:           ${mode}`);

  const lock = acquireLock(opts.stateDir);
  if (!lock.acquired) {
    log(`[sync-data] another sync (pid ${lock.holder.pid}, since ${lock.holder.startedAt}) is running - yielding (exit 0).`);
    return { exitCode: EXIT_CLEAN, alreadyRunning: true };
  }

  const startedAt = new Date().toISOString();
  const warnings = [];
  const conflicts = []; // loud, reported state (exit 2)
  const errors = []; // hard failures (exit 1)
  const resolved = []; // import-as-copy uploads performed this run
  const inserted = { jobs: 0, files: 0 };
  let noops = 0;

  try {
    // -- 1. strict read-only vault read + content addressing through the cache --
    const jobs = readJobsDomain(opts.jobsDir, warnings, { lazyBytes: true });
    const cache = loadCache(opts.stateDir);
    let cacheDirty = false;
    let hydrated = 0;
    for (const job of jobs) {
      job.rowSha = rowShaOf(job.front, job.body);
      for (const f of job.files) {
        const k = cacheKey(f);
        if (cache[k]) {
          f.sha256 = cache[k];
        } else {
          f.sha256 = sha256Hex(f.read()); // hydrates this one file
          cache[k] = f.sha256;
          cacheDirty = true;
          hydrated++;
        }
      }
    }
    const fileCount = jobs.reduce((n, j) => n + j.files.length, 0);
    log(`[read] ${jobs.length} job folder(s), ${fileCount} companion file(s) (${hydrated} hashed fresh, ${fileCount - hydrated} from cache)`);
    for (const w of warnings) log(`[warn] ${w}`);
    if (cacheDirty) writeStateFile(opts.stateDir, CACHE_FILE, JSON.stringify({ version: 1, entries: cache }));

    // -- 2. manifest diff (design B4 layer 1) ---------------------------------
    // Composite (jobId, name) keys join on NUL: job ids legally contain spaces,
    // so a printable join could collide two distinct pairs, while NUL can never
    // appear in a safe name (control chars are rejected by the shared rules).
    // A job-LEVEL record uses the same helper with name=null.
    const keyOf = (jobId, name) => jobId + "\u0000" + (name === null ? "\u0000row" : name);
    const manifest = await getManifest("diff");
    const cloudJobs = new Map(manifest.jobs.map((j) => [j.id, j.rowSha]));
    const cloudFiles = new Map(manifest.files.map((f) => [keyOf(f.jobId, f.name), f.sha256]));
    const cloudFilesByJob = new Map();
    for (const f of manifest.files) {
      if (!cloudFilesByJob.has(f.jobId)) cloudFilesByJob.set(f.jobId, []);
      cloudFilesByJob.get(f.jobId).push(f);
    }
    const wantResolve = new Set(opts.resolves.map((r) => keyOf(r.jobId, r.name)));

    const plan = { newJobs: [], newFiles: [], resolveUploads: [] };
    for (const job of jobs) {
      // Client-side name safety (shared server/name-safety.js rules): a hostile
      // folder/file name is refused HERE - the server never even sees it.
      if (!isSafeName(job.id)) {
        conflicts.push({ reason: "unsafe-name", jobId: job.id, name: null });
        continue;
      }
      const isNewJob = !cloudJobs.has(job.id);
      if (isNewJob) plan.newJobs.push(job);
      else if (cloudJobs.get(job.id) !== job.rowSha) {
        // Existing rows are CLOUD-OWNED (design A): vault-side drift is reported,
        // never applied, never lost silently.
        conflicts.push({ reason: "frontmatter-drift", jobId: job.id, name: null, vaultRowSha: job.rowSha, cloudRowSha: cloudJobs.get(job.id) });
      }
      for (const f of job.files) {
        if (!isSafeName(f.name)) {
          conflicts.push({ reason: "unsafe-name", jobId: job.id, name: f.name });
          continue;
        }
        const key = keyOf(job.id, f.name);
        const cloudSha = cloudFiles.get(key);
        if (cloudSha === undefined) {
          plan.newFiles.push({ job, f, viaNewJob: isNewJob });
        } else if (cloudSha === f.sha256) {
          noops++;
        } else {
          // Same path, different bytes. If the vault byte-set already exists
          // cloud-side under a DATED COPY name for this job, a previous
          // --resolve import-as-copy handled it: containment holds, so count it
          // resolved instead of re-raising the same conflict forever (stateless).
          const copies = cloudFilesByJob.get(job.id) || [];
          const already = copies.some((c) => c.name !== f.name && isDatedCopy(c.name) && c.sha256 === f.sha256);
          if (already) {
            noops++;
          } else if (wantResolve.has(key)) {
            plan.resolveUploads.push({ job, f, cloudSha });
          } else {
            conflicts.push({
              reason: "bytes-differ",
              jobId: job.id,
              name: f.name,
              vaultSha: f.sha256,
              cloudSha,
              vaultMtimeIso: new Date(f.mtimeMs).toISOString(),
            });
          }
        }
      }
    }
    for (const r of opts.resolves) {
      if (!plan.resolveUploads.some((u) => u.job.id === r.jobId && u.f.name === r.name)) {
        warnings.push(`--resolve ${r.jobId}/${r.name}: no live bytes-differ conflict for it (already resolved, or not a conflict) - nothing to do`);
        log(`[warn] ${warnings[warnings.length - 1]}`);
      }
    }

    log(
      `[plan] insert ${plan.newJobs.length} job(s) + ${plan.newFiles.length} file(s); ` +
        `${noops} no-op(s); ${conflicts.length} conflict(s); ${plan.resolveUploads.length} resolution upload(s)`,
    );

    // -- 3. dry-run stops here: one manifest GET, zero cloud writes -----------
    if (!opts.push) {
      for (const j of plan.newJobs) log(`[plan] + job  ${j.id} (${j.files.length} file(s))`);
      for (const nf of plan.newFiles.filter((x) => !x.viaNewJob)) log(`[plan] + file ${nf.job.id} / ${nf.f.name}`);
      reportConflicts(conflicts, log);
      const exitCode = conflicts.length ? EXIT_CONFLICTS : EXIT_CLEAN;
      log(`[sync-data] DRY-RUN complete - nothing was pushed. Exit ${exitCode}.`);
      return { exitCode, dryRun: true, plan: summarizePlan(plan), inserted, noops, conflicts, resolved, errors, warnings };
    }

    // -- 4. push: insert-only job POSTs, then insert-only file PUTs ------------
    for (const job of plan.newJobs) {
      const r = await req("/api/sync/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: job.id,
          role: job.front.role,
          employer: job.front.employer,
          front: job.front,
          body: job.body,
          tags: job.tags,
          mtimeIso: new Date(job.mtimeMs).toISOString(),
        }),
      });
      if (r.status === 201) {
        inserted.jobs++;
        log(`[push] job inserted: ${job.id}`);
      } else if (r.status === 409) {
        // Raced by a concurrent in-app "Add lead" (design B6's safe degradation):
        // skip-and-report, never overwrite. Its files still sync additively below.
        conflicts.push({ reason: "job-exists", jobId: job.id, name: null });
        log(`[push] job ${job.id}: 409 job-exists (raced) - skipped, files continue`);
      } else {
        errors.push(`POST /api/sync/jobs ${job.id} -> ${r.status} (${await safeText(r)})`);
      }
    }
    const putFile = async (jobId, name, bytes, mime, mtimeMs) => {
      return req(`/api/sync/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: {
          "content-type": mime || "application/octet-stream",
          "x-file-sha256": sha256Hex(bytes),
          "x-file-mime": mime || "",
          "x-file-mtime": new Date(mtimeMs).toISOString(),
        },
        body: bytes,
      });
    };
    for (const { job, f } of plan.newFiles) {
      const bytes = f.read();
      const r = await putFile(job.id, f.name, bytes, f.mime, f.mtimeMs);
      if (r.status === 201) inserted.files++;
      else if (r.status === 200) noops++; // raced duplicate send - idempotent by layer 2
      else if (r.status === 409) {
        const body = await safeJson(r);
        conflicts.push({ reason: "bytes-differ", jobId: job.id, name: f.name, vaultSha: sha256Hex(bytes), cloudSha: body && body.cloudSha, vaultMtimeIso: new Date(f.mtimeMs).toISOString() });
      } else errors.push(`PUT ${job.id}/${f.name} -> ${r.status} (${await safeText(r)})`);
    }

    // -- 5. owner resolutions: vault bytes up as a DATED SIBLING copy ----------
    for (const { job, f } of plan.resolveUploads) {
      const taken = new Set((cloudFilesByJob.get(job.id) || []).map((c) => c.name));
      const as = datedCopyName(f.name, taken);
      const bytes = f.read();
      const r = await putFile(job.id, as, bytes, f.mime, f.mtimeMs);
      if (r.status === 201) {
        inserted.files++;
        resolved.push({ jobId: job.id, name: f.name, as });
        log(`[resolve] ${job.id} / ${f.name} imported as copy: "${as}" (cloud copy untouched)`);
      } else {
        errors.push(`resolve PUT ${job.id}/${as} -> ${r.status} (${await safeText(r)})`);
      }
    }

    // -- 6. containment verify (design B5): vault ⊆ cloud ∪ conflicts ----------
    const after = await getManifest("verify");
    const afterJobs = new Map(after.jobs.map((j) => [j.id, j.rowSha]));
    const afterFiles = new Map(after.files.map((x) => [keyOf(x.jobId, x.name), x.sha256]));
    const afterByJob = new Map();
    for (const x of after.files) {
      if (!afterByJob.has(x.jobId)) afterByJob.set(x.jobId, []);
      afterByJob.get(x.jobId).push(x);
    }
    const conflictKey = new Set(conflicts.map((c) => keyOf(c.jobId, c.name === undefined ? null : c.name)));
    for (const job of jobs) {
      // an unsafe-id folder was refused wholesale client-side and loudly reported
      if (conflicts.some((c) => c.jobId === job.id && c.name === null && c.reason === "unsafe-name")) continue;
      if (!afterJobs.has(job.id)) {
        errors.push(`containment: job "${job.id}" is still missing cloud-side`);
        continue;
      }
      if (afterJobs.get(job.id) !== job.rowSha && !conflictKey.has(keyOf(job.id, null))) {
        errors.push(`containment: job "${job.id}" rowSha differs cloud-side with no conflict recorded`);
      }
      for (const f of job.files) {
        if (conflictKey.has(keyOf(job.id, f.name))) continue; // reported, by design
        const sha = afterFiles.get(keyOf(job.id, f.name));
        if (sha === f.sha256) continue;
        // resolved-as-copy counts: the byte-set is cloud-side under a dated name
        const copies = afterByJob.get(job.id) || [];
        if (copies.some((c) => isDatedCopy(c.name) && c.sha256 === f.sha256)) continue;
        errors.push(`containment: ${job.id}/${f.name} (sha ${f.sha256.slice(0, 12)}…) is not cloud-side and not in the conflict list`);
      }
    }
    log(errors.length ? `[verify] containment FAILED (${errors.length} problem(s))` : "[verify] containment holds: every vault byte-set is cloud-side or loudly reported");

    // -- 7. run summary line -> the app's activity feed (design B2) ------------
    const finishedAt = new Date().toISOString();
    const rs = await req("/api/sync/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startedAt,
        finishedAt,
        inserted,
        noops,
        conflicts: conflicts.slice(0, 200).map((c) => ({ reason: c.reason, jobId: c.jobId, name: c.name, vaultSha: c.vaultSha, cloudSha: c.cloudSha, vaultMtimeIso: c.vaultMtimeIso })),
        clientVersion: CLIENT_VERSION,
      }),
    });
    if (rs.status !== 201) errors.push(`POST /api/sync/runs -> ${rs.status} (${await safeText(rs)})`);

    reportConflicts(conflicts, log);
    const exitCode = errors.length ? EXIT_ERRORS : conflicts.length ? EXIT_CONFLICTS : EXIT_CLEAN;
    for (const e of errors) log(`[error] ${e}`);
    log(
      `[sync-data] done: inserted ${inserted.jobs} job(s) + ${inserted.files} file(s), ${noops} no-op(s), ` +
        `${conflicts.length} conflict(s), ${resolved.length} resolved. Exit ${exitCode}.`,
    );
    appendRunLog(opts.stateDir, { startedAt, finishedAt, mode: "push", inserted, noops, conflicts: conflicts.length, resolved: resolved.length, errors: errors.length, exitCode });
    return { exitCode, dryRun: false, inserted, noops, conflicts, resolved, errors, warnings };
  } finally {
    removeStateFile(opts.stateDir, LOCK_FILE);
  }
}

// "<stem> (YYYY-MM-DD).<ext>", bumping "(n)" against the names already taken
// cloud-side - the app's _datedCopyName / isDatedCopy convention (design B3).
export function datedCopyName(name, taken = new Set(), stamp = localDateStamp()) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = `${base} (${stamp})${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} (${stamp}) (${n})${ext}`;
    n++;
  }
  return candidate;
}

function summarizePlan(plan) {
  return {
    newJobs: plan.newJobs.map((j) => j.id),
    newFiles: plan.newFiles.map((x) => `${x.job.id}/${x.f.name}`),
    resolveUploads: plan.resolveUploads.map((x) => `${x.job.id}/${x.f.name}`),
  };
}

function reportConflicts(conflicts, log) {
  for (const c of conflicts) {
    if (c.reason === "bytes-differ") {
      log(`[CONFLICT] ${c.jobId} / ${c.name}: vault bytes differ from cloud (vault ${String(c.vaultSha).slice(0, 12)}… vs cloud ${String(c.cloudSha).slice(0, 12)}…). Cloud copy untouched. Resolve with --resolve "${c.jobId}/${c.name}=import-as-copy".`);
    } else if (c.reason === "frontmatter-drift") {
      log(`[CONFLICT] ${c.jobId}: vault frontmatter/body drifted on a cloud-owned job - NOT applied (status moves happen in-app).`);
    } else if (c.reason === "unsafe-name") {
      log(`[CONFLICT] ${c.jobId}${c.name ? ` / ${c.name}` : ""}: unsafe name refused client-side (shared name-safety rules) - rename it in the vault.`);
    } else {
      log(`[CONFLICT] ${c.jobId}${c.name ? ` / ${c.name}` : ""}: ${c.reason}`);
    }
  }
}

function appendRunLog(stateDir, record) {
  try {
    appendStateFile(stateDir, LOG_FILE, JSON.stringify(record) + "\n");
  } catch {
    /* the log is best-effort telemetry */
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---- CLI ----------------------------------------------------------------------
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const opts = resolveOptions(process.argv.slice(2), process.env);
      const r = await runSync(opts);
      process.exit(r.exitCode);
    } catch (e) {
      const label = e instanceof VaultReadError ? "vault read ABORT" : "ABORT";
      console.error(`[sync-data] ${label}: ${e && e.message ? e.message : e}`);
      process.exit(EXIT_ERRORS);
    }
  })();
}
