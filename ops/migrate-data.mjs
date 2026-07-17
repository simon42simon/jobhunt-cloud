#!/usr/bin/env node
// RC-2 / SIM-86 P7 - the ONE-SHOT, byte-verified file -> Postgres DATA migration
// for the jobhunt real-data cutover.
//
// WHAT IT DOES
//   1. Reads the owner's REAL FileStore data - STRICTLY and READ-ONLY. Every file
//      is opened with read flags only; nothing under the source dirs is written,
//      renamed, or touched. Any parse failure, unreadable file, or unexpected
//      shape ABORTS with a precise message and a non-zero exit (the OPPOSITE of
//      the tolerant FileStore reads and demo/seed.mjs's best-effort applySeed:
//      a migration must never silently drop a byte of the owner's data).
//   2. Imports the dataset into the target Postgres (DATABASE_URL) in ONE
//      transaction - a failure anywhere rolls the whole import back, leaving the
//      target exactly as it was.
//   3. VERIFIES equivalence through the Store seam: boots a FileStore over the
//      source dirs and a PgStore over the target, deep-compares every domain
//      (job DTOs + details, per-file sha256 through openJobFile, tasks, task
//      attachments, requests, sources, chats, activity, telemetry, notify state)
//      plus a direct raw-fidelity check of jobs.body / jobs.raw_frontmatter
//      against a fresh parseFront of the real job files. Prints a verification
//      table and exits non-zero on ANY mismatch.
//
// TABLE-BY-TABLE ACCOUNTING (every table in migrations/0001 + 0002)
//   jobs              MIGRATED - one row per job folder, from parseFront() of the
//                     REAL <Role>.md: typed columns + body + raw_frontmatter
//                     (full fidelity incl. unmodeled keys), updated_at = the
//                     file's mtime so mtime-derived readiness flags agree.
//   job_files         MIGRATED - every OTHER file in each job folder (notes,
//                     CV/cover .docx/.pdf, dated history copies, prep docs,
//                     application-content.json, anything else) as bytea, with
//                     mime by extension and kind mirroring PgStore's own write
//                     paths (writeJobNote note kinds, saveJobArtifact cv/cover/
//                     other), updated_at = the file's mtime. The job's own .md is
//                     NOT a job_files row - its content lives on the jobs row,
//                     exactly like PgStore.createJob.
//   tasks             MIGRATED - one row per task (raw doc jsonb, file order via
//                     seq), from tasks.yaml.
//   board_config      MIGRATED - the tasks.yaml top-level `columns` (single row).
//   task_attachments  MIGRATED - every blob under DATA_DIR/attachments/<taskId>/,
//                     meta (name/mime/ts) joined from the owning task's
//                     attachments records. A task attachment record whose blob
//                     file is missing ABORTS; a stray blob with no task record is
//                     migrated anyway (never lose bytes) with a warning.
//   requests          MIGRATED - one row per request (raw doc jsonb, file order),
//                     from requests.yaml.
//   activity_log      MIGRATED - one row per JSONL line, order preserved, each
//                     line inserted verbatim as jsonb (key ORDER canonicalizes in
//                     jsonb by design; the verify compares PARSED records, the
//                     same posture as tests/pg-filestore-differential.test.js).
//   telemetry_events  MIGRATED - same treatment for usage-telemetry.jsonl.
//   notify_state      MIGRATED - the parsed notify-state.json as the single row.
//                     An absent file intentionally creates NO row (absent row ==
//                     uninitialized, identical semantics to the missing file).
//   job_chats         MIGRATED - one row per job id from job-chats.json.
//   discovery_sources MIGRATED - serializeSource(normalizeSource(raw)) per source
//                     (the exact doc PgStore.saveSources would store), file order.
//   discovery_meta    MIGRATED - the file's own version + updated stamp (NOT
//                     re-stamped, so loadSources agrees on both sides).
//   discovery_finds   N/A - the file side has no Store-seam finds store (finds
//                     live in the vault workspace xlsx behind discovery.py /
//                     JOBHUNT_DISCOVERY_FINDS, outside JOBS_DIR/DATA_DIR/DOCS_DIR)
//                     and no code reads or writes this table yet. Starts empty.
//   agent_jobs        N/A - the hybrid-runner queue is runtime state, not data;
//                     the cloud queue starts empty. The laptop-side
//                     agent-jobs.json stays on the laptop (a warning is printed
//                     if it still holds non-terminal jobs at cutover time).
//   pgmigrations      N/A - node-pg-migrate's own ledger (infra), written by
//                     `node ops/migrate.mjs`, never by this script.
//   (roadmap.yaml / portfolio.yaml / agents.yaml are bundled read-only repo files
//    in BOTH stores by design - they ship with the deploy, nothing to migrate.)
//
// RUNBOOK (the real cutover; rehearsed by tests/migrate-data.test.js)
//   1. [SIMON] Open the Railway TCP proxy on the private Postgres for the window;
//      copy the public URL (keep any TLS params it carries - they ride on the URL).
//   2. Schema onto the fresh DB:
//        STORE_BACKEND=pg DATABASE_URL="<public-url>" node ops/migrate.mjs
//   3. Import + verify (one shot; flags win over env JOBS_DIR/DATA_DIR/DOCS_DIR):
//        DATABASE_URL="<public-url>" node ops/migrate-data.mjs \
//          --jobs-dir "<...>\Jobs" --data-dir "<...\data zone>" --docs-dir "<repo>\docs"
//      The script prints what it resolved, refuses a non-empty target (see
//      --force-empty-check-bypass), imports in one transaction, then verifies.
//   4. Re-check any time later without importing:  add --verify-only
//   5. [SIMON] Close the TCP proxy.
//   A failed import rolls back (the target stays empty). If a target is dirty
//   from some OTHER writer, wipe it with the printed TRUNCATE statement or
//   `node-pg-migrate down` + `up`, then re-run.
//
// SAFETY POSTURE
//   - READ-ONLY on the source: fs.readdirSync / readFileSync / statSync /
//     createReadStream only. No write API is ever called with a source path.
//   - Parameterized queries ONLY (guardian MF-12).
//   - No new dependencies: pg, js-yaml, and the repo's own server modules.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import pg from "pg";
import { parseFront } from "../server/lib.js";
import { isDatedCopy } from "../server/store-helpers.js";
import { FileStore } from "../server/store.js";
import { PgStore } from "../server/pg-store.js";

// A migration abort: precise message, non-zero exit. Every strict check throws this.
export class MigrateError extends Error {}
const fail = (msg) => {
  throw new MigrateError(msg);
};

// ---- domain constants -------------------------------------------------------
// Mirrors server/index.js "domain constants" (they are module-private consts
// there; the test suites keep the same local-copy convention, see
// tests/pg-filestore-differential.test.js). Both stores in the verify receive
// the SAME deps object, so the equivalence proof cannot be skewed by this copy.
const STATUSES = ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"];
const TRACKS = {
  industry_outreach_focused: "Industry Outreach",
  higher_ed_generalist_focused: "Higher-Ed Generalist",
  b2b_gtm_focused: "B2B GTM",
  operations_leadership_focused: "Operations Leadership",
  public_sector_focused: "Public Sector",
  aerospace_defence_focused: "Aerospace / Defence",
  fire_alarm_focused: "Fire / Life-Safety",
};

// jsonb bind helper (same rationale as server/pg-store.js: send a JSON STRING
// against $n::jsonb so top-level arrays bind correctly).
const J = (v) => JSON.stringify(v == null ? null : v);

// mime by extension for job_files. writeJobNote stores text/markdown for the .md
// notes; artifacts arrive with a caller mime - for migrated files we derive the
// same values from the extension. mime is display metadata (never compared by the
// DTO derivations), but we keep it faithful.
const MIME_BY_EXT = {
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  json: "application/json",
  txt: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  csv: "text/csv",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const extOf = (name) => path.extname(name).toLowerCase().replace(".", "");
const mimeOf = (name) => MIME_BY_EXT[extOf(name)] || null;

// kind for a job_files row, mirroring what PgStore's OWN write paths would set:
// writeJobNote's note kinds first (a current .md named gaps/job-description/
// feedback), then saveJobArtifact's cv/cover/other name derivation.
export function jobFileKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") && !isDatedCopy(name)) {
    if (lower.includes("gaps")) return "gaps";
    if (lower.includes("job-description")) return "job-description";
    if (lower.includes("feedback")) return "feedback";
  }
  if (lower.includes("cv")) return "cv";
  if (lower.includes("cover")) return "cover";
  return "other";
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const isoOf = (ms) => new Date(ms).toISOString();
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- injected domain helpers (one home per thing) ---------------------------
// dropInvalidJobEnums / normalizeSource / serializeSource live (exported +
// directly tested) in server/index.js. Importing index.js boots nothing under
// JOBHUNT_TEST=1 (the same seam every test uses); we point its module-level
// FileStore at a scratch dir so the import can never even READ the real source
// through the server's own config, and force the file backend so no second pg
// connection is opened at import time.
let _deps = null;
async function loadDomainDeps() {
  if (_deps) return _deps;
  process.env.JOBHUNT_TEST = "1";
  if (!process.env.JOBHUNT_JOBS_DIR || !process.env.JOBHUNT_DOCS_DIR) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-migrate-boot-"));
    process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || scratch;
    process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || scratch;
  }
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  const mod = await import("../server/index.js");
  _deps = {
    TRACKS,
    STATUSES,
    dropInvalidJobEnums: mod.dropInvalidJobEnums,
    normalizeSource: mod.normalizeSource,
    serializeSource: mod.serializeSource,
  };
  return _deps;
}

// ============================================================================
// STRICT source read (READ-ONLY; every anomaly aborts)
// ============================================================================

// Frontmatter columns split by coercion class (see the DTO derivations in
// server/store.js _buildJob / server/pg-store.js _rowToJob):
//   STRING_COLS  are served RAW by both DTO builders (`d.status || ""` vs
//                `row.status || ""`), so a non-string scalar would round-trip
//                with a different TYPE on the file side -> must be string.
//   SCALAR_COLS  pass through normDate()/String() on BOTH sides, so any scalar
//                coerces identically -> string/number/boolean allowed.
const STRING_COLS = ["type", "status", "fit", "track", "sector", "tailoring", "link", "next_action"];
const SCALAR_COLS = ["deadline", "applied", "next_action_date", "source"];

function readJobsDomain(jobsDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch (e) {
    fail(`JOBS_DIR is not readable: ${jobsDir} (${e.message})`);
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      fail(
        `unexpected non-folder entry directly under JOBS_DIR: "${entry.name}". ` +
          `Jobs/ must contain only job folders - move or remove it, then re-run (nothing was written).`,
      );
    }
    const folder = entry.name;
    const folderPath = path.join(jobsDir, folder);
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    const files = [];
    for (const it of items) {
      if (!it.isFile()) {
        fail(
          `unexpected non-file entry inside job folder "${folder}": "${it.name}". ` +
            `A nested folder would not be migrated (data loss) - flatten or remove it, then re-run.`,
        );
      }
      const p = path.join(folderPath, it.name);
      let bytes, stat;
      try {
        bytes = fs.readFileSync(p); // read flag only
        stat = fs.statSync(p);
      } catch (e) {
        fail(`unreadable file: ${p} (${e.message})`);
      }
      files.push({ name: it.name, bytes, mtimeMs: stat.mtimeMs });
    }

    // Exactly ONE .md with frontmatter `type: job` is the folder's job file.
    const jobMds = [];
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith(".md")) continue;
      const parsed = parseFront(f.bytes.toString("utf8"));
      if (parsed === null) {
        fail(`unparseable .md in job folder "${folder}": "${f.name}" - fix or remove it, then re-run.`);
      }
      if (parsed.data && parsed.data.type === "job") jobMds.push({ file: f, parsed });
    }
    if (jobMds.length === 0) {
      fail(
        `job folder "${folder}" has no .md with frontmatter "type: job" - it would be invisible to the app ` +
          `and its files would be dropped by a migration. Fix the folder (or move it out of Jobs/), then re-run.`,
      );
    }
    if (jobMds.length > 1) {
      fail(
        `job folder "${folder}" has ${jobMds.length} .md files with "type: job" ` +
          `(${jobMds.map((j) => j.file.name).join(", ")}) - ambiguous; keep exactly one, then re-run.`,
      );
    }

    const { file: jobFile, parsed } = jobMds[0];
    const d = parsed.data || {};
    if (typeof d.role !== "string" || !d.role) {
      fail(`job "${folder}" (${jobFile.name}): frontmatter "role" must be a non-empty string (jobs.role is NOT NULL).`);
    }
    if (typeof d.employer !== "string" || !d.employer) {
      fail(`job "${folder}" (${jobFile.name}): frontmatter "employer" must be a non-empty string (jobs.employer is NOT NULL).`);
    }
    for (const key of STRING_COLS) {
      if (d[key] != null && typeof d[key] !== "string") {
        fail(`job "${folder}" (${jobFile.name}): frontmatter "${key}" must be a string (got ${typeof d[key]}).`);
      }
    }
    for (const key of SCALAR_COLS) {
      const v = d[key];
      if (v != null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        fail(`job "${folder}" (${jobFile.name}): frontmatter "${key}" must be a scalar (got ${Array.isArray(v) ? "array" : typeof v}).`);
      }
    }
    let tags = [];
    if (Array.isArray(d.tags)) {
      for (const t of d.tags) {
        if (typeof t !== "string") fail(`job "${folder}" (${jobFile.name}): every tag must be a string (got ${typeof t}).`);
      }
      tags = d.tags;
    } else if (typeof d.tags === "string") {
      tags = [d.tags];
    } else if (d.tags != null) {
      fail(`job "${folder}" (${jobFile.name}): "tags" must be a string or a list of strings.`);
    }

    jobs.push({
      id: folder,
      jobFileName: jobFile.name,
      front: d,
      body: parsed.content != null ? parsed.content : "",
      tags,
      mtimeMs: jobFile.mtimeMs,
      files: files
        .filter((f) => f.name !== jobFile.name)
        .map((f) => ({ ...f, mime: mimeOf(f.name), kind: jobFileKind(f.name) })),
    });
  }
  return jobs;
}

function loadYamlStrict(filePath, label) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    fail(`${label} failed to parse as YAML: ${filePath} (${e.message})`);
  }
}

function loadJsonStrict(filePath, label) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${label} failed to parse as JSON: ${filePath} (${e.message})`);
  }
}

// Strict JSONL: returns the raw line texts (inserted verbatim) after proving each
// parses to a plain JSON object; blank lines are ignored, same as every consumer.
function loadJsonlStrict(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = [];
  const rawLines = raw.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch (e) {
      fail(`${label} line ${i + 1} is not valid JSON: ${filePath} (${e.message})`);
    }
    if (!isPlainObject(rec)) fail(`${label} line ${i + 1} is not a JSON object: ${filePath}`);
    lines.push(t);
  }
  return lines;
}

const assertUniqueIds = (list, label) => {
  const seen = new Set();
  for (const id of list) {
    if (seen.has(id)) fail(`duplicate ${label} id "${id}" - resolve the duplicate, then re-run.`);
    seen.add(id);
  }
};

export function readSourceDataset({ jobsDir, dataDir, docsDir }, log) {
  const warnings = [];
  const ds = { warnings };

  // -- jobs + job files
  ds.jobs = readJobsDomain(jobsDir);
  log(`[read] jobs: ${ds.jobs.length} folder(s), ${ds.jobs.reduce((n, j) => n + j.files.length, 0)} companion file(s)`);

  // -- tasks + board columns
  const tasksFile = path.join(dataDir, "tasks.yaml");
  if (fs.existsSync(tasksFile)) {
    const data = loadYamlStrict(tasksFile, "tasks.yaml") || {};
    if (data.tasks != null && !Array.isArray(data.tasks)) fail(`tasks.yaml "tasks" must be a list: ${tasksFile}`);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    for (const t of tasks) {
      if (!isPlainObject(t) || t.id == null || String(t.id) === "") {
        fail(`tasks.yaml has a task without an id (tasks.id is the primary key): ${tasksFile}`);
      }
    }
    assertUniqueIds(tasks.map((t) => String(t.id)), "task");
    if (data.columns != null && (!Array.isArray(data.columns) || data.columns.some((c) => typeof c !== "string"))) {
      fail(`tasks.yaml "columns" must be a list of strings: ${tasksFile}`);
    }
    ds.tasksDoc = { columns: Array.isArray(data.columns) ? data.columns : null, tasks };
    log(`[read] tasks: ${tasks.length} task(s)${ds.tasksDoc.columns ? `, columns [${ds.tasksDoc.columns.join(", ")}]` : ""}`);
  } else {
    ds.tasksDoc = null;
    log("[read] tasks: tasks.yaml absent - empty, nothing to migrate");
  }

  // -- task attachment blobs
  const attachmentsDir = path.join(dataDir, "attachments");
  ds.attachments = [];
  if (fs.existsSync(attachmentsDir)) {
    for (const entry of fs.readdirSync(attachmentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) fail(`unexpected non-folder entry under attachments/: "${entry.name}"`);
      const taskId = entry.name;
      const dir = path.join(attachmentsDir, taskId);
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) fail(`unexpected nested folder under attachments/${taskId}/: "${f.name}"`);
        const p = path.join(dir, f.name);
        let bytes, stat;
        try {
          bytes = fs.readFileSync(p);
          stat = fs.statSync(p);
        } catch (e) {
          fail(`unreadable attachment blob: ${p} (${e.message})`);
        }
        ds.attachments.push({ taskId, file: f.name, bytes, mtimeMs: stat.mtimeMs });
      }
    }
  }
  // Cross-check: every attachment record on a task must have its blob on disk
  // (a missing blob would silently vanish in the cutover - abort instead); a
  // stray blob with no record still migrates (never lose bytes), with a warning.
  const blobKey = (t, f) => `${t} ${f}`;
  const blobSet = new Set(ds.attachments.map((a) => blobKey(a.taskId, a.file)));
  const metaByKey = new Map();
  for (const t of ds.tasksDoc ? ds.tasksDoc.tasks : []) {
    for (const a of Array.isArray(t.attachments) ? t.attachments : []) {
      if (!isPlainObject(a) || typeof a.file !== "string") {
        fail(`task ${t.id}: malformed attachment record (expected an object with a "file" name).`);
      }
      metaByKey.set(blobKey(String(t.id), a.file), a);
      if (!blobSet.has(blobKey(String(t.id), a.file))) {
        fail(`task ${t.id}: attachment "${a.file}" is recorded on the task but its blob file is missing under ${attachmentsDir}.`);
      }
    }
  }
  for (const a of ds.attachments) {
    a.meta = metaByKey.get(blobKey(a.taskId, a.file)) || null;
    if (!a.meta) warnings.push(`attachments/${a.taskId}/${a.file} has no record on any task - migrated anyway (unreferenced bytes preserved).`);
  }
  log(`[read] task attachments: ${ds.attachments.length} blob(s)`);

  // -- requests
  const requestsFile = path.join(dataDir, "requests.yaml");
  if (fs.existsSync(requestsFile)) {
    const data = loadYamlStrict(requestsFile, "requests.yaml") || {};
    if (data.requests != null && !Array.isArray(data.requests)) fail(`requests.yaml "requests" must be a list: ${requestsFile}`);
    const requests = Array.isArray(data.requests) ? data.requests : [];
    for (const r of requests) {
      if (!isPlainObject(r) || r.id == null || String(r.id) === "") {
        fail(`requests.yaml has a request without an id (requests.id is the primary key): ${requestsFile}`);
      }
    }
    assertUniqueIds(requests.map((r) => String(r.id)), "request");
    ds.requests = requests;
    log(`[read] requests: ${requests.length} record(s)`);
  } else {
    ds.requests = null;
    log("[read] requests: requests.yaml absent - empty, nothing to migrate");
  }

  // -- discovery sources (+ the registry header)
  const sourcesFile = path.join(docsDir, "discovery-sources.yaml");
  if (fs.existsSync(sourcesFile)) {
    const data = loadYamlStrict(sourcesFile, "discovery-sources.yaml") || {};
    if (data.sources != null && !Array.isArray(data.sources)) fail(`discovery-sources.yaml "sources" must be a list: ${sourcesFile}`);
    if (data.version != null && !Number.isSafeInteger(data.version)) {
      fail(`discovery-sources.yaml "version" must be an integer: ${sourcesFile}`);
    }
    if (data.updated != null && typeof data.updated !== "string") {
      fail(`discovery-sources.yaml "updated" must be a string: ${sourcesFile}`);
    }
    for (const s of Array.isArray(data.sources) ? data.sources : []) {
      if (!isPlainObject(s)) fail(`discovery-sources.yaml has a non-object source entry: ${sourcesFile}`);
    }
    ds.sourcesDoc = {
      version: typeof data.version === "number" ? data.version : 1,
      updated: typeof data.updated === "string" ? data.updated : null,
      sources: Array.isArray(data.sources) ? data.sources : [],
    };
    log(`[read] discovery sources: ${ds.sourcesDoc.sources.length} source(s), version ${ds.sourcesDoc.version}, updated ${ds.sourcesDoc.updated}`);
  } else {
    ds.sourcesDoc = null;
    log("[read] discovery sources: discovery-sources.yaml absent - empty, nothing to migrate");
  }

  // -- per-job chats
  const chatsFile = path.join(dataDir, "job-chats.json");
  if (fs.existsSync(chatsFile)) {
    const obj = loadJsonStrict(chatsFile, "job-chats.json");
    if (!isPlainObject(obj)) fail(`job-chats.json must be a JSON object keyed by job id: ${chatsFile}`);
    ds.chats = obj;
    log(`[read] chats: ${Object.keys(obj).length} job(s)`);
  } else {
    ds.chats = null;
    log("[read] chats: job-chats.json absent - empty, nothing to migrate");
  }

  // -- append streams
  ds.activityLines = loadJsonlStrict(path.join(dataDir, "activity-log.jsonl"), "activity-log.jsonl");
  log(ds.activityLines ? `[read] activity log: ${ds.activityLines.length} line(s)` : "[read] activity log: absent - empty, nothing to migrate");
  ds.telemetryLines = loadJsonlStrict(path.join(dataDir, "usage-telemetry.jsonl"), "usage-telemetry.jsonl");
  log(ds.telemetryLines ? `[read] telemetry: ${ds.telemetryLines.length} line(s)` : "[read] telemetry: absent - empty, nothing to migrate");

  // -- notify state
  const notifyFile = path.join(dataDir, "notify-state.json");
  if (fs.existsSync(notifyFile)) {
    const doc = loadJsonStrict(notifyFile, "notify-state.json");
    if (!isPlainObject(doc)) fail(`notify-state.json must be a JSON object: ${notifyFile}`);
    ds.notifyDoc = doc;
    log("[read] notify state: present");
  } else {
    ds.notifyDoc = null;
    log("[read] notify state: absent - stays uninitialized (no row created; identical semantics)");
  }

  // -- laptop runner queue (n/a domain; warn if it still holds live work)
  const agentJobsFile = path.join(dataDir, "agent-jobs.json");
  if (fs.existsSync(agentJobsFile)) {
    try {
      const obj = JSON.parse(fs.readFileSync(agentJobsFile, "utf8"));
      const live = (Array.isArray(obj && obj.jobs) ? obj.jobs : []).filter((j) =>
        ["queued", "claimed", "running"].includes(j && j.status),
      );
      if (live.length) {
        warnings.push(
          `agent-jobs.json holds ${live.length} non-terminal runner job(s) - the queue is NOT migrated ` +
            `(the cloud queue starts empty); let them finish or accept losing them before cutover.`,
        );
      }
    } catch {
      warnings.push("agent-jobs.json exists but did not parse - the runner queue is not migrated either way.");
    }
  }

  for (const w of warnings) log(`[warn] ${w}`);
  return ds;
}

// ============================================================================
// IMPORT (one transaction; parameterized only)
// ============================================================================

// Tables this migration owns. The preflight refuses a target where ANY of them
// already has rows (the real cutover runs ONCE against a fresh DB).
const MIGRATED_TABLES = [
  "jobs",
  "job_files",
  "tasks",
  "task_attachments",
  "requests",
  "activity_log",
  "telemetry_events",
  "notify_state",
  "job_chats",
  "discovery_sources",
  "discovery_meta",
  "discovery_finds",
  "agent_jobs",
];
const TRUNCATE_HINT =
  `truncate ${MIGRATED_TABLES.join(", ")}, board_config restart identity cascade; ` +
  `insert into board_config (id) values (1);`;

async function assertSchemaMigrated(client) {
  const r = await client.query("select to_regclass('public.jobs') as jobs, to_regclass('public.agent_jobs') as aj", []);
  const row = r.rows[0] || {};
  if (!row.jobs || !row.aj) {
    fail(`target database has no schema - run: STORE_BACKEND=pg DATABASE_URL="<url>" node ops/migrate.mjs (node-pg-migrate up), then re-run.`);
  }
  const c = await client.query(
    "select 1 from information_schema.columns where table_schema='public' and table_name='agent_jobs' and column_name='progress'",
    [],
  );
  if (!c.rows.length) {
    fail("target schema is behind (migration 0002 not applied) - run node ops/migrate.mjs, then re-run.");
  }
}

async function assertEmptyTarget(client, bypass, log) {
  const nonEmpty = [];
  for (const t of MIGRATED_TABLES) {
    const r = await client.query(`select count(*)::int as n from ${t}`, []); // table names from the constant list above, never from input
    if (r.rows[0].n > 0) nonEmpty.push(`${t} (${r.rows[0].n})`);
  }
  if (nonEmpty.length === 0) return;
  if (bypass) {
    log(`[preflight] WARNING: target is non-empty (${nonEmpty.join(", ")}) - proceeding because --force-empty-check-bypass was passed.`);
    return;
  }
  fail(
    `target database is not empty: ${nonEmpty.join(", ")}. The real cutover runs once against a fresh DB. ` +
      `Wipe it first (either \`node-pg-migrate down\` then \`node ops/migrate.mjs\`, or run:\n  ${TRUNCATE_HINT}\n` +
      `) or pass --force-empty-check-bypass if you truly mean to import into it.`,
  );
}

const CHUNK = 200;
async function insertJsonlLines(client, table, column, lines) {
  for (let i = 0; i < lines.length; i += CHUNK) {
    const batch = lines.slice(i, i + CHUNK);
    const values = batch.map((_, k) => `($${k + 1}::jsonb)`).join(",");
    await client.query(`insert into ${table} (${column}) values ${values}`, batch);
  }
}

async function importDataset(client, ds, deps, log) {
  // -- jobs + job_files (raw fidelity: the REAL parseFront output, not a template)
  for (const job of ds.jobs) {
    const d = job.front;
    const str = (v) => (v ? v : null); // STRING_COLS (validated string | null)
    const scalar = (v) => (v == null || v === "" ? null : String(v)); // SCALAR_COLS
    await client.query(
      `insert into jobs
         (id, role, employer, type, status, fit, track, sector, tailoring, deadline, applied,
          next_action, next_action_date, link, source, tags, body, raw_frontmatter, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
      [
        job.id,
        d.role,
        d.employer,
        str(d.type),
        str(d.status),
        str(d.fit),
        str(d.track),
        str(d.sector),
        str(d.tailoring),
        scalar(d.deadline),
        scalar(d.applied),
        str(d.next_action),
        scalar(d.next_action_date),
        str(d.link),
        scalar(d.source),
        job.tags,
        job.body,
        J(d),
        isoOf(job.mtimeMs),
      ],
    );
    for (const f of job.files) {
      await client.query(
        `insert into job_files (job_id, name, mime, kind, bytes, updated_at) values ($1,$2,$3,$4,$5,$6)`,
        [job.id, f.name, f.mime, f.kind, f.bytes, isoOf(f.mtimeMs)],
      );
    }
  }
  log(`[import] jobs: ${ds.jobs.length} row(s); job_files: ${ds.jobs.reduce((n, j) => n + j.files.length, 0)} row(s)`);

  // -- tasks + board_config
  if (ds.tasksDoc) {
    for (const t of ds.tasksDoc.tasks) {
      await client.query("insert into tasks (id, doc) values ($1, $2::jsonb)", [String(t.id), J(t)]);
    }
    if (ds.tasksDoc.columns) {
      await client.query(
        "insert into board_config (id, columns) values (1, $1) on conflict (id) do update set columns=excluded.columns",
        [ds.tasksDoc.columns],
      );
    }
    log(`[import] tasks: ${ds.tasksDoc.tasks.length} row(s); board_config: ${ds.tasksDoc.columns ? "columns set" : "default kept"}`);
  } else {
    log("[import] tasks: empty, nothing to migrate");
  }

  // -- task_attachments
  for (const a of ds.attachments) {
    const m = a.meta || {};
    await client.query(
      `insert into task_attachments (task_id, file, name, mime, bytes_len, blob, ts) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        a.taskId,
        a.file,
        typeof m.name === "string" ? m.name : null,
        typeof m.mime === "string" ? m.mime : null,
        a.bytes.length,
        a.bytes,
        typeof m.ts === "string" ? m.ts : isoOf(a.mtimeMs),
      ],
    );
  }
  log(`[import] task_attachments: ${ds.attachments.length} row(s)`);

  // -- requests
  if (ds.requests) {
    for (const r of ds.requests) {
      await client.query("insert into requests (id, doc, ts) values ($1,$2::jsonb,$3)", [
        String(r.id),
        J(r),
        typeof r.ts === "string" ? r.ts : null,
      ]);
    }
    log(`[import] requests: ${ds.requests.length} row(s)`);
  } else {
    log("[import] requests: empty, nothing to migrate");
  }

  // -- discovery sources + meta (the exact docs PgStore.saveSources would store,
  //    but the FILE's own version/updated stamp - never re-stamped)
  if (ds.sourcesDoc) {
    const { normalizeSource, serializeSource } = deps;
    const seen = new Set();
    for (const rawSource of ds.sourcesDoc.sources) {
      const s = serializeSource(normalizeSource(rawSource));
      if (!s.id) fail(`discovery source normalizes to an empty id (raw id: ${JSON.stringify(rawSource.id)}, name: ${JSON.stringify(rawSource.name)}).`);
      if (seen.has(s.id)) fail(`duplicate discovery source id "${s.id}" after normalization.`);
      seen.add(s.id);
      await client.query(
        "insert into discovery_sources (id, sector, active, type, doc) values ($1,$2,$3,$4,$5::jsonb)",
        [s.id, s.sector || null, s.active || null, s.type || null, J(s)],
      );
    }
    await client.query("insert into discovery_meta (id, version, updated) values (1,$1,$2)", [
      ds.sourcesDoc.version,
      ds.sourcesDoc.updated,
    ]);
    log(`[import] discovery_sources: ${ds.sourcesDoc.sources.length} row(s); discovery_meta: version ${ds.sourcesDoc.version}, updated ${ds.sourcesDoc.updated}`);
  } else {
    log("[import] discovery_sources: empty, nothing to migrate");
  }

  // -- chats
  if (ds.chats) {
    for (const [jobId, transcript] of Object.entries(ds.chats)) {
      await client.query("insert into job_chats (job_id, transcript) values ($1, $2::jsonb)", [jobId, J(transcript)]);
    }
    log(`[import] job_chats: ${Object.keys(ds.chats).length} row(s)`);
  } else {
    log("[import] job_chats: empty, nothing to migrate");
  }

  // -- append streams (order preserved; lines inserted verbatim as jsonb)
  if (ds.activityLines) {
    await insertJsonlLines(client, "activity_log", "line", ds.activityLines);
    log(`[import] activity_log: ${ds.activityLines.length} row(s)`);
  } else {
    log("[import] activity_log: empty, nothing to migrate");
  }
  if (ds.telemetryLines) {
    await insertJsonlLines(client, "telemetry_events", "event", ds.telemetryLines);
    log(`[import] telemetry_events: ${ds.telemetryLines.length} row(s)`);
  } else {
    log("[import] telemetry_events: empty, nothing to migrate");
  }

  // -- notify state (absent file -> intentionally NO row: uninitialized)
  if (ds.notifyDoc) {
    await client.query("insert into notify_state (id, doc) values (1, $1::jsonb)", [J(ds.notifyDoc)]);
    log("[import] notify_state: 1 row");
  } else {
    log("[import] notify_state: absent - no row created (uninitialized, matching the missing file)");
  }

  log("[import] discovery_finds: n/a - no file-side Store-seam finds store (vault xlsx via discovery.py); starts empty");
  log("[import] agent_jobs: n/a - runtime runner queue; the cloud queue starts empty");
  log("[import] pgmigrations: n/a - node-pg-migrate infra ledger (written by ops/migrate.mjs)");
}

// ============================================================================
// VERIFY (through the Store seam; the point of the parcel)
// ============================================================================

const stripJob = (j) => {
  if (!j) return j;
  // Filesystem-only DTO fields, excluded BY DESIGN (same set as
  // tests/pg-filestore-differential.test.js): FileStore has a real folder,
  // PgStore has rows. The raw `files` listing is compared separately by NAME SET
  // + per-file sha256 (the file side's listing includes the job's own .md, which
  // is the jobs row on the pg side).
  const { folderPath, jobFile, jobFileName, mtime, files, ...rest } = j;
  return rest;
};

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

const parseJsonl = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

export async function verifyEquivalence({ ds, paths, databaseUrl, query }, log) {
  const deps = await loadDomainDeps();
  const fileStore = new FileStore({ jobsDir: paths.jobsDir, docsDir: paths.docsDir, dataDir: paths.dataDir, deps });
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-migrate-blob-"));
  const pgStore = new PgStore({ url: databaseUrl, docsDir: paths.docsDir, blobDir, deps });

  const rows = [];
  const mismatches = [];
  const record = (domain, fileCount, pgCount, problems) => {
    rows.push({ domain, fileCount, pgCount, ok: problems.length === 0 });
    for (const p of problems) mismatches.push(`${domain}: ${p}`);
  };

  try {
    // ---- jobs: DTO arrays (order-normalized) + per-job detail -----------------
    {
      const problems = [];
      const byId = (list) => new Map(list.map((j) => [j.id, j]));
      const fj = fileStore.listJobs();
      const pj = pgStore.listJobs();
      const fMap = byId(fj);
      const pMap = byId(pj);
      if (fj.length !== pj.length) problems.push(`listJobs count file=${fj.length} pg=${pj.length}`);
      for (const id of fMap.keys()) if (!pMap.has(id)) problems.push(`job "${id}" missing on the pg side`);
      for (const id of pMap.keys()) if (!fMap.has(id)) problems.push(`job "${id}" present on pg but not on file side`);
      for (const [id, f] of fMap) {
        const p = pMap.get(id);
        if (!p) continue;
        if (!isDeepStrictEqual(stripJob(f), stripJob(p))) problems.push(`listJobs DTO differs for "${id}"`);
        const fd = fileStore.getJob(id);
        const pd = pgStore.getJob(id);
        if (!isDeepStrictEqual(stripJob(fd), stripJob(pd))) problems.push(`getJob detail differs for "${id}"`);
      }
      record("jobs (DTO + detail)", fj.length, pj.length, problems);
    }

    // ---- jobs raw fidelity: body + raw_frontmatter vs a fresh parse -----------
    {
      const problems = [];
      for (const job of ds.jobs) {
        const r = await query("select body, raw_frontmatter, tags from jobs where id=$1", [job.id]);
        const row = r.rows[0];
        if (!row) {
          problems.push(`jobs row missing for "${job.id}"`);
          continue;
        }
        if (row.body !== job.body) problems.push(`body differs for "${job.id}"`);
        if (!isDeepStrictEqual(row.raw_frontmatter, JSON.parse(J(job.front)))) {
          problems.push(`raw_frontmatter differs for "${job.id}"`);
        }
        if (!isDeepStrictEqual(row.tags, job.tags)) problems.push(`tags differ for "${job.id}"`);
      }
      record("jobs raw (body/frontmatter)", ds.jobs.length, ds.jobs.length, problems);
    }

    // ---- job files: name sets + per-file sha256 through openJobFile -----------
    {
      const problems = [];
      let fileCount = 0;
      let pgCount = 0;
      for (const f of fileStore.listJobs()) {
        const p = pgStore.getJobSummary(f.id);
        const fNames = f.files.map((x) => x.name).filter((n) => n !== f.jobFileName);
        const pNames = p ? p.files.map((x) => x.name) : [];
        fileCount += fNames.length;
        pgCount += pNames.length;
        const fSet = new Set(fNames);
        const pSet = new Set(pNames);
        for (const n of fSet) if (!pSet.has(n)) problems.push(`"${f.id}": file "${n}" missing on pg side`);
        for (const n of pSet) if (!fSet.has(n)) problems.push(`"${f.id}": extra pg file "${n}"`);
        for (const n of fNames) {
          if (!pSet.has(n)) continue;
          const a = fileStore.openJobFile(f.id, n);
          const b = pgStore.openJobFile(f.id, n);
          if (!a.ok || !b.ok) {
            problems.push(`"${f.id}": openJobFile failed for "${n}" (file:${a.ok} pg:${b.ok})`);
            continue;
          }
          const [ba, bb] = [await streamToBuffer(a.stream), await streamToBuffer(b.stream)];
          if (sha256(ba) !== sha256(bb)) problems.push(`"${f.id}": sha256 mismatch for "${n}"`);
        }
      }
      record("job files (sha256)", fileCount, pgCount, problems);
    }

    // ---- tasks -----------------------------------------------------------------
    {
      const problems = [];
      const pgTasks = pgStore.loadTasks();
      if (ds.tasksDoc) {
        const fileTasks = fileStore.loadTasks();
        if (!isDeepStrictEqual(pgTasks, fileTasks)) problems.push("loadTasks() differs");
        record("tasks", fileTasks.tasks.length, pgTasks.tasks.length, problems);
      } else {
        if (pgTasks.tasks.length !== 0) problems.push(`file side has no tasks.yaml but pg has ${pgTasks.tasks.length} task(s)`);
        record("tasks", 0, pgTasks.tasks.length, problems);
      }
    }

    // ---- task attachments: inventory + sha256 through the seam ----------------
    {
      const problems = [];
      const r = await query("select task_id, file from task_attachments order by task_id, file", []);
      const pgKeys = new Set(r.rows.map((x) => `${x.task_id} ${x.file}`));
      const fileKeys = new Set(ds.attachments.map((a) => `${a.taskId} ${a.file}`));
      for (const k of fileKeys) if (!pgKeys.has(k)) problems.push(`blob missing on pg side: ${k.replace(" ", "/")}`);
      for (const k of pgKeys) if (!fileKeys.has(k)) problems.push(`extra pg blob: ${k.replace(" ", "/")}`);
      for (const a of ds.attachments) {
        const fPath = fileStore.attachmentFilePath(a.taskId, a.file);
        const pPath = pgStore.attachmentFilePath(a.taskId, a.file); // re-materializes from bytea (the SoT)
        if (!fPath || !pPath || !fs.existsSync(pPath)) {
          problems.push(`attachmentFilePath failed for ${a.taskId}/${a.file}`);
          continue;
        }
        if (sha256(fs.readFileSync(fPath)) !== sha256(fs.readFileSync(pPath))) {
          problems.push(`sha256 mismatch for ${a.taskId}/${a.file}`);
        }
      }
      record("task attachments (sha256)", ds.attachments.length, r.rows.length, problems);
    }

    // ---- requests --------------------------------------------------------------
    {
      const problems = [];
      const f = fileStore.loadRequests();
      const p = pgStore.loadRequests();
      if (!isDeepStrictEqual(p, f)) problems.push("loadRequests() differs");
      record("requests", f.requests.length, p.requests.length, problems);
    }

    // ---- discovery sources (incl. the version + updated header) ---------------
    {
      const problems = [];
      const f = fileStore.loadSources();
      const p = pgStore.loadSources();
      if (!isDeepStrictEqual(p, f)) problems.push("loadSources() differs (sources/version/updated)");
      record("discovery sources", f.sources.length, p.sources.length, problems);
    }

    // ---- chats -----------------------------------------------------------------
    {
      const problems = [];
      const f = fileStore.loadChats();
      const p = pgStore.loadChats();
      if (!isDeepStrictEqual(p, f)) problems.push("loadChats() differs");
      record("job chats", Object.keys(f).length, Object.keys(p).length, problems);
    }

    // ---- activity log: line count + per-line parsed equality -------------------
    // (parsed, not raw text: jsonb canonicalizes KEY ORDER, semantically
    // irrelevant - every consumer JSON.parses each line. Same posture as the
    // differential suite.)
    {
      const problems = [];
      const f = parseJsonl(fileStore.readActivityText());
      const p = parseJsonl(pgStore.readActivityText());
      if (f.length !== p.length) problems.push(`line count file=${f.length} pg=${p.length}`);
      const n = Math.min(f.length, p.length);
      for (let i = 0; i < n; i++) {
        if (!isDeepStrictEqual(f[i], p[i])) problems.push(`line ${i + 1} differs`);
      }
      record("activity log (per line)", f.length, p.length, problems);
    }

    // ---- telemetry --------------------------------------------------------------
    {
      const problems = [];
      const f = parseJsonl(fileStore.readTelemetryText());
      const p = parseJsonl(pgStore.readTelemetryText());
      if (f.length !== p.length) problems.push(`line count file=${f.length} pg=${p.length}`);
      const n = Math.min(f.length, p.length);
      for (let i = 0; i < n; i++) {
        if (!isDeepStrictEqual(f[i], p[i])) problems.push(`line ${i + 1} differs`);
      }
      record("telemetry (per line)", f.length, p.length, problems);
    }

    // ---- notify state ------------------------------------------------------------
    {
      const problems = [];
      const f = fileStore.loadNotifyState();
      const p = pgStore.loadNotifyState();
      if (!isDeepStrictEqual(p, f)) problems.push("loadNotifyState() differs");
      record("notify state", f.initialized ? 1 : 0, p.initialized ? 1 : 0, problems);
    }
  } finally {
    pgStore.close();
    try {
      fs.rmSync(blobDir, { recursive: true, force: true });
    } catch {
      /* scratch cache; ignore */
    }
  }

  // ---- the verification table -------------------------------------------------
  const w1 = Math.max(...rows.map((r) => r.domain.length), 6) + 2;
  log("");
  log(`${"domain".padEnd(w1)}| file-side | pg-side | match`);
  log(`${"-".repeat(w1)}|-----------|---------|------`);
  for (const r of rows) {
    log(`${r.domain.padEnd(w1)}| ${String(r.fileCount).padStart(9)} | ${String(r.pgCount).padStart(7)} | ${r.ok ? "OK" : "FAIL"}`);
  }
  log("");
  return { rows, mismatches };
}

// ============================================================================
// entry point
// ============================================================================

export function resolveOptions(argv = [], env = process.env) {
  const opts = {
    jobsDir: env.JOBS_DIR || null,
    dataDir: env.DATA_DIR || null,
    docsDir: env.DOCS_DIR || null,
    databaseUrl: env.DATABASE_URL || null,
    verifyOnly: false,
    forceEmptyCheckBypass: false,
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
    if (a.startsWith("--jobs-dir")) opts.jobsDir = grab();
    else if (a.startsWith("--data-dir")) opts.dataDir = grab();
    else if (a.startsWith("--docs-dir")) opts.docsDir = grab();
    else if (a === "--verify-only") opts.verifyOnly = true;
    else if (a === "--force-empty-check-bypass") opts.forceEmptyCheckBypass = true;
    else fail(`unknown argument: ${a}`);
  }
  if (!opts.jobsDir) fail("missing source jobs dir: pass --jobs-dir or set JOBS_DIR");
  if (!opts.dataDir) fail("missing source data dir: pass --data-dir or set DATA_DIR");
  if (!opts.docsDir) fail("missing source docs dir: pass --docs-dir or set DOCS_DIR");
  if (!opts.databaseUrl) fail("missing target: set DATABASE_URL");
  opts.jobsDir = path.resolve(opts.jobsDir);
  opts.dataDir = path.resolve(opts.dataDir);
  opts.docsDir = path.resolve(opts.docsDir);
  return opts;
}

export async function migrateData(opts, log = (m) => console.log(m)) {
  const { jobsDir, dataDir, docsDir, databaseUrl, verifyOnly, forceEmptyCheckBypass } = opts;
  const redacted = databaseUrl.replace(/:\/\/([^:@/]+):[^@/]+@/, "://$1:***@");
  log(`[migrate-data] source jobs dir: ${jobsDir}`);
  log(`[migrate-data] source data dir: ${dataDir}`);
  log(`[migrate-data] source docs dir: ${docsDir}`);
  log(`[migrate-data] target:          ${redacted}`);
  log(`[migrate-data] mode:            ${verifyOnly ? "VERIFY-ONLY (no import)" : "import + verify"}`);
  if (!fs.existsSync(jobsDir)) fail(`source jobs dir does not exist: ${jobsDir}`);
  if (!fs.existsSync(dataDir)) fail(`source data dir does not exist: ${dataDir}`);
  if (!fs.existsSync(docsDir)) fail(`source docs dir does not exist: ${docsDir}`);

  const deps = await loadDomainDeps();

  // 1. STRICT source read - before any DB connection is opened, so a source
  //    anomaly can never leave the target half-touched.
  const ds = readSourceDataset({ jobsDir, dataDir, docsDir }, log);

  // 2. Target work.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertSchemaMigrated(client);
    if (!verifyOnly) {
      await assertEmptyTarget(client, forceEmptyCheckBypass, log);
      await client.query("begin");
      try {
        await importDataset(client, ds, deps, log);
        await client.query("commit");
      } catch (e) {
        try {
          await client.query("rollback");
        } catch {
          /* connection may be gone */
        }
        log("[import] FAILED - transaction rolled back; the target is unchanged.");
        throw e;
      }
      log("[import] committed.");
    }

    // 3. VERIFY through the Store seam.
    const { rows, mismatches } = await verifyEquivalence(
      { ds, paths: { jobsDir, dataDir, docsDir }, databaseUrl, query: (t, v) => client.query(t, v) },
      log,
    );
    if (mismatches.length) {
      for (const m of mismatches.slice(0, 50)) log(`[verify] MISMATCH: ${m}`);
      if (mismatches.length > 50) log(`[verify] ... and ${mismatches.length - 50} more`);
      fail(`verification FAILED: ${mismatches.length} mismatch(es). The file side remains untouched and authoritative.`);
    }
    log(`[verify] all ${rows.length} domains match. The Postgres copy is equivalent through the Store seam.`);
    return { ok: true, rows, warnings: ds.warnings };
  } finally {
    await client.end();
  }
}

// ---- CLI --------------------------------------------------------------------
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const opts = resolveOptions(process.argv.slice(2), process.env);
      await migrateData(opts);
      process.exit(0);
    } catch (e) {
      console.error(`[migrate-data] ABORT: ${e && e.message ? e.message : e}`);
      process.exit(1);
    }
  })();
}
