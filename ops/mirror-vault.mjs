// SIM-393 I6 - the LAPTOP-SIDE cloud->vault MIRROR client (Owner amendment v2,
// V2-3; guardian delta review 2026-07-18, GC-8..GC-13).
//
// The vault Jobs tree is, by dated owner decision, a PASSIVE one-way replica of
// the cloud (cloud PG is canonical for everything). This client is the vault Jobs
// tree's ONLY writer going forward. It holds one standing OUTBOUND long-poll to
// the private instance (GET /api/mirror/changes - triggers only, never names or
// paths), debounces events (>= 5s) into a mirror pass, and runs an hourly
// full-manifest safety-net sweep so a dropped event can never strand a file.
//
// THE WRITE SEMANTICS ARE THE WHOLE POINT (V2-3, all binding):
//   - THREE-WAY SHA CHECK: an existing vault file is only ever overwritten when
//     its CURRENT bytes' sha256 equals the sha this client LAST WROTE for that
//     path (the mirror-state manifest). The mirror only overwrites bytes it
//     itself placed; anything else SKIPS and reports loudly. Out-of-band vault
//     edits are never clobbered - not even work that should not exist.
//   - NO DELETE PATH. There is no unlink/rm/rmdir call anywhere in this module,
//     by construction (proven by tests/mirror-client.test.js at grep level AND
//     behaviorally). A file absent from the cloud manifest is simply left alone:
//     absence is not a delete instruction. Stale mirror copies accumulate; that
//     is the accepted, disclosed cost of never-deletes.
//   - ADOPTION PASS (first run / lost cache): a pre-existing vault file whose
//     sha256 matches the cloud copy is adopted as already-mirrored (recorded, no
//     write). Differing bytes surface in a one-time transition report and are
//     left untouched. Losing %LOCALAPPDATA%\ssc\jobhunt-mirror-state.json (a
//     derived cache, never SoT) degrades EXACTLY to these adoption semantics -
//     never to write-through (GC-8).
//   - EXCLUSIVE CREATES + CASE-COLLISION SAFETY (GC-8): creates open with the
//     "wx" flag (fail-if-exists); a pre-existing file or folder at the target
//     under CASE-INSENSITIVE comparison (NTFS/OneDrive semantics) routes through
//     the adoption/skip-report path, never a plain write - two cloud names
//     differing only in case can never clobber one another.
//   - GC-1 VERBATIM: every cloud-supplied name (job id, file name) passes the
//     SHARED server/name-safety.js `isSafeName` + `resolveInside`-the-Jobs-root
//     containment BEFORE any filesystem access. Cloud data is untrusted on this
//     path; server-side ingest validation does not satisfy this client-side duty.
//   - Atomic writes: updates stage a sibling temp file + rename inside the job
//     folder; creates are "wx"-exclusive.
//   - GC-12(b): the mirror writes bytes VERBATIM and never renders, executes,
//     opens, or launches anything it writes. Bytes in, bytes on disk, nothing
//     else.
//
// OUTBOUND-ONLY POSTURE (GC-6, verbatim from the runner/I2 lane): https only,
// host pinned from the configured cloud URL, redirect-refusing fetch, TLS-bypass
// refusal - re-asserted on EVERY request, so the posture holds across reconnects.
// This process opens NO listening socket (prove with
// ops/scripts/assert-rc-no-listener.ps1 while it runs).
//
// GC-13 - NO MIRROR ARTIFACT IN THE VAULT OR ANY SYNCED STORE: the token lives in
// ~/.ssc-secrets (env override), and the state cache, log, and lockfile live in
// %LOCALAPPDATA%\ssc\ ONLY (centralized in mirrorPaths() below - the single place
// these paths are built). The mirror writes NOTHING into the vault except the
// mirrored Jobs-tree bytes themselves.
//
// Run:  node ops/mirror-vault.mjs            (standing long-poll mode)
//       node ops/mirror-vault.mjs --poll     (fallback: 15s manifest polling)
//       node ops/mirror-vault.mjs --once     (one attended mirror pass, then exit)
//
// ACTIVATION IS GATED: this client does nothing until MIRROR_TOKEN provisioning
// GO + the I6 landing-time guardian check + the GC-11 decision-log record (see
// V2-4's activation gate). Building it does not activate it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { isSafeName, resolveInside } from "../server/name-safety.js";
import { assertOutboundUrl, assertTlsNotBypassed } from "../server/runner-lib.js";
import { sha256Hex, rowShaOf } from "../server/sync-lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MIRROR_CLIENT_VERSION = "mirror-vault/1";
export const DEBOUNCE_MS = 5_000; // >= 5s batch window (V2-3)
export const DEBOUNCE_MAX_WAIT_MS = 30_000; // a busy stream still flushes
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly safety net
export const FALLBACK_POLL_MS = 15_000; // manifest-poll fallback cadence
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// ---- GC-13: THE single place every non-vault artifact path is built ---------
// State, log, and lock live in %LOCALAPPDATA%\ssc\ - outside the vault, outside
// OneDrive, outside every repo. Nothing below ever constructs a state/log/lock
// path anywhere else.
export function mirrorPaths(env = process.env) {
  const base = path.join(
    env.LOCALAPPDATA && String(env.LOCALAPPDATA).trim()
      ? String(env.LOCALAPPDATA)
      : path.join(os.homedir(), "AppData", "Local"),
    "ssc",
  );
  return {
    dir: base,
    state: path.join(base, "jobhunt-mirror-state.json"),
    log: path.join(base, "jobhunt-mirror.log"),
    lock: path.join(base, "jobhunt-mirror.lock"),
  };
}

// ---- secrets / config (never committed, never in the vault) -----------------
export function loadMirrorSecrets(env = process.env) {
  const file = path.join(os.homedir(), ".ssc-secrets");
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* env-only is fine */
  }
  const token = env.MIRROR_TOKEN || s.mirrorToken || "";
  const cloudUrl = env.MIRROR_CLOUD_URL || s.mirrorCloudUrl || s.cloudUrl || "";
  if (!token) throw new Error("mirror: no MIRROR_TOKEN (env or ~/.ssc-secrets.mirrorToken)");
  if (!cloudUrl) throw new Error("mirror: no cloud URL (MIRROR_CLOUD_URL env or ~/.ssc-secrets.mirrorCloudUrl/.cloudUrl)");
  if (/onedrive/i.test(file)) console.warn("mirror: WARNING ~/.ssc-secrets appears to be in a synced path");
  return { token, cloudUrl };
}

function loadRepoConfig() {
  const localPath = path.join(ROOT, "config.local.json");
  const basePath = path.join(ROOT, "config.json");
  return JSON.parse(fs.readFileSync(fs.existsSync(localPath) ? localPath : basePath, "utf8"));
}

// ---- pinned-host, redirect-refusing outbound API (GC-6) ---------------------
// Every call re-asserts the URL + TLS posture, so a reconnect after an outage
// gets the identical checks the first connection got.
export function createApi({ token, cloudUrl, fetchImpl = fetch, env = process.env }) {
  assertTlsNotBypassed(env);
  const pinned = assertOutboundUrl(cloudUrl); // https-only, parsed once for the pin
  const call = async (pathPart, init = {}) => {
    assertTlsNotBypassed(env); // GC-6 holds across reconnects
    const u = assertOutboundUrl(new URL(pathPart, cloudUrl).toString(), { requireHost: pinned.hostname });
    const res = await fetchImpl(u.toString(), {
      ...init,
      redirect: "manual", // NEVER follow a redirect off the pinned host
      headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`mirror: refused redirect (${res.status}) from ${pinned.hostname}`);
    }
    return res;
  };
  return {
    host: pinned.hostname,
    async getJson(p) {
      const r = await call(p);
      if (!r.ok) throw new Error(`mirror: GET ${p} -> ${r.status}`);
      return r.json();
    },
    async getBytes(p) {
      const r = await call(p);
      if (!r.ok) throw new Error(`mirror: GET ${p} -> ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async postJson(p, body) {
      const r = await call(p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`mirror: POST ${p} -> ${r.status}`);
      return r.json();
    },
    // The standing trigger channel. The server holds ~25s; a jobs-changed
    // broadcast answers early. Frames are triggers ONLY - the pass acts solely
    // on manifest/API responses (GC-10), never on anything in this frame.
    async longPoll(since) {
      return this.getJson(`/api/mirror/changes?since=${encodeURIComponent(String(since))}`);
    },
  };
}

// ---- <Role>.md reconstruction (byte-faithful) -------------------------------
// EXACTLY the serialization FileStore.createJobIfAbsent writes for a sync-inserted
// job: "---\n" + yaml.dump(front) + "---\n" + body. Round-trips through the
// app's parseFrontmatter with front/body identical, so rowShaOf(front, body) of
// the re-read file equals the manifest rowSha (proven in tests).
export function reconstructJobFileText(front, body) {
  return "---\n" + yaml.dump(front || {}) + "---\n" + (body == null ? "" : String(body));
}

// ---- mirror-state manifest (a DERIVED cache, never SoT) ---------------------
// entries:   "<jobId>/<name>" -> sha256 this client last WROTE (or adopted) there
// reported:  "<jobId>/<name>" -> vault sha already surfaced in a transition
//            report (so the loud line is one-time; the skip itself continues)
// rows:      "<jobId>" -> { rowSha, name } of the last mirrored job file
// vaultHash: "<jobId>/<name>" -> { size, mtimeMs, sha } local hash cache so a
//            steady-state sweep re-hashes (and re-hydrates) nothing
// Corrupt or missing -> a fresh empty state: the pass degrades to ADOPTION
// semantics (sha-equal adopt, differing report), NEVER write-through (GC-8).
export function loadMirrorState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("bad state");
    return {
      version: 1,
      entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {},
      reported: raw.reported && typeof raw.reported === "object" ? raw.reported : {},
      rows: raw.rows && typeof raw.rows === "object" ? raw.rows : {},
      vaultHash: raw.vaultHash && typeof raw.vaultHash === "object" ? raw.vaultHash : {},
    };
  } catch {
    return { version: 1, entries: {}, reported: {}, rows: {}, vaultHash: {} };
  }
}

export function saveMirrorState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomic; the tmp NAME disappears via rename, not unlink
}

// ---- owner dismissal of transition-report divergences (V2-3 resolution) ------
// The transition report lists vault paths whose bytes differ from cloud and were
// NOT written by this mirror (pre-cutover copies, agent work, hand edits). The
// owner resolves each one of two ways: import-as-copy (push the vault bytes up as
// a dated sibling via the sync client - preserve them) OR DISMISSAL (accept the
// vault copy as superseded and let cloud truth flow down). Dismissal writes
// NOTHING to the vault: it records each reported path's CURRENT vault sha as the
// mirror's last-written sha, so the next pass's three-way check (state.entries[key]
// === currentSha) treats those bytes as mirror-owned and performs the ONE
// sanctioned overwrite with cloud bytes - through the same reviewed write path,
// with the same activity-log line. GC-1 still applies here: an unsafe stored key
// is refused, never resolved. A reported path missing from disk is left reported.
// Re-reading the current bytes (not trusting the stale reported sha) keeps the
// safe direction: if the vault drifted since the report, we mark the true sha.
export function dismissReported(state, jobsRoot, { only = null } = {}) {
  const result = { dismissed: [], missing: [], unsafe: [] };
  for (const key of Object.keys(state.reported)) {
    if (only && !only.has(key)) continue;
    const slash = key.indexOf("/");
    const jobId = slash === -1 ? key : key.slice(0, slash);
    const name = slash === -1 ? "" : key.slice(slash + 1);
    if (!isSafeName(jobId) || !isSafeName(name)) {
      result.unsafe.push(key);
      continue;
    }
    let target;
    try {
      target = resolveInside(resolveInside(jobsRoot, jobId), name);
    } catch {
      result.unsafe.push(key);
      continue;
    }
    let currentSha;
    try {
      currentSha = sha256Hex(fs.readFileSync(target));
    } catch {
      result.missing.push(key); // gone from disk since the report - leave it reported
      continue;
    }
    state.entries[key] = currentSha; // now mirror-managed at its true current bytes
    delete state.reported[key];
    result.dismissed.push(key);
  }
  return result;
}

// ---- case-insensitive collision primitives (GC-8) ---------------------------
// Directory entries that alias `name` under case-insensitive (NTFS/OneDrive)
// comparison. A missing/unreadable dir is simply "no siblings".
export function caseSiblings(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const lower = String(name).toLowerCase();
  return entries.filter((e) => e.toLowerCase() === lower);
}

// Lowercased keys that appear under MORE THAN ONE distinct spelling in the
// manifest itself (two cloud names differing only in case = one NTFS path).
export function findCaseCollisions(names) {
  const spellings = new Map(); // lower -> Set of exact spellings
  for (const n of names) {
    const k = String(n).toLowerCase();
    if (!spellings.has(k)) spellings.set(k, new Set());
    spellings.get(k).add(String(n));
  }
  const out = new Set();
  for (const [k, set] of spellings) if (set.size > 1) out.add(k);
  return out;
}

// ---- the one vault write path -----------------------------------------------
// EVERY byte this client ever puts in the vault flows through writeMirrorEntry.
// Returns the action taken; mutates `state` and `summary`; never throws for a
// refused/skipped item (the pass continues; the item is reported).
//   "created" | "updated" | "adopted" | "refused-name" |
//   "skipped-case-collision" | "skipped-divergent" | "skipped-unreadable"
export function writeMirrorEntry({ jobsRoot, jobId, name, bytes, state, summary, report = () => {} }) {
  const key = `${jobId}/${name}`;
  // GC-1 VERBATIM: shared validator + containment BEFORE any fs access. A hostile
  // cloud-supplied name is refused outright - no write, no stat, no mkdir.
  if (!isSafeName(jobId) || !isSafeName(name)) {
    summary.refused += 1;
    report("refused-name", { jobId, name: "(unsafe name withheld)" });
    return "refused-name";
  }
  let folder;
  let target;
  try {
    folder = resolveInside(jobsRoot, jobId);
    target = resolveInside(folder, name);
  } catch {
    summary.refused += 1;
    report("refused-containment", { jobId, name });
    return "refused-name";
  }

  // GC-8 folder half: a folder that exists only under a DIFFERENT casing is the
  // same NTFS directory - route through skip-report, never write into it.
  const folderSiblings = caseSiblings(jobsRoot, jobId);
  if (folderSiblings.length && !folderSiblings.includes(jobId)) {
    summary.skipped += 1;
    summary.conflicts.push(`case-collision folder ${jobId}`);
    report("skipped-case-collision", { jobId, name });
    return "skipped-case-collision";
  }

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const newSha = sha256Hex(buf);
  const fileSiblings = folderSiblings.length ? caseSiblings(folder, name) : [];
  const exact = fileSiblings.includes(name);

  // GC-8 file half: an alias under a different casing is the same NTFS file.
  if (fileSiblings.length && !exact) {
    summary.skipped += 1;
    summary.conflicts.push(`case-collision file ${key}`);
    report("skipped-case-collision", { jobId, name });
    return "skipped-case-collision";
  }

  if (exact) {
    let currentSha;
    try {
      currentSha = sha256Hex(fs.readFileSync(target));
    } catch {
      summary.skipped += 1;
      summary.conflicts.push(`unreadable ${key}`);
      report("skipped-unreadable", { jobId, name });
      return "skipped-unreadable";
    }
    if (currentSha === newSha) {
      // Adoption / idempotent no-op: the vault already holds the cloud bytes.
      state.entries[key] = newSha;
      recordVaultHash(state, key, target, newSha);
      summary.adopted += 1;
      return "adopted";
    }
    if (state.entries[key] && state.entries[key] === currentSha) {
      // THREE-WAY SHA CHECK PASSED: the current bytes are the bytes this client
      // itself wrote - the one sanctioned overwrite (the recorded owner
      // exception). Atomic temp+rename inside the job folder. A refused stage
      // (stale tmp from a crashed pass, case-alias) skips loudly - no delete
      // path exists to clean it, so the owner resolves it (L1, I7 hardening).
      try {
        atomicReplace(target, buf);
      } catch (e) {
        summary.skipped += 1;
        summary.conflicts.push(`update-refused ${key} (${e.code || "error"})`);
        report("skipped-update-refused", { jobId, name, code: e.code || null });
        return "skipped-update-refused";
      }
      state.entries[key] = newSha;
      recordVaultHash(state, key, target, newSha);
      summary.updated += 1;
      return "updated";
    }
    // Divergent bytes this client did not write (out-of-band vault edit, lost
    // cache, or pre-existing agent work): SKIP + loud one-time transition report.
    // NEVER write-through (GC-8 degradation rule).
    summary.skipped += 1;
    const alreadyReported = state.reported[key] === currentSha;
    if (!alreadyReported) {
      state.reported[key] = currentSha;
      summary.conflicts.push(`divergent ${key} vault=${currentSha.slice(0, 12)} cloud=${newSha.slice(0, 12)}`);
    }
    report("skipped-divergent", { jobId, name, vaultSha: currentSha, cloudSha: newSha, alreadyReported });
    return "skipped-divergent";
  }

  // CREATE: exclusive, "wx"-style (GC-8). mkdir is create-only-additive; the
  // open fails if anything appeared at the exact path since the sibling scan
  // (the EEXIST race routes back through the skip path on the next pass).
  try {
    fs.mkdirSync(folder, { recursive: true });
    const fd = fs.openSync(target, "wx");
    try {
      fs.writeFileSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    summary.skipped += 1;
    summary.conflicts.push(`create-refused ${key} (${e.code || "error"})`);
    report("skipped-create-refused", { jobId, name, code: e.code || null });
    return "skipped-case-collision";
  }
  state.entries[key] = newSha;
  recordVaultHash(state, key, target, newSha);
  summary.created += 1;
  return "created";
}

// Atomic update: stage a sibling temp file inside the SAME job folder (V2-3
// sanctions the temp+rename idiom there), then rename over the target. rename is
// the replace primitive - no unlink exists on this path (or anywhere here).
function atomicReplace(target, buf) {
  const tmp = `${target}.mirror-tmp`;
  // "wx"-exclusive stage (L1): a pre-existing tmp file refuses the update
  // instead of being clobbered; the caller routes EEXIST to skip-report.
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function recordVaultHash(state, key, target, sha) {
  try {
    const st = fs.statSync(target);
    state.vaultHash[key] = { size: st.size, mtimeMs: st.mtimeMs, sha };
  } catch {
    delete state.vaultHash[key];
  }
}

// True when the local hash cache proves the vault file already holds `sha`
// without re-reading (and thus re-hydrating) the bytes. Any doubt -> false.
function vaultHashFresh(state, key, target, sha) {
  const h = state.vaultHash[key];
  if (!h || h.sha !== sha) return false;
  try {
    const st = fs.statSync(target);
    return st.size === h.size && st.mtimeMs === h.mtimeMs;
  } catch {
    return false;
  }
}

// ---- one mirror pass --------------------------------------------------------
// manifest diff -> pull changed bytes (guarded reader + raw job detail) ->
// writeMirrorEntry for every changed item -> persist state -> report the pass
// (one structured activity line via POST /api/mirror/runs) when it WROTE or hit
// anything worth surfacing (GC-2). Integrity: every pulled byte-set is re-hashed
// and must match the manifest hash it was selected by; a mismatch (mid-pass
// cloud change, or tamper) SKIPS - the next pass runs off a fresh manifest.
export async function runMirrorPass({ api, jobsRoot, statePath, trigger = "manual", log = () => {} }) {
  const startedAt = new Date().toISOString();
  const state = loadMirrorState(statePath);
  const summary = { created: 0, updated: 0, adopted: 0, skipped: 0, refused: 0, conflicts: [] };
  const report = (action, detail) => log(`${action} ${detail && detail.jobId ? `${detail.jobId}/${detail.name}` : ""}`.trim());

  const manifest = await api.getJson("/api/sync/manifest");
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];

  // GC-8: manifest-level case-collision scan. Any lowercased key carried by more
  // than one distinct spelling is skipped WHOLESALE (all spellings) + reported -
  // the per-write sibling scan below is the second layer.
  const jobCollisions = findCaseCollisions(jobs.map((j) => String(j.id ?? "")));
  const fileCollisions = findCaseCollisions(files.map((f) => `${String(f.jobId ?? "")}/${String(f.name ?? "")}`));

  for (const j of jobs) {
    const id = String(j.id ?? "");
    if (jobCollisions.has(id.toLowerCase())) {
      summary.skipped += 1;
      summary.conflicts.push(`case-collision manifest job ${id}`);
      report("skipped-manifest-case-collision", { jobId: id, name: "" });
      continue;
    }
    if (!isSafeName(id)) {
      summary.refused += 1;
      report("refused-name", { jobId: "(unsafe id withheld)", name: "" });
      continue;
    }
    // Fast path: row unchanged AND the vault file provably already holds the
    // bytes we last wrote - nothing to fetch, nothing to hydrate.
    const prevRow = state.rows[id];
    if (prevRow && prevRow.rowSha === j.rowSha && prevRow.name && isSafeName(prevRow.name)) {
      const key = `${id}/${prevRow.name}`;
      let target = null;
      try {
        target = resolveInside(resolveInside(jobsRoot, id), prevRow.name);
      } catch {
        target = null;
      }
      if (target && state.entries[key] && vaultHashFresh(state, key, target, state.entries[key])) continue;
    }
    let detail;
    try {
      detail = await api.getJson(`/api/mirror/jobs/${encodeURIComponent(id)}`);
    } catch (e) {
      summary.skipped += 1;
      summary.conflicts.push(`job-detail-failed ${id}`);
      continue;
    }
    const name = String(detail && detail.name ? detail.name : "");
    const front = detail && detail.front && typeof detail.front === "object" ? detail.front : {};
    const body = detail && detail.body != null ? String(detail.body) : "";
    // Integrity: the reconstruction must hash to the manifest rowSha it was
    // selected by. A mismatch is a skip, never a write off unverified data.
    if (rowShaOf(front, body) !== j.rowSha) {
      summary.skipped += 1;
      summary.conflicts.push(`row-sha-mismatch ${id}`);
      report("skipped-row-sha-mismatch", { jobId: id, name });
      continue;
    }
    const action = writeMirrorEntry({
      jobsRoot,
      jobId: id,
      name,
      bytes: Buffer.from(reconstructJobFileText(front, body), "utf8"),
      state,
      summary,
      report,
    });
    if (action === "created" || action === "updated" || action === "adopted") {
      state.rows[id] = { rowSha: j.rowSha, name };
    }
  }

  for (const f of files) {
    const jobId = String(f.jobId ?? "");
    const name = String(f.name ?? "");
    const key = `${jobId}/${name}`;
    if (fileCollisions.has(key.toLowerCase()) || jobCollisions.has(jobId.toLowerCase())) {
      summary.skipped += 1;
      summary.conflicts.push(`case-collision manifest file ${key}`);
      report("skipped-manifest-case-collision", { jobId, name });
      continue;
    }
    if (!isSafeName(jobId) || !isSafeName(name)) {
      summary.refused += 1;
      report("refused-name", { jobId, name: "(unsafe name withheld)" });
      continue;
    }
    const wantSha = typeof f.sha256 === "string" ? f.sha256.toLowerCase() : "";
    // Fast path: already mirrored at this sha and the vault bytes are provably
    // untouched since we wrote them.
    if (wantSha && state.entries[key] === wantSha) {
      let target = null;
      try {
        target = resolveInside(resolveInside(jobsRoot, jobId), name);
      } catch {
        target = null;
      }
      if (target && vaultHashFresh(state, key, target, wantSha)) continue;
    }
    let bytes;
    try {
      bytes = await api.getBytes(`/api/mirror/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`);
    } catch (e) {
      summary.skipped += 1;
      summary.conflicts.push(`file-pull-failed ${key}`);
      continue;
    }
    // Integrity: pulled bytes must hash to the manifest sha they were selected by.
    if (wantSha && sha256Hex(bytes) !== wantSha) {
      summary.skipped += 1;
      summary.conflicts.push(`file-sha-mismatch ${key}`);
      report("skipped-file-sha-mismatch", { jobId, name });
      continue;
    }
    writeMirrorEntry({ jobsRoot, jobId, name, bytes, state, summary, report });
  }

  saveMirrorState(statePath, state);
  const finishedAt = new Date().toISOString();
  const wrote = summary.created + summary.updated > 0;
  const loud = wrote || summary.refused > 0 || summary.conflicts.length > 0;
  if (loud) {
    // GC-2 / GC-9: one structured activity line per WRITING (or conflicted) pass
    // so unexpected mirror activity is owner-visible in-app. Best-effort: a
    // failed report never un-does the pass; the log line still records it.
    try {
      await api.postJson("/api/mirror/runs", {
        trigger,
        startedAt,
        finishedAt,
        created: summary.created,
        updated: summary.updated,
        adopted: summary.adopted,
        skipped: summary.skipped,
        refused: summary.refused,
        conflicts: summary.conflicts,
        clientVersion: MIRROR_CLIENT_VERSION,
      });
    } catch (e) {
      log(`mirror-runs report failed: ${e.message}`);
    }
  }
  log(
    `pass done (${trigger}): created=${summary.created} updated=${summary.updated} adopted=${summary.adopted} ` +
      `skipped=${summary.skipped} refused=${summary.refused} conflicts=${summary.conflicts.length}`,
  );
  return summary;
}

// ---- debounce (>= 5s batch window, bounded wait) ----------------------------
export function createDebouncer(fn, { quietMs = DEBOUNCE_MS, maxWaitMs = DEBOUNCE_MAX_WAIT_MS, setT = setTimeout, clearT = clearTimeout } = {}) {
  let timer = null;
  let firstAt = null;
  const fire = () => {
    timer = null;
    firstAt = null;
    fn();
  };
  return {
    trigger(now = Date.now()) {
      if (firstAt == null) firstAt = now;
      if (timer) clearT(timer);
      const cap = Math.max(0, firstAt + maxWaitMs - now);
      timer = setT(fire, Math.min(quietMs, cap));
      if (timer && timer.unref) timer.unref();
    },
    pending() {
      return timer != null;
    },
  };
}

// ---- lockfile (overlap guard, NO unlink) ------------------------------------
// Acquired with an exclusive "wx" create. A pre-existing lock is honored unless
// its recorded pid is dead or it is stale (> 6h), in which case it is RE-WRITTEN
// in place (overwrite, never delete - this module has no delete path at all).
// Release marks the lock released in place.
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, release: () => releaseLock(lockPath) };
  } catch {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      holder = null;
    }
    const stale =
      !holder ||
      holder.released === true ||
      !pidAlive(holder.pid) ||
      (holder.startedAt && Date.now() - Date.parse(holder.startedAt) > LOCK_STALE_MS);
    if (!stale) return { ok: false, release: () => {} };
    fs.writeFileSync(lockPath, payload); // take over the stale lock in place
    return { ok: true, release: () => releaseLock(lockPath) };
  }
}
function releaseLock(lockPath) {
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ released: true, releasedAt: new Date().toISOString() }));
  } catch {
    /* best-effort */
  }
}
function pidAlive(pid) {
  if (!Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // alive but not ours
  }
}

// ---- standing loop ----------------------------------------------------------
// Long-poll with reconnect + exponential backoff; every event schedules ONE
// debounced pass; an hourly sweep pass runs regardless of events; --poll swaps
// the long-poll for a 15s manifest-cadence trigger (same pass semantics).
async function mainLoop({ api, jobsRoot, statePath, log, mode, pollMs, once }) {
  let passRunning = false;
  let passQueued = null; // trigger label of a queued re-run
  const pass = async (trigger) => {
    if (passRunning) {
      passQueued = trigger;
      return;
    }
    passRunning = true;
    try {
      await runMirrorPass({ api, jobsRoot, statePath, trigger, log });
    } catch (e) {
      log(`pass failed (${trigger}): ${e.message}`);
    } finally {
      passRunning = false;
      if (passQueued) {
        const t = passQueued;
        passQueued = null;
        void pass(t);
      }
    }
  };

  if (once) {
    await pass("manual");
    return;
  }

  const debouncer = createDebouncer(() => void pass("event"));
  const sweep = setInterval(() => void pass("sweep"), SWEEP_INTERVAL_MS);
  sweep.unref?.();
  await pass("sweep"); // boot catch-up: adoption pass / anything missed while off

  if (mode === "poll") {
    // Fallback trigger: short-interval manifest poll (V2-3 fallback mode). Same
    // pass; ~pollMs worst-case latency instead of the long-poll's push.
    let lastManifestSha = null;
    for (;;) {
      try {
        const manifest = await api.getJson("/api/sync/manifest");
        const sha = sha256Hex(JSON.stringify(manifest));
        if (lastManifestSha && sha !== lastManifestSha) debouncer.trigger();
        lastManifestSha = sha;
      } catch (e) {
        log(`manifest poll failed: ${e.message}`);
      }
      await sleep(pollMs);
    }
  }

  let since = -1;
  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    try {
      const frame = await api.longPoll(since); // triggers only (GC-10)
      backoff = BACKOFF_MIN_MS; // healthy connection resets the backoff
      const seq = Number(frame && frame.seq);
      if (Number.isFinite(seq)) {
        // The very first poll (since=-1) answers immediately with the current
        // counter - that is a baseline, not a change (the boot sweep already
        // covered it). Only frames after the baseline schedule a pass.
        if (since >= 0 && (frame.changed || seq > since)) debouncer.trigger();
        since = seq;
      }
    } catch (e) {
      log(`long-poll error: ${e.message}; reconnecting in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS); // exponential backoff
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (line) => {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(`mirror: ${line}`);
    try {
      fs.appendFileSync(logPath, msg + "\n");
    } catch {
      /* logging must never break the pass */
    }
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const paths = mirrorPaths();
  const log = makeLogger(paths.log);
  assertTlsNotBypassed(process.env); // GC-6, again at entry
  const { token, cloudUrl } = loadMirrorSecrets();
  const api = createApi({ token, cloudUrl });
  const cfg = loadRepoConfig();
  const jobsRoot = path.resolve(process.env.JOBHUNT_MIRROR_JOBS_DIR || process.env.JOBHUNT_JOBS_DIR || cfg.jobsDir);
  if (!fs.existsSync(jobsRoot)) throw new Error(`mirror: vault Jobs root does not exist: ${jobsRoot}`);
  const lock = acquireLock(paths.lock);
  if (!lock.ok) {
    log("another mirror instance holds the lock; exiting 0");
    return;
  }
  process.on("exit", () => lock.release());

  // --dismiss (V2-3 resolution): accept every reported divergence as superseded
  // BEFORE running the pass, so this invocation's pass overwrites them with cloud
  // truth through the sanctioned update path. Writes nothing to the vault itself.
  if (args.has("--dismiss")) {
    const state = loadMirrorState(paths.state);
    const res = dismissReported(state, jobsRoot);
    saveMirrorState(paths.state, state);
    log(
      `dismiss: ${res.dismissed.length} divergence(s) accepted as superseded ` +
        `(cloud overwrites them on this pass); ${res.missing.length} missing, ${res.unsafe.length} unsafe`,
    );
  }

  const mode = args.has("--poll") ? "poll" : "longpoll";
  log(`mirroring ${api.host} -> ${jobsRoot} (${mode}, outbound-only, no-delete). Ctrl-C to stop.`);
  await mainLoop({
    api,
    jobsRoot,
    statePath: paths.state,
    log,
    mode,
    pollMs: Number(process.env.MIRROR_POLL_INTERVAL_MS) > 0 ? Number(process.env.MIRROR_POLL_INTERVAL_MS) : FALLBACK_POLL_MS,
    once: args.has("--once"),
  });
}

// Only run the loop when invoked directly (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`mirror: fatal: ${e.message}`);
    process.exit(1);
  });
}
