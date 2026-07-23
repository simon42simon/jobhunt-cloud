// Test-only fixture builders for SIM-598 (JP-6) - the quality gate's page
// estimators need REAL (if minimal) docx/pdf bytes to measure, not the
// lightweight placeholder content ("cv bytes", "%PDF-1.4 tailored cv") the
// rest of the suite uses to simulate an artifact landing. These builders
// produce bytes the gate's own readers can genuinely parse:
//   - buildDocxFixture: a real single-entry ZIP (word/document.xml) - no
//     external zip library, hand-rolled to mirror server/quality-gate-lib.js's
//     own reader exactly (local header + central directory + EOCD).
//   - buildPdfFixture: fpdf2-shaped plain PDF objects (one literal
//     "/Type /Page" per page, plus the page-tree "/Type /Pages" root that
//     must NOT be counted).
// CRC32 is written as 0 throughout - the gate's own reader never validates it,
// and nothing else reads these fixtures.

import zlib from "node:zlib";

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const method = e.method === 8 ? 8 : 0;
    const stored = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const localOffset = offset;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(0, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, stored);
    offset += lfh.length + nameBuf.length + stored.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(0, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(localOffset, 42);
    centralParts.push(cdh, nameBuf);
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// A real single-entry docx-shaped ZIP whose word/document.xml body carries
// exactly `wordCount` space-separated words. `method` picks compression: 8
// (deflate, the default - what python-docx/Word actually write) or 0 (stored).
export function buildDocxFixture(wordCount, { method = 8 } = {}) {
  const words = Array.from({ length: wordCount }, (_, i) => `word${i}`).join(" ");
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body><w:p><w:r><w:t xml:space="preserve">${words}</w:t></w:r></w:p></w:body></w:document>`;
  return buildZip([{ name: "word/document.xml", data: Buffer.from(xml, "utf8"), method }]);
}

// An fpdf2-shaped plain PDF with exactly `pageCount` page objects, plus one
// page-TREE "/Type /Pages" root (object 2) that a correct counter must
// exclude.
export function buildPdfFixture(pageCount) {
  const pageObjs = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjs.push(`${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`);
  }
  const body =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [] >>\nendobj\n` +
    pageObjs.join("");
  return Buffer.from(body, "latin1");
}
