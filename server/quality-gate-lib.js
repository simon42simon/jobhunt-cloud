// SIM-598 (JP-6) - the fail-closed generation-quality gate: a deterministic
// page-count check for a rendered CV / cover-letter artifact, usable at DRAFT
// time (a .docx, since first-draft-job renders --no-pdf) as well as at
// finalize (a .pdf). Closes the gap the owner hit directly: an over-2-page CV
// shipped from a first-draft batch because the old page guard was PDF-based
// and only ran at finalize, while at draft time the 2-page cap existed only as
// prose a model was trusted to follow. Pure + import-only (no socket, no DB,
// no spawn, and NO new npm dependency - this lane's fence forbids touching
// package.json) so every check here is unit-tested directly against real
// bytes, mirroring runner-lib.js's "hybrid runner: pure, importable helpers"
// posture.
//
// SCOPE OF "FAIL-CLOSED" HERE: this module blocks a CONFIRMED, MEASURED
// overflow - it does not guess. When a file cannot be measured (not really a
// docx/pdf - malformed bytes, or in tests, a lightweight placeholder fixture),
// checkPageCap reports the gate as not-applicable rather than a violation.
// This pipeline's real renderers (fpdf2 for PDF, python-docx for .docx) always
// produce measurable output, so a genuine render is always covered; an
// unmeasurable file in production is itself a different anomaly this narrow
// gate has nothing to say about. Guessing "violation" on ambiguity would trade
// one failure mode (a silent overflow) for a worse one (blocking every real
// draft on a parser edge case) - so it stays silent instead.

import zlib from "node:zlib";

// The caps SIM-598 states explicitly: CV <= 2 pages, cover letter <= 1 page.
// Only these two artifact kinds are gated; every other kind (gaps,
// job-description, prep, offer, follow-up, other) is untouched by this module.
export const PAGE_CAPS = { cv: 2, cover: 1 };

// ---- PDF: object-count page estimator --------------------------------------
// fpdf2 (this pipeline's PDF renderer, per merge_application_pdf.py) writes
// plain, uncompressed page objects - no compressed object streams - so every
// page in the file shows up as a literal "/Type /Page" token. The negative
// lookahead excludes "/Type /Pages", the page-TREE root, which is not a page.
// Deterministic, no PDF library needed. A producer that DOES use compressed
// object streams would undercount here; out of scope, since nothing in this
// pipeline renders that way today.
const PDF_PAGE_OBJECT_RE = /\/Type\s*\/Page(?!s)\b/g;

export function countPdfPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  // latin1 is byte-preserving (never mangles binary the way utf8 decoding
  // would), and every byte we care about ("/Type /Page") is plain ASCII.
  const text = buffer.toString("latin1");
  const matches = text.match(PDF_PAGE_OBJECT_RE);
  return matches && matches.length > 0 ? matches.length : null;
}

// ---- DOCX: word-count page estimator ---------------------------------------
// A .docx is a ZIP archive; word/document.xml holds the document body as XML.
// True pagination needs real layout (fonts, margins, line-breaking), which
// this gate deliberately does not attempt to reproduce - that fidelity is the
// vault-side AFM-width estimator's job (SIM-598 scope item 1, a separate
// slice outside this lane's fence). This is the coarser, conservative
// backstop the ticket calls for so a --no-pdf DRAFT render (no PDF exists yet
// to count) is not gated by prose alone: extract the run text, count words,
// divide by a words-per-page constant calibrated for a dense single-column
// resume/cover-letter layout (~11pt body text, ~0.7in margins). The constant
// deliberately leans conservative (i.e. LOW) - a false block just costs a
// re-render; a missed overflow is the exact bug this ticket exists to close.
const WORDS_PER_PAGE_ESTIMATE = 500;

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

// Minimal, dependency-free ZIP reader: locate ONE named entry's bytes via the
// central directory (never the fragile "walk local headers in order" - a
// streamed entry can zero its local-header sizes and rely on a trailing data
// descriptor, but the central directory's sizes are always authoritative).
// Returns the entry's raw (post-decompression) bytes, or null if the buffer
// is not a ZIP / has no such entry / uses a compression method this reader
// does not support (anything but store=0 or deflate=8 - docx writers never
// use anything else in practice).
function readZipEntry(buffer, entryName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  const searchFloor = Math.max(0, buffer.length - 65557); // EOCD + max comment
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFloor; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buffer.length) return null;

  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== ZIP_CDH_SIG) return null;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const lfhOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === entryName) return readZipLocalData(buffer, lfhOffset, method, compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function readZipLocalData(buffer, lfhOffset, method, compSize) {
  if (lfhOffset + 30 > buffer.length || buffer.readUInt32LE(lfhOffset) !== ZIP_LFH_SIG) return null;
  const nameLen = buffer.readUInt16LE(lfhOffset + 26);
  const extraLen = buffer.readUInt16LE(lfhOffset + 28);
  const dataStart = lfhOffset + 30 + nameLen + extraLen;
  if (dataStart + compSize > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null; // an unsupported compression method - never seen from a docx writer
}

// Extract the visible text of a .docx's word/document.xml: strip every XML
// tag to a single space (so adjacent runs never fuse into one token) and
// collapse entities. Not a real OOXML parser - good enough for a word count.
export function extractDocxText(buffer) {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) return null;
  return xml
    .toString("utf8")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, " ")
    .trim();
}

export function estimateDocxPages(buffer, wordsPerPage = WORDS_PER_PAGE_ESTIMATE) {
  const text = extractDocxText(buffer);
  if (text == null) return null;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return null;
  return Math.max(1, Math.ceil(words / wordsPerPage));
}

// ---- dispatch + the gate verdict -------------------------------------------
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

// { pages: number|null, method: string|null } - method names the estimator
// actually used, so a block's reason can say HOW the count was reached.
export function pageCountForArtifact({ name, mime, buffer }) {
  const ext = extOf(name);
  if (ext === "pdf" || mime === "application/pdf") {
    return { pages: countPdfPages(buffer), method: "pdf-object-count" };
  }
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { pages: estimateDocxPages(buffer), method: "docx-word-count-estimate" };
  }
  return { pages: null, method: null };
}

// The gate's one entry point. `kind` is the artifactKindOf() classification
// (runner-lib.js) - "cv" | "cover" | anything else. Returns:
//   { ok: true,  applicable: false }                          - kind not capped
//   { ok: true,  applicable: false, pages: null }              - unmeasurable, not a violation
//   { ok: true,  applicable: true,  pages, cap, method }        - measured, within cap
//   { ok: false, applicable: true,  pages, cap, method, reason } - measured, OVER cap
export function checkPageCap({ kind, name, mime, buffer }) {
  const cap = PAGE_CAPS[kind];
  if (!cap) return { ok: true, applicable: false };
  const { pages, method } = pageCountForArtifact({ name, mime, buffer });
  if (pages == null) return { ok: true, applicable: false, pages: null, method };
  if (pages > cap) {
    return {
      ok: false,
      applicable: true,
      pages,
      cap,
      method,
      reason: `quality gate: "${name}" is ${pages} page(s), over the ${cap}-page cap for a ${kind} (measured via ${method}) - not reported done`,
    };
  }
  return { ok: true, applicable: true, pages, cap, method };
}
