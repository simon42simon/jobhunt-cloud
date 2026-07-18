// SIM-393 I2 - the STRICT, READ-ONLY vault jobs-domain reader.
//
// EXTRACTED (module-split, not duplicated) from the one-shot migration script's
// `readJobsDomain` in `jobhunt-cloud/ops/migrate-data.mjs`, per the SIM-393 design
// (audit/2026-07-17-sim393-vault-cloud-dataflow-design.md, B5: "the hashing
// primitives and the jobs-domain reader are REUSED from migrate-data.mjs
// (readJobsDomain, the strict-read posture, sha256)"). migrate-data.mjs lives in
// the jobhunt-cloud repo; this dev repo has no copy of it, so the reuse mandate is
// satisfied by extracting the reader into this ONE shared module. When the repos
// reconcile, migrate-data.mjs should import readJobsDomain from here instead of
// carrying its own copy - the strict semantics below are byte-for-byte its.
//
// SAFETY POSTURE (guardian GC-6: "read-only on the vault by construction"):
//   - The ONLY fs calls in this module are fs.readdirSync / fs.readFileSync /
//     fs.statSync - read flags only. No write API appears anywhere in this file,
//     so no caller can reach a vault write through it.
//   - Every anomaly ABORTS with a precise message (VaultReadError) and a non-zero
//     exit at the CLI - the OPPOSITE of the tolerant FileStore reads: a sync must
//     never silently drop a byte of the owner's data.
//
// The `lazyBytes` option (sync-client hydration cache, design B7): hashing the
// vault reads bytes, which hydrates OneDrive online-only placeholders. With
// { lazyBytes: true } every NON-markdown companion file is returned as
// { name, size, mtimeMs, path, read() } - stat only, bytes deferred behind the
// read() thunk - so the sync client's (path,size,mtimeMs)->sha256 cache can skip
// hydrating unchanged files entirely. Markdown files are always read eagerly (the
// job file must be parsed to find the folder's `type: job` SoT and compute rowSha).
// Default (no options) is the eager migrate-data behavior: every file carries its
// bytes.

import fs from "node:fs";
import path from "node:path";
import { parseFront } from "../server/lib.js";
import { jobFileKind } from "../server/store-helpers.js";

// A strict-read abort: precise message, non-zero exit. Every check throws this.
// (migrate-data calls its equivalent MigrateError; same contract.)
export class VaultReadError extends Error {}
const fail = (msg) => {
  throw new VaultReadError(msg);
};

// mime by extension for companion files - identical table to migrate-data.mjs so a
// synced file's mime matches a migrated one.
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
export const mimeOf = (name) => MIME_BY_EXT[extOf(name)] || null;

// Frontmatter columns split by coercion class - kept identical to migrate-data.mjs
// AND server/sync-lib.js (the server re-runs the same validation on ingest):
//   STRING_COLS are served RAW by both DTO builders -> must be string.
//   SCALAR_COLS pass through normDate()/String() on both sides -> any scalar.
const STRING_COLS = ["type", "status", "fit", "track", "sector", "tailoring", "link", "next_action"];
const SCALAR_COLS = ["deadline", "applied", "next_action_date", "source"];

// STRICT read of the jobs domain (READ-ONLY; every anomaly aborts).
// Returns [{ id, jobFileName, front, body, tags, mtimeMs, files }] where each
// companion file is { name, mime, kind, mtimeMs, size, path } plus either
// `bytes` (eager / markdown) or `read()` (lazyBytes non-markdown).
export function readJobsDomain(jobsDir, warnings = [], { lazyBytes = false } = {}) {
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
        // A nested folder is INVISIBLE to the app on both backends (FileStore's
        // _listFolderFiles lists direct-child files only), so skipping it keeps
        // app-view parity exactly - and the bytes stay in the vault on disk, so
        // nothing is lost. Loud, never silent.
        warnings.push(
          `job folder "${folder}" contains a nested non-file entry "${it.name}" - SKIPPED ` +
            `(the app never reads nested folders on either backend; the bytes remain in the vault).`,
        );
        continue;
      }
      const p = path.join(folderPath, it.name);
      const isMd = it.name.toLowerCase().endsWith(".md");
      let bytes = null;
      let stat;
      try {
        stat = fs.statSync(p);
        if (!lazyBytes || isMd) bytes = fs.readFileSync(p); // read flag only
      } catch (e) {
        fail(`unreadable file: ${p} (${e.message})`);
      }
      files.push({
        name: it.name,
        bytes,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        path: p,
        // Lazy hydration thunk (read flag only). Present on every entry so callers
        // can treat eager and lazy uniformly.
        read: bytes ? () => bytes : () => fs.readFileSync(p),
      });
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
          `and its files would be dropped by a sync. Fix the folder (or move it out of Jobs/), then re-run.`,
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
