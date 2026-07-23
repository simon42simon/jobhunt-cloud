// RC-3 / SIM-87 I7 - the LAPTOP-SIDE hybrid agent runner (design section 4).
//
// This is the trusted-core half of the hybrid model. It runs on the owner's laptop
// and does the ONLY thing that keeps facts local: it polls the cloud's OUTBOUND
// queue over HTTPS, spawns claude.exe LOCALLY (reading ops/facts + the master CV
// from local disk), and posts back ONLY the generated, kind-bounded artifacts.
//
// THE OUTBOUND-ONLY INVARIANT (T3/G8, MF-6): every network call here is a laptop
// -> cloud HTTPS request. This process opens NO listening socket (prove it with
// ops/scripts/assert-rc-no-listener.ps1: snapshot listeners before, again while it
// polls, diff -> zero new listener). It refuses http, an unpinned host, or a TLS
// bypass before a single artifact byte leaves the box.
//
// Secrets: RUNNER_TOKEN (plaintext) + RUNNER_CLOUD_URL live in ~/.ssc-secrets (JSON,
// OUTSIDE any OneDrive-synced path per MF-5) or the environment. The cloud holds
// only sha256(token). This script never logs the token.
//
// Run:  node ops/agent-runner.mjs        (Ctrl-C to stop; laptop-off = jobs pend)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertOutboundUrl,
  assertTlsNotBypassed,
  buildRunnerPrompt,
  RUNNER_KIND_AGENT,
  RUNNER_ARTIFACT_KINDS,
  RUNNER_REQUIRED_ARTIFACT_KINDS,
  artifactKindOf,
  validateArtifact,
  isRunnerKind,
} from "../server/runner-lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLL_IDLE_MS = 5000; // wait between empty polls
const HEARTBEAT_MS = 60_000; // lease keep-alive cadence (< the 10-min lease)
const ARTIFACT_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  json: "application/json",
  txt: "text/plain",
};

// ---- config / secrets ------------------------------------------------------
function loadSecrets() {
  // ~/.ssc-secrets (JSON) first; env overrides. MF-5: this path must not be under a
  // OneDrive-synced tree - the runner asserts that below.
  const file = path.join(os.homedir(), ".ssc-secrets");
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* env-only is fine */
  }
  const token = process.env.RUNNER_TOKEN || s.runnerToken || "";
  const cloudUrl = process.env.RUNNER_CLOUD_URL || s.cloudUrl || "";
  if (!token) throw new Error("runner: no RUNNER_TOKEN (env or ~/.ssc-secrets.runnerToken)");
  if (!cloudUrl) throw new Error("runner: no RUNNER_CLOUD_URL (env or ~/.ssc-secrets.cloudUrl)");
  // MF-5: warn loudly if the secrets file sits in a synced store.
  if (/onedrive/i.test(file)) console.warn("runner: WARNING ~/.ssc-secrets appears to be in a synced path");
  return { token, cloudUrl, secretsFile: file };
}

function loadConfig() {
  const localPath = path.join(ROOT, "config.local.json");
  const basePath = path.join(ROOT, "config.json");
  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(localPath) ? localPath : basePath, "utf8"));
  return cfg;
}

function resolveClaude(cfg) {
  if (cfg.claudeBin && fs.existsSync(cfg.claudeBin)) return cfg.claudeBin;
  const guess = path.join(process.env.USERPROFILE || os.homedir(), ".local", "bin", "claude.exe");
  if (fs.existsSync(guess)) return guess;
  return process.platform === "win32" ? "claude.exe" : "claude";
}

// SIM-543: everything a spawn needs, checked ONCE at boot. Returns a list of
// plain-language problems (empty = good to run). Exported for the unit test.
// A bare-name claudeBin ("claude.exe" on PATH) is unverifiable here and is
// allowed through; the per-job spawn-error capture still names it on failure.
export function validateRunnerBoot(ctx) {
  const problems = [];
  if (!fs.existsSync(ctx.workspaceDir) || !fs.statSync(ctx.workspaceDir).isDirectory()) {
    problems.push(
      `workspace dir does not exist: ${ctx.workspaceDir} (derived from jobsDir=${ctx.jobsDir}; set JOBHUNT_JOBS_DIR or config.local.json jobsDir to a real local directory - the repo config.json carries the CONTAINER's /data/Jobs)`,
    );
  }
  if (path.isAbsolute(ctx.claudeBin) && !fs.existsSync(ctx.claudeBin)) {
    problems.push(`claude binary not found: ${ctx.claudeBin} (config claudeBin)`);
  }
  return problems;
}

// ---- outbound HTTPS helpers (pinned host, https only) ----------------------
let PINNED_HOST = null;
function api(cloudUrl, pathPart) {
  const u = assertOutboundUrl(new URL(pathPart, cloudUrl).toString(), { requireHost: PINNED_HOST });
  return u.toString();
}

async function pollNext(ctx) {
  const res = await fetch(api(ctx.cloudUrl, "/api/runner/jobs/next"), {
    method: "GET",
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  if (res.status === 204) return null;
  if (res.status === 401) throw new Error("runner: token rejected by cloud (401)");
  if (res.status === 501) throw new Error("runner: cloud runner not enabled (501)");
  if (!res.ok) throw new Error(`runner: claim failed ${res.status}`);
  return res.json();
}

async function heartbeat(ctx, id) {
  try {
    await fetch(api(ctx.cloudUrl, `/api/runner/jobs/${encodeURIComponent(id)}/heartbeat`), {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.token}` },
    });
  } catch {
    /* a missed heartbeat is recoverable (the lease is generous) */
  }
}

// Returns { status, reason } - reason is the JSON body's `error` (e.g. the
// SIM-598 gate's page-cap message) when the cloud rejected the upload, so a
// swallowed 400 (SIM-613) can carry its real cause into the run result instead
// of a bare console.warn no one downstream ever sees.
async function postArtifact(ctx, id, nonce, name, mime, bytes) {
  const res = await fetch(api(ctx.cloudUrl, `/api/runner/jobs/${encodeURIComponent(id)}/artifact`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "x-runner-nonce": nonce,
      "x-artifact-name": name,
      "x-artifact-mime": mime,
      "content-type": mime,
    },
    body: bytes,
  });
  let reason = null;
  if (!res.ok) {
    try {
      const body = await res.json();
      reason = body && typeof body.error === "string" ? body.error : null;
    } catch {
      /* a non-JSON error body still leaves the status itself informative */
    }
  }
  return { status: res.status, reason };
}

// SIM-613/615: pure outcome decision, exported for the unit test. `postedKinds`
// is the Set of artifact KINDS (cv/cover/...) that landed with a 2xx this run;
// `failures` are plain-language notes (gate rejection, post error, ...) for the
// error message. A non-zero process exit still wins outright (unchanged prior
// behavior); otherwise a REQUIRED kind that never posted turns an exit-0 run
// into a reported failure - the fail-closed rule the SIM-598 gate itself is
// never touched to enforce.
export function resolveRunOutcome(kind, code, spawnError, postedKinds, failures) {
  if (code !== 0) return { status: "failed", error: spawnError || `local run exited ${code}` };
  const required = RUNNER_REQUIRED_ARTIFACT_KINDS[kind] || [];
  const missing = required.filter((k) => !postedKinds.has(k));
  if (missing.length) {
    const detail = failures.length ? ` (${failures.join("; ")})` : "";
    return { status: "failed", error: `required artifact(s) never landed in job_files: ${missing.join(", ")}${detail}` };
  }
  return { status: "done", error: null };
}

async function postResult(ctx, id, nonce, status, error, result = null) {
  await fetch(api(ctx.cloudUrl, `/api/runner/jobs/${encodeURIComponent(id)}/result`), {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
    body: JSON.stringify(result ? { nonce, status, error, result } : { nonce, status, error }),
  });
}

// ---- local execution -------------------------------------------------------
// Snapshot the job folder's current files + mtimes, so after the run we can collect
// only the NEW/MODIFIED outputs (and only those whose kind the routine may post).
function snapshotFolder(folderPath) {
  const map = {};
  try {
    for (const name of fs.readdirSync(folderPath)) {
      try {
        map[name] = fs.statSync(path.join(folderPath, name)).mtimeMs;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* folder may not exist yet */
  }
  return map;
}

function collectOutputs(kind, folderPath, before) {
  const allowed = RUNNER_ARTIFACT_KINDS[kind] || [];
  const out = [];
  let now = {};
  try {
    now = snapshotFolder(folderPath);
  } catch {
    return out;
  }
  for (const name of Object.keys(now)) {
    const changed = before[name] === undefined || now[name] > before[name];
    if (!changed) continue;
    const kindOf = artifactKindOf(name);
    if (!allowed.includes(kindOf)) continue; // MF-2: never post an out-of-scope file
    const ext = path.extname(name).toLowerCase().replace(".", "");
    const mime = ARTIFACT_MIME[ext];
    if (!mime) continue; // only the known artifact mimes
    out.push({ name, mime, kindOf });
  }
  return out;
}

// SIM-535 (discover-jobs-source): the run's local scratch space. The claim's
// tracked-links index is written here for the scout to READ, and the scout
// writes its ONE finds file here for the runner to post back as the result -
// the spawned agent itself never talks to the cloud. Paths are runner-chosen
// (never payload-driven) and the dir is per-claim, so runs cannot collide.
function prepareSourceRunWorkdir(job) {
  const dir = path.join(os.tmpdir(), "jobhunt-runner", job.id);
  fs.mkdirSync(dir, { recursive: true });
  const trackedLinksFile = path.join(dir, "tracked-links.json");
  const findsFile = path.join(dir, "finds.json");
  const links = Array.isArray(job.payload && job.payload.trackedLinks) ? job.payload.trackedLinks : [];
  fs.writeFileSync(trackedLinksFile, JSON.stringify(links, null, 2), "utf8");
  try {
    fs.rmSync(findsFile, { force: true }); // never let a stale finds file pass as this run's output
  } catch {}
  return { dir, trackedLinksFile, findsFile };
}

// Read + trim the finds file to fit the cloud's 100kb JSON body cap: drop tail
// finds (never counters) until it fits, loudly. Returns null when the file is
// missing/unparseable - the cloud records that honestly as an incomplete run.
const RESULT_MAX_BYTES = 90_000;
function collectSourceRunResult(findsFile) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(findsFile, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = { counters: parsed.counters || {}, finds: Array.isArray(parsed.finds) ? parsed.finds : [] };
  while (JSON.stringify(result).length > RESULT_MAX_BYTES && result.finds.length) {
    result.finds.pop();
    result.truncated = (result.truncated || 0) + 1;
  }
  if (result.truncated) console.warn(`runner: finds payload over ${RESULT_MAX_BYTES}B - dropped ${result.truncated} tail find(s)`);
  return result;
}

// Resolves { code, spawnError }: spawnError carries the REASON a spawn never
// started (ENOENT binary, missing cwd, ...) instead of a bare code=1 that the
// cloud can only render as "runner reported failure" (SIM-543 - a cwd
// misconfig failed every job for an afternoon with no reason recorded anywhere).
function runClaudeLocally(ctx, kind, jobId, payload, onLine, promptOpts = {}) {
  return new Promise((resolve) => {
    const prompt = buildRunnerPrompt(kind, jobId, payload, promptOpts); // MF-1: fixed template + data
    const agent = RUNNER_KIND_AGENT[kind];
    const args = [
      "-p", prompt,
      "--permission-mode", "acceptEdits", // never skip-permissions (ADR-005)
      "--allowedTools", ctx.allowedTools,
      "--output-format", "stream-json", "--verbose",
    ];
    if (agent) args.push("--agent", agent);
    const proc = spawn(ctx.claudeBin, args, { cwd: ctx.workspaceDir, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    proc.stderr.on("data", (d) => onLine(d.toString()));
    proc.on("error", (e) => {
      const msg = `spawn failed: ${e && e.message ? e.message : e} (bin=${ctx.claudeBin} cwd=${ctx.workspaceDir})`;
      console.error(`runner: ${msg}`);
      onLine(`[spawn error] ${msg}`);
      resolve({ code: 1, spawnError: msg });
    });
    proc.on("close", (code) => resolve({ code: code == null ? 1 : code, spawnError: null }));
  });
}

async function processJob(ctx, job) {
  const { id, kind, jobId, payload, nonce } = job;
  if (!isRunnerKind(kind)) {
    await postResult(ctx, id, nonce, "failed", `refused unknown kind: ${kind}`);
    return;
  }
  const folderPath = jobId ? path.join(ctx.jobsDir, jobId) : null;
  const before = folderPath ? snapshotFolder(folderPath) : {};
  // SIM-535: a source-scoped discovery run gets a per-claim scratch dir; its
  // finds file becomes the result payload instead of artifacts.
  const sourceRun = kind === "discover-jobs-source" ? prepareSourceRunWorkdir(job) : null;
  const hb = setInterval(() => heartbeat(ctx, id), HEARTBEAT_MS);
  hb.unref?.();
  let code = 1;
  let spawnError = null;
  try {
    ({ code, spawnError } = await runClaudeLocally(ctx, kind, jobId, payload, (line) => {
      // progress is DATA only; best-effort, never blocks the run
      const t = String(line).trim();
      if (t) fetch(api(ctx.cloudUrl, `/api/runner/jobs/${encodeURIComponent(id)}/progress`), {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
        body: JSON.stringify({ lines: [t.slice(0, 500)] }),
      }).catch(() => {});
    }, sourceRun ? { trackedLinksFile: sourceRun.trackedLinksFile, findsFile: sourceRun.findsFile } : {}));
  } finally {
    clearInterval(hb);
  }
  // Post the generated, kind-bounded outputs (only for job-scoped kinds).
  // postedKinds/failures feed resolveRunOutcome below (SIM-613/615): a
  // required kind that is rejected, errors, or simply never appears must sink
  // the run's reported status - never a silent console.warn no one sees.
  const postedKinds = new Set();
  const failures = [];
  if (folderPath && code === 0) {
    for (const art of collectOutputs(kind, folderPath, before)) {
      try {
        const bytes = fs.readFileSync(path.join(folderPath, art.name));
        const v = validateArtifact(kind, { name: art.name, mime: art.mime }, bytes.length);
        if (!v.ok) {
          console.warn(`runner: skipping ${art.name}: ${v.reason}`);
          failures.push(`${art.name}: ${v.reason}`);
          continue;
        }
        const { status: st, reason } = await postArtifact(ctx, id, nonce, art.name, art.mime, bytes);
        console.log(`runner: posted ${art.name} (${art.mime}) -> ${st}`);
        if (st >= 200 && st < 300) {
          postedKinds.add(v.kind);
        } else {
          failures.push(`${art.name} (${v.kind}): rejected ${st}${reason ? ` - ${reason}` : ""}`);
        }
      } catch (e) {
        failures.push(`${art.name}: ${e.message}`);
        console.warn(`runner: failed to post ${art.name}: ${e.message}`);
      }
    }
  }
  // SIM-535: a successful source run posts its finds file as the result; a
  // missing/unparseable file posts result:null and the cloud records the run
  // as incomplete (honest - never a fake success over unseen finds).
  let result = null;
  if (sourceRun && code === 0) {
    result = collectSourceRunResult(sourceRun.findsFile);
    if (!result) console.warn(`runner: no readable finds file at ${sourceRun.findsFile}`);
  }
  const outcome = resolveRunOutcome(kind, code, spawnError, postedKinds, failures);
  await postResult(ctx, id, nonce, outcome.status, outcome.error, result);
  console.log(`runner: job ${id} (${kind}) finished code=${code} status=${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}`);
}

// ---- main loop -------------------------------------------------------------
async function main() {
  assertTlsNotBypassed(process.env); // MF-6: refuse a global TLS bypass
  const { token, cloudUrl } = loadSecrets();
  const pinned = assertOutboundUrl(cloudUrl); // MF-6: https only
  PINNED_HOST = pinned.hostname; // pin the cloud host for every subsequent call
  const cfg = loadConfig();
  const jobsDir = path.resolve(process.env.JOBHUNT_JOBS_DIR || cfg.jobsDir);
  const ctx = {
    token,
    cloudUrl,
    jobsDir,
    workspaceDir: path.dirname(jobsDir),
    claudeBin: resolveClaude(cfg),
    allowedTools: cfg.claudeAllowedTools || "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,Bash,Task,TodoWrite",
  };
  // SIM-543 boot validation: refuse to START rather than fail every claim the
  // same way. The repo config.json is the CONTAINER's (jobsDir /data/Jobs) -
  // on a laptop, JOBHUNT_JOBS_DIR (or config.local.json's jobsDir) is
  // REQUIRED to point at a real local directory; a bad claude binary path is
  // the same class. Every claim this process took would otherwise die
  // "spawn failed" with the queue half-drained.
  const bootProblems = validateRunnerBoot(ctx);
  if (bootProblems.length) {
    for (const p of bootProblems) console.error(`runner: BOOT REFUSED - ${p}`);
    process.exit(1);
  }
  console.log(`runner: workspace=${ctx.workspaceDir} jobsDir=${ctx.jobsDir} claude=${ctx.claudeBin}`);
  console.log(`runner: polling ${PINNED_HOST} (https, outbound-only). Ctrl-C to stop.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let job = null;
    try {
      job = await pollNext(ctx);
    } catch (e) {
      console.error(`runner: ${e.message}`);
      await new Promise((r) => setTimeout(r, POLL_IDLE_MS * 3));
      continue;
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
      continue;
    }
    console.log(`runner: claimed ${job.id} kind=${job.kind} job=${job.jobId || "(none)"}`);
    try {
      await processJob(ctx, job);
    } catch (e) {
      console.error(`runner: job ${job.id} errored: ${e.message}`);
      try {
        await postResult(ctx, job.id, job.nonce, "failed", e.message);
      } catch {
        /* ignore */
      }
    }
  }
}

// Only run the loop when invoked directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`runner: fatal: ${e.message}`);
    process.exit(1);
  });
}

export { collectOutputs, snapshotFolder, prepareSourceRunWorkdir, collectSourceRunResult };
