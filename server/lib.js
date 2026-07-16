// Pure, side-effect-free helpers for the file bridge. Extracted from index.js
// so they can be unit-tested without starting the server. The only I/O here is
// updateFrontmatter (it takes an explicit path), which tests exercise on a temp
// file. See the Quality Constitution: this is the load-bearing write path.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";

// Parse frontmatter with the JSON schema so YAML does NOT coerce `2026-06-22`
// into a Date. Falls back to the default engine if a file uses YAML the JSON
// schema can't represent, so no job is ever silently dropped.
export const MATTER_OPTS = {
  engines: {
    yaml: {
      parse: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }),
      stringify: (o) => yaml.dump(o),
    },
  },
};

// Resolve the LIVE app-data directory for standalone ops scripts (activity-log
// append/lint, delegation hook) that run outside the server process. Precedence:
// JOBHUNT_DATA_DIR env > config(.local).json dataDir > <repo>/docs (pre-ADR-023
// back-compat). The server itself resolves its DATA_DIR inline (server/index.js)
// because its default must follow the JOBHUNT_DOCS_DIR test seam; the PRODUCTION
// answer of both rules is identical: ssc-brain\data\jobhunt (RFC v2-006 Phase 3).
export function resolveDataDir(repoRoot) {
  if (process.env.JOBHUNT_DATA_DIR) return path.resolve(process.env.JOBHUNT_DATA_DIR);
  for (const name of ["config.local.json", "config.json"]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, name), "utf8"));
      if (cfg.dataDir) return path.resolve(cfg.dataDir);
      break; // config.local.json REPLACES config.json when present (loadConfig contract)
    } catch {
      /* missing/unreadable -> try the next, then fall through */
    }
  }
  return path.join(repoRoot, "docs");
}

export function parseFront(content) {
  // Strip a leading UTF-8 BOM before parsing. gray-matter only recognizes a
  // frontmatter block when the file starts LITERALLY with "---"; a BOM (U+FEFF,
  // which Obsidian / Windows editors sometimes prepend) makes the file start
  // with an invisible character instead, so the whole frontmatter goes
  // undetected and the job silently vanishes from the dashboard. This was the
  // root cause of two jobs (UTMCIP BDO, Assistant to the Chair) disappearing.
  if (typeof content === "string" && content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  try {
    return matter(content, MATTER_OPTS);
  } catch {
    try {
      return matter(content);
    } catch {
      return null;
    }
  }
}

// Parse an OPTIONAL leading YAML frontmatter block off a doc's raw Markdown
// (server/index.js docs browser: GET /api/docs, GET /api/doc/*). Distinct from
// parseFront (which reads job frontmatter that is always expected to exist): a
// doc's frontmatter is optional, so "no fence at all" and "an empty fence" are
// different states a caller may care about - meta is `null` only when the file
// does not open with a `---` block; an empty block still yields `{}` (the file
// DID open one, it just declared nothing). body is the content with the
// frontmatter block stripped; with no fence, body is the raw string,
// untouched. Tolerant: any parse failure degrades to { meta: null, body: raw }
// rather than throwing, so one malformed doc can never break the docs browser.
export function parseFrontmatter(raw) {
  if (typeof raw !== "string" || !/^---\r?\n/.test(raw)) {
    return { meta: null, body: raw };
  }
  const parsed = parseFront(raw);
  if (!parsed) return { meta: null, body: raw };
  return { meta: parsed.data || {}, body: parsed.content };
}

// Normalize a frontmatter date value to a literal YYYY-MM-DD string. A JS Date
// (if some file still parses to one) is rendered from UTC parts; non-date text
// such as "1-yr contract" passes through unchanged.
export function normDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

export function parseLeadWith(body) {
  const m = body.match(/\*\*Lead with:\*\*\s*(.+)/);
  return m ? m[1].trim() : "";
}

export function yamlScalar(value) {
  if (value === null || value === undefined || value === "") return '""';
  const s = String(value);
  // Quote when the value could be misread as YAML structure.
  if (/[:#\[\]{}",&*!|>%@`]/.test(s) || /^\s|\s$/.test(s) || /^[-?]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

// Only these frontmatter keys may be written by the dashboard.
export const WRITABLE_FIELDS = [
  "status",
  "fit",
  "track",
  "sector",
  "tailoring",
  "deadline",
  "applied",
  "next_action",
  "next_action_date",
  "link", // posting URL (the vault's established field, present on every job)
];

// Atomic file write: stage the bytes into a sibling `<file>.tmp`, then rename it
// over the target. rename is atomic on the same volume, so a reader (Obsidian,
// git, the Python pipeline) never sees a half-written SoT and a crash mid-write
// can't truncate it. The chokidar watcher already ignores `*.tmp`, so the staging
// write never fires a spurious reload. Shared by the two SoT write paths:
// updateFrontmatter (job frontmatter) and saveTasks (tasks.yaml).
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}

// Replace or insert frontmatter keys in-place, preserving everything else
// (body byte-for-byte). A null/empty value removes the key.
export function updateFrontmatter(filePath, updates) {
  let raw = fs.readFileSync(filePath, "utf8");
  // Normalize away a leading BOM (see parseFront): a BOM makes lines[0] fail the
  // "---" check below, and a write should not preserve the very thing that hides
  // the job from the reader. The BOM sits before the frontmatter, not in the body.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  // Preserve the file's existing line endings. 63 of the 112 real job files are
  // CRLF; splitting on /\r?\n/ then rejoining with "\n" rewrites EVERY line on a
  // one-field edit, which blows the surgical one-line-diff / byte-identical-body
  // promise. Detect the dominant EOL from the raw bytes and rejoin with it. A
  // trailing newline is preserved for free: the split leaves a trailing "" that
  // rejoins to a trailing EOL.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== "---") throw new Error("file has no frontmatter block");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("unterminated frontmatter block");

  for (const [key, value] of Object.entries(updates)) {
    if (!WRITABLE_FIELDS.includes(key)) continue;
    const re = new RegExp(`^(\\s*)${key}\\s*:.*$`);
    let found = false;
    for (let i = 1; i < end; i++) {
      if (re.test(lines[i])) {
        if (value === null || value === "") {
          lines.splice(i, 1);
          end--;
        } else {
          lines[i] = `${key}: ${yamlScalar(value)}`;
        }
        found = true;
        break;
      }
    }
    if (!found && value !== null && value !== "") {
      lines.splice(end, 0, `${key}: ${yamlScalar(value)}`);
      end++;
    }
  }
  writeFileAtomic(filePath, lines.join(eol));
}

// ---- deadline auto-close rule (pure) ---------------------------------------
// One of the app's TWO rule-based automatic status writes (see the
// "What the app may do" contract in docs/data-schema.md §7.1; the other is
// nextStatusAfterRun below, the run-completion advance): a job still in a
// PRE-APPLICATION status whose deadline has strictly passed is closed on the
// next job-list load. This is the pure predicate; the sweep itself (GET
// /api/jobs, server/index.js) does the I/O. Kept here so tests can pin `today`
// and prove every boundary without touching the clock.
//   - statuses: only the pre-submission set (lead | queued | drafted | ready)
//     qualifies. `ready` is finalized but NOT yet submitted, so once its posting
//     deadline passes it can no longer be applied to - honestly closed, same as a
//     drafted job. submitted / interview / offer outlive the posting (you already
//     applied); rejected / closed are already terminal.
//   - deadline: must be a literal YYYY-MM-DD. Free-text deadlines ("1-yr
//     contract") and absent deadlines can never be judged, so they never close.
//   - strictly before: a deadline of TODAY is still live (you can apply today).
//     Two zero-padded ISO dates compare correctly as strings.
export const AUTO_CLOSE_STATUSES = ["lead", "queued", "drafted", "ready"];
export const AUTO_CLOSE_NOTE = "Auto-closed: deadline passed";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The one shared "this deadline has already passed" predicate: a REAL calendar
// deadline (literal YYYY-MM-DD) strictly before today's LOCAL date. Free-text
// deadlines ("1-yr contract", "rolling") and absent deadlines can never be
// judged, so they never count as expired; a deadline of TODAY is still live
// (you can apply today). Two zero-padded ISO dates compare correctly as strings.
// Reused by shouldAutoClose (the Job auto-close sweep) AND the discovery write
// path's expired-find drop (server: mapApifyDataset), so "past deadline" means
// exactly the same thing for a tracked Job and a fresh discovery find. The
// discovery.py cmd_add guard is the Python mirror of this rule on the single
// write path (t-1783422051088).
export function isExpiredDeadline(deadline, today) {
  if (typeof deadline !== "string" || !ISO_DATE.test(deadline)) return false;
  if (typeof today !== "string" || !ISO_DATE.test(today)) return false;
  return deadline < today;
}

export function shouldAutoClose(status, deadline, today) {
  if (!AUTO_CLOSE_STATUSES.includes(status)) return false;
  return isExpiredDeadline(deadline, today);
}

// ---- run-completion status automation (pure) -------------------------------
// The SECOND of the app's two rule-based automatic status writes (t-1783390854845,
// ADR-022, extended by t-1783481509014; sibling to shouldAutoClose above and
// governed by the same "What the app may do" clause in docs/data-schema.md §7.1).
// When a scope:"job" routine FINISHES, this returns the status the job should
// auto-advance to, or null for "leave it exactly as it is". The run-close handler
// (server/index.js) applies a non-null result with a surgical updateFrontmatter
// write.
//
// There are TWO safe advances, one per core pipeline routine. Both share the same
// safety profile - EVIDENCE-BACKED (a successful run on a job whose materials
// exist, never "the process exited 0" alone - a run exiting is not the work
// succeeding), FORWARD + PRE-SUBMISSION (neither crosses the submit boundary, so
// the never-auto-submit contract holds), and REVERSIBLE + IDEMPOTENT (each fires
// only from its one source status, so it cannot fight the agent or re-fire on a
// Regenerate of an already-advanced job):
//
//   1. lead|queued -> drafted when first-draft-job SUCCEEDED (exitCode 0) AND the
//      draft artifacts now exist on disk (job.draftDone). This is the transition the
//      documented lifecycle ascribes to a first draft (STATUS_INFO.drafted). Fires
//      from BOTH pre-draft statuses because first-draft-job is a supported action on a
//      `lead` (not-yet-queued) job as well as a `queued` one (the recipe's own inputs
//      list `status: lead or queued`); gating only on `queued` silently stranded every
//      lead job that was drafted directly (owner report 2026-07-14). Still forward +
//      pre-submission + idempotent: it cannot fire from `drafted` or later, so a
//      Regenerate on an already-advanced job never re-triggers it.
//
//   2. drafted -> ready when finalize-job SUCCEEDED (exitCode 0) AND the job has
//      draft materials (job.draftDone). `ready` = "finalized, ready to submit"
//      (STATUS_INFO.ready). finalize regenerates the draft's files IN PLACE (the
//      submission PDFs) with no NEW file type the app can reliably attribute to
//      finalize alone, so the evidence here is the successful run itself: the
//      server refuses to LAUNCH finalize-job unless the job is finalizeReady
//      (drafted + CV + gaps answered - the isRoutineAllowed guard in
//      server/index.js), so an exit-0 finalize provably ran on a real, gaps-answered
//      draft. The draftDone re-check is the belt confirming materials still exist.
//      Owner product decision t-1783481509014 ("when Finalize succeeds it should be
//      Ready") - the "finalized stage" the earlier revision deferred pending this
//      exact call.
export const DRAFT_ROUTINE = "first-draft-job";
export const FINALIZE_ROUTINE = "finalize-job";
export function nextStatusAfterRun(routine, exitCode, job) {
  if (!job || exitCode !== 0) return null;
  if (
    routine === DRAFT_ROUTINE &&
    (job.status === "lead" || job.status === "queued") &&
    job.draftDone === true
  ) {
    return "drafted";
  }
  if (routine === FINALIZE_ROUTINE && job.status === "drafted" && job.draftDone === true) {
    return "ready";
  }
  return null;
}

// Today's date as YYYY-MM-DD in the machine's LOCAL timezone (a UTC slice of
// toISOString() would flip the day early/late around midnight for non-UTC
// machines, closing a job a day too soon or too late). Injectable for tests.
export function localDateISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function sanitizeForPath(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalize an id-typed reference (project / milestone / owner / delegated_by /
// wbs on a task). Lowercase, trim, strip to the kebab/dotted id charset so a
// reference can never smuggle in path or YAML-structure characters. An empty
// result becomes null (an absent reference), never an empty string. This is a
// shape guard only: it does NOT check that the id resolves to a real entity -
// referential integrity is a read/test invariant, not a write-time gate.
export function sanitizeId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return s === "" ? null : s;
}

export function isInsideJobsDir(jobsDir, target) {
  const rel = path.relative(jobsDir, path.resolve(target));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---- image attachment helpers (ADR-014) -----------------------------------
// Pure, importable-without-a-server helpers backing the pasted-image upload path
// (POST /api/tasks/:id/attachments). The upload endpoint NEVER trusts the
// client-sent Content-Type alone: it also sniffs the leading bytes here and
// requires the two to AGREE, so an HTML/script payload wearing an image MIME is
// rejected. Raster formats ONLY - SVG is deliberately excluded (scriptable XML,
// an XSS vector even behind nosniff). Kept in lib.js (not index.js) so the sniff
// and the mime->ext map are unit-testable without booting the server.

// The allowlisted image MIME types, mapped to the file extension the server uses
// for the stored (content-addressed) filename. The extension is ALWAYS derived
// from this validated MIME, never from a client-sent filename, so no
// client-controlled path component ever reaches disk.
export const MIME_ALLOWLIST = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// The stored-file extension for an allowlisted MIME, or null if the MIME is not
// allowed. Case-insensitive on the MIME (a browser may send "image/PNG").
export function extFromMime(mime) {
  if (typeof mime !== "string") return null;
  const key = mime.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_ALLOWLIST, key) ? MIME_ALLOWLIST[key] : null;
}

// Sniff the real image type from the leading bytes of a Buffer, returning the
// canonical MIME ("image/png" | "image/jpeg" | "image/gif" | "image/webp") or
// null when the bytes match no allowlisted raster format. Magic numbers:
//   PNG  - 89 50 4E 47 0D 0A 1A 0A
//   JPEG - FF D8 FF
//   GIF  - "GIF87a" / "GIF89a"  (47 49 46 38 3(7|9) 61)
//   WEBP - "RIFF" <4-byte size> "WEBP"  (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
// Only the signature is inspected; a truncated/short/non-Buffer input returns
// null rather than throwing. This is the sniff the upload endpoint requires to
// AGREE with the client-sent Content-Type before a byte is written.
export function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF ("GIF87a" / "GIF89a")
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP ("RIFF"<size>"WEBP")
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// Build the argv for opening a file in its OS default application, returned as a
// { cmd, args } pair for execFile - NOT a shell string for exec. The target is a
// standalone argv element, so the OS never re-parses the path as shell syntax
// (no interpolation of spaces / quotes / `&` / etc.). Matches the routine
// runner's spawn+argv posture. On Windows `start` is a cmd.exe builtin, so it
// runs via `cmd /c`; the empty "" is start's optional window-title argument,
// which stops start from mistaking a (quoted) target for the title. macOS uses
// `open`, everything else `xdg-open`.
export function buildOpenCommand(platform, target) {
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", target] };
  if (platform === "darwin") return { cmd: "open", args: [target] };
  return { cmd: "xdg-open", args: [target] };
}

// Normalize a hand-edited YAML doc (portfolio / agents / roadmap) so a partial
// edit can never make a downstream .map / .filter throw. Returns a SHALLOW copy
// with each named key guaranteed to be an array: a missing or non-array value
// becomes []; a value that is already an array is kept BY REFERENCE, so the
// shape is unchanged when the data is present and well-formed. Never mutates the
// input. Mirrors the defaulting loadTasks already does for the task board.
export function ensureArrays(obj, keys) {
  const out = obj && typeof obj === "object" && !Array.isArray(obj) ? { ...obj } : {};
  for (const k of keys) if (!Array.isArray(out[k])) out[k] = [];
  return out;
}

// Append one record as a single JSON line to a .jsonl file, creating the file
// (and its parent dir) if needed. Stamps `ts` (ISO8601) when the record omits
// it. This is the ONE writer for the activity log so the server and the hook
// script (ops/activity-log-append.mjs) can never drift in on-disk format. The
// log is append-only telemetry: each line is an independent JSON object, so a
// torn or malformed line never corrupts the ones around it. Callers treat this
// as best-effort - a failure here must never break a load-bearing write path.
export function appendJsonl(filePath, record) {
  const rec = { ts: new Date().toISOString(), ...record };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
}

// Interview-prep consistency check (read-only, deterministic, high-precision).
// Cross-references the prep sheet's STAR-story citations against the STAR bank and
// notes whether the submitted materials were available to cross-check. The design
// bar (docs/proposals/2026-07-06-interview-coaching-feature-design.md, feature 1) is
// that HARD flags stay trustworthy, so the only `high` finding is a story the prep
// sheet cites that the bank never defines (the classic "-> Story G" that was never
// written). Orphan stories (defined but never cited) and a missing
// application-content.json are `info`, never hard flags.
//
//   prep         : the [{ name, content }] array the job endpoint already builds
//                  (frontmatter stripped); the prep sheet and the STAR bank.
//   hasSubmitted : whether application-content.json exists in the job folder.
//   returns      : { checked, hasSubmitted, findings: [{ severity, kind, refs, message }] }
//                  checked=false when there is no prep material at all.
export function computeInterviewConsistency(prep, hasSubmitted) {
  const docs = Array.isArray(prep) ? prep.filter((d) => d && typeof d.content === "string") : [];
  const isStar = (n) => /star/i.test(n || "");
  const prepDoc = docs.find((d) => !isStar(d.name));
  const starDoc = docs.find((d) => isStar(d.name));
  if (!prepDoc && !starDoc) return { checked: false, hasSubmitted: !!hasSubmitted, findings: [] };

  // Collect the single-letter story labels a regex finds, uppercased + deduped.
  const collect = (text, source) => {
    const out = new Set();
    if (typeof text !== "string") return out;
    const rx = new RegExp(source, "gm");
    let m;
    while ((m = rx.exec(text)) !== null) out.add(m[1].toUpperCase());
    return out;
  };
  const sorted = (set) => [...set].sort();
  const list = (letters) => letters.map((l) => `Story ${l}`).join(", ");

  // Defined: a STAR-bank heading "## Story A - ...". Cited: any "Story X" reference
  // in the prep sheet. Both are case-sensitive on "Story" + one capital letter, so
  // "STAR stories" / "story bank" never match and "Story Approach" never false-hits.
  const defined = starDoc ? collect(starDoc.content, "^#{1,6}\\s*Story\\s+([A-Z])\\b") : new Set();
  const cited = prepDoc ? collect(prepDoc.content, "\\bStory\\s+([A-Z])\\b") : new Set();

  const findings = [];

  // HARD: the prep sheet cites a story the bank does not define.
  const dangling = sorted(cited).filter((l) => !defined.has(l));
  if (dangling.length) {
    const defNote = defined.size ? `defined: ${sorted(defined).join(", ")}` : "the STAR bank defines no stories";
    findings.push({
      severity: "high",
      kind: "dangling-story",
      refs: dangling,
      message:
        `The prep sheet cites ${list(dangling)}, which ${dangling.length > 1 ? "are" : "is"} not in the STAR bank ` +
        `(${defNote}). Fix the citation or add the story, then rerun Refine.`,
    });
  }

  // INFO: a bank story never cited in the prep sheet (only meaningful when both exist).
  if (prepDoc && starDoc) {
    const orphans = sorted(defined).filter((l) => !cited.has(l));
    if (orphans.length) {
      findings.push({
        severity: "info",
        kind: "orphan-story",
        refs: orphans,
        message: `${list(orphans)} ${orphans.length > 1 ? "are" : "is"} in the STAR bank but never cited in the prep sheet.`,
      });
    }
  }

  // INFO: no submitted materials on file to cross-check answers against.
  if (!hasSubmitted) {
    findings.push({
      severity: "info",
      kind: "no-submitted",
      refs: [],
      message:
        "No application-content.json in this folder, so answers were not cross-checked against a submitted CV or cover letter (structural check only).",
    });
  }

  return { checked: true, hasSubmitted: !!hasSubmitted, findings };
}

// ---------------------------------------------------------------------------
// Parked-decision consistency guard (ADR-020, t-1783371847653). Deterministic,
// read-only, mirrors computeInterviewConsistency. Flags the drift that silently
// dropped owner-decisions from the Decisions inbox: a ticket that is being parked
// for the owner (its title carries the "[PARKED]" marker and/or it is labeled
// "owner-decision") but is MISSING the canonical "parked" label.
//
// The inbox reads a UNION now (parked label OR "[PARKED]" title, src/lib/decisions
// isParkedForOwner), so this drift no longer hides a decision - but it is still an
// inconsistency (the two park signals disagree), so this guard makes it LOUD and
// fixable at the source rather than leaving the SoT quietly divergent.
//
// Precision (only a genuine, still-open park is a finding):
//   - terminal tickets (done/canceled) are skipped: a resolved decision correctly
//     has no "parked" label.
//   - RESOLVED-but-still-open decisions are exempt: buildResolveWrite strips the
//     "[PARKED]" marker AND appends an "Owner decision: ..." owner comment, so a
//     resolved ticket neither trips the title test nor (belt-and-braces) the
//     comment test below.
//   - the "owner-decision" label alone is NOT a positive signal, because it is a
//     PERMANENT classification kept forever after resolve (labelsAfterResolve); it
//     only counts as drift here when the "[PARKED]" title still marks the ticket
//     as actively waiting.
//
//   tasks   : the docs/tasks.yaml tasks array (each { title, status, labels?, comments? }).
//   returns : { checked, findings: [{ severity, kind, id, title, message }] }
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled"]);
function titleIsParked(title) {
  return /^\s*\[parked\]/i.test(title || "");
}
function looksResolved(task) {
  const comments = Array.isArray(task && task.comments) ? task.comments : [];
  return comments.some((c) => c && typeof c.body === "string" && /^Owner decision:/.test(c.body.trim()));
}
export function computeParkedConsistency(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const findings = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    if (TERMINAL_TASK_STATUSES.has(t.status)) continue;
    const labels = Array.isArray(t.labels) ? t.labels : [];
    const parked = labels.includes("parked");
    const markedParked = titleIsParked(t.title);
    // Drift: the title marks it "[PARKED]" (actively waiting) but the canonical
    // "parked" label is absent - and it has not been resolved.
    if (markedParked && !parked && !looksResolved(t)) {
      findings.push({
        severity: "high",
        kind: "parked-label-missing",
        id: t.id,
        title: t.title,
        message:
          `Ticket ${t.id} is titled "[PARKED]" (an owner decision awaiting a call) but is missing the ` +
          `"parked" label. File parked owner-decisions with labels ["owner-decision","parked"] (autonomous-session ` +
          `skill) so the two park signals agree; add the "parked" label to reconcile.`,
      });
    }
  }
  return { checked: true, findings };
}

// ---------------------------------------------------------------------------
// Project<->task linkage consistency guard (ADR-021, t-1783371847653).
// Deterministic, read-only. Answers "can a project be marked done with no real
// work behind it?" A task belongs to a project via its direct `project` ref OR via
// its `milestone`'s parent project - the SAME resolution the Projects view uses
// (src/components/ProjectsView buildDerived), computed here so the guard and the
// view can never disagree about what links to what.
//
// Findings (a "done"/"shipped"/"complete"/"archived" project is nonsensical
// without work behind it):
//   - "done-project-no-tasks"        : zero tasks resolve to the project (high).
//   - "done-project-incomplete-tasks": has linked tasks, but not all are terminal
//                                       (a project cannot be more done than its
//                                       work) (high).
// Also surfaces genuine ROUTE breakage so a real linkage bug is not mistaken for a
// data gap:
//   - "dangling-project-ref"   : a task points at a project id that does not exist.
//   - "dangling-milestone-ref" : a task points at a milestone id that does not exist.
//   - "orphan-milestone"       : a milestone's parent project does not exist.
//
//   portfolio : { projects: [...], milestones: [...] } (docs/portfolio.yaml).
//   tasks     : the docs/tasks.yaml tasks array.
//   returns   : { checked, findings: [{ severity, kind, projectId?, taskId?, milestoneId?, message }] }
const DONE_PROJECT_STATUSES = new Set(["done", "shipped", "complete", "archived"]);
export function computeProjectTaskConsistency(portfolio, tasks) {
  const projects = portfolio && Array.isArray(portfolio.projects) ? portfolio.projects : [];
  const milestones = portfolio && Array.isArray(portfolio.milestones) ? portfolio.milestones : [];
  const taskList = Array.isArray(tasks) ? tasks : [];
  const findings = [];

  const projectIds = new Set(projects.map((p) => p && p.id).filter(Boolean));
  const milestoneProject = {};
  const milestoneIds = new Set();
  for (const m of milestones) {
    if (!m || !m.id) continue;
    milestoneIds.add(m.id);
    milestoneProject[m.id] = m.project;
    if (m.project && !projectIds.has(m.project)) {
      findings.push({
        severity: "high",
        kind: "orphan-milestone",
        milestoneId: m.id,
        projectId: m.project,
        message: `Milestone ${m.id} belongs to project ${m.project}, which does not exist in portfolio.projects.`,
      });
    }
  }

  // Resolve tasks to projects (direct ref OR via milestone), flagging dangling refs.
  const tasksByProject = {};
  for (const t of taskList) {
    if (!t || typeof t !== "object") continue;
    const pids = new Set();
    if (t.project) {
      if (projectIds.has(t.project)) pids.add(t.project);
      else findings.push({ severity: "high", kind: "dangling-project-ref", taskId: t.id, projectId: t.project, message: `Task ${t.id} references project ${t.project}, which does not exist.` });
    }
    if (t.milestone) {
      if (!milestoneIds.has(t.milestone)) findings.push({ severity: "high", kind: "dangling-milestone-ref", taskId: t.id, milestoneId: t.milestone, message: `Task ${t.id} references milestone ${t.milestone}, which does not exist.` });
      const mp = milestoneProject[t.milestone];
      if (mp && projectIds.has(mp)) pids.add(mp);
    }
    for (const pid of pids) (tasksByProject[pid] ||= []).push(t);
  }

  const isTerminal = (s) => s === "done" || s === "canceled";
  for (const p of projects) {
    if (!p || !p.id || !DONE_PROJECT_STATUSES.has(p.status)) continue;
    const linked = tasksByProject[p.id] || [];
    if (linked.length === 0) {
      findings.push({
        severity: "high",
        kind: "done-project-no-tasks",
        projectId: p.id,
        message:
          `Project ${p.id} is marked "${p.status}" but has ZERO linked tasks (no task references it directly or ` +
          `via one of its milestones). A shipped project needs the work behind it recorded: link its tickets ` +
          `(project/milestone ref) or correct the status.`,
      });
    } else {
      const open = linked.filter((t) => !isTerminal(t.status));
      if (open.length) {
        findings.push({
          severity: "high",
          kind: "done-project-incomplete-tasks",
          projectId: p.id,
          message:
            `Project ${p.id} is marked "${p.status}" but ${open.length} of its ${linked.length} linked tasks are not ` +
            `terminal (${open.map((t) => `${t.id}:${t.status}`).join(", ")}). A project cannot be more done than its work.`,
        });
      }
    }
  }

  return { checked: true, findings };
}

// ---- routine-run live progress helpers (t-1783650926662) -------------------
// The routine runner spawns `claude -p ... --output-format stream-json`, which
// emits one JSON event per line as the agent works (init, assistant turns with
// text + tool_use blocks, tool results, one terminal `result`). These pure
// helpers turn that stream into the run record's live-progress fields: a
// human-readable transcript line per event, a short "what it is doing right
// now" activity label, a per-routine milestone (stage) index, and the finish
// stats. Pure + exported so the parsing rules are unit-testable without
// spawning anything.

// The primary string target of a tool call - the ONE input field that names
// what the tool is acting on (file path, command, pattern, url). Used for both
// the activity label and stage matching, so a stage regex can never
// false-positive on unrelated fields (e.g. an Edit whose CONTENT mentions a
// script name).
export function toolTarget(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return String(input.file_path || input.notebook_path || "");
    case "Bash":
      return String(input.command || "");
    case "Glob":
    case "Grep":
      return String(input.pattern || "");
    case "WebFetch":
      return String(input.url || "");
    case "WebSearch":
      return String(input.query || "");
    case "Task":
      return String(input.description || "");
    default:
      return "";
  }
}

const TOOL_VERB = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  NotebookEdit: "Editing",
  Bash: "Running",
  Glob: "Searching",
  Grep: "Searching",
  WebFetch: "Fetching",
  WebSearch: "Searching web",
  Task: "Delegating",
  TodoWrite: "Planning",
};

// One short human label for a tool_use block ("Reading resume.yaml",
// "Running python ops/scripts/render_application.py ..."). File paths shrink
// to their last two segments; everything caps at 80 chars.
export function describeToolUse(name, input) {
  const verb = TOOL_VERB[name] || String(name || "Working");
  let target = toolTarget(name, input).replace(/\s+/g, " ").trim();
  if (!target) return verb;
  if (/^(Read|Write|Edit|NotebookEdit)$/.test(name) && /[\\/]/.test(target)) {
    target = target.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");
  }
  if (target.length > 80) target = target.slice(0, 77) + "...";
  return `${verb} ${target}`;
}

// Advance the milestone index for one tool call. `stages` is the routine's
// ordered stage list ({ label, match: { tools, path?, exclude? } }); the index
// only ever moves FORWARD (a later Read of an early-stage file never regresses
// the bar), and may legitimately skip stages (e.g. a run that needs no fact
// edits). Returns the new index (-1 = nothing matched yet).
export function matchRunStage(stages, currentIndex, toolName, target) {
  if (!Array.isArray(stages)) return currentIndex;
  let next = currentIndex;
  for (let j = currentIndex + 1; j < stages.length; j++) {
    const m = stages[j] && stages[j].match;
    if (!m || !Array.isArray(m.tools) || !m.tools.includes(toolName)) continue;
    if (m.path && !m.path.test(target)) continue;
    if (m.exclude && m.exclude.test(target)) continue;
    next = j;
  }
  return next;
}

// Fold ONE stream-json event into a run-record update. Pure: returns what to
// apply, never mutates. `activity` is undefined (leave as-is) | null (clear) |
// string (set); `appendText` is transcript text to append; `stats` is set once
// by the terminal `result` event. `hasTranscript` tells the result handler
// whether anything already streamed into the output - when nothing did (e.g. a
// future CLI whose turn events this parser no longer recognizes), the success
// result's text is appended as a fallback so the run output can never end up
// EMPTIER than the old single-dump text mode.
export function agentEventToUpdate(evt, stages, stageIndex, hasTranscript = true) {
  const out = { appendText: "", activity: undefined, stageIndex, stats: null };
  if (!evt || typeof evt !== "object") return out;
  if (evt.type === "system" && evt.subtype === "init") {
    out.activity = "Agent started";
    return out;
  }
  if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        out.appendText += String(block.text).replace(/\r\n/g, "\n").trimEnd() + "\n";
      } else if (block.type === "tool_use") {
        const label = describeToolUse(block.name, block.input);
        out.appendText += `> ${label}\n`;
        out.activity = label;
        out.stageIndex = matchRunStage(stages, out.stageIndex, block.name, toolTarget(block.name, block.input));
      }
    }
    return out;
  }
  if (evt.type === "result") {
    out.stats = {
      durationMs: Number.isFinite(evt.duration_ms) ? evt.duration_ms : null,
      numTurns: Number.isFinite(evt.num_turns) ? evt.num_turns : null,
      costUsd: Number.isFinite(evt.total_cost_usd) ? evt.total_cost_usd : null,
    };
    out.activity = null;
    // A successful result's text already streamed as the last assistant turn,
    // so appending it again would duplicate - UNLESS nothing streamed at all
    // (unrecognized turn events), where it is the only text we will ever get.
    // An ERROR subtype always adds a line so failures stay visible.
    if (evt.subtype && evt.subtype !== "success") {
      out.appendText += `[result: ${evt.subtype}]${evt.result ? ` ${evt.result}` : ""}\n`;
    } else if (!hasTranscript && evt.result) {
      out.appendText += String(evt.result).replace(/\r\n/g, "\n").trimEnd() + "\n";
    }
  }
  return out;
}

// Median of a duration sample list (ms). Null when there is no history - the
// UI falls back to the indeterminate sweep.
export function medianMs(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const s = list.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Rebuild per-routine duration history from the raw activity log (JSONL).
// Pairs each run's start line (status:"running", carries `routine`) with its
// close line (status:"done") by runId; keeps the most recent `cap` successful
// durations per routine. Tolerant of torn/malformed lines, same posture as
// every other activity-log read.
export function runDurationHistory(raw, cap = 8) {
  const starts = new Map();
  const byRoutine = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (!rec || rec.kind !== "run" || !rec.runId) continue;
    if (rec.status === "running" && rec.routine) {
      starts.set(rec.runId, rec);
    } else if (rec.status === "done") {
      const start = starts.get(rec.runId);
      if (!start) continue;
      const ms = Date.parse(rec.ts) - Date.parse(start.ts);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const arr = byRoutine.get(start.routine) || [];
      arr.push(ms);
      if (arr.length > cap) arr.shift();
      byRoutine.set(start.routine, arr);
    }
  }
  return byRoutine;
}
