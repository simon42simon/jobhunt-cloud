// RC-3 / SIM-87 I4 - pure helpers SHARED by FileStore and PgStore so the two
// backends can never drift on name/listing logic or read-side normalization.
// Extracted verbatim from the FileStore (server/store.js) private helpers; the
// existing store-contract suite + full test suite prove FileStore is unchanged by
// the extraction, and PgStore imports the SAME functions (one home per thing).
//
// All functions here are pure: they operate on names, file-listing arrays, and
// plain records - never the filesystem and never a database.

import path from "node:path";
import { sanitizeId } from "./lib.js";

// A regenerate history copy is named "<stem> (YYYY-MM-DD).<ext>" or
// "<stem> (YYYY-MM-DD) (<n>).<ext>". These are NOT current outputs.
const DATED_COPY_STEM_RE = / \(\d{4}-\d{2}-\d{2}\)( \(\d+\))?$/;

export function isDatedCopy(name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return DATED_COPY_STEM_RE.test(stem);
}

// The CURRENT (non-history) files: dated regenerate copies dropped.
export function currentFiles(files) {
  return files.filter((f) => !isDatedCopy(f.name));
}

// YYYY-MM-DD in LOCAL time (matches the app's "use today's local date" idiom).
export function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Coerce a spawned {tasks, projects} shape into two clean, deduped id lists. Each
// id runs through sanitizeId (shape guard); blanks + dupes drop. Both arrays are
// always present.
export function coerceSpawned(v) {
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

// Is this .md an interview-prep DELIVERABLE (the prep sheet / STAR bank)?
export function isPrepDoc(name) {
  const n = name.toLowerCase();
  if (!n.endsWith(".md")) return false;
  if (n.includes("gaps") || n.includes("job-description") || n.includes("feedback")) return false;
  return n.includes("interview") || n.includes("prep") || n.includes("star");
}

// Derive the job_files `kind` for a companion file from its name, mirroring what
// the stores' OWN write paths set (SIM-393 I1; identical to migrate-data.mjs's
// jobFileKind so a synced file's kind matches a migrated one). Note kinds first (a
// current .md named gaps/job-description/feedback), then the cv/cover/other
// artifact derivation. Shared by FileStore.addJobFileIfAbsent and
// PgStore.addJobFileIfAbsent so the two backends can never drift on kind.
export function jobFileKind(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".md") && !isDatedCopy(name)) {
    if (lower.includes("gaps")) return "gaps";
    if (lower.includes("job-description")) return "job-description";
    if (lower.includes("feedback")) return "feedback";
  }
  if (lower.includes("cv")) return "cv";
  if (lower.includes("cover")) return "cover";
  return "other";
}

// The read-only ledger vocabularies each YAML doc normalizes to (ensureArrays).
export const LEDGER_ARRAYS = {
  "roadmap.yaml": ["phases"],
  "portfolio.yaml": ["projects", "milestones"],
  "agents.yaml": ["groups", "roles"],
};

// Normalize one raw request record into the served shape. Preserves the VERBATIM
// text; the id-typed spawned refs are coerced. Returns null for a record with no
// id (tolerant read - skip, never throw). Shared so FileStore.loadRequests and
// PgStore.loadRequests normalize identically.
export function normalizeRequest(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || !r.id) return null;
  const out = {
    id: String(r.id),
    text: typeof r.text === "string" ? r.text : "",
    source: r.source === "chatbot" ? "chatbot" : "session",
    created: typeof r.created === "string" ? r.created : "",
    ts: typeof r.ts === "string" ? r.ts : "",
  };
  if (typeof r.assessment === "string" && r.assessment.trim()) out.assessment = r.assessment;
  out.spawned = coerceSpawned(r.spawned);
  return out;
}
