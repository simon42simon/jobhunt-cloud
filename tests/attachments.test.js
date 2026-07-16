import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sniffImageMime, extFromMime, MIME_ALLOWLIST } from "../server/lib.js";

// Pasted-image ticket attachments (ADR-014). Two layers under test:
//   1. Pure helpers (sniffImageMime / extFromMime) - importable without a server.
//   2. The upload endpoint (POST /api/tasks/:id/attachments) and the guarded
//      reader (GET /api/tasks/:id/attachments/:file), driven with supertest
//      against the importable app (JOBHUNT_TEST=1).
//
// Hermetic: own fixture tasks.yaml in a temp docs dir (JOBHUNT_DOCS_DIR seam);
// the committed docs/ is never read or written, and docs/attachments/ lands
// under the temp dir. Caps are shrunk via the env seam (JOBHUNT_ATTACH_MAX_*)
// so the oversize / over-count guards are exercised with tiny buffers.

// ---- tiny valid-magic image buffers ---------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_SIG = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), // "RIFF"
  Buffer.from([0x1a, 0x00, 0x00, 0x00]), // size (ignored by the sniff)
  Buffer.from([0x57, 0x45, 0x42, 0x50]), // "WEBP"
  Buffer.from([0x56, 0x50, 0x38, 0x20]), // "VP8 "
]);

// A png with a distinct tail -> a distinct sha256 (so count-cap tests get
// genuinely different files). `pad` grows the byte length for the size-cap test.
function png(tag = "", pad = 0) {
  return Buffer.concat([PNG_SIG, Buffer.from(tag, "utf8"), Buffer.alloc(pad, 0x2a)]);
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Force supertest to buffer a binary response so res.body is the raw bytes.
function binaryParser(res, cb) {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------
describe("sniffImageMime", () => {
  it("detects each allowlisted raster type from its magic bytes", () => {
    expect(sniffImageMime(png())).toBe("image/png");
    expect(sniffImageMime(JPEG_SIG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF_SIG)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("returns null when bytes match no allowlisted format (junk / HTML)", () => {
    expect(sniffImageMime(Buffer.from("<html><script>x</script></html>", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from("not an image at all", "utf8"))).toBeNull();
    // A RIFF container that is NOT WEBP (e.g. a WAV) must not be accepted.
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
    expect(sniffImageMime(wav)).toBeNull();
  });
  it("returns null (never throws) for a short or non-Buffer input", () => {
    expect(sniffImageMime(Buffer.alloc(2))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime("image/png")).toBeNull();
    expect(sniffImageMime(null)).toBeNull();
    expect(sniffImageMime(undefined)).toBeNull();
  });
});

describe("extFromMime", () => {
  it("maps each allowlisted MIME to its stored extension", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
  });
  it("is case-insensitive on the MIME", () => {
    expect(extFromMime("image/PNG")).toBe("png");
    expect(extFromMime("  image/JPEG ")).toBe("jpg");
  });
  it("returns null for a non-allowlisted or non-string MIME (SVG excluded)", () => {
    expect(extFromMime("image/svg+xml")).toBeNull();
    expect(extFromMime("text/plain")).toBeNull();
    expect(extFromMime("")).toBeNull();
    expect(extFromMime(null)).toBeNull();
    expect(extFromMime(42)).toBeNull();
  });
  it("MIME_ALLOWLIST has exactly the four raster types (no SVG)", () => {
    expect(Object.keys(MIME_ALLOWLIST).sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Endpoints
// ---------------------------------------------------------------------------
let app;
let tmpRoot;
let docsDir;
let jobsDir;

const MAX_BYTES = 64;
const MAX_COUNT = 2;
const TASK_ID = "t-attach-target";
const OTHER_ID = "t-attach-other"; // never gets an image; strip-clean subject

function tasksFile() {
  return path.join(docsDir, "tasks.yaml");
}
function attachDir(taskId) {
  return path.join(docsDir, "attachments", taskId);
}
function writeTasksFixture() {
  const yaml = [
    "columns:",
    "  - backlog",
    "  - todo",
    "  - in_progress",
    "  - done",
    "tasks:",
    `  - id: ${TASK_ID}`,
    "    title: Ticket that receives image attachments",
    "    epic: testing",
    "    priority: medium",
    "    status: triage",
    "    created: '2026-07-04'",
    `  - id: ${OTHER_ID}`,
    "    title: Ticket that never gets an image",
    "    epic: testing",
    "    priority: low",
    "    status: backlog",
    "    created: '2026-07-04'",
    "",
  ].join("\n");
  fs.writeFileSync(tasksFile(), yaml, "utf8");
}

function upload(taskId, mime, buf, name) {
  let req = request(app).post(`/api/tasks/${taskId}/attachments`).set("Content-Type", mime);
  if (name !== undefined) req = req.set("X-Attachment-Name", name);
  return req.send(buf);
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-attach-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  writeTasksFixture();

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_ATTACH_MAX_BYTES = String(MAX_BYTES);
  process.env.JOBHUNT_ATTACH_MAX_COUNT = String(MAX_COUNT);
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  writeTasksFixture();
  // Clear any files a prior test wrote under the temp attachments store.
  try {
    fs.rmSync(path.join(docsDir, "attachments"), { recursive: true, force: true });
  } catch {}
});

describe("POST /api/tasks/:id/attachments - happy path", () => {
  it("writes docs/attachments/<taskId>/<sha256>.<ext> and appends unforgeable metadata", async () => {
    const buf = png("hello");
    const res = await upload(TASK_ID, "image/png", buf, "Screenshot 1.png");

    expect(res.status).toBe(201);
    const expectedFile = `${sha(buf)}.png`;
    expect(res.body).toMatchObject({
      file: expectedFile,
      name: "Screenshot 1.png",
      mime: "image/png",
      bytes: buf.length,
    });
    expect(typeof res.body.ts).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.ts))).toBe(false);

    // The bytes are on disk at the reconstructable, content-addressed path.
    const onDisk = path.join(attachDir(TASK_ID), expectedFile);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).equals(buf)).toBe(true);
    // No staged .tmp is left behind by the atomic write.
    expect(fs.existsSync(`${onDisk}.tmp`)).toBe(false);

    // The metadata survives a reload from disk (not just the handler echo).
    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === TASK_ID);
    expect(saved.attachments).toHaveLength(1);
    expect(saved.attachments[0].file).toBe(expectedFile);
    expect(fs.readFileSync(tasksFile(), "utf8")).toMatch(/attachments:/);
  });

  it("defaults the display name when no X-Attachment-Name header is sent", async () => {
    const res = await upload(TASK_ID, "image/gif", GIF_SIG); // no name header
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("pasted image.gif");
  });
});

describe("POST /api/tasks/:id/attachments - guards", () => {
  it("(1) 404 when the parent task does not exist", async () => {
    const res = await upload("t-nope", "image/png", png());
    expect(res.status).toBe(404);
  });

  it("(2) 415 for a non-image Content-Type", async () => {
    const res = await upload(TASK_ID, "text/plain", Buffer.from("just some text", "utf8"));
    expect(res.status).toBe(415);
  });

  it("(2) 415 for SVG (deliberately excluded - scriptable XML)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', "utf8");
    const res = await upload(TASK_ID, "image/svg+xml", svg);
    expect(res.status).toBe(415);
  });

  it("(3) 415 when the bytes do not match the declared type (HTML-as-png)", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
    const res = await upload(TASK_ID, "image/png", html);
    expect(res.status).toBe(415);
    // Nothing was written for the rejected upload.
    expect(fs.existsSync(attachDir(TASK_ID))).toBe(false);
  });

  it("(4) 413 when the image exceeds the byte cap", async () => {
    // Valid PNG magic, padded past MAX_BYTES but within express.raw's slack so it
    // reaches the handler's explicit size check (not the parser's own 413).
    const big = png("", MAX_BYTES + 8);
    expect(big.length).toBeGreaterThan(MAX_BYTES);
    const res = await upload(TASK_ID, "image/png", big);
    expect(res.status).toBe(413);
  });

  it("(5) 409 when the ticket already holds the maximum count of DISTINCT images", async () => {
    expect((await upload(TASK_ID, "image/png", png("a"))).status).toBe(201);
    expect((await upload(TASK_ID, "image/png", png("b"))).status).toBe(201);
    const third = await upload(TASK_ID, "image/png", png("c"));
    expect(third.status).toBe(409);
  });

  it("de-dupes identical bytes idempotently (200, no second record, count not consumed)", async () => {
    const buf = png("same");
    const first = await upload(TASK_ID, "image/png", buf);
    expect(first.status).toBe(201);
    const again = await upload(TASK_ID, "image/png", buf);
    expect(again.status).toBe(200);
    expect(again.body.file).toBe(first.body.file);

    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === TASK_ID);
    expect(saved.attachments).toHaveLength(1); // not two
  });
});

describe("attachments are server-managed and unforgeable", () => {
  it("ignores an `attachments` array supplied in a POST /api/tasks body", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "forged create", attachments: [{ file: "evil.png", name: "x", mime: "image/png", bytes: 9, ts: "t" }] });
    expect(res.status).toBe(201);
    expect(res.body.attachments).toBeUndefined();

    // And it is not written to disk (saveTasks strips the empty array).
    const saved = (await request(app).get("/api/tasks")).body.tasks.find((t) => t.id === res.body.id);
    expect(saved.attachments === undefined || saved.attachments.length === 0).toBe(true);
  });

  it("ignores an `attachments` array supplied in a PATCH /api/tasks/:id body", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ attachments: [{ file: "evil.png", name: "x", mime: "image/png", bytes: 9, ts: "t" }] });
    expect(res.status).toBe(200);
    expect(res.body.attachments === undefined || res.body.attachments.length === 0).toBe(true);
  });

  it("a ticket that never received an image stays keyless on disk (strip-clean)", async () => {
    await upload(TASK_ID, "image/png", png("x")); // triggers a saveTasks
    const raw = fs.readFileSync(tasksFile(), "utf8");
    const otherBlock = raw.slice(raw.indexOf(`id: ${OTHER_ID}`));
    expect(otherBlock).not.toMatch(/attachments:/);
  });
});

describe("GET /api/tasks/:id/attachments/:file - guarded reader", () => {
  it("serves a referenced file inline with nosniff + a locked-down CSP", async () => {
    const buf = png("readme");
    const up = await upload(TASK_ID, "image/png", buf);
    expect(up.status).toBe(201);

    const res = await request(app)
      .get(`/api/tasks/${TASK_ID}/attachments/${up.body.file}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe(`inline; filename="${up.body.file}"`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(buf)).toBe(true);
  });

  it("404s a file the task does not reference (existence allowlist)", async () => {
    await upload(TASK_ID, "image/png", png("one"));
    const res = await request(app).get(`/api/tasks/${TASK_ID}/attachments/${sha(png("other"))}.png`);
    expect(res.status).toBe(404);
  });

  it("404s a traversal-shaped :file and never leaks a file outside the store", async () => {
    await upload(TASK_ID, "image/png", png("guard"));
    const res = await request(app).get(
      `/api/tasks/${TASK_ID}/attachments/${encodeURIComponent("../../tasks.yaml")}`,
    );
    expect(res.status).toBe(404);
    expect(res.text || "").not.toMatch(/columns:/); // tasks.yaml content never served
  });

  it("404s when the parent task is unknown", async () => {
    const res = await request(app).get(`/api/tasks/t-nope/attachments/${sha(png())}.png`);
    expect(res.status).toBe(404);
  });
});
