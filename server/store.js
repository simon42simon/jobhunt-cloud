// Storage seam (RC-3 / SIM-87, ADR-025). The ONE boundary every persistent
// read/write crosses, so a cloud deployment can swap the file backend for a
// Postgres one WITHOUT touching a single route handler or pure derivation.
//
// The seam cuts at the LOGICAL data-operation boundary (load*/save*/append*/
// read*/updateJobFields/createJob/...), never at raw `fs` (too fine) and never at
// HTTP (too coarse). The store returns and accepts PARSED DOMAIN OBJECTS (plus
// raw bytes for blobs), never serialized YAML/markdown strings - serialization is
// each store's private business. The DERIVED overlays (toJob's readiness flags,
// deriveSources, the notification fold, computeInterviewConsistency, ...) stay as
// storage-agnostic pure functions in the route layer, consuming what the store
// returns; they are NOT duplicated per backend.
//
// This module is the FileStore: today's exact file logic, moved verbatim behind
// the interface and parameterized on { jobsDir, docsDir, dataDir }. It is
// BYTE-IDENTICAL to the pre-seam server - the whole existing test suite plus the
// parameterized store-contract suite (tests/store-contract.test.js) is the
// regression proof. It is importable + constructable against a temp dir WITHOUT
// booting the server, which is what lets the contract suite exercise it directly.
//
// SSE / live-reload note (design 2.4): the store does NOT own the SSE channel -
// the ROUTE broadcasts. FileStore's jobs-changed signal is the external chokidar
// watcher on JOBS_DIR (still wired in index.js); every DATA_DIR/DOCS_DIR mutation
// is followed by an explicit route-level broadcast(). That posture is unchanged.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  writeFileAtomic,
  updateFrontmatter,
  appendJsonl,
  isInsideJobsDir,
  sanitizeForPath,
  yamlScalar,
  normDate,
  parseLeadWith,
  parseFront,
  localDateISO,
  ensureArrays,
} from "./lib.js";
// Pure name/listing/normalization helpers now SHARED with PgStore (I4) so the two
// backends can never drift. Extracted verbatim from the private helpers that lived
// here; the store-contract + full suite prove FileStore is unchanged.
import {
  isDatedCopy,
  currentFiles,
  localDateStamp,
  isPrepDoc,
  LEDGER_ARRAYS,
  normalizeRequest,
} from "./store-helpers.js";
// Hybrid-runner queue policy + primitives (RC-3 / SIM-87 I7), shared with PgStore
// so the two backends can never drift on lease/attempts/nonce semantics.
import {
  mintNonce,
  constantTimeEqualHex,
  RUNNER_LEASE_MS,
  RUNNER_MAX_ATTEMPTS,
} from "./runner-lib.js";

export class FileStore {
  // deps carries the pure DOMAIN helpers that live (exported + directly tested)
  // in index.js and must not be duplicated: the job enum vocabularies + guard,
  // and the discovery-source normalize/serialize round-trip. Injected rather than
  // imported to avoid a store<->index circular import while keeping index.js the
  // single home for those exported-and-tested functions.
  constructor({ jobsDir, docsDir, dataDir, deps = {} }) {
    this.jobsDir = path.resolve(jobsDir);
    this.docsDir = path.resolve(docsDir);
    this.dataDir = path.resolve(dataDir);
    this.deps = deps; // { TRACKS, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource }

    // DATA_DIR stores (server-written, out of git).
    this.tasksFile = path.join(this.dataDir, "tasks.yaml");
    this.requestsFile = path.join(this.dataDir, "requests.yaml");
    this.activityFile = path.join(this.dataDir, "activity-log.jsonl");
    this.usageTelemetryFile = path.join(this.dataDir, "usage-telemetry.jsonl");
    this.notifyStateFile = path.join(this.dataDir, "notify-state.json");
    this.chatsFile = path.join(this.dataDir, "job-chats.json");
    this.attachmentsDir = path.join(this.dataDir, "attachments");

    // DOCS_DIR store (app-managed repo content).
    this.sourcesFile = path.join(this.docsDir, "discovery-sources.yaml");
  }

  // Lifecycle. FileStore has no connection to open; the vault dir is asserted by
  // index.js at boot. Kept for interface parity with PgStore (I4).
  init() {}
  close() {}

  // ======================================================================
  // JOBS domain (JOBS_DIR, markdown+frontmatter)
  // ======================================================================

  // Resolve + CONTAIN a client-supplied jobId to a real folder INSIDE Jobs/. A
  // traversal id ("../foo") can never aim outside the vault's Jobs/ tree.
  // Returns the absolute folder path, or null to reject.
  jobFolderPath(jobId) {
    if (typeof jobId !== "string" || !jobId) return null;
    const folderPath = path.join(this.jobsDir, jobId);
    if (!isInsideJobsDir(this.jobsDir, folderPath) || !fs.existsSync(folderPath)) return null;
    return folderPath;
  }

  // Find the one .md in a folder whose frontmatter type is "job".
  _findJobFile(folderPath) {
    let entries;
    try {
      entries = fs.readdirSync(folderPath);
    } catch {
      return null;
    }
    const mdFiles = entries.filter((f) => f.toLowerCase().endsWith(".md"));
    for (const f of mdFiles) {
      const full = path.join(folderPath, f);
      try {
        const parsed = parseFront(fs.readFileSync(full, "utf8"));
        if (parsed && parsed.data && parsed.data.type === "job") {
          return { name: f, path: full, data: parsed.data, body: parsed.content };
        }
      } catch {
        /* ignore unparseable files */
      }
    }
    return null;
  }

  _listFolderFiles(folderPath) {
    try {
      return fs
        .readdirSync(folderPath, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => ({
          name: d.name,
          ext: path.extname(d.name).toLowerCase().replace(".", ""),
        }));
    } catch {
      return [];
    }
  }

  // mtimeMs of a folder file, tolerant: a missing / unreadable stat yields 0.
  _fileMtimeMs(folderPath, entry) {
    if (!entry) return 0;
    try {
      return fs.statSync(path.join(folderPath, entry.name)).mtimeMs;
    } catch {
      return 0;
    }
  }

  // Build the job DTO for one folder (was toJob). Contains the readiness
  // derivation because in the file world that derivation IS filesystem I/O
  // (mtimes, artifact existence); PgStore reconstructs the same DTO from its
  // rows/blobs. Output is byte-identical to the pre-seam toJob.
  _buildJob(folder) {
    const { TRACKS, STATUSES } = this.deps;
    const folderPath = path.join(this.jobsDir, folder);
    const jobFile = this._findJobFile(folderPath);
    if (!jobFile) return null;
    const d = jobFile.data;
    const files = this._listFolderFiles(folderPath);
    const cur = currentFiles(files);
    const lower = (s) => (s || "").toLowerCase();
    const cvFile = cur.find((f) => lower(f.name).includes("cv") && (f.ext === "docx" || f.ext === "pdf"));
    const coverFile = cur.find((f) => lower(f.name).includes("cover") && (f.ext === "docx" || f.ext === "pdf"));
    const gapsFile = cur.find(
      (f) => f.name !== jobFile.name && lower(f.name).includes("gaps") && f.ext === "md",
    );
    const hasCV = !!cvFile;
    const hasCoverLetter = !!coverFile;
    const status = STATUSES.includes(d.status) ? d.status : "lead";
    let mtime = 0;
    try {
      mtime = fs.statSync(jobFile.path).mtimeMs;
    } catch {}
    const gapsAnswered =
      !!(cvFile && gapsFile) &&
      this._fileMtimeMs(folderPath, gapsFile) > this._fileMtimeMs(folderPath, cvFile);
    const finalizeReady = status === "drafted" && hasCV && gapsAnswered;
    const appliedDate = normDate(d.applied);
    const interviewPrepDone = cur.some((f) => f.name !== jobFile.name && isPrepDoc(f.name));
    const offerPrepDone = cur.some((f) => f.ext === "md" && /offer|negotiation/.test(lower(f.name)));
    const followUpDone = cur.some((f) => f.ext === "md" && /follow[- ]?up/.test(lower(f.name)));
    const draftDone = hasCV || hasCoverLetter;
    const finalizeDone = ["ready", "submitted", "interview", "offer"].includes(status) || !!appliedDate;
    const mergePdfReady =
      cur.some((f) => lower(f.name).includes("cv") && f.ext === "pdf") &&
      cur.some((f) => lower(f.name).includes("cover") && f.ext === "pdf");
    const mergedPdfDone = cur.some((f) => f.ext === "pdf" && lower(f.name).includes("application"));
    return {
      id: folder,
      folder,
      folderPath,
      jobFile: jobFile.path,
      jobFileName: jobFile.name,
      role: d.role || "",
      employer: d.employer || "",
      track: d.track || "",
      trackLabel: TRACKS[d.track] || d.track || "",
      fit: d.fit || "",
      status,
      rawStatus: d.status || "",
      sector: d.sector || "",
      tailoring: d.tailoring || "",
      deadline: normDate(d.deadline),
      applied: normDate(d.applied),
      link: d.link || "",
      source: d.source != null ? String(d.source) : "",
      nextAction: d.next_action || "",
      nextActionDate: normDate(d.next_action_date),
      tags: Array.isArray(d.tags) ? d.tags : d.tags ? [d.tags] : [],
      leadWith: parseLeadWith(jobFile.body),
      files,
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
      mtime,
    };
  }

  // Scan every job folder into DTOs (was scanAllJobs). Tolerant: an unreadable
  // vault dir yields [] (absent -> empty).
  listJobs() {
    let folders;
    try {
      folders = fs
        .readdirSync(this.jobsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    return folders.map((f) => this._buildJob(f)).filter(Boolean);
  }

  // One job DTO by id (was toJob(id)). null when the folder has no job file.
  getJobSummary(id) {
    return this._buildJob(id);
  }

  // Full job detail: DTO + body + companion notes + prep materials + the mtime-
  // derived answered flags + the submitted-materials flag. The route computes the
  // (pure) interview consistency from prep + hasSubmitted, then responds. null
  // when the job does not exist.
  getJob(id) {
    const folder = id;
    const folderPath = path.join(this.jobsDir, folder);
    const jobFile = this._findJobFile(folderPath);
    if (!jobFile) return null;
    const job = this._buildJob(folder);

    const files = this._listFolderFiles(folderPath);
    const readIf = (predicate) => {
      const hit = files.find(predicate);
      if (!hit) return null;
      try {
        return { name: hit.name, content: fs.readFileSync(path.join(folderPath, hit.name), "utf8") };
      } catch {
        return null;
      }
    };
    const gaps = readIf((f) => f.name.toLowerCase().includes("gaps") && f.ext === "md");
    const jd = readIf((f) => f.name.toLowerCase().includes("job-description") && f.ext === "md");

    const prepFiles = files.filter(
      (f) => f.name !== jobFile.name && !isDatedCopy(f.name) && isPrepDoc(f.name),
    );
    const prep = prepFiles
      .sort(
        (a, b) =>
          Number(a.name.toLowerCase().includes("star")) - Number(b.name.toLowerCase().includes("star")),
      )
      .map((hit) => {
        try {
          const raw = fs.readFileSync(path.join(folderPath, hit.name), "utf8");
          const parsed = parseFront(raw);
          const content = (parsed && parsed.content != null ? parsed.content : raw).replace(/^\n+/, "");
          return { name: hit.name, content };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const feedbackPred = (f) =>
      f.name !== jobFile.name && !isDatedCopy(f.name) && f.ext === "md" && f.name.toLowerCase().includes("feedback");
    const prepFeedback = readIf(feedbackPred);
    const feedbackEntry = files.find(feedbackPred);
    const newestPrepMtime = prepFiles.reduce((m, f) => Math.max(m, this._fileMtimeMs(folderPath, f)), 0);
    const prepFeedbackAnswered =
      !!feedbackEntry && prepFiles.length > 0 && this._fileMtimeMs(folderPath, feedbackEntry) > newestPrepMtime;
    const prepRefineReady = !!job.interviewPrepDone && prepFeedbackAnswered;

    const hasSubmitted = files.some((f) => f.name.toLowerCase() === "application-content.json");

    return {
      ...job,
      body: jobFile.body,
      gaps,
      jobDescription: jd,
      prep,
      prepFeedback,
      prepFeedbackAnswered,
      prepRefineReady,
      hasSubmitted,
    };
  }

  // The surgical one-line frontmatter patch (LOAD-BEARING). Byte-identical body,
  // EOL + BOM preserved; only WRITABLE_FIELDS written. Returns the fresh DTO, or
  // null when the job does not exist (the route 404s).
  updateJobFields(id, updates) {
    const folderPath = path.join(this.jobsDir, id);
    const jobFile = this._findJobFile(folderPath);
    if (!jobFile) return null;
    updateFrontmatter(jobFile.path, updates);
    return this._buildJob(id);
  }

  // Create a new job folder + <Role>.md whole-file. Throws with .httpStatus on
  // bad input or a name collision (the route maps it). Returns the new DTO.
  createJob({ role, employer, track, fit, status, sector, deadline, link, source }) {
    const { dropInvalidJobEnums } = this.deps;
    if (!role || !employer) {
      const e = new Error("role and employer are required");
      e.httpStatus = 400;
      throw e;
    }
    const folderName = sanitizeForPath(`${role} - ${employer}`);
    const folderPath = path.join(this.jobsDir, folderName);
    if (fs.existsSync(folderPath)) {
      const e = new Error("a job folder with that name already exists");
      e.httpStatus = 409;
      throw e;
    }
    const fileName = `${sanitizeForPath(role)}.md`;
    const clean = dropInvalidJobEnums({ track, fit, sector, status });
    const sec = clean.sector || "private";
    const tailoring = sec === "private" ? "light" : "heavy";
    const trk = clean.track || "";
    const ft = clean.fit || "";
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
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, fileName), fm, "utf8");
    return this._buildJob(folderName);
  }

  // Overwrite a whitelisted freeform note (gaps / job-description / feedback only;
  // NEVER the SoT <Role>.md, never a dated history copy). Storage-safety guards
  // (allowlist + containment) live here; the route does request-shape validation.
  // Throws .httpStatus-coded errors the route maps; returns { ok, name, bytes }.
  writeJobNote(id, name, content) {
    const folderPath = path.join(this.jobsDir, id);
    const jobFile = this._findJobFile(folderPath);
    if (!jobFile) {
      const e = new Error("job not found");
      e.httpStatus = 404;
      throw e;
    }
    const base = path.basename(name); // drop any path component the client sent
    const lower = base.toLowerCase();
    const jobFileName = path.basename(jobFile.path);
    const isJobFile = lower === jobFileName.toLowerCase();
    const allowed =
      lower.endsWith(".md") &&
      !isJobFile &&
      !isDatedCopy(base) &&
      (lower.includes("gaps") || lower.includes("job-description") || lower.includes("feedback"));
    if (!allowed) {
      const e = new Error("only the gaps, job-description, or feedback .md note may be written here");
      e.httpStatus = 400;
      throw e;
    }
    const target = path.join(folderPath, base);
    const rel = path.relative(folderPath, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
      const e = new Error("invalid path");
      e.httpStatus = 400;
      throw e;
    }
    fs.writeFileSync(target, content, "utf8"); // verbatim whole-file note write
    return { ok: true, name: base, bytes: Buffer.byteLength(content, "utf8") };
  }

  // The guarded job-file reader. Returns a discriminated result the route maps to
  // headers + a stream (never a static file server): { ok:true, stream, ext, name }
  // or { ok:false, status, error } preserving the exact pre-seam status/messages.
  openJobFile(id, name) {
    const folderPath = this.jobFolderPath(id);
    if (!folderPath) return { ok: false, status: 404, error: "job folder not found" };
    const base = path.basename(name); // strip any client dir component
    const entry = this._listFolderFiles(folderPath).find((f) => f.name === base);
    if (!entry) return { ok: false, status: 404, error: "file not found" };
    const target = path.join(folderPath, base);
    const rel = path.relative(folderPath, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return { ok: false, status: 400, error: "invalid path" };
    }
    return { ok: true, stream: fs.createReadStream(target), ext: entry.ext, name: base };
  }

  // Resolve + contain a { id, rel } pair to a real file inside a job folder, for
  // the OS-open route. Returns the absolute target path, or null to reject.
  resolveOpenTarget(id, rel) {
    if (!rel || !id) return null;
    const target = path.join(this.jobsDir, id, rel);
    if (!isInsideJobsDir(this.jobsDir, target) || !fs.existsSync(target)) return null;
    return target;
  }

  // The CURRENT output files a given routine regenerates in place (was
  // routineOutputFiles). Contained to non-history files, never the SoT job file.
  _routineOutputFiles(routine, folderPath) {
    const cur = currentFiles(this._listFolderFiles(folderPath));
    const jobFile = this._findJobFile(folderPath);
    const jobName = jobFile ? jobFile.name.toLowerCase() : null;
    const notJob = (f) => f.name.toLowerCase() !== jobName;
    const lower = (f) => f.name.toLowerCase();
    const isDoc = (f) => f.ext === "docx" || f.ext === "pdf";
    switch (routine) {
      case "first-draft-job":
      case "finalize-job":
        return cur.filter((f) => isDoc(f) && (lower(f).includes("cv") || lower(f).includes("cover")));
      case "interview-prep":
        return cur.filter((f) => notJob(f) && (isPrepDoc(f.name) || (f.ext === "md" && lower(f).includes("feedback"))));
      case "interview-prep-refine":
        return cur.filter((f) => notJob(f) && isPrepDoc(f.name));
      case "offer-prep":
        return cur.filter((f) => notJob(f) && f.ext === "md" && /offer|negotiation/.test(lower(f)));
      case "draft-follow-up":
        return cur.filter((f) => notJob(f) && f.ext === "md" && /follow[- ]?up/.test(lower(f)));
      default:
        return [];
    }
  }

  // Build a non-colliding dated-copy name for a file about to be regenerated.
  _datedCopyName(folderPath, name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const stamp = localDateStamp();
    let candidate = `${base} (${stamp})${ext}`;
    let n = 2;
    while (fs.existsSync(path.join(folderPath, candidate))) {
      candidate = `${base} (${stamp}) (${n})${ext}`;
      n++;
    }
    return candidate;
  }

  // Regenerate safety net (honors "never delete"): before a JOB routine
  // regenerates its outputs in place, keep a dated copy of each CURRENT output.
  // No-op on a first run. Copy-only, contained, best-effort (a failure is
  // swallowed and never blocks the run).
  backupRoutineOutputs(id, routine) {
    const backupFolder = this.jobFolderPath(id);
    if (!backupFolder) return;
    for (const f of this._routineOutputFiles(routine, backupFolder)) {
      try {
        const dst = path.join(backupFolder, this._datedCopyName(backupFolder, f.name));
        const rel = path.relative(backupFolder, path.resolve(dst));
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) continue;
        fs.copyFileSync(path.join(backupFolder, f.name), dst, fs.constants.COPYFILE_EXCL);
      } catch {
        /* best-effort backup; never block the run */
      }
    }
  }

  // Post a generated artifact (CV / cover letter) back into a job folder. New
  // (design 2.2), used by the hybrid runner (I7); no I1 route calls it, but the
  // contract suite exercises it. Contained to the job folder; overwrites in place
  // (dated-copy history is the backupRoutineOutputs path's job). Returns the meta.
  saveJobArtifact(id, name, mime, bytes) {
    const folderPath = this.jobFolderPath(id);
    if (!folderPath) {
      const e = new Error("job folder not found");
      e.httpStatus = 404;
      throw e;
    }
    const base = path.basename(name);
    const target = path.join(folderPath, base);
    const rel = path.relative(folderPath, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
      const e = new Error("invalid path");
      e.httpStatus = 400;
      throw e;
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    writeFileAtomic(target, buf);
    return { name: base, mime: mime || null, bytes: buf.length };
  }

  // ======================================================================
  // TASK BOARD (DATA_DIR)
  // ======================================================================

  loadTasks() {
    const raw = fs.readFileSync(this.tasksFile, "utf8");
    const data = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) || {};
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    for (const t of tasks) {
      if (t && typeof t === "object" && !Array.isArray(t.comments)) t.comments = [];
    }
    return {
      columns: data.columns || ["backlog", "todo", "in_progress", "done"],
      tasks,
    };
  }

  saveTasks(data) {
    const header = "# Task board (app-managed). Edit in the app: Product hub -> Tasks.\n";
    const clean = {
      ...data,
      tasks: data.tasks.map((t) => {
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
      }),
    };
    writeFileAtomic(this.tasksFile, header + yaml.dump(clean, { lineWidth: 100 }));
  }

  // ======================================================================
  // TASK ATTACHMENTS (DATA_DIR, content-addressed blobs)
  // ======================================================================

  // Persist the validated blob bytes at attachments/<taskId>/<file>. The task-
  // domain guards (mime sniff, count cap, dedup, meta) stay in the route - they
  // need the task record (loadTasks). This owns ONLY where the bytes live: the
  // per-task containment + atomic write. Returns the absolute target path.
  saveAttachmentBlob(taskId, file, buffer) {
    const dir = path.join(this.attachmentsDir, path.basename(taskId));
    const target = path.join(dir, file);
    const rel = path.relative(dir, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
      const e = new Error("invalid path");
      e.httpStatus = 400;
      throw e;
    }
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(target, buffer);
    return target;
  }

  // Resolve + contain an attachment path for the guarded reader. Returns the
  // absolute path (existence NOT asserted here - the route reports the missing
  // file), or null when the path escapes the task's own attachments dir.
  attachmentFilePath(taskId, file) {
    const base = path.basename(file);
    const dir = path.join(this.attachmentsDir, path.basename(taskId));
    const target = path.join(dir, base);
    const rel = path.relative(dir, path.resolve(target));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    return target;
  }

  // ======================================================================
  // INTAKE LEDGER / REQUESTS (DATA_DIR)
  // ======================================================================

  // Request read-side normalization now lives in store-helpers.normalizeRequest
  // (shared with PgStore). Preserves the VERBATIM text; coerces id-typed spawned
  // refs; tolerant (a record with no id is skipped).

  loadRequests() {
    let raw;
    try {
      raw = fs.readFileSync(this.requestsFile, "utf8");
    } catch {
      return { requests: [] };
    }
    let data;
    try {
      data = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    } catch {
      return { requests: [] };
    }
    const list = data && Array.isArray(data.requests) ? data.requests : [];
    const requests = [];
    for (const r of list) {
      const norm = normalizeRequest(r);
      if (norm) requests.push(norm);
    }
    return { requests };
  }

  saveRequests(data) {
    const header =
      "# Intake ledger (app-managed). The ORIGIN of the orchestration chain: a verbatim\n" +
      "# owner/chatbot prompt -> CTO assessment -> the tasks/projects it spawned.\n" +
      "# Written by the app (POST/PATCH /api/requests, atomic). Do not hand-edit while running.\n";
    writeFileAtomic(this.requestsFile, header + yaml.dump({ requests: data.requests }, { lineWidth: 100 }));
  }

  // ======================================================================
  // ACTIVITY LOG (DATA_DIR, append-only JSONL)
  // ======================================================================

  // Best-effort append. A logging failure must NEVER break the caller - the
  // activity feed is telemetry, not the write path.
  appendActivity(record) {
    try {
      appendJsonl(this.activityFile, record);
    } catch (e) {
      console.error(`[jobhunt] activity append failed: ${e.message}`);
    }
  }

  // The raw activity-log text (tolerant: a missing file -> ""). The append-only
  // JSONL log has several consumers that parse it differently (the newest-first
  // feed, the notification tail, the pure runDurationHistory aggregator), so the
  // store exposes the tolerant text primitive and parsing stays in those pure
  // consumers rather than forcing one parsed shape.
  readActivityText() {
    try {
      return fs.readFileSync(this.activityFile, "utf8");
    } catch {
      return "";
    }
  }

  // ======================================================================
  // USAGE TELEMETRY (DATA_DIR, append-only JSONL)
  // ======================================================================

  // Append a validated batch in ONE write (per-line atomicity, best-effort). The
  // enum/cap validation (validateTelemetryEvent) is a pure route concern.
  appendTelemetry(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    fs.mkdirSync(path.dirname(this.usageTelemetryFile), { recursive: true });
    fs.appendFileSync(this.usageTelemetryFile, events.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
  }

  // Raw telemetry text for the pure summarizeTelemetry aggregator (tolerant: a
  // missing file -> "").
  readTelemetryText() {
    try {
      return fs.readFileSync(this.usageTelemetryFile, "utf8");
    } catch {
      return "";
    }
  }

  // ======================================================================
  // NOTIFICATION STATE (DATA_DIR)
  // ======================================================================

  loadNotifyState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.notifyStateFile, "utf8"));
      const b = s && typeof s.baseline === "object" && s.baseline ? s.baseline : {};
      return {
        cursor: typeof s.cursor === "string" ? s.cursor : null,
        baseline: {
          tasks: b.tasks && typeof b.tasks === "object" && !Array.isArray(b.tasks) ? b.tasks : {},
          projects: Array.isArray(b.projects) ? b.projects : [],
        },
        initialized: true,
      };
    } catch {
      return { cursor: null, baseline: { tasks: {}, projects: [] }, initialized: false };
    }
  }

  saveNotifyState(state) {
    const out = {
      version: 1,
      cursor: state.cursor,
      baseline: { tasks: state.baseline.tasks, projects: state.baseline.projects },
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(this.notifyStateFile, JSON.stringify(out, null, 2) + "\n");
  }

  // ======================================================================
  // PER-JOB CHATS (DATA_DIR)
  // ======================================================================

  loadChats() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.chatsFile, "utf8"));
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  saveChats(obj) {
    writeFileAtomic(this.chatsFile, JSON.stringify(obj, null, 2) + "\n");
  }

  // ======================================================================
  // DISCOVERY SOURCES (DOCS_DIR)
  // ======================================================================

  loadSources() {
    const { normalizeSource } = this.deps;
    let raw;
    try {
      raw = fs.readFileSync(this.sourcesFile, "utf8");
    } catch {
      return { version: 1, updated: null, sources: [] };
    }
    let data;
    try {
      data = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    } catch {
      return { version: 1, updated: null, sources: [] };
    }
    const sources = data && Array.isArray(data.sources) ? data.sources.map(normalizeSource) : [];
    return {
      version: data && typeof data.version === "number" ? data.version : 1,
      updated: data && typeof data.updated === "string" ? data.updated : null,
      sources,
    };
  }

  saveSources(data) {
    const { normalizeSource, serializeSource } = this.deps;
    const header =
      "# Discovery sources (app-managed). Native SoT for the Discovery console (ADR-016).\n" +
      "# Edit in the app: Discovery -> Sources. Written atomically by\n" +
      "# POST/PATCH/DELETE /api/discovery/sources and the per-source run endpoint.\n";
    const out = {
      version: 1,
      updated: localDateISO(),
      sources: (data.sources || []).map((s) => serializeSource(normalizeSource(s))),
    };
    writeFileAtomic(this.sourcesFile, header + yaml.dump(out, { lineWidth: 100 }));
  }

  // ======================================================================
  // HYBRID RUNNER QUEUE (DATA_DIR, agent-jobs.json) - RC-3 / SIM-87 I7
  // ======================================================================
  // The cloud PgStore uses FOR UPDATE SKIP LOCKED for true concurrent claim; the
  // laptop FileStore is single-process/single-user, so a JSON file with a
  // read-modify-write claim is correct here (no competing claimer). Same lease +
  // attempts-cap + single-use-nonce semantics as PgStore, shared via runner-lib.

  get _agentJobsFile() {
    return path.join(this.dataDir, "agent-jobs.json");
  }
  _loadAgentJobs() {
    try {
      const obj = JSON.parse(fs.readFileSync(this._agentJobsFile, "utf8"));
      return obj && Array.isArray(obj.jobs) ? obj : { jobs: [] };
    } catch {
      return { jobs: [] };
    }
  }
  _saveAgentJobs(data) {
    writeFileAtomic(this._agentJobsFile, JSON.stringify(data, null, 2) + "\n");
  }
  // Return expired claimed/running jobs to the queue; cap-exhausted ones to dead.
  _sweepAgentJobs(data, nowMs, maxAttempts) {
    for (const j of data.jobs) {
      if ((j.status === "claimed" || j.status === "running") && j.leaseExpiresAt && Date.parse(j.leaseExpiresAt) < nowMs) {
        if (j.attempts >= maxAttempts) {
          j.status = "dead";
          j.error = j.error || "lease expired; attempts exhausted";
        } else {
          j.status = "queued";
        }
        j.claimedBy = null;
        j.claimedAt = null;
        j.leaseExpiresAt = null;
        j.nonce = null;
        j.updatedAt = new Date(nowMs).toISOString();
      }
    }
  }

  enqueueAgentJob({ kind, jobId = null, payload = {} }) {
    const data = this._loadAgentJobs();
    const now = new Date().toISOString();
    const id = `aj-${Date.now()}-${mintNonce().slice(0, 8)}`;
    data.jobs.push({
      id, kind, jobId, payload,
      status: "queued", nonce: null, claimedBy: null, claimedAt: null,
      leaseExpiresAt: null, lastHeartbeatAt: null, attempts: 0,
      progress: [], result: null, error: null, createdAt: now, updatedAt: now,
    });
    this._saveAgentJobs(data);
    return { id };
  }

  claimAgentJob(runnerId, { nowMs = Date.now(), leaseMs = RUNNER_LEASE_MS, maxAttempts = RUNNER_MAX_ATTEMPTS } = {}) {
    const data = this._loadAgentJobs();
    this._sweepAgentJobs(data, nowMs, maxAttempts);
    const rec = data.jobs.find((j) => j.status === "queued" && j.attempts < maxAttempts);
    if (!rec) {
      this._saveAgentJobs(data);
      return null;
    }
    const nonce = mintNonce();
    rec.status = "claimed";
    rec.claimedBy = runnerId;
    rec.claimedAt = new Date(nowMs).toISOString();
    rec.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
    rec.lastHeartbeatAt = rec.claimedAt;
    rec.attempts += 1;
    rec.nonce = nonce;
    rec.updatedAt = rec.claimedAt;
    this._saveAgentJobs(data);
    return { id: rec.id, kind: rec.kind, jobId: rec.jobId, payload: rec.payload, nonce, attempts: rec.attempts };
  }

  heartbeatAgentJob(id, runnerId, { nowMs = Date.now(), leaseMs = RUNNER_LEASE_MS } = {}) {
    const data = this._loadAgentJobs();
    const rec = data.jobs.find((j) => j.id === id);
    if (!rec || rec.claimedBy !== runnerId || (rec.status !== "claimed" && rec.status !== "running")) {
      return { ok: false };
    }
    rec.status = "running";
    rec.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
    rec.lastHeartbeatAt = new Date(nowMs).toISOString();
    rec.updatedAt = rec.lastHeartbeatAt;
    this._saveAgentJobs(data);
    return { ok: true, leaseExpiresAt: rec.leaseExpiresAt };
  }

  appendAgentJobProgress(id, runnerId, lines) {
    const data = this._loadAgentJobs();
    const rec = data.jobs.find((j) => j.id === id);
    if (!rec || rec.claimedBy !== runnerId || rec.status === "done" || rec.status === "failed" || rec.status === "dead") {
      return { ok: false };
    }
    const add = Array.isArray(lines) ? lines : [lines];
    rec.progress = [...(rec.progress || []), ...add.map(String)].slice(-200);
    rec.updatedAt = new Date().toISOString();
    this._saveAgentJobs(data);
    return { ok: true };
  }

  agentJobById(id) {
    const rec = this._loadAgentJobs().jobs.find((j) => j.id === id);
    return rec ? { ...rec } : null;
  }

  completeAgentJob(id, { runnerId, nonce, status, error = null, result = null }) {
    const data = this._loadAgentJobs();
    const rec = data.jobs.find((j) => j.id === id);
    if (!rec) return { ok: false, notFound: true, reason: "agent job not found" };
    // Idempotent terminal no-op (replay-safe): a repeat result for a finished job
    // is a 200 no-op, not a re-application.
    if (rec.status === "done" || rec.status === "failed" || rec.status === "dead") {
      return { ok: true, idempotent: true, jobId: rec.jobId, kind: rec.kind };
    }
    if (rec.claimedBy !== runnerId || (rec.status !== "claimed" && rec.status !== "running")) {
      return { ok: false, reason: "job is not claimed by this runner" };
    }
    if (!rec.nonce || !constantTimeEqualHex(rec.nonce, nonce)) {
      return { ok: false, reason: "nonce mismatch (stale or replayed result)" };
    }
    rec.status = status === "failed" ? "failed" : "done";
    rec.result = result;
    rec.error = status === "failed" ? error || "runner reported failure" : null;
    rec.nonce = null; // consume the single-use nonce
    rec.updatedAt = new Date().toISOString();
    this._saveAgentJobs(data);
    return { ok: true, jobId: rec.jobId, kind: rec.kind };
  }

  // Honest laptop-off pending state (design 4.6): counts by status + the newest
  // heartbeat, so the UI can distinguish "runner polling" from "laptop offline".
  runnerQueueState() {
    const jobs = this._loadAgentJobs().jobs;
    const counts = { queued: 0, claimed: 0, running: 0, done: 0, failed: 0, dead: 0 };
    let lastHeartbeatAt = null;
    let oldestQueuedAt = null;
    for (const j of jobs) {
      if (counts[j.status] !== undefined) counts[j.status] += 1;
      if (j.lastHeartbeatAt && (!lastHeartbeatAt || j.lastHeartbeatAt > lastHeartbeatAt)) lastHeartbeatAt = j.lastHeartbeatAt;
      if (j.status === "queued" && (!oldestQueuedAt || j.createdAt < oldestQueuedAt)) oldestQueuedAt = j.createdAt;
    }
    return { counts, lastHeartbeatAt, oldestQueuedAt };
  }

  // ======================================================================
  // READ-ONLY LEDGERS (DOCS_DIR, bundled repo content)
  // ======================================================================
  // Design 2.2: these stay bundled read-only files in BOTH stores (org/repo
  // content, edited by a git+redeploy act, never a runtime write). Exposed here
  // for interface parity; PgStore reads the same bundled files. A read error
  // propagates so the route can 500 (matches the pre-seam try/catch).

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
}

// Select a store from the environment. STORE_BACKEND=pg -> PgStore(DATABASE_URL);
// anything else -> FileStore. Default is FileStore, so a naked `npm run dev` is
// byte-identical to today (mirrors the ADR-024 "off = today's behavior" posture).
// PgStore is imported LAZILY so a FileStore deploy never loads `pg` / the worker.
export function resolveStore(env, paths) {
  const backend = (env && env.STORE_BACKEND) || "";
  if (backend === "pg") {
    // PgStore needs an async import (keeps `pg`/the worker off the FileStore path)
    // and a live connection, so it is built via createPgStore at boot, not here.
    throw new Error("STORE_BACKEND=pg: build the store with createPgStore(env, paths) (async) at boot");
  }
  return new FileStore(paths);
}

// Async constructor for the pg backend (the boot path). Kept separate from
// resolveStore so the FileStore path never imports `pg`. index.js awaits this when
// STORE_BACKEND=pg; the contract suite imports PgStore directly.
export async function createPgStore(env, paths) {
  const { PgStore } = await import("./pg-store.js");
  return new PgStore({ url: env.DATABASE_URL, docsDir: paths.docsDir, blobDir: paths.blobDir, deps: paths.deps });
}
