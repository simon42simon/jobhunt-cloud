// SIM-393 I5 - the LAPTOP-SIDE cloud->local EXPORT SNAPSHOT client (design
// section D; guardian conditions GC-1 (HIGH), GC-2, GC-6, GC-7).
//
// What it does: one outbound, READ-ONLY pull of the ENTIRE cloud dataset into
// the file layout the app already understands (the FileStore layout), so the
// SIM-64 restore drill is "boot a FileStore over the snapshot" or "re-run
// ops/migrate-data.mjs with the snapshot as source". Each run lands in a fresh
// append-only directory:
//
//   <base>\<UTC-yyyymmdd-HHMMSS>\
//     Jobs\<jobId>\<Role>.md          (reconstructed byte-faithfully: the exact
//                                      "---\n" + yaml.dump(front) + "---\n" + body
//                                      serialization createJobIfAbsent writes,
//                                      re-verified against the manifest rowSha)
//     Jobs\<jobId>\<companion files>  (bytes re-hashed against the manifest sha256)
//     tasks.yaml / requests.yaml / discovery-sources.yaml
//     activity-log.jsonl / usage-telemetry.jsonl
//     notify-state.json / job-chats.json
//     attachments\<taskId>\<file>
//     snapshot-manifest.json          (per-file sha256, counts, app version, timestamp)
//     VERIFIED                        (written ONLY after the verification pass)
//
// where <base> = %SSC_ROOT%\data\jobhunt\cloud-snapshots (SSC_ROOT derived the
// way the repo's other ops entry points do - the env the start-app/choose-channel
// chain carries; JOBHUNT_SNAPSHOT_DIR is the explicit override/test seam, and
// without either the base falls back to resolveDataDir(repo)/cloud-snapshots -
// the same data-zone answer choose-channel.cmd names explicitly). The zone's
// index.md/log.md carry the subfolder + writer disclosure (build-plan I5).
//
// GC-1 (HIGH, verbatim): every cloud-supplied name - job folder id, file name,
// attachment task id + file name, ANY id used in a path - is validated through
// the SHARED server/name-safety.js `isSafeName` AND contained through
// `resolveInside`-the-snapshot-root BEFORE any filesystem access. Cloud data is
// UNTRUSTED on this path (legacy rows, migration-era rows, the compromised-cloud
// case): under exactly the RR-1/RR-7 compromise, a poisoned name would otherwise
// turn the unattended export task into an arbitrary-write primitive on the
// trusted laptop. Server-side ingest validation does NOT satisfy this duty -
// the containment lives HERE, client-side, and the hostile-name fixture tests
// prove a refused name produces NO write of any kind.
//
// GC-6: outbound-only pinned-host posture, REUSED (not re-implemented) from the
// shared `ops/cloud-client.mjs` module's `createApi` - https-only, host pinned
// from the configured cloud URL, redirect-refusing fetch, TLS-bypass refusal
// re-asserted on every request. (That module's own error strings carry a
// "cloud-client:" prefix; cosmetic only.) This process opens NO listening
// socket (prove with ops/scripts/assert-rc-no-listener.ps1 while it runs).
// SIM-614 (2026-07-23): `createApi`/`acquireLock`/`reconstructJobFileText` used
// to live in ops/mirror-vault.mjs (the SIM-393 I6 cloud->vault mirror client,
// since retired outright); they were extracted to ops/cloud-client.mjs first so
// removing the mirror lane did not touch this still-live I5 export lane.
//
// VERIFIED semantics: the marker is written ONLY after the verification pass
// re-fetches the manifest + every domain and asserts an EXACT match against the
// bytes actually on disk (re-read + re-hashed), with ZERO refused names and
// ZERO integrity conflicts. A snapshot without VERIFIED is treated as garbage
// by the restore drill. Verification failing leaves everything written (this
// tool deletes nothing) - it just never earns the marker.
//
// GC-7 - PRUNE STAYS COLD: the snapshot pass contains no delete path; `--prune`
// is a separate, explicitly owner-invoked mode that REFUSES to run unless the
// owner has set `retention.keep` (a positive integer) in config(.local).json,
// always protects the newest VERIFIED snapshot (and the newest `keep` VERIFIED
// snapshots), never touches an UNVERIFIED snapshot, and is never wired into any
// scheduled task. Ship default: no retention key -> keep everything, the delete
// path is dead code with a test proving the refusal.
//
// GC-2: every run reports ONE structured activity line via POST
// /api/export/runs (best-effort - a failed report never undoes the run), so an
// export the owner did not schedule is visible in-app.
//
// Run:  node ops/export-snapshot.mjs           (one snapshot pass)
//       node ops/export-snapshot.mjs --prune   (owner-invoked retention, GC-7)
//
// Secrets: EXPORT_TOKEN env or ~/.ssc-secrets `exportToken`; cloud URL from
// EXPORT_CLOUD_URL env or ~/.ssc-secrets `exportCloudUrl`/`cloudUrl`. The cloud
// holds only the sha256 verify-hash. Log + lockfile live in %LOCALAPPDATA%\ssc\
// (outside the vault, outside OneDrive, outside every repo).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { isSafeName, resolveInside } from "../server/name-safety.js";
import { assertTlsNotBypassed } from "../server/runner-lib.js";
import { sha256Hex, rowShaOf } from "../server/sync-lib.js";
import { resolveDataDir } from "../server/lib.js";
// GC-6 posture + the lockfile + the byte-faithful <Role>.md serialization are
// shared with (never re-implemented for) other laptop ops clients.
import { createApi, acquireLock, reconstructJobFileText } from "./cloud-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPORT_CLIENT_VERSION = "export-snapshot/1";

// ---- non-snapshot artifact paths (log + lock, %LOCALAPPDATA%\ssc\ only) -----
export function exportPaths(env = process.env) {
  const base = path.join(
    env.LOCALAPPDATA && String(env.LOCALAPPDATA).trim()
      ? String(env.LOCALAPPDATA)
      : path.join(os.homedir(), "AppData", "Local"),
    "ssc",
  );
  return {
    dir: base,
    log: path.join(base, "jobhunt-export.log"),
    lock: path.join(base, "jobhunt-export.lock"),
  };
}

// ---- secrets / config (never committed, never in the snapshot) --------------
export function loadExportSecrets(env = process.env) {
  const file = path.join(os.homedir(), ".ssc-secrets");
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* env-only is fine */
  }
  const token = env.EXPORT_TOKEN || s.exportToken || "";
  const cloudUrl = env.EXPORT_CLOUD_URL || s.exportCloudUrl || s.cloudUrl || "";
  if (!token) throw new Error("export: no EXPORT_TOKEN (env or ~/.ssc-secrets.exportToken)");
  if (!cloudUrl) throw new Error("export: no cloud URL (EXPORT_CLOUD_URL env or ~/.ssc-secrets.exportCloudUrl/.cloudUrl)");
  return { token, cloudUrl };
}

function loadRepoConfig() {
  const localPath = path.join(ROOT, "config.local.json");
  const basePath = path.join(ROOT, "config.json");
  try {
    return JSON.parse(fs.readFileSync(fs.existsSync(localPath) ? localPath : basePath, "utf8"));
  } catch {
    return {};
  }
}

// ---- snapshot target directory ----------------------------------------------
// %SSC_ROOT%\data\jobhunt\cloud-snapshots, derived like the repo's other ops
// scripts derive the data zone: SSC_ROOT env (the start-app/choose-channel
// convention: JOBHUNT_DATA_DIR = %SSC_ROOT%\data\jobhunt), with
// JOBHUNT_SNAPSHOT_DIR as the explicit override/test seam and
// resolveDataDir(ROOT) (JOBHUNT_DATA_DIR env > config dataDir) as the
// production-identical fallback.
export function snapshotBaseDir(env = process.env) {
  if (env.JOBHUNT_SNAPSHOT_DIR && String(env.JOBHUNT_SNAPSHOT_DIR).trim()) {
    return path.resolve(String(env.JOBHUNT_SNAPSHOT_DIR));
  }
  if (env.SSC_ROOT && String(env.SSC_ROOT).trim()) {
    return path.join(path.resolve(String(env.SSC_ROOT)), "data", "jobhunt", "cloud-snapshots");
  }
  return path.join(resolveDataDir(ROOT), "cloud-snapshots");
}

export function utcStamp(d = new Date()) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15); // yyyymmdd-HHMMSS
}

// Create a FRESH, unique snapshot dir under base. Exclusive mkdir: a same-second
// second run derives "-2", "-3", ... instead of ever sharing (or reusing) a dir.
export function createSnapshotDir(base, now = new Date()) {
  fs.mkdirSync(base, { recursive: true });
  const stamp = utcStamp(now);
  for (let n = 1; n <= 100; n++) {
    const name = n === 1 ? stamp : `${stamp}-${n}`;
    const dir = path.join(base, name);
    try {
      fs.mkdirSync(dir); // non-recursive: throws EEXIST instead of adopting
      return dir;
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error("export: could not create a unique snapshot directory");
}

// ---- the ONE snapshot write path (GC-1) -------------------------------------
// EVERY byte this client puts in a snapshot flows through writeSnapshotEntry.
// `segments` are path components; any component that came from the cloud is
// untrusted and must pass the SHARED isSafeName rules; the assembled target is
// contained under the snapshot root via resolveInside BEFORE any fs access.
// A refusal throws BEFORE any stat/mkdir/write - no partial path is created.
export function writeSnapshotEntry({ root, segments, bytes, manifestFiles = null }) {
  if (!Array.isArray(segments) || segments.length === 0) throw refusal("empty path");
  for (const seg of segments) {
    if (!isSafeName(seg)) throw refusal(`unsafe path component`);
  }
  const target = resolveInside(root, ...segments); // throws PATH_ESCAPE on any escape
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // "wx"-exclusive: the dir is fresh, so a collision means a manifest
  // double-name (e.g. case-aliasing on NTFS) - refuse rather than clobber.
  const fd = fs.openSync(target, "wx");
  try {
    fs.writeFileSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  const rel = segments.join("/");
  const sha = sha256Hex(buf);
  if (manifestFiles) manifestFiles[rel] = sha;
  return { rel, sha, bytes: buf.length };
}

function refusal(message) {
  const e = new Error(`export: refused: ${message}`);
  e.code = "EXPORT_REFUSED";
  return e;
}

const countLines = (text) => String(text || "").split(/\r?\n/).filter((l) => l.trim()).length;

// ---- one export pass --------------------------------------------------------
// Pull everything -> write the snapshot -> verify by RE-FETCHING and comparing
// against the bytes actually on disk -> only then write VERIFIED. Returns the
// summary. Never deletes anything, on any path, ever.
export async function runExportSnapshot({ api, snapshotRoot, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const summary = { jobs: 0, files: 0, attachments: 0, bytes: 0, refused: 0, conflicts: [], verified: false };
  const manifestFiles = {}; // relpath -> sha256 of the bytes WE wrote

  const meta = await api.getJson("/api/export/meta");
  const manifest = await api.getJson("/api/export/manifest");
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const jobFileRel = {}; // jobId -> the snapshot relpath of its written <Role>.md

  const write = (segments, bytes) => {
    const r = writeSnapshotEntry({ root: snapshotRoot, segments, bytes, manifestFiles });
    summary.bytes += r.bytes;
    return r;
  };

  // -- jobs domain: <Role>.md reconstruction, rowSha-verified BEFORE write ----
  for (const j of jobs) {
    const id = String(j.id ?? "");
    if (!isSafeName(id)) {
      summary.refused += 1;
      log("refused job id (unsafe name withheld)");
      continue;
    }
    let detail;
    try {
      detail = await api.getJson(`/api/export/jobs/${encodeURIComponent(id)}`);
    } catch (e) {
      summary.conflicts.push(`job-detail-failed ${id}`);
      continue;
    }
    const name = String(detail && detail.name ? detail.name : "");
    const front = detail && detail.front && typeof detail.front === "object" ? detail.front : {};
    const body = detail && detail.body != null ? String(detail.body) : "";
    if (!isSafeName(name)) {
      summary.refused += 1;
      log(`refused job-file name under ${id}`);
      continue;
    }
    // Integrity: the reconstruction must hash to the manifest rowSha it was
    // selected by - never write off unverified data.
    if (rowShaOf(front, body) !== j.rowSha) {
      summary.conflicts.push(`row-sha-mismatch ${id}`);
      continue;
    }
    try {
      write(["Jobs", id, name], Buffer.from(reconstructJobFileText(front, body), "utf8"));
      jobFileRel[id] = `Jobs/${id}/${name}`;
      summary.jobs += 1;
    } catch (e) {
      summary.refused += 1;
      log(`refused write for job ${id}: ${e.message}`);
    }
  }

  // -- companion files: bytes re-hashed against the manifest sha256 -----------
  for (const f of files) {
    const jobId = String(f.jobId ?? "");
    const name = String(f.name ?? "");
    if (!isSafeName(jobId) || !isSafeName(name)) {
      summary.refused += 1;
      log("refused file (unsafe name withheld)");
      continue;
    }
    let bytes;
    try {
      bytes = await api.getBytes(`/api/export/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`);
    } catch (e) {
      summary.conflicts.push(`file-pull-failed ${jobId}/${name}`);
      continue;
    }
    const wantSha = typeof f.sha256 === "string" ? f.sha256.toLowerCase() : "";
    if (wantSha && sha256Hex(bytes) !== wantSha) {
      summary.conflicts.push(`file-sha-mismatch ${jobId}/${name}`);
      continue;
    }
    try {
      write(["Jobs", jobId, name], bytes);
      summary.files += 1;
    } catch (e) {
      summary.refused += 1;
      log(`refused write for file under ${jobId}: ${e.message}`);
    }
  }

  // -- every other domain (cloud-canonical, snapshot-only replicas) -----------
  const tasks = await api.getJson("/api/export/tasks");
  write(["tasks.yaml"], yaml.dump(tasks));
  const requests = await api.getJson("/api/export/requests");
  write(["requests.yaml"], yaml.dump(requests));
  const sources = await api.getJson("/api/export/sources");
  write(["discovery-sources.yaml"], yaml.dump(sources));
  const chats = await api.getJson("/api/export/chats");
  write(["job-chats.json"], JSON.stringify(chats, null, 2));
  const notifyState = await api.getJson("/api/export/notify-state");
  write(["notify-state.json"], JSON.stringify(notifyState, null, 2));
  const activityText = await api.getText("/api/export/activity");
  write(["activity-log.jsonl"], activityText);
  const telemetryText = await api.getText("/api/export/telemetry");
  write(["usage-telemetry.jsonl"], telemetryText);

  // -- task-attachment blobs (task id + file name are cloud-supplied: GC-1) ---
  for (const t of Array.isArray(tasks.tasks) ? tasks.tasks : []) {
    const taskId = String(t && t.id ? t.id : "");
    for (const a of Array.isArray(t && t.attachments) ? t.attachments : []) {
      const file = String(a && a.file ? a.file : "");
      if (!isSafeName(taskId) || !isSafeName(file)) {
        summary.refused += 1;
        log("refused attachment (unsafe name withheld)");
        continue;
      }
      let bytes;
      try {
        bytes = await api.getBytes(`/api/export/attachments/${encodeURIComponent(taskId)}/${encodeURIComponent(file)}`);
      } catch (e) {
        summary.conflicts.push(`attachment-pull-failed ${taskId}/${file}`);
        continue;
      }
      try {
        write(["attachments", taskId, file], bytes);
        summary.attachments += 1;
      } catch (e) {
        summary.refused += 1;
        log(`refused write for attachment under ${taskId}: ${e.message}`);
      }
    }
  }

  // -- snapshot manifest (always written; VERIFIED is the quality gate) -------
  const counts = {
    jobs: summary.jobs,
    files: summary.files,
    attachments: summary.attachments,
    tasks: Array.isArray(tasks.tasks) ? tasks.tasks.length : 0,
    requests: Array.isArray(requests.requests) ? requests.requests.length : 0,
    sources: Array.isArray(sources.sources) ? sources.sources.length : 0,
    chats: chats && typeof chats === "object" ? Object.keys(chats).length : 0,
    activityLines: countLines(activityText),
    telemetryLines: countLines(telemetryText),
  };
  const snapshotManifest = {
    clientVersion: EXPORT_CLIENT_VERSION,
    startedAt,
    app: meta,
    counts,
    refused: summary.refused,
    conflicts: summary.conflicts,
    files: manifestFiles,
  };
  write(["snapshot-manifest.json"], JSON.stringify(snapshotManifest, null, 2));

  // -- verification pass (design D): re-fetch + exact-match, then VERIFIED ----
  const verifyErrors = [];
  if (summary.refused > 0) verifyErrors.push(`refused=${summary.refused} (snapshot is incomplete)`);
  if (summary.conflicts.length > 0) verifyErrors.push(`conflicts=${summary.conflicts.length}`);

  // (a) disk integrity: every recorded file re-reads to its recorded sha256.
  for (const [rel, sha] of Object.entries(manifestFiles)) {
    const abs = resolveInside(snapshotRoot, ...rel.split("/"));
    let onDisk;
    try {
      onDisk = fs.readFileSync(abs);
    } catch {
      verifyErrors.push(`missing ${rel}`);
      continue;
    }
    if (sha256Hex(onDisk) !== sha) verifyErrors.push(`disk-sha-mismatch ${rel}`);
  }

  // (b) jobs domain: the manifest, RE-FETCHED, must exactly match what landed.
  try {
    const m2 = await api.getJson("/api/export/manifest");
    const jobs2 = Array.isArray(m2.jobs) ? m2.jobs : [];
    const files2 = Array.isArray(m2.files) ? m2.files : [];
    if (jobs2.length !== jobs.length || files2.length !== files.length) {
      verifyErrors.push("manifest drifted during the pull (job/file counts changed)");
    }
    for (const j of jobs2) {
      const id = String(j.id ?? "");
      if (!isSafeName(id)) {
        verifyErrors.push("manifest carries an unsafe job id");
        continue;
      }
      const written = jobFileRel[id];
      if (!written) {
        verifyErrors.push(`job not in snapshot: ${id}`);
        continue;
      }
      const abs = resolveInside(snapshotRoot, ...written.split("/"));
      const detail2 = await api.getJson(`/api/export/jobs/${encodeURIComponent(id)}`);
      const expect = Buffer.from(
        reconstructJobFileText(detail2 && detail2.front ? detail2.front : {}, detail2 && detail2.body != null ? String(detail2.body) : ""),
        "utf8",
      );
      if (rowShaOf(detail2 && detail2.front ? detail2.front : {}, detail2 && detail2.body != null ? String(detail2.body) : "") !== j.rowSha) {
        verifyErrors.push(`re-fetch rowSha mismatch: ${id}`);
      } else if (!fs.readFileSync(abs).equals(expect)) {
        verifyErrors.push(`job bytes differ on disk: ${id}`);
      }
    }
    for (const f of files2) {
      const jobId = String(f.jobId ?? "");
      const name = String(f.name ?? "");
      if (!isSafeName(jobId) || !isSafeName(name)) {
        verifyErrors.push("manifest carries an unsafe file name");
        continue;
      }
      const rel = `Jobs/${jobId}/${name}`;
      const wantSha = typeof f.sha256 === "string" ? f.sha256.toLowerCase() : "";
      if (!manifestFiles[rel]) verifyErrors.push(`file not in snapshot: ${rel}`);
      else if (wantSha && manifestFiles[rel] !== wantSha) verifyErrors.push(`file sha drifted: ${rel}`);
    }
  } catch (e) {
    verifyErrors.push(`manifest re-fetch failed: ${e.message}`);
  }

  // (c) non-jobs domains: re-fetch and compare against the disk bytes.
  const domainChecks = [
    ["tasks.yaml", async () => yaml.dump(await api.getJson("/api/export/tasks"))],
    ["requests.yaml", async () => yaml.dump(await api.getJson("/api/export/requests"))],
    ["discovery-sources.yaml", async () => yaml.dump(await api.getJson("/api/export/sources"))],
    ["job-chats.json", async () => JSON.stringify(await api.getJson("/api/export/chats"), null, 2)],
    ["notify-state.json", async () => JSON.stringify(await api.getJson("/api/export/notify-state"), null, 2)],
    ["activity-log.jsonl", async () => api.getText("/api/export/activity")],
    ["usage-telemetry.jsonl", async () => api.getText("/api/export/telemetry")],
  ];
  for (const [rel, fetch2] of domainChecks) {
    try {
      const again = Buffer.from(await fetch2(), "utf8");
      const abs = resolveInside(snapshotRoot, rel);
      if (!fs.readFileSync(abs).equals(again)) verifyErrors.push(`domain drifted during the pull: ${rel}`);
    } catch (e) {
      verifyErrors.push(`domain re-fetch failed: ${rel}`);
    }
  }

  if (verifyErrors.length === 0) {
    // The marker is the LAST byte written, and only on a perfect pass.
    write(["VERIFIED"], JSON.stringify({ verifiedAt: new Date().toISOString(), counts }, null, 2));
    summary.verified = true;
  } else {
    for (const v of verifyErrors.slice(0, 20)) log(`verify: ${v}`);
    log(`verification FAILED (${verifyErrors.length} problem(s)) - NO VERIFIED marker written`);
  }

  const finishedAt = new Date().toISOString();
  // GC-2: one structured activity line per run, owner-visible in-app.
  // Best-effort: a failed report never undoes the snapshot.
  try {
    await api.postJson("/api/export/runs", {
      startedAt,
      finishedAt,
      snapshot: path.basename(snapshotRoot),
      jobs: summary.jobs,
      files: summary.files,
      bytes: summary.bytes,
      refused: summary.refused,
      verified: summary.verified,
      conflicts: summary.conflicts,
      clientVersion: EXPORT_CLIENT_VERSION,
    });
  } catch (e) {
    log(`export-runs report failed: ${e.message}`);
  }
  log(
    `snapshot ${summary.verified ? "VERIFIED" : "UNVERIFIED"}: jobs=${summary.jobs} files=${summary.files} ` +
      `attachments=${summary.attachments} bytes=${summary.bytes} refused=${summary.refused} conflicts=${summary.conflicts.length}`,
  );
  return summary;
}

// ---- GC-7: owner-invoked prune (COLD by default, never scheduled) -----------
// Refuses outright unless the OWNER has set `retention.keep` (integer >= 1) in
// config(.local).json. Deletes only VERIFIED snapshots beyond the newest
// `keep`; the newest VERIFIED snapshot is always protected (it is the first
// member of the kept set); UNVERIFIED snapshots are never auto-deleted (they
// are surfaced for manual attention instead). This function is reachable ONLY
// via the explicit `--prune` argv - nothing schedules it.
export function runPrune({ baseDir, config, log = () => {} }) {
  const keep = config && config.retention ? config.retention.keep : undefined;
  if (!Number.isInteger(keep) || keep < 1) {
    const e = new Error(
      "export: --prune REFUSED: retention.keep is not set. Pruning only runs after the owner sets " +
        '{"retention":{"keep":<n>}} in config.local.json (H1, decision-log-recorded). Ship default: keep everything.',
    );
    e.code = "PRUNE_REFUSED";
    throw e;
  }
  let entries = [];
  try {
    entries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse(); // UTC stamps sort lexicographically: newest first
  } catch {
    return { kept: [], deleted: [], unverified: [] };
  }
  const verified = entries.filter((name) => fs.existsSync(path.join(baseDir, name, "VERIFIED")));
  const unverified = entries.filter((name) => !verified.includes(name));
  const kept = verified.slice(0, keep); // newest `keep` VERIFIED - always includes the newest
  const deletable = verified.slice(keep);
  const deleted = [];
  for (const name of deletable) {
    fs.rmSync(path.join(baseDir, name), { recursive: true, force: true });
    deleted.push(name);
    log(`pruned ${name}`);
  }
  if (unverified.length) log(`left ${unverified.length} UNVERIFIED snapshot(s) untouched (manual attention)`);
  return { kept, deleted, unverified };
}

// ---- entry point ------------------------------------------------------------
function makeLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (line) => {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(`export: ${line}`);
    try {
      fs.appendFileSync(logPath, msg + "\n");
    } catch {
      /* logging must never break the pass */
    }
  };
}

// The shared createApi has no text reader; wrap it with one (same call posture).
export function createExportApi({ token, cloudUrl, fetchImpl = fetch, env = process.env }) {
  const api = createApi({ token, cloudUrl, fetchImpl, env });
  if (!api.getText) {
    api.getText = async (p) => (await api.getBytes(p)).toString("utf8");
  }
  return api;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const paths = exportPaths();
  const log = makeLogger(paths.log);
  assertTlsNotBypassed(process.env); // GC-6, again at entry
  const base = snapshotBaseDir(process.env);

  if (args.has("--prune")) {
    const r = runPrune({ baseDir: base, config: loadRepoConfig(), log });
    log(`prune done: kept=${r.kept.length} deleted=${r.deleted.length} unverified=${r.unverified.length}`);
    return;
  }

  const { token, cloudUrl } = loadExportSecrets();
  const api = createExportApi({ token, cloudUrl });
  const lock = acquireLock(paths.lock);
  if (!lock.ok) {
    log("another export instance holds the lock; exiting 0");
    return;
  }
  process.on("exit", () => lock.release());
  const snapshotRoot = createSnapshotDir(base);
  log(`exporting ${api.host} -> ${snapshotRoot} (outbound-only, read-only, no-delete)`);
  const summary = await runExportSnapshot({ api, snapshotRoot, log });
  if (!summary.verified) process.exitCode = 1; // an unverified snapshot is a failed run
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`export: fatal: ${e.message}`);
    process.exit(1);
  });
}
