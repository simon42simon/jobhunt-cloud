// SIM-393 I1 - pure helpers for the vault->cloud sync ingest surface.
//
// Mirrors the runner-lib.js posture: no socket, no DB, no fs, so the security- and
// correctness-critical bits (content hashing, the canonical row hash, the same
// STRING_COLS/SCALAR_COLS frontmatter validation migrate-data re-runs) are unit-
// tested directly and SHARED by BOTH store backends so they can never drift.
//
// Filename/path validation is NOT here - it lives in the single shared
// server/name-safety.js (guardian GC-1). This module owns only the JOBS-domain
// content semantics of the sync surface.

import crypto from "node:crypto";

// The frontmatter columns migrate-data's importDataset validates + serves RAW.
// Kept identical to ops/migrate-data.mjs so the server-side re-validation the design
// mandates ("STRING_COLS/SCALAR_COLS validation server-side re-run") matches the
// one-shot migration exactly - a job the migration would have accepted is the only
// job the sync accepts, and vice-versa.
export const STRING_COLS = ["type", "status", "fit", "track", "sector", "tailoring", "link", "next_action"];
export const SCALAR_COLS = ["deadline", "applied", "next_action_date", "source"];

// sha256 hex of a Buffer / string. The one hashing primitive the sync surface uses
// (transport integrity on PUT, the manifest hashes, insert-or-report comparison).
export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? "" : input));
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Deterministic JSON: object keys sorted recursively so two semantically-equal
// frontmatter objects (differing only in key ORDER, as a YAML round-trip or a jsonb
// read-back may) hash identically. Arrays keep their order (meaningful); scalars
// pass through. This is what makes rowSha stable across FileStore (re-parsed
// frontmatter) and PgStore (raw_frontmatter jsonb) for the SAME job.
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// rowSha for a job (design B2): sha256(canonical JSON of raw_frontmatter + "\n" +
// body). The manifest exposes it so the sync client can detect frontmatter drift on
// an existing (cloud-owned) job WITHOUT shipping the body. Both store backends
// compute it the same way over the same (front, body), so a job seeded identically
// on FileStore and PgStore yields the identical rowSha.
export function rowShaOf(front, body) {
  return sha256Hex(canonicalJson(front || {}) + "\n" + (body == null ? "" : String(body)));
}

function badRequest(message) {
  const e = new Error(message);
  e.httpStatus = 400;
  e.code = "INVALID_JOB";
  return e;
}

// Re-run migrate-data's readJobsDomain type validation server-side, so a poisoned
// or malformed sync payload is a 400, never a bad row. Throws httpStatus-400 on the
// first violation; returns a normalized { role, employer, front, body, tags } on
// success. Insert-only callers use the return value for the row.
//
// `front` is the full raw frontmatter object (as parsed from the vault <Role>.md),
// preserved VERBATIM into raw_frontmatter for fidelity; role/employer/tags are the
// modeled top-level fields the jobs table also stores in typed columns.
export function validateJobFront({ role, employer, front, tags }) {
  if (front != null && (typeof front !== "object" || Array.isArray(front))) {
    throw badRequest("front must be an object");
  }
  if (typeof role !== "string" || !role) throw badRequest('role must be a non-empty string (jobs.role is NOT NULL)');
  if (typeof employer !== "string" || !employer) throw badRequest('employer must be a non-empty string (jobs.employer is NOT NULL)');
  const d = front || {};
  for (const key of STRING_COLS) {
    if (d[key] != null && typeof d[key] !== "string") throw badRequest(`frontmatter "${key}" must be a string`);
  }
  for (const key of SCALAR_COLS) {
    const v = d[key];
    if (v != null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw badRequest(`frontmatter "${key}" must be a scalar`);
    }
  }
  let outTags = [];
  if (Array.isArray(tags)) {
    for (const t of tags) if (typeof t !== "string") throw badRequest("every tag must be a string");
    outTags = tags;
  } else if (typeof tags === "string") {
    outTags = [tags];
  } else if (tags != null) {
    throw badRequest('"tags" must be a string or a list of strings');
  }
  return { role, employer, front: d, tags: outTags };
}
