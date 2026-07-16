import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// GET /api/jobs/:id/files/:name (t-1783201094679) - the remote-honest Files
// path. POST /api/open shell-opens a file on the machine RUNNING the server,
// which is a silent no-op from a phone; this endpoint streams the bytes to the
// requesting client instead. It is a GUARDED reader, not a static file server:
//   - the job id must resolve INSIDE Jobs/ (resolveJobFolder containment);
//   - the name must be a DIRECT child file the job listing already serves;
//   - the served MIME comes from a conservative extension map (text formats go
//     out as text/plain, unmapped/scriptable extensions as octet-stream);
//   - nosniff + CSP default-src 'none' + private,no-store on every response
//     (the ADR-014 attachment-reader idiom).
// Read-only by construction: the suite asserts served bytes are exact and the
// fixture file on disk is untouched.

let app;
let fixture;

const jobA = [
  "---", "type: job", "role: Alpha Role", "employer: Alpha Co",
  "track: industry_outreach_focused", "fit: strong", "status: drafted",
  "sector: bps", "tailoring: heavy", "deadline: 2099-07-15", "tags: [job]",
  "---", "", "# Alpha Role - Alpha Co", "", "**Lead with:** alpha", "",
].join("\n");

// Deterministic non-trivial binary payload standing in for a .docx (the
// endpoint never parses content; byte fidelity is what matters).
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0x01, 0x02]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\nfake body\n", "latin1");

const A = "Alpha Role - Alpha Co";

function writeFixture() {
  fs.rmSync(fixture, { recursive: true, force: true });
  const a = path.join(fixture, A);
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "Alpha Role.md"), jobA, "utf8");
  fs.writeFileSync(path.join(a, "Simon Kim - CV - Alpha Role.docx"), DOCX_BYTES);
  fs.writeFileSync(path.join(a, "posting.pdf"), PDF_BYTES);
  fs.writeFileSync(path.join(a, "notes.html"), "<script>alert(1)</script>", "utf8");
  // A subdirectory must never be servable (direct child FILES only).
  fs.mkdirSync(path.join(a, "subdir"), { recursive: true });
  fs.writeFileSync(path.join(a, "subdir", "secret.txt"), "inside", "utf8");
  // A sibling file OUTSIDE the job folder that traversal must never reach.
  fs.writeFileSync(path.join(fixture, "outside.txt"), "outside jobs folder", "utf8");
}

const id = (s) => encodeURIComponent(s);

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jh-fileserve-"));
  writeFixture();
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(fixture, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => writeFixture());

describe("GET /api/jobs/:id/files/:name - guarded job-file reader", () => {
  it("streams a listed file byte-exact with the guarded headers (docx)", async () => {
    const res = await request(app)
      .get(`/api/jobs/${id(A)}/files/${id("Simon Kim - CV - Alpha Role.docx")}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, DOCX_BYTES)).toBe(0); // byte-exact
    expect(res.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("Simon Kim - CV - Alpha Role.docx")}`
    );
  });

  it("serves a pdf as application/pdf and leaves the file on disk untouched", async () => {
    const before = fs.readFileSync(path.join(fixture, A, "posting.pdf"));
    const res = await request(app).get(`/api/jobs/${id(A)}/files/${id("posting.pdf")}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const after = fs.readFileSync(path.join(fixture, A, "posting.pdf"));
    expect(Buffer.compare(before, after)).toBe(0); // read-only path
  });

  it("serves markdown as text/plain (never text/html)", async () => {
    const res = await request(app).get(`/api/jobs/${id(A)}/files/${id("Alpha Role.md")}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("serves an unmapped/scriptable extension as application/octet-stream, never its native type", async () => {
    const res = await request(app).get(`/api/jobs/${id(A)}/files/${id("notes.html")}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("404s a file the job folder does not list", async () => {
    const res = await request(app).get(`/api/jobs/${id(A)}/files/${id("nope.pdf")}`);
    expect(res.status).toBe(404);
  });

  it("404s a subdirectory entry (direct child files only)", async () => {
    const res = await request(app).get(`/api/jobs/${id(A)}/files/${id("subdir")}`);
    expect(res.status).toBe(404);
  });

  it("cannot traverse out of the job folder via the name", async () => {
    for (const name of ["../outside.txt", "..\\outside.txt", "subdir/secret.txt", "subdir\\secret.txt"]) {
      const res = await request(app).get(`/api/jobs/${id(A)}/files/${encodeURIComponent(name)}`);
      expect([400, 404]).toContain(res.status);
      expect(res.headers["content-type"] || "").not.toContain("text/plain; charset=utf-8");
    }
  });

  it("cannot traverse out of Jobs/ via the job id", async () => {
    const res = await request(app).get(`/api/jobs/${encodeURIComponent("../")}/files/${id("outside.txt")}`);
    expect([400, 404]).toContain(res.status);
  });

  it("404s an unknown job id", async () => {
    const res = await request(app).get(`/api/jobs/${id("No Such Job")}/files/${id("posting.pdf")}`);
    expect(res.status).toBe(404);
  });
});
