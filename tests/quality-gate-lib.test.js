// SIM-598 (JP-6) - unit tests for the fail-closed generation-quality gate's
// pure page-count estimators (server/quality-gate-lib.js). Real (if minimal)
// docx/pdf bytes throughout via tests/helpers/docx-fixture.mjs - the
// estimators are deliberately NOT exercised with placeholder strings here,
// since "cannot measure -> not applicable" is already the documented,
// intentional behavior for those (proven separately below).

import { describe, it, expect } from "vitest";
import {
  PAGE_CAPS,
  countPdfPages,
  extractDocxText,
  estimateDocxPages,
  pageCountForArtifact,
  checkPageCap,
} from "../server/quality-gate-lib.js";
import { buildDocxFixture, buildPdfFixture } from "./helpers/docx-fixture.mjs";

describe("PAGE_CAPS", () => {
  it("is exactly the SIM-598 caps: CV <= 2pp, cover letter <= 1p", () => {
    expect(PAGE_CAPS).toEqual({ cv: 2, cover: 1 });
  });
});

describe("countPdfPages", () => {
  it("counts one /Type /Page object per page", () => {
    expect(countPdfPages(buildPdfFixture(1))).toBe(1);
    expect(countPdfPages(buildPdfFixture(2))).toBe(2);
    expect(countPdfPages(buildPdfFixture(3))).toBe(3);
  });

  it("never counts the /Type /Pages page-TREE root as a page", () => {
    // buildPdfFixture(2) writes exactly one "/Type /Pages" (object 2) alongside
    // its 2 "/Type /Page" objects - a naive substring count would see 3.
    const buf = buildPdfFixture(2);
    expect(buf.toString("latin1")).toContain("/Type /Pages");
    expect(countPdfPages(buf)).toBe(2);
  });

  it("returns null for bytes with no recognizable page object (not a violation - unmeasurable)", () => {
    expect(countPdfPages(Buffer.from("%PDF-1.4 tailored cv", "utf8"))).toBeNull();
    expect(countPdfPages(Buffer.alloc(0))).toBeNull();
    expect(countPdfPages(null)).toBeNull();
  });
});

describe("extractDocxText / estimateDocxPages", () => {
  it("extracts the word/document.xml body text, tags stripped", () => {
    const buf = buildDocxFixture(5);
    const text = extractDocxText(buf);
    expect(text).toBe("word0 word1 word2 word3 word4");
  });

  it("works identically for a STORED (uncompressed) entry, not just deflate", () => {
    const buf = buildDocxFixture(5, { method: 0 });
    expect(extractDocxText(buf)).toBe("word0 word1 word2 word3 word4");
  });

  it("estimates 1 page for a short, clearly-in-bounds CV", () => {
    expect(estimateDocxPages(buildDocxFixture(200))).toBe(1);
  });

  it("estimates multiple pages once the word count crosses the per-page estimate", () => {
    // 500 words/page (the documented constant): 1001 words -> ceil(1001/500) = 3
    expect(estimateDocxPages(buildDocxFixture(1001))).toBe(3);
  });

  it("returns null for bytes that are not a real ZIP (not a violation - unmeasurable)", () => {
    expect(estimateDocxPages(Buffer.from("cv bytes", "utf8"))).toBeNull();
    expect(extractDocxText(Buffer.from("cv bytes", "utf8"))).toBeNull();
  });

  it("returns null for a ZIP with no word/document.xml entry", () => {
    // A garbage ZIP-ish buffer still without the expected central directory
    // entry name resolves to null just like a non-ZIP.
    expect(estimateDocxPages(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("pageCountForArtifact", () => {
  it("dispatches to the PDF counter by extension", () => {
    expect(pageCountForArtifact({ name: "CV.pdf", buffer: buildPdfFixture(2) })).toEqual({ pages: 2, method: "pdf-object-count" });
  });

  it("dispatches to the docx estimator by extension", () => {
    const r = pageCountForArtifact({ name: "CV.docx", buffer: buildDocxFixture(200) });
    expect(r).toEqual({ pages: 1, method: "docx-word-count-estimate" });
  });

  it("falls back to mime when the extension is missing/unrecognized", () => {
    expect(pageCountForArtifact({ name: "CV", mime: "application/pdf", buffer: buildPdfFixture(1) }).method).toBe("pdf-object-count");
  });

  it("is not applicable to a format neither estimator recognizes (e.g. markdown)", () => {
    expect(pageCountForArtifact({ name: "gaps.md", buffer: Buffer.from("# gaps") })).toEqual({ pages: null, method: null });
  });
});

describe("checkPageCap - the gate's verdict", () => {
  it("is not applicable to an uncapped kind, regardless of content", () => {
    expect(checkPageCap({ kind: "gaps", name: "gaps.md", buffer: Buffer.from("anything") })).toEqual({ ok: true, applicable: false });
    expect(checkPageCap({ kind: "other", name: "notes.md", buffer: buildPdfFixture(9) })).toEqual({ ok: true, applicable: false });
  });

  it("PASSES a CV within the 2-page cap", () => {
    const r = checkPageCap({ kind: "cv", name: "CV - Analyst.pdf", buffer: buildPdfFixture(2) });
    expect(r).toEqual({ ok: true, applicable: true, pages: 2, cap: 2, method: "pdf-object-count" });
  });

  it("BLOCKS a CV over the 2-page cap (PDF path - finalize)", () => {
    const r = checkPageCap({ kind: "cv", name: "CV - Analyst.pdf", buffer: buildPdfFixture(3) });
    expect(r.ok).toBe(false);
    expect(r.applicable).toBe(true);
    expect(r.pages).toBe(3);
    expect(r.cap).toBe(2);
    expect(r.reason).toMatch(/CV - Analyst\.pdf.*3 page.*2-page cap/);
  });

  // THE owner-reported failure this ticket exists to close: an over-limit CV
  // shipped from a first-draft batch. First drafts render --no-pdf, so at
  // DRAFT time only a .docx exists - no PDF to count. This proves the docx
  // word-count estimator catches that overflow on its own, with zero PDF
  // involved.
  it("BLOCKS an over-limit CV at DRAFT time (.docx, --no-pdf, no PDF exists yet)", () => {
    const overLimitDocx = buildDocxFixture(1300); // ceil(1300/500) = 3 pages
    const r = checkPageCap({ kind: "cv", name: "CV - Analyst.docx", buffer: overLimitDocx });
    expect(r.ok).toBe(false);
    expect(r.pages).toBe(3);
    expect(r.method).toBe("docx-word-count-estimate");
  });

  it("PASSES a draft-time CV within cap (.docx)", () => {
    const r = checkPageCap({ kind: "cv", name: "CV - Analyst.docx", buffer: buildDocxFixture(600) }); // ceil(600/500)=2
    expect(r).toEqual({ ok: true, applicable: true, pages: 2, cap: 2, method: "docx-word-count-estimate" });
  });

  it("cover letters are capped at 1 page, independent of the CV cap", () => {
    expect(checkPageCap({ kind: "cover", name: "Cover Letter.pdf", buffer: buildPdfFixture(1) }).ok).toBe(true);
    const over = checkPageCap({ kind: "cover", name: "Cover Letter.pdf", buffer: buildPdfFixture(2) });
    expect(over.ok).toBe(false);
    expect(over.cap).toBe(1);
  });

  it("does NOT block on unmeasurable content - waves it through as not-applicable", () => {
    // A placeholder fixture like the rest of the suite uses ("%PDF-1.4 tailored
    // cv") has no counted page objects - this must NEVER read as a violation,
    // or every test/harness that posts lightweight fake artifacts breaks.
    const r = checkPageCap({ kind: "cv", name: "CV - Analyst.pdf", buffer: Buffer.from("%PDF-1.4 tailored cv", "utf8") });
    expect(r).toEqual({ ok: true, applicable: false, pages: null, method: "pdf-object-count" });
  });
});
