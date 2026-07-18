// SIM-393 I4 - the owner drawer upload: POST /api/jobs/:id/files.
//
// The write-path guarantees under test (design section C + guardian GC-4):
//   - INSERT-ONLY with automatic unique-name derivation: a name collision lands
//     as a "<stem> (2).<ext>" sibling and NEVER replaces existing bytes (the
//     contract clause "write paths refuse to overwrite and derive unique
//     filenames so a collision cannot clobber", implemented verbatim).
//   - Every name goes through the SHARED server/name-safety.js rules (GC-1
//     corollary): traversal, absolute forms, reserved device names, control
//     chars, trailing dot/space aliasing are all 400s.
//   - Byte cap 413 (UPLOAD_FILE_MAX_BYTES; tiny here so the 413 is cheap).
//   - Session-wall posture: the route sits BEHIND the cookie gate - anonymous
//     401 with auth ON, and no bearer token (sync lane) opens it.
//   - GC-4 demo policy: resolveUploadPolicy is the pure, deterministic seam
//     (demo <= 1 MB AND a per-job count cap of 6; real 15 MB, no count cap).
//     The end-to-end demo wiring is proven in tests/demo-mode.test.js against
//     a real APP_MODE=demo boot on embedded PG.
//
// Mirrors the boot pattern of tests/sync-endpoints.test.js.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashToken } from "../server/runner-lib.js";
import {
  resolveUploadPolicy,
  UPLOAD_FILE_MAX_BYTES_DEFAULT,
  UPLOAD_DEMO_MAX_BYTES,
  UPLOAD_DEMO_MAX_COUNT,
} from "../server/lib.js";

const sh = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SYNC_TOKEN = "sync-token-abcdefghij-1234567890";
const JOB = "Analyst - Acme Co";
const uploadPath = (id = JOB) => `/api/jobs/${encodeURIComponent(id)}/files`;
const readerPath = (name, id = JOB) => `/api/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;

const upload = (app, name, bytes, id = JOB) =>
  request(app)
    .post(uploadPath(id))
    .set("x-file-name", encodeURIComponent(name))
    .set("content-type", "application/octet-stream")
    .send(bytes);

const readBytes = async (app, name) => {
  const r = await request(app).get(readerPath(name)).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  return { status: r.status, bytes: r.body };
};

// ---------------------------------------------------------------------------
// The GC-4 policy seam (pure - always runs, no Postgres needed).
// ---------------------------------------------------------------------------
describe("resolveUploadPolicy (GC-4)", () => {
  it("real instance: guardian-ratified 15 MB default, env-overridable, NO count cap", () => {
    expect(resolveUploadPolicy({ demo: false })).toEqual({ maxBytes: 15 * 1024 * 1024, maxCount: null });
    expect(UPLOAD_FILE_MAX_BYTES_DEFAULT).toBe(15 * 1024 * 1024);
    expect(resolveUploadPolicy({ demo: false, env: { UPLOAD_FILE_MAX_BYTES: "2048" } })).toEqual({
      maxBytes: 2048,
      maxCount: null,
    });
  });

  it("demo instance: capped at <= 1 MB AND a per-job count cap of 6 (ATTACHMENT_MAX_COUNT precedent)", () => {
    expect(resolveUploadPolicy({ demo: true })).toEqual({ maxBytes: UPLOAD_DEMO_MAX_BYTES, maxCount: UPLOAD_DEMO_MAX_COUNT });
    expect(UPLOAD_DEMO_MAX_BYTES).toBe(1024 * 1024);
    expect(UPLOAD_DEMO_MAX_COUNT).toBe(6);
  });

  it("a mis-set env cap can never RAISE the demo ceiling (floor'd min)", () => {
    const p = resolveUploadPolicy({ demo: true, env: { UPLOAD_FILE_MAX_BYTES: String(50 * 1024 * 1024) } });
    expect(p.maxBytes).toBe(UPLOAD_DEMO_MAX_BYTES);
    // ...but a SMALLER env cap still applies in demo too
    expect(resolveUploadPolicy({ demo: true, env: { UPLOAD_FILE_MAX_BYTES: "512" } }).maxBytes).toBe(512);
  });

  it("garbage env values fall back to the default", () => {
    for (const bad of ["", "0", "-5", "NaN", "lots"]) {
      expect(resolveUploadPolicy({ demo: false, env: { UPLOAD_FILE_MAX_BYTES: bad } }).maxBytes).toBe(
        UPLOAD_FILE_MAX_BYTES_DEFAULT,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Block A: real mode, file-backed, auth OFF, tiny byte cap.
// ---------------------------------------------------------------------------
describe("drawer upload route (real mode, auth off)", () => {
  let app, store, tmpRoot;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upload-ep-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    const dataDir = path.join(tmpRoot, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = dataDir;
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    process.env.UPLOAD_FILE_MAX_BYTES = "1024"; // tiny cap -> cheap 413
    vi.resetModules();
    ({ app, store } = await import("../server/index.js"));

    const created = await request(app).post("/api/jobs").send({ role: "Analyst", employer: "Acme Co", sector: "private", status: "lead" });
    expect(created.status).toBe(201);
  });

  afterAll(() => {
    delete process.env.UPLOAD_FILE_MAX_BYTES;
    delete process.env.JOBHUNT_DATA_DIR;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("uploads a file (201), returns the stored name + sha256, and serves it via the guarded reader", async () => {
    const bytes = Buffer.from("%PDF-1.4 posting bytes");
    const r = await upload(app, "Posting - Acme.pdf", bytes);
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("Posting - Acme.pdf");
    expect(r.body.bytes).toBe(bytes.length);
    expect(r.body.sha256).toBe(sh(bytes));
    const got = await readBytes(app, "Posting - Acme.pdf");
    expect(got.status).toBe(200);
    expect(got.bytes.equals(bytes)).toBe(true);
    // sha256 populated on the write path (manifest-visible, like every writer)
    const f = store.syncManifest().files.find((x) => x.name === "Posting - Acme.pdf");
    expect(f.sha256).toBe(sh(bytes));
  });

  it("collision derives a SIBLING '<stem> (2).<ext>' and never replaces the original bytes", async () => {
    const original = Buffer.from("original notes v1");
    const second = Buffer.from("second upload DIFFERENT bytes");
    const third = Buffer.from("third upload");
    expect((await upload(app, "notes.md", original)).body.name).toBe("notes.md");
    const r2 = await upload(app, "notes.md", second);
    expect(r2.status).toBe(201);
    expect(r2.body.name).toBe("notes (2).md"); // the ACTUAL stored name in the 201 body
    const r3 = await upload(app, "notes.md", third);
    expect(r3.body.name).toBe("notes (3).md");
    // the original is byte-for-byte intact; the siblings hold their own bytes
    expect((await readBytes(app, "notes.md")).bytes.equals(original)).toBe(true);
    expect((await readBytes(app, "notes (2).md")).bytes.equals(second)).toBe(true);
    expect((await readBytes(app, "notes (3).md")).bytes.equals(third)).toBe(true);
  });

  it("a unicode file name rides URI-encoded in x-file-name and is stored decoded", async () => {
    const bytes = Buffer.from("korean-named bytes");
    const name = "김시현 - 이력서.md";
    const r = await upload(app, name, bytes);
    expect(r.status).toBe(201);
    expect(r.body.name).toBe(name);
    expect((await readBytes(app, name)).bytes.equals(bytes)).toBe(true);
  });

  it("refuses hostile names (400) via the shared name-safety rules - and writes NOTHING", async () => {
    const before = store.syncManifest().files.length;
    const hostile = [
      "../../etc/passwd",
      "..\\..\\windows\\system32\\evil.dll",
      "/absolute.txt",
      "C:\\abs.txt",
      "NUL",
      "nul.txt",
      "CONOUT$",
      "a/b.txt",
      "trailing-dot.txt.",
      "trailing-space.txt ",
      "badname.txt",
      "..",
    ];
    for (const name of hostile) {
      const r = await upload(app, name, Buffer.from("x"));
      expect(r.status, `name ${JSON.stringify(name)} must be refused`).toBe(400);
    }
    expect(store.syncManifest().files.length).toBe(before); // zero writes from the sweep
  });

  it("400s a missing x-file-name header and a malformed URI encoding", async () => {
    const noHeader = await request(app).post(uploadPath()).set("content-type", "application/octet-stream").send(Buffer.from("x"));
    expect(noHeader.status).toBe(400);
    const badEnc = await request(app)
      .post(uploadPath())
      .set("x-file-name", "%zz-broken")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("x"));
    expect(badEnc.status).toBe(400);
  });

  it("400s an empty body, 404s an unknown job", async () => {
    expect((await upload(app, "empty.md", Buffer.alloc(0))).status).toBe(400);
    expect((await upload(app, "x.md", Buffer.from("x"), "Nope - Nowhere")).status).toBe(404);
  });

  it("413s a file over UPLOAD_FILE_MAX_BYTES", async () => {
    const big = Buffer.alloc(2048, 0x41); // > 1024 cap
    expect((await upload(app, "big.bin", big)).status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Block B: auth ON - the upload sits BEHIND the session cookie wall.
// ---------------------------------------------------------------------------
describe("drawer upload with app-auth ON (session wall, not token auth)", () => {
  let app;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upload-authon-"));
    const jobsDir = path.join(tmp, "Jobs");
    const docsDir = path.join(tmp, "docs");
    for (const d of [jobsDir, docsDir, path.join(tmp, "data")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
    process.env.JOBHUNT_TEST = "1";
    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.JOBHUNT_DATA_DIR = path.join(tmp, "data");
    delete process.env.STORE_BACKEND;
    delete process.env.APP_MODE;
    process.env.SYNC_TOKEN_HASH = hashToken(SYNC_TOKEN);
    process.env.JOBHUNT_AUTH = "required";
    process.env.JOBHUNT_AUTH_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0MImKKQjLYm0k0f0f5x0N7q1s0M0aVvY0mF1yB0m0aE";
    vi.resetModules();
    ({ app } = await import("../server/index.js"));
  });
  afterAll(() => {
    delete process.env.SYNC_TOKEN_HASH;
    delete process.env.JOBHUNT_AUTH;
    delete process.env.JOBHUNT_AUTH_HASH;
    delete process.env.JOBHUNT_DATA_DIR;
  });

  it("401s an anonymous upload (cookie gate)", async () => {
    const r = await upload(app, "x.md", Buffer.from("x"));
    expect(r.status).toBe(401);
  });

  it("a SYNC bearer token does NOT open the upload route (session wall only)", async () => {
    const r = await request(app)
      .post(uploadPath())
      .set("authorization", `Bearer ${SYNC_TOKEN}`)
      .set("x-file-name", encodeURIComponent("x.md"))
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("x"));
    expect(r.status).toBe(401);
  });
});
