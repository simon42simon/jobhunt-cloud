// RC-3 / SIM-87 I4 - PgStore: the Postgres implementation of the storage seam
// (ADR-025). Implements the SAME interface as FileStore (server/store.js), so the
// route handlers and the pure derivations are untouched and the ONE contract suite
// (tests/store-contract.test.js) runs against both backends.
//
// ============================ THE LOAD-BEARING DEVIATIONS ====================
// D1  SYNCHRONOUS over async pg. The landed Store interface is synchronous (routes
//     do `res.json(store.loadTasks())`; the contract asserts without `await`).
//     PgStore keeps that interface by running every query on a worker thread and
//     BLOCKING the main thread on Atomics.wait until the worker answers (see
//     server/pg-sync.js + pg-worker.js). This is correct but SERIALIZES DB access
//     and blocks the event loop per call - acceptable for the single-owner private
//     instance and the low-traffic demo (RC-2/RC-4), but the Store interface should
//     go ASYNC (routes `await store.x()`) before PgStore serves real concurrency.
//     Flagged to the CTO as the top follow-up; out of this parcel's scope (it would
//     rewrite every route handler and the contract-suite bodies, contra the DoD).
// D2  BLOBS (task attachments, job artifacts, companion notes) are canonical in
//     Postgres `bytea`. Because the landed interface serves attachments via a
//     filesystem PATH (`attachmentFilePath` -> route `createReadStream`), PgStore
//     also keeps a LOCAL, disposable cache under `blobDir`, lazily re-materialized
//     from bytea. bytea is the single source of truth (durable on Railway's
//     ephemeral FS); the cache is a derived read-through, never authoritative.
//     openJobFile streams straight from bytea (no cache needed).
// D3  JSONB-DOCUMENT stores for the DATA_DIR docs FileStore treats as opaque
//     (tasks/requests/notify/chats) and discovery_sources: each row is the parsed
//     domain object as `doc jsonb`, mirroring FileStore's serialize->store->parse
//     round-trip EXACTLY (guarantees the differential; no missed-column data loss).
//     Jobs keep the design's typed frontmatter columns; append streams + true blobs
//     get real relational/bytea rows. See migrations/0001_init.cjs header.
//
// Parameterized queries ONLY (guardian MF-12): every value crosses as a bound
// parameter; the only interpolated SQL fragments are column names drawn from
// CONSTANT whitelists (never from client input).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import { SyncPg } from "./pg-sync.js";
import {
  WRITABLE_FIELDS,
  sanitizeForPath,
  yamlScalar,
  normDate,
  parseLeadWith,
  parseFront,
  localDateISO,
  ensureArrays,
} from "./lib.js";
import { isDatedCopy, currentFiles, isPrepDoc, jobFileKind, LEDGER_ARRAYS, normalizeRequest } from "./store-helpers.js";
import { mintNonce, constantTimeEqualHex, RUNNER_LEASE_MS, RUNNER_MAX_ATTEMPTS } from "./runner-lib.js";
// SIM-393 I1 - the vault->cloud sync ingest seam (shared with FileStore; guardian
// GC-1's ONE name validator + sync-lib's content hashing / migrate-data-parity
// front validation), so the two backends can never drift on sync semantics.
import { assertSafeName } from "./name-safety.js";
import { sha256Hex, rowShaOf, validateJobFront } from "./sync-lib.js";

// WRITABLE_FIELDS -> jobs column. Keys are the ONLY frontmatter fields the surgical
// patch may touch (mirrors updateFrontmatter's gate); column names are constants.
const WRITABLE_COLUMN = {
  status: "status",
  fit: "fit",
  track: "track",
  sector: "sector",
  tailoring: "tailoring",
  deadline: "deadline",
  applied: "applied",
  next_action: "next_action",
  next_action_date: "next_action_date",
  link: "link",
};

// Every data table, for the test-only TRUNCATE reset (helpers use it via the
// exported truncateAllForTests). board_config is re-seeded after.
const DATA_TABLES = [
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
  "webauthn_credentials",
  "board_config",
];

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// jsonb bind helper. node-postgres binds a JS OBJECT to jsonb correctly, but a JS
// ARRAY it binds as a Postgres ARRAY literal ("{...}") - which a jsonb column
// rejects (a per-job chat transcript is a top-level array). So every jsonb value is
// sent as a JSON STRING against a `$n::jsonb` placeholder: unambiguous for both
// objects and arrays. Reads still come back as parsed JS (pg parses jsonb on read).
const J = (v) => JSON.stringify(v == null ? null : v);

const extOf = (name) => path.extname(name).toLowerCase().replace(".", "");
const msOf = (ts) => (ts ? new Date(ts).getTime() : 0);

export class PgStore {
  // { url, docsDir, blobDir?, deps } - deps = { TRACKS, STATUSES, dropInvalidJobEnums,
  // normalizeSource, serializeSource }, same injected domain helpers FileStore takes.
  constructor({ url, docsDir, blobDir, deps = {} }) {
    this.url = url;
    this.docsDir = docsDir ? path.resolve(docsDir) : null;
    this.blobDir = blobDir
      ? path.resolve(blobDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-pgblob-"));
    this.deps = deps;
    this.pg = new SyncPg();
    this.pg.connect(this.url);
    // Fail-fast (design 3.3): refuse to serve an unmigrated database.
    const r = this.pg.query("select to_regclass('public.jobs') as t", []);
    if (!r.rows[0] || !r.rows[0].t) {
      throw new Error("PgStore: schema not migrated - run `node-pg-migrate up` before boot");
    }
  }

  init() {
    /* connected in the constructor; kept for interface parity with FileStore */
  }
  close() {
    if (this.pg) this.pg.close();
  }

  // ---- tiny query helpers ----------------------------------------------------
  _all(text, values) {
    return this.pg.query(text, values).rows;
  }
  _one(text, values) {
    return this.pg.query(text, values).rows[0] || null;
  }

  // ======================================================================
  // JOBS domain
  // ======================================================================

  // Cloud has no desktop folder to open (design 2.2); the OS-open routes degrade
  // a null folder to the guarded reader / hidden button.
  jobFolderPath() {
    return null;
  }
  resolveOpenTarget() {
    return null;
  }

  _jobFileRows(id) {
    return this._all(
      "select name, mime, kind, bytes, updated_at from job_files where job_id=$1",
      [id],
    );
  }

  // Build the job DTO from a jobs row + its job_files rows. Byte-for-byte the same
  // shape FileStore._buildJob returns; the readiness flags are derived from the
  // job_files rows (design: "PgStore supplies readiness from rows"). Filesystem-only
  // fields (folderPath/jobFile/jobFileName/mtime) are null/0 - the differential
  // excludes them by construction.
  _rowToJob(row, fileRows) {
    const { TRACKS, STATUSES } = this.deps;
    const files = (fileRows || []).map((f) => ({ name: f.name, ext: extOf(f.name), mtime: msOf(f.updated_at) }));
    const cur = currentFiles(files);
    const lower = (s) => (s || "").toLowerCase();
    const cvFile = cur.find((f) => lower(f.name).includes("cv") && (f.ext === "docx" || f.ext === "pdf"));
    const coverFile = cur.find((f) => lower(f.name).includes("cover") && (f.ext === "docx" || f.ext === "pdf"));
    const gapsFile = cur.find((f) => lower(f.name).includes("gaps") && f.ext === "md");
    const hasCV = !!cvFile;
    const hasCoverLetter = !!coverFile;
    const status = STATUSES.includes(row.status) ? row.status : "lead";
    const gapsAnswered = !!(cvFile && gapsFile) && gapsFile.mtime > cvFile.mtime;
    const finalizeReady = status === "drafted" && hasCV && gapsAnswered;
    const appliedDate = normDate(row.applied);
    const interviewPrepDone = cur.some((f) => isPrepDoc(f.name));
    const offerPrepDone = cur.some((f) => f.ext === "md" && /offer|negotiation/.test(lower(f.name)));
    const followUpDone = cur.some((f) => f.ext === "md" && /follow[- ]?up/.test(lower(f.name)));
    const draftDone = hasCV || hasCoverLetter;
    const finalizeDone = ["ready", "submitted", "interview", "offer"].includes(status) || !!appliedDate;
    const mergePdfReady =
      cur.some((f) => lower(f.name).includes("cv") && f.ext === "pdf") &&
      cur.some((f) => lower(f.name).includes("cover") && f.ext === "pdf");
    const mergedPdfDone = cur.some((f) => f.ext === "pdf" && lower(f.name).includes("application"));
    return {
      id: row.id,
      folder: row.id,
      folderPath: null,
      jobFile: null,
      jobFileName: null,
      role: row.role || "",
      employer: row.employer || "",
      track: row.track || "",
      trackLabel: TRACKS[row.track] || row.track || "",
      fit: row.fit || "",
      status,
      rawStatus: row.status || "",
      sector: row.sector || "",
      tailoring: row.tailoring || "",
      deadline: normDate(row.deadline),
      applied: normDate(row.applied),
      link: row.link || "",
      source: row.source != null ? String(row.source) : "",
      nextAction: row.next_action || "",
      nextActionDate: normDate(row.next_action_date),
      tags: Array.isArray(row.tags) ? row.tags : row.tags ? [row.tags] : [],
      leadWith: parseLeadWith(row.body || ""),
      files: files.map((f) => ({ name: f.name, ext: f.ext })),
      hasCV,
      hasCoverLetter,
      gapsAnswered,
      finalizeReady,
      draftDone,
      finalizeDone,
      interviewPrepDone,
      offerPrepDone,
      followUpDone,
      mergePdfReady,
      mergedPdfDone,
      mtime: msOf(row.updated_at),
    };
  }

  listJobs() {
    const jobs = this._all("select * from jobs order by id", []);
    const files = this._all("select job_id, name, mime, kind, updated_at from job_files", []);
    const byJob = {};
    for (const f of files) (byJob[f.job_id] ||= []).push(f);
    return jobs.map((j) => this._rowToJob(j, byJob[j.id] || []));
  }

  getJobSummary(id) {
    const row = this._one("select * from jobs where id=$1", [id]);
    if (!row) return null;
    return this._rowToJob(row, this._jobFileRows(id));
  }

  getJob(id) {
    const row = this._one("select * from jobs where id=$1", [id]);
    if (!row) return null;
    const frows = this._jobFileRows(id);
    const job = this._rowToJob(row, frows);
    const readText = (pred) => {
      const hit = frows.find(pred);
      if (!hit) return null;
      return { name: hit.name, content: Buffer.from(hit.bytes).toString("utf8") };
    };
    const gaps = readText((f) => f.name.toLowerCase().includes("gaps") && extOf(f.name) === "md");
    const jd = readText((f) => f.name.toLowerCase().includes("job-description") && extOf(f.name) === "md");

    const prepRows = frows.filter((f) => !isDatedCopy(f.name) && isPrepDoc(f.name));
    const prep = prepRows
      .sort(
        (a, b) =>
          Number(a.name.toLowerCase().includes("star")) - Number(b.name.toLowerCase().includes("star")),
      )
      .map((hit) => {
        const raw = Buffer.from(hit.bytes).toString("utf8");
        const parsed = parseFront(raw);
        const content = (parsed && parsed.content != null ? parsed.content : raw).replace(/^\n+/, "");
        return { name: hit.name, content };
      });

    const feedbackPred = (f) => !isDatedCopy(f.name) && extOf(f.name) === "md" && f.name.toLowerCase().includes("feedback");
    const prepFeedback = readText(feedbackPred);
    const feedbackEntry = frows.find(feedbackPred);
    const newestPrepMtime = prepRows.reduce((m, f) => Math.max(m, msOf(f.updated_at)), 0);
    const prepFeedbackAnswered = !!feedbackEntry && prepRows.length > 0 && msOf(feedbackEntry.updated_at) > newestPrepMtime;
    const prepRefineReady = !!job.interviewPrepDone && prepFeedbackAnswered;

    const hasSubmitted = frows.some((f) => f.name.toLowerCase() === "application-content.json");

    return {
      ...job,
      body: row.body || "",
      gaps,
      jobDescription: jd,
      prep,
      prepFeedback,
      prepFeedbackAnswered,
      prepRefineReady,
      hasSubmitted,
    };
  }

  updateJobFields(id, updates) {
    const row = this._one("select id, raw_frontmatter from jobs where id=$1", [id]);
    if (!row) return null;
    const rf = { ...(row.raw_frontmatter || {}) };
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of WRITABLE_FIELDS) {
      if (!(key in updates)) continue;
      const col = WRITABLE_COLUMN[key];
      if (!col) continue;
      const v = updates[key];
      if (v === null || v === "") {
        sets.push(`${col}=NULL`);
        delete rf[key];
      } else {
        sets.push(`${col}=$${i++}`);
        vals.push(String(v));
        rf[key] = v;
      }
    }
    sets.push(`raw_frontmatter=$${i++}::jsonb`);
    vals.push(J(rf));
    sets.push("updated_at=now()");
    vals.push(id);
    this.pg.query(`update jobs set ${sets.join(", ")} where id=$${i}`, vals);
    return this.getJobSummary(id);
  }

  createJob({ role, employer, track, fit, status, sector, deadline, link, source }) {
    const { dropInvalidJobEnums } = this.deps;
    if (!role || !employer) throw httpError(400, "role and employer are required");
    const folderName = sanitizeForPath(`${role} - ${employer}`);
    if (this._one("select id from jobs where id=$1", [folderName])) {
      throw httpError(409, "a job folder with that name already exists");
    }
    const clean = dropInvalidJobEnums({ track, fit, sector, status });
    const sec = clean.sector || "private";
    const tailoring = sec === "private" ? "light" : "heavy";
    const trk = clean.track || "";
    const ft = clean.fit || "";
    // Build the SAME file text FileStore.createJob writes, then split it with the
    // SAME parseFront - so `body` + `raw_frontmatter` are identical to what
    // FileStore would produce on read (the differential relies on this).
    const fm = [
      "---",
      "type: job",
      `role: ${yamlScalar(role)}`,
      `employer: ${yamlScalar(employer)}`,
      `track: ${trk}`,
      `fit: ${ft}`,
      `status: ${clean.status || "lead"}`,
      `sector: ${sec}`,
      `tailoring: ${tailoring}`,
      ...(deadline ? [`deadline: ${deadline}`] : []),
      ...(link ? [`link: ${yamlScalar(link)}`] : []),
      ...(source ? [`source: ${yamlScalar(source)}`] : []),
      "tags: [job]",
      "---",
      "",
      `# ${role} - ${employer}`,
      "",
      `\`Track: ${trk || "(agent will assess)"}  |  Fit: ${ft || "(agent will assess)"}${deadline ? `  |  Deadline: ${deadline}` : ""}\``,
      "",
      "**Lead with:** ",
      "",
      "## Notes",
      "",
    ].join("\n");
    const parsed = parseFront(fm);
    const d = (parsed && parsed.data) || {};
    const body = parsed && parsed.content != null ? parsed.content : "";
    this.pg.query(
      `insert into jobs
        (id, role, employer, type, status, fit, track, sector, tailoring, deadline, applied,
         next_action, next_action_date, link, source, tags, body, raw_frontmatter)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
      [
        folderName,
        d.role || role,
        d.employer || employer,
        d.type || "job",
        d.status || null,
        d.fit || null,
        d.track || null,
        d.sector || null,
        d.tailoring || null,
        d.deadline != null ? String(d.deadline) : null,
        null,
        null,
        null,
        d.link || null,
        d.source != null ? String(d.source) : null,
        Array.isArray(d.tags) ? d.tags : d.tags ? [String(d.tags)] : [],
        body,
        J(d),
      ],
    );
    return this.getJobSummary(folderName);
  }

  // (frontmatter scalar quoting reuses lib.yamlScalar, shared with FileStore.)

  _upsertJobFile(jobId, name, mime, kind, buf) {
    // SIM-393 I1: every job_files write populates sha256 so the sync manifest never
    // re-hashes blobs per call (design B2). This is the runner/upsert path (overwrite
    // on name collision) - NOT the sync surface, which is insert-only via
    // addJobFileIfAbsent below.
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pg.query(
      `insert into job_files (job_id, name, mime, kind, bytes, sha256, updated_at)
       values ($1,$2,$3,$4,$5,$6, now())
       on conflict (job_id, name) do update
         set mime=excluded.mime, kind=excluded.kind, bytes=excluded.bytes,
             sha256=excluded.sha256, updated_at=now()`,
      [jobId, name, mime, kind, b, sha256Hex(b)],
    );
  }

  writeJobNote(id, name, content) {
    const row = this._one("select role from jobs where id=$1", [id]);
    if (!row) throw httpError(404, "job not found");
    const base = path.basename(name);
    const lower = base.toLowerCase();
    const sotName = `${sanitizeForPath(row.role)}.md`.toLowerCase();
    const allowed =
      lower.endsWith(".md") &&
      lower !== sotName &&
      !isDatedCopy(base) &&
      (lower.includes("gaps") || lower.includes("job-description") || lower.includes("feedback"));
    if (!allowed) throw httpError(400, "only the gaps, job-description, or feedback .md note may be written here");
    const kind = lower.includes("gaps") ? "gaps" : lower.includes("job-description") ? "job-description" : "feedback";
    this._upsertJobFile(id, base, "text/markdown", kind, Buffer.from(content, "utf8"));
    return { ok: true, name: base, bytes: Buffer.byteLength(content, "utf8") };
  }

  openJobFile(id, name) {
    if (!this._one("select id from jobs where id=$1", [id])) {
      return { ok: false, status: 404, error: "job folder not found" };
    }
    const base = path.basename(name);
    const row = this._one("select bytes from job_files where job_id=$1 and name=$2", [id, base]);
    if (!row) return { ok: false, status: 404, error: "file not found" };
    return { ok: true, stream: Readable.from(Buffer.from(row.bytes)), ext: extOf(base), name: base };
  }

  saveJobArtifact(id, name, mime, bytes) {
    if (!this._one("select id from jobs where id=$1", [id])) {
      throw httpError(404, "job folder not found");
    }
    const base = path.basename(name);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const lower = base.toLowerCase();
    const kind = lower.includes("cv") ? "cv" : lower.includes("cover") ? "cover" : "other";
    this._upsertJobFile(id, base, mime || null, kind, buf);
    return { name: base, mime: mime || null, bytes: buf.length };
  }

  // Cloud regenerate history is an I7 concern (the runner posts fresh artifacts);
  // no route calls this in the storage parcel. No-op keeps the never-delete
  // contract trivially (it never removes anything).
  backupRoutineOutputs() {}

  // ======================================================================
  // VAULT -> CLOUD SYNC INGEST (SIM-393 I1) - INSERT-ONLY, never overwrites
  // ======================================================================
  // The SAME observable contract FileStore.{syncManifest,createJobIfAbsent,
  // addJobFileIfAbsent} implement (the store-contract differential proves parity).
  // Insert-only BY CONSTRUCTION: `on conflict do nothing` + a row-count check, and
  // NO update/delete of an existing row/byte anywhere on this surface. The
  // poison-the-CV overwrite attack is structurally impossible (guardian W2).

  // Metadata + hashes only (design B2). rowSha from the stored raw_frontmatter +
  // body; per-file sha256 read straight from the column the migration backfilled
  // (and every write path now populates), so the manifest never re-hashes bytes.
  syncManifest() {
    const jobRows = this._all("select id, body, raw_frontmatter from jobs order by id", []);
    const jobs = jobRows.map((r) => ({ id: r.id, rowSha: rowShaOf(r.raw_frontmatter || {}, r.body || "") }));
    const fileRows = this._all(
      "select job_id, name, sha256, octet_length(bytes) as bytes_len from job_files order by job_id, name",
      [],
    );
    const files = fileRows.map((r) => ({
      jobId: r.job_id,
      name: r.name,
      sha256: r.sha256,
      bytesLen: Number(r.bytes_len),
    }));
    return { jobs, files };
  }

  // INSERT a jobs row from the vault's raw front + body (raw fidelity, EXACTLY as
  // migrate-data's importDataset), insert-only via `on conflict (id) do nothing`.
  // Returns { created:true, id } or { created:false, conflict:"job-exists" }.
  createJobIfAbsent({ id, role, employer, front, body = "", tags = [], mtimeIso = null }) {
    assertSafeName(id, "job id");
    const v = validateJobFront({ role, employer, front, tags });
    const d = v.front;
    const str = (x) => (x ? x : null); // STRING_COLS
    const scalar = (x) => (x == null || x === "" ? null : String(x)); // SCALAR_COLS
    const updatedAt = mtimeIso ? new Date(mtimeIso).toISOString() : new Date().toISOString();
    const r = this.pg.query(
      `insert into jobs
         (id, role, employer, type, status, fit, track, sector, tailoring, deadline, applied,
          next_action, next_action_date, link, source, tags, body, raw_frontmatter, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
       on conflict (id) do nothing`,
      [
        id,
        role,
        employer,
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
        v.tags,
        body == null ? "" : String(body),
        J(d),
        updatedAt,
      ],
    );
    if (r.rowCount === 1) return { created: true, id };
    return { created: false, conflict: "job-exists" };
  }

  // INSERT a companion file under an existing job, additively (design B3):
  //   unknown job -> {result:"job-not-found"}; absent -> insert; same sha -> noop;
  //   different bytes -> {result:"bytes-differ", cloudSha} (SKIP, cloud untouched).
  addJobFileIfAbsent(jobId, name, { mime = null, mtimeIso = null, bytes } = {}) {
    if (!this._one("select id from jobs where id=$1", [jobId])) return { result: "job-not-found" };
    assertSafeName(name, "file name");
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
    const sha = sha256Hex(buf);
    const existing = this._one("select sha256 from job_files where job_id=$1 and name=$2", [jobId, name]);
    if (existing) {
      if (existing.sha256 === sha) return { result: "noop", sha256: sha };
      return { result: "bytes-differ", sha256: sha, cloudSha: existing.sha256 };
    }
    const kind = jobFileKind(name);
    const updatedAt = mtimeIso ? new Date(mtimeIso).toISOString() : new Date().toISOString();
    const r = this.pg.query(
      `insert into job_files (job_id, name, mime, kind, bytes, sha256, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (job_id, name) do nothing`,
      [jobId, name, mime, kind, buf, sha, updatedAt],
    );
    if (r.rowCount === 1) return { result: "inserted", sha256: sha, kind, mime: mime || null };
    // A concurrent insert won the race: re-read and report against the winner,
    // never overwrite (insert-only degrades to noop/conflict, never clobber).
    const now = this._one("select sha256 from job_files where job_id=$1 and name=$2", [jobId, name]);
    if (now && now.sha256 === sha) return { result: "noop", sha256: sha };
    return { result: "bytes-differ", sha256: sha, cloudSha: now ? now.sha256 : null };
  }

  // ======================================================================
  // TASK BOARD
  // ======================================================================

  loadTasks() {
    const cfg = this._one("select columns from board_config where id=1", []);
    const columns = cfg && Array.isArray(cfg.columns) && cfg.columns.length ? cfg.columns : ["backlog", "todo", "in_progress", "done"];
    const tasks = this._all("select doc from tasks order by seq", []).map((r) => r.doc);
    for (const t of tasks) if (t && typeof t === "object" && !Array.isArray(t.comments)) t.comments = [];
    return { columns, tasks };
  }

  saveTasks(data) {
    // Mirror FileStore.saveTasks: drop an empty comments/attachments array so a task
    // that never had one round-trips clean (comments re-added as [] on read).
    const clean = (data.tasks || []).map((t) => {
      if (!t || typeof t !== "object") return t;
      let out = t;
      if (Array.isArray(out.comments) && out.comments.length === 0) {
        const { comments, ...rest } = out;
        out = rest;
      }
      if (Array.isArray(out.attachments) && out.attachments.length === 0) {
        const { attachments, ...rest } = out;
        out = rest;
      }
      return out;
    });
    const cols = Array.isArray(data.columns) ? data.columns : ["backlog", "todo", "in_progress", "done"];
    this._tx(() => {
      this.pg.query("delete from tasks", []);
      for (const t of clean) {
        const id = t && t.id != null ? String(t.id) : null;
        this.pg.query("insert into tasks (id, doc) values ($1, $2::jsonb)", [id, J(t)]);
      }
      this.pg.query("update board_config set columns=$1 where id=1", [cols]);
    });
  }

  // ======================================================================
  // TASK ATTACHMENTS (bytea canonical + read-through cache, deviation D2)
  // ======================================================================

  _attachmentCachePath(taskId, file) {
    const base = path.basename(file);
    const dir = path.join(this.blobDir, "attachments", path.basename(String(taskId)));
    const target = path.join(dir, base);
    const rel = path.relative(dir, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    return target;
  }

  saveAttachmentBlob(taskId, file, buffer) {
    const base = path.basename(file);
    this.pg.query(
      `insert into task_attachments (task_id, file, bytes_len, blob, ts)
       values ($1,$2,$3,$4, now())
       on conflict (task_id, file) do update set bytes_len=excluded.bytes_len, blob=excluded.blob`,
      [String(taskId), base, buffer.length, buffer],
    );
    const target = this._attachmentCachePath(taskId, file);
    if (target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }
    return target;
  }

  // Return a filesystem path the route can stream, re-materializing the byte-exact
  // blob from bytea (the SoT) when the local cache is cold. Null when the path would
  // escape the task's own dir (containment guard, same as FileStore).
  attachmentFilePath(taskId, file) {
    const target = this._attachmentCachePath(taskId, file);
    if (!target) return null;
    const base = path.basename(file);
    const row = this._one("select blob from task_attachments where task_id=$1 and file=$2", [String(taskId), base]);
    if (row && row.blob) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(row.blob));
    }
    return target;
  }

  // ======================================================================
  // INTAKE LEDGER / REQUESTS
  // ======================================================================

  loadRequests() {
    const rows = this._all("select doc from requests order by seq", []);
    const requests = [];
    for (const r of rows) {
      const norm = normalizeRequest(r.doc);
      if (norm) requests.push(norm);
    }
    return { requests };
  }

  saveRequests(data) {
    const list = Array.isArray(data.requests) ? data.requests : [];
    this._tx(() => {
      this.pg.query("delete from requests", []);
      for (const r of list) {
        const id = r && r.id != null ? String(r.id) : null;
        this.pg.query("insert into requests (id, doc, ts) values ($1,$2::jsonb,$3)", [id, J(r), r && typeof r.ts === "string" ? r.ts : null]);
      }
    });
  }

  // ======================================================================
  // WEBAUTHN CREDENTIALS (SIM-394 passkey second factor)
  // ======================================================================
  // Same observable contract as FileStore (tests/store-contract.test.js): plain
  // CRUD; policy (the >=2 rule / last-credential refusal) stays in the route
  // layer. publicKey is a base64url string; counter round-trips as a JS number
  // (bigint column -> pg returns a string -> Number() on read; the WebAuthn
  // counter is a uint32, safely inside Number range); created is ISO.

  _webauthnRow(r) {
    return {
      id: r.id,
      publicKey: r.public_key,
      counter: Number(r.counter) || 0,
      transports: Array.isArray(r.transports) ? r.transports : [],
      label: r.label == null ? null : r.label,
      created: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
  }

  listWebauthnCredentials() {
    return this._all(
      "select id, public_key, counter, transports, label, created_at from webauthn_credentials order by created_at, id",
      [],
    ).map((r) => this._webauthnRow(r));
  }

  countWebauthnCredentials() {
    const r = this._one("select count(*)::int as n from webauthn_credentials", []);
    return r ? Number(r.n) : 0;
  }

  getWebauthnCredential(id) {
    const r = this._one(
      "select id, public_key, counter, transports, label, created_at from webauthn_credentials where id=$1",
      [id],
    );
    return r ? this._webauthnRow(r) : null;
  }

  createWebauthnCredential({ id, publicKey, counter = 0, transports = [], label = null }) {
    if (typeof id !== "string" || !id || typeof publicKey !== "string" || !publicKey) {
      throw httpError(400, "credential id and publicKey are required");
    }
    if (this.getWebauthnCredential(id)) {
      throw httpError(409, "credential already registered");
    }
    this.pg.query(
      "insert into webauthn_credentials (id, public_key, counter, transports, label) values ($1,$2,$3,$4,$5)",
      [
        id,
        publicKey,
        Number(counter) || 0,
        Array.isArray(transports) ? transports.map(String) : [],
        label == null ? null : String(label),
      ],
    );
    return this.getWebauthnCredential(id);
  }

  updateWebauthnCredentialCounter(id, counter) {
    const r = this.pg.query("update webauthn_credentials set counter=$2 where id=$1", [id, Number(counter) || 0]);
    return { ok: (r.rowCount || 0) > 0 };
  }

  deleteWebauthnCredential(id) {
    const r = this.pg.query("delete from webauthn_credentials where id=$1", [id]);
    return { deleted: (r.rowCount || 0) > 0 };
  }

  // ======================================================================
  // ACTIVITY LOG (append-only)
  // ======================================================================

  appendActivity(record) {
    try {
      const rec = { ts: new Date().toISOString(), ...record };
      this.pg.query("insert into activity_log (line) values ($1::jsonb)", [J(rec)]);
    } catch (e) {
      console.error(`[jobhunt] activity append failed: ${e.message}`);
    }
  }

  readActivityText() {
    const rows = this._all("select line from activity_log order by id", []);
    if (!rows.length) return "";
    return rows.map((r) => JSON.stringify(r.line)).join("\n") + "\n";
  }

  // ======================================================================
  // USAGE TELEMETRY (append-only)
  // ======================================================================

  appendTelemetry(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    this._tx(() => {
      for (const e of events) this.pg.query("insert into telemetry_events (event) values ($1::jsonb)", [J(e)]);
    });
  }

  readTelemetryText() {
    const rows = this._all("select event from telemetry_events order by id", []);
    if (!rows.length) return "";
    return rows.map((r) => JSON.stringify(r.event)).join("\n") + "\n";
  }

  // ======================================================================
  // NOTIFICATION STATE
  // ======================================================================

  loadNotifyState() {
    const row = this._one("select doc from notify_state where id=1", []);
    if (!row) return { cursor: null, baseline: { tasks: {}, projects: [] }, initialized: false };
    const s = row.doc || {};
    const b = s && typeof s.baseline === "object" && s.baseline ? s.baseline : {};
    return {
      cursor: typeof s.cursor === "string" ? s.cursor : null,
      baseline: {
        tasks: b.tasks && typeof b.tasks === "object" && !Array.isArray(b.tasks) ? b.tasks : {},
        projects: Array.isArray(b.projects) ? b.projects : [],
      },
      initialized: true,
    };
  }

  saveNotifyState(state) {
    const out = {
      version: 1,
      cursor: state.cursor,
      baseline: { tasks: state.baseline.tasks, projects: state.baseline.projects },
      updatedAt: new Date().toISOString(),
    };
    this.pg.query(
      "insert into notify_state (id, doc, updated_at) values (1, $1::jsonb, now()) on conflict (id) do update set doc=excluded.doc, updated_at=now()",
      [J(out)],
    );
  }

  // ======================================================================
  // PER-JOB CHATS
  // ======================================================================

  loadChats() {
    const rows = this._all("select job_id, transcript from job_chats", []);
    const out = {};
    for (const r of rows) out[r.job_id] = r.transcript;
    return out;
  }

  saveChats(obj) {
    const map = obj && typeof obj === "object" ? obj : {};
    this._tx(() => {
      this.pg.query("delete from job_chats", []);
      for (const [jobId, transcript] of Object.entries(map)) {
        this.pg.query("insert into job_chats (job_id, transcript) values ($1, $2::jsonb)", [jobId, J(transcript)]);
      }
    });
  }

  // ======================================================================
  // DISCOVERY SOURCES
  // ======================================================================

  loadSources() {
    const { normalizeSource } = this.deps;
    const rows = this._all("select doc from discovery_sources order by seq", []);
    const sources = rows.map((r) => normalizeSource(r.doc));
    const meta = this._one("select version, updated from discovery_meta where id=1", []);
    return {
      version: meta && typeof meta.version === "number" ? meta.version : 1,
      updated: meta && typeof meta.updated === "string" ? meta.updated : null,
      sources,
    };
  }

  saveSources(data) {
    const { normalizeSource, serializeSource } = this.deps;
    const serialized = (data.sources || []).map((s) => serializeSource(normalizeSource(s)));
    this._tx(() => {
      this.pg.query("delete from discovery_sources", []);
      for (const s of serialized) {
        this.pg.query(
          "insert into discovery_sources (id, sector, active, type, doc) values ($1,$2,$3,$4,$5::jsonb)",
          [s.id, s.sector || null, s.active || null, s.type || null, J(s)],
        );
      }
      this.pg.query(
        "insert into discovery_meta (id, version, updated) values (1, 1, $1) on conflict (id) do update set version=1, updated=excluded.updated",
        [localDateISO()],
      );
    });
  }

  // ======================================================================
  // READ-ONLY LEDGERS (bundled repo files in BOTH stores, design 2.2)
  // ======================================================================

  _readLedger(name) {
    const raw = fs.readFileSync(path.join(this.docsDir, name), "utf8");
    return ensureArrays(yaml.load(raw, { schema: yaml.JSON_SCHEMA }), LEDGER_ARRAYS[name]);
  }
  getRoadmap() {
    return this._readLedger("roadmap.yaml");
  }
  getPortfolio() {
    return this._readLedger("portfolio.yaml");
  }
  getAgents() {
    return this._readLedger("agents.yaml");
  }

  // ======================================================================
  // HYBRID RUNNER QUEUE (agent_jobs) - RC-3 / SIM-87 I7
  // ======================================================================
  // The cloud's OUTBOUND queue the laptop polls (design section 4). Claim is
  // FOR UPDATE SKIP LOCKED so a double-claim is STRUCTURALLY impossible; the nonce
  // is a single-use CSPRNG value; the lease + attempts-cap-3 bound retries. Every
  // value is a bound parameter (MF-12); payload/result/progress cross as jsonb.

  // Return expired claimed/running jobs to the queue; cap-exhausted ones to dead.
  _sweepExpiredAgentJobs(maxAttempts) {
    this.pg.query(
      `update agent_jobs
         set status = case when attempts >= $1 then 'dead' else 'queued' end,
             error  = case when attempts >= $1 then coalesce(error, 'lease expired; attempts exhausted') else error end,
             claimed_by = null, claimed_at = null, lease_expires_at = null, nonce = null, updated_at = now()
       where status in ('claimed','running') and lease_expires_at < now()`,
      [maxAttempts],
    );
  }

  enqueueAgentJob({ kind, jobId = null, payload = {} }) {
    const id = `aj-${Date.now()}-${mintNonce().slice(0, 8)}`;
    this.pg.query(
      `insert into agent_jobs (id, kind, job_id, payload, status) values ($1,$2,$3,$4::jsonb,'queued')`,
      [id, kind, jobId, J(payload)],
    );
    return { id };
  }

  claimAgentJob(runnerId, { leaseMs = RUNNER_LEASE_MS, maxAttempts = RUNNER_MAX_ATTEMPTS } = {}) {
    const nonce = mintNonce();
    let row = null;
    this._tx(() => {
      this._sweepExpiredAgentJobs(maxAttempts);
      const r = this.pg.query(
        `update agent_jobs
           set status='claimed', claimed_by=$1, claimed_at=now(),
               lease_expires_at = now() + ($2::bigint) * interval '1 millisecond',
               last_heartbeat_at = now(), attempts = attempts + 1, nonce=$3, updated_at=now()
         where id = (
           select id from agent_jobs
            where status='queued' and attempts < $4
            order by created_at
            for update skip locked
            limit 1)
         returning id, kind, job_id, payload, nonce, attempts`,
        [runnerId, leaseMs, nonce, maxAttempts],
      );
      row = r.rows[0] || null;
    });
    if (!row) return null;
    return { id: row.id, kind: row.kind, jobId: row.job_id, payload: row.payload, nonce: row.nonce, attempts: row.attempts };
  }

  heartbeatAgentJob(id, runnerId, { leaseMs = RUNNER_LEASE_MS } = {}) {
    const r = this.pg.query(
      `update agent_jobs
         set status='running', lease_expires_at = now() + ($1::bigint) * interval '1 millisecond',
             last_heartbeat_at = now(), updated_at = now()
       where id=$2 and claimed_by=$3 and status in ('claimed','running')
       returning lease_expires_at`,
      [leaseMs, id, runnerId],
    );
    if (!r.rows[0]) return { ok: false };
    return { ok: true, leaseExpiresAt: r.rows[0].lease_expires_at };
  }

  appendAgentJobProgress(id, runnerId, lines) {
    const add = (Array.isArray(lines) ? lines : [lines]).map(String);
    const r = this.pg.query(
      `update agent_jobs
         set progress = (
           select to_jsonb(array(select value::text from jsonb_array_elements_text(progress || $1::jsonb)))
         ), updated_at = now()
       where id=$2 and claimed_by=$3 and status not in ('done','failed','dead')
       returning id`,
      [J(add), id, runnerId],
    );
    return { ok: !!r.rows[0] };
  }

  agentJobById(id) {
    const row = this._one("select * from agent_jobs where id=$1", [id]);
    if (!row) return null;
    return {
      id: row.id, kind: row.kind, jobId: row.job_id, payload: row.payload, status: row.status,
      nonce: row.nonce, claimedBy: row.claimed_by, attempts: row.attempts,
      progress: row.progress || [], result: row.result, error: row.error,
      leaseExpiresAt: row.lease_expires_at, lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  completeAgentJob(id, { runnerId, nonce, status, error = null, result = null }) {
    let out = { ok: false, reason: "agent job not found", notFound: true };
    this._tx(() => {
      const row = this._one("select id, kind, job_id, status, nonce, claimed_by from agent_jobs where id=$1", [id]);
      if (!row) return;
      if (row.status === "done" || row.status === "failed" || row.status === "dead") {
        out = { ok: true, idempotent: true, jobId: row.job_id, kind: row.kind };
        return;
      }
      if (row.claimed_by !== runnerId || (row.status !== "claimed" && row.status !== "running")) {
        out = { ok: false, reason: "job is not claimed by this runner" };
        return;
      }
      if (!row.nonce || !constantTimeEqualHex(row.nonce, nonce)) {
        out = { ok: false, reason: "nonce mismatch (stale or replayed result)" };
        return;
      }
      const finalStatus = status === "failed" ? "failed" : "done";
      this.pg.query(
        `update agent_jobs set status=$1, result=$2::jsonb, error=$3, nonce=null, updated_at=now() where id=$4`,
        [finalStatus, J(result), finalStatus === "failed" ? error || "runner reported failure" : null, id],
      );
      out = { ok: true, jobId: row.job_id, kind: row.kind };
    });
    return out;
  }

  runnerQueueState() {
    const rows = this._all("select status, count(*)::int as n from agent_jobs group by status", []);
    const counts = { queued: 0, claimed: 0, running: 0, done: 0, failed: 0, dead: 0 };
    for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] = r.n;
    const meta = this._one(
      "select max(last_heartbeat_at) as hb, min(created_at) filter (where status='queued') as oq from agent_jobs",
      [],
    );
    return {
      counts,
      lastHeartbeatAt: meta && meta.hb ? new Date(meta.hb).toISOString() : null,
      oldestQueuedAt: meta && meta.oq ? new Date(meta.oq).toISOString() : null,
    };
  }

  // ======================================================================
  // internals
  // ======================================================================

  _tx(fn) {
    this.pg.query("begin", []);
    try {
      fn();
      this.pg.query("commit", []);
    } catch (e) {
      try {
        this.pg.query("rollback", []);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // Wipe every table + re-seed the single board_config row. Used by the DEMO
  // nightly reset (design 5.3 / MF-10) to return the demo DB to a pristine seed,
  // and by the contract suite to isolate one test from the next. The demo reset
  // re-applies the fictional seed AFTER this; here we only clear + re-seed the
  // board_config singleton. Never wired on the real/private instance.
  resetAll() {
    this.pg.query(`truncate ${DATA_TABLES.join(", ")} restart identity cascade`, []);
    this.pg.query("insert into board_config (id) values (1)", []);
  }
  // TEST-ONLY alias kept so the existing contract-suite harness call is unchanged.
  truncateAllForTests() {
    this.resetAll();
  }
}
