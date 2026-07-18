// Parameterized STORE CONTRACT suite (RC-3 / SIM-87 I2, ADR-025).
//
// One spec run against ANY Store implementation, encoding the interface contract
// the storage seam promises: CRUD round-trips, tolerant absent->empty reads,
// append-only semantics, byte-identical blob round-trips, unforgeable/never-SoT
// write guards, and error paths. FileStore passes it here; PgStore (I4) plugs in
// by adding ONE entry to the `backends` array below - ZERO changes to the spec
// bodies, because every test seeds + asserts THROUGH the store interface, never
// through a backend-specific fixture.
//
// Two scoping notes, faithful to the binding design:
//  - EVENT EMISSION is deliberately NOT a per-store contract here. Design 2.4:
//    "the store does not own the SSE channel; the route does." FileStore's
//    jobs-changed signal is the external chokidar watcher; every other mutation is
//    broadcast by the route. Route-level SSE emission is guarded by
//    tests/sse-broadcast.test.js, not by a store method.
//  - The FRONTMATTER BYTE-CONTRACT (EOL/BOM/body preserved, only WRITABLE_FIELDS
//    touched) is a FileStore realization of the cross-store "updateJobFields
//    changes only the named fields" contract - PgStore has no markdown bytes to
//    preserve (it keeps typed columns + raw_frontmatter). So the DOMAIN round-trip
//    is parameterized (all stores), and the byte-level assertions live in a
//    FileStore-specific block at the end.
//
// The suite constructs FileStore DIRECTLY via resolveStore against a temp dir - no
// Express app, no supertest, no server boot - which is exactly the importable/
// testable-in-isolation property the seam was designed for. It imports the three
// exported domain helpers (dropInvalidJobEnums / normalizeSource / serializeSource)
// that FileStore takes by injection; index.js is imported only for those pure
// functions (JOBHUNT_TEST=1 + a throwaway vault dir keep that import hermetic).

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionPgBackend } from "./helpers/embedded-pg.mjs";

process.env.JOBHUNT_TEST = "1";
// Keep the index.js import (for the exported domain helpers only) hermetic: point
// its vault/docs seams at a throwaway dir so importing it never touches the real
// vault and never binds a port / starts the watcher (JOBHUNT_TEST gate).
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-contract-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;

const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const { resolveStore, FileStore } = await import("../server/store.js");

// The status vocabulary the store's job-record derivation checks against. Kept
// local to the contract (the contract does not depend on the product's exact
// track/status list - only that what createJob writes, getJobSummary reads back).
const STATUSES = ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"];
const DEPS = { TRACKS: {}, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource };

// ---- backend registry: add PgStore here at I4, nothing else changes ----------
const backends = [
  {
    name: "FileStore",
    make() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-contract-"));
      const jobsDir = path.join(root, "Jobs");
      const docsDir = path.join(root, "docs");
      const dataDir = path.join(root, "data");
      for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
      const store = resolveStore({}, { jobsDir, docsDir, dataDir, deps: DEPS });
      store.init();
      return {
        store,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
        // FileStore-only escape hatch for the byte-contract block (not used by the
        // parameterized specs). Lets that block plant a raw CRLF+BOM job file.
        _fileRoot: { jobsDir, docsDir, dataDir },
      };
    },
  },
];

// ---- PgStore backend (I4): the ONE sanctioned change to this file per the design
// ("describe.each gains the PgStore row"). Every test BODY is untouched - PgStore
// passes the identical specs. The backend self-provisions a real ephemeral Postgres
// (embedded-postgres); if it cannot start (offline binary download, or a Windows
// ADMIN-token refusal on an elevated shell - run de-elevated to exercise it) the
// row is omitted with a clear console note and the FileStore row still runs, so the
// gate stays green everywhere. See tests/helpers/embedded-pg.mjs.
const pgBackend = await provisionPgBackend(DEPS);
if (pgBackend.available) {
  backends.push(pgBackend.backend);
} else {
  // eslint-disable-next-line no-console
  console.warn(`[store-contract] PgStore backend SKIPPED: ${pgBackend.reason}`);
}
afterAll(async () => {
  if (pgBackend.available) await pgBackend.stopAll();
});

describe.each(backends)("Store contract [$name]", ({ make }) => {
  let ctx;
  let store;
  beforeEach(() => {
    ctx = make();
    store = ctx.store;
  });
  afterEach(() => ctx.cleanup());

  // ---- tasks -------------------------------------------------------------
  describe("tasks", () => {
    it("round-trips a saved board and normalizes comments to [] on read", () => {
      store.saveTasks({
        columns: ["backlog", "todo", "done"],
        tasks: [
          { id: "t-1", title: "One", status: "todo" }, // no comments key
          { id: "t-2", title: "Two", status: "done", comments: [{ author: "cto", body: "hi" }] },
        ],
      });
      const { columns, tasks } = store.loadTasks();
      expect(columns).toEqual(["backlog", "todo", "done"]);
      const t1 = tasks.find((t) => t.id === "t-1");
      const t2 = tasks.find((t) => t.id === "t-2");
      expect(t1.comments).toEqual([]); // read-side normalization
      expect(t2.comments).toEqual([{ author: "cto", body: "hi" }]);
      expect(t1.title).toBe("One");
    });

    it("preserves server-managed fields verbatim across a round-trip", () => {
      store.saveTasks({
        columns: ["backlog"],
        tasks: [{ id: "t-9", title: "T", status: "done", completed: "2026-07-16", created: "2026-07-01" }],
      });
      const t = store.loadTasks().tasks[0];
      expect(t.completed).toBe("2026-07-16");
      expect(t.created).toBe("2026-07-01");
    });
  });

  // ---- webauthn credentials (SIM-394 passkey second factor) ---------------
  // Plain CRUD contract, identical on both backends. POLICY (the >=2
  // enforcement rule, the last-credential deletion refusal) is deliberately
  // NOT here - it lives in the route layer (server/webauthn.js) because it
  // depends on the env flag, not on storage; tests/webauthn-endpoints.test.js
  // pins it.
  describe("webauthn credentials", () => {
    const CRED = {
      id: "cred-aaa111",
      publicKey: "pQECAyYgASFYIAAA", // opaque base64url string to the store
      counter: 0,
      transports: ["internal", "hybrid"],
      label: "laptop-touchid",
    };

    it("empty store: list [] / count 0 / get null (absent -> empty)", () => {
      expect(store.listWebauthnCredentials()).toEqual([]);
      expect(store.countWebauthnCredentials()).toBe(0);
      expect(store.getWebauthnCredential("nope")).toBe(null);
    });

    it("create stamps `created` (server-managed) and round-trips every field", () => {
      const rec = store.createWebauthnCredential(CRED);
      expect(rec.id).toBe(CRED.id);
      expect(rec.publicKey).toBe(CRED.publicKey);
      expect(rec.counter).toBe(0);
      expect(rec.transports).toEqual(["internal", "hybrid"]);
      expect(rec.label).toBe("laptop-touchid");
      expect(typeof rec.created).toBe("string");
      expect(Number.isNaN(Date.parse(rec.created))).toBe(false);

      const got = store.getWebauthnCredential(CRED.id);
      expect(got).toEqual(rec);
      expect(store.countWebauthnCredentials()).toBe(1);
      expect(store.listWebauthnCredentials()).toEqual([rec]);
    });

    it("a duplicate credential id is refused with httpStatus 409", () => {
      store.createWebauthnCredential(CRED);
      let err = null;
      try {
        store.createWebauthnCredential({ ...CRED, label: "other" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeTruthy();
      expect(err.httpStatus).toBe(409);
      expect(store.countWebauthnCredentials()).toBe(1);
    });

    it("a missing id/publicKey is refused with httpStatus 400", () => {
      for (const bad of [{ id: "", publicKey: "x" }, { id: "x", publicKey: "" }, {}]) {
        let err = null;
        try {
          store.createWebauthnCredential(bad);
        } catch (e) {
          err = e;
        }
        expect(err && err.httpStatus).toBe(400);
      }
    });

    it("updateWebauthnCredentialCounter persists the new counter; unknown id -> ok:false", () => {
      store.createWebauthnCredential(CRED);
      expect(store.updateWebauthnCredentialCounter(CRED.id, 41).ok).toBe(true);
      expect(store.getWebauthnCredential(CRED.id).counter).toBe(41);
      expect(store.updateWebauthnCredentialCounter("nope", 1).ok).toBe(false);
    });

    it("deleteWebauthnCredential deletes by id; unknown id -> deleted:false", () => {
      store.createWebauthnCredential(CRED);
      store.createWebauthnCredential({ ...CRED, id: "cred-bbb222", label: "phone" });
      expect(store.deleteWebauthnCredential("nope")).toEqual({ deleted: false });
      expect(store.deleteWebauthnCredential(CRED.id)).toEqual({ deleted: true });
      expect(store.countWebauthnCredentials()).toBe(1);
      expect(store.getWebauthnCredential(CRED.id)).toBe(null);
      expect(store.getWebauthnCredential("cred-bbb222")).toBeTruthy();
    });
  });

  // ---- requests (tolerant absent + verbatim + spawned coercion) ----------
  describe("requests", () => {
    it("yields { requests: [] } when nothing has been written (absent -> empty)", () => {
      expect(store.loadRequests()).toEqual({ requests: [] });
    });

    it("stores request text VERBATIM (colons, hashes, quotes, newlines survive)", () => {
      const text = 'ship it: fast # now "quoted"\nsecond line';
      store.saveRequests({
        requests: [{ id: "r-1", text, source: "session", created: "2026-07-16", ts: "2026-07-16T00:00:00.000Z", spawned: { tasks: [], projects: [] } }],
      });
      expect(store.loadRequests().requests[0].text).toBe(text);
    });

    it("coerces spawned refs (sanitize + dedupe) on read", () => {
      store.saveRequests({
        requests: [{ id: "r-2", text: "x", source: "chatbot", created: "2026-07-16", ts: "2026-07-16T00:00:00.000Z", spawned: { tasks: ["T-1 ", "t-1", "b@d!"], projects: [] } }],
      });
      const r = store.loadRequests().requests[0];
      expect(r.source).toBe("chatbot");
      expect(r.spawned.tasks).toEqual(["t-1", "bd"]); // "T-1 "->"t-1" dedupes; "b@d!"->"bd"
      expect(r.spawned.projects).toEqual([]);
    });
  });

  // ---- notify state (tolerant absent + round-trip) -----------------------
  describe("notify state", () => {
    it("returns the uninitialized shape when absent", () => {
      expect(store.loadNotifyState()).toEqual({ cursor: null, baseline: { tasks: {}, projects: [] }, initialized: false });
    });

    it("round-trips cursor + baseline and reports initialized:true", () => {
      store.saveNotifyState({ cursor: "2026-07-16T00:00:00.000Z", baseline: { tasks: { "t-1": "done" }, projects: ["p-1"] } });
      const s = store.loadNotifyState();
      expect(s.initialized).toBe(true);
      expect(s.cursor).toBe("2026-07-16T00:00:00.000Z");
      expect(s.baseline).toEqual({ tasks: { "t-1": "done" }, projects: ["p-1"] });
    });
  });

  // ---- chats (tolerant absent + round-trip) ------------------------------
  describe("chats", () => {
    it("returns {} when absent", () => {
      expect(store.loadChats()).toEqual({});
    });
    it("round-trips a per-job transcript", () => {
      const map = { "Analyst - OCI": [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] };
      store.saveChats(map);
      expect(store.loadChats()).toEqual(map);
    });
  });

  // ---- activity log (tolerant absent + append-only) ----------------------
  describe("activity log", () => {
    it("reads empty text when absent (tolerant)", () => {
      expect(store.readActivityText()).toBe("");
    });

    it("is append-only and stamps ts, preserving order", () => {
      store.appendActivity({ kind: "run", runId: "r1", status: "running" });
      store.appendActivity({ kind: "run", runId: "r1", status: "done", exitCode: 0 });
      const lines = store.readActivityText().split(/\r?\n/).filter((l) => l.trim());
      expect(lines).toHaveLength(2);
      const a = JSON.parse(lines[0]);
      const b = JSON.parse(lines[1]);
      expect(a.status).toBe("running");
      expect(b.status).toBe("done");
      expect(typeof a.ts).toBe("string"); // stamped
      expect(a.runId).toBe("r1");
    });
  });

  // ---- usage telemetry (tolerant absent + batch append + empty no-op) ----
  describe("telemetry", () => {
    it("reads empty text when absent", () => {
      expect(store.readTelemetryText()).toBe("");
    });
    it("appends a batch in one write; an empty batch is a no-op", () => {
      store.appendTelemetry([]); // no-op, must not create noise
      store.appendTelemetry([
        { ts: "2026-07-16T00:00:00.000Z", sessionId: "s", kind: "view", surface: "insights", name: "open" },
        { ts: "2026-07-16T00:00:01.000Z", sessionId: "s", kind: "action", surface: "insights", name: "click" },
      ]);
      const lines = store.readTelemetryText().split(/\r?\n/).filter((l) => l.trim());
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]).name).toBe("click");
    });
  });

  // ---- discovery sources (tolerant absent + version-skew round-trip) -----
  describe("discovery sources", () => {
    it("yields the empty registry when absent", () => {
      expect(store.loadSources()).toEqual({ version: 1, updated: null, sources: [] });
    });

    it("round-trips a source and preserves an unmodeled (version-skew) field", () => {
      store.saveSources({
        sources: [
          {
            id: "s1", name: "Board One", type: "board", sector: "private", active: "yes",
            urls: ["https://example.test"], cadence: "manual", instructions: "look here",
            outputFields: ["title"], aliases: [], tracks: [], _extra: { futureKey: "keep-me" },
          },
        ],
      });
      const doc = store.loadSources();
      expect(doc.sources).toHaveLength(1);
      const s = doc.sources[0];
      expect(s.id).toBe("s1");
      expect(s.name).toBe("Board One");
      expect(s.urls).toEqual(["https://example.test"]);
      // the unmodeled carry-through survives the serialize/normalize round-trip
      expect(s._extra && s._extra.futureKey).toBe("keep-me");
    });
  });

  // ---- jobs: CRUD + guards + error paths ---------------------------------
  describe("jobs", () => {
    it("creates a job, reads it back, and lists it", () => {
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", status: "queued", sector: "private" });
      expect(id).toBe("Analyst - OCI");
      const rec = store.getJobSummary(id);
      expect(rec.role).toBe("Analyst");
      expect(rec.employer).toBe("OCI");
      expect(rec.status).toBe("queued");
      expect(store.listJobs().map((j) => j.id)).toContain(id);
    });

    it("updateJobFields changes a whitelisted field and returns the fresh DTO", () => {
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", status: "queued", sector: "private" });
      const updated = store.updateJobFields(id, { status: "drafted" });
      expect(updated.status).toBe("drafted");
      expect(store.getJobSummary(id).status).toBe("drafted");
    });

    it("updateJobFields on a missing job returns null (no throw)", () => {
      expect(store.updateJobFields("Nope - Nowhere", { status: "drafted" })).toBeNull();
    });

    it("getJob returns null for a missing job and a detail shape for a real one", () => {
      expect(store.getJob("Nope - Nowhere")).toBeNull();
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", status: "queued", sector: "private" });
      const detail = store.getJob(id);
      expect(detail.role).toBe("Analyst");
      expect(Array.isArray(detail.prep)).toBe(true);
      expect(typeof detail.body).toBe("string");
      expect(detail.hasSubmitted).toBe(false);
    });

    it("createJob rejects a duplicate (409) and a missing role/employer (400)", () => {
      store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      expect(() => store.createJob({ role: "Analyst", employer: "OCI", sector: "private" })).toThrow(/already exists/);
      try {
        store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      } catch (e) {
        expect(e.httpStatus).toBe(409);
      }
      try {
        store.createJob({ role: "", employer: "OCI" });
      } catch (e) {
        expect(e.httpStatus).toBe(400);
      }
    });
  });

  // ---- job notes: whitelisted overwrite, never the SoT -------------------
  describe("job notes (writeJobNote)", () => {
    it("writes a gaps note and getJob reads it back", () => {
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      const r = store.writeJobNote(id, "gaps.md", "# Gaps\nanswered");
      expect(r).toEqual({ ok: true, name: "gaps.md", bytes: Buffer.byteLength("# Gaps\nanswered", "utf8") });
      expect(store.getJob(id).gaps.content).toBe("# Gaps\nanswered");
    });

    it("refuses to overwrite the SoT job file (400)", () => {
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      try {
        store.writeJobNote(id, "Analyst.md", "malicious");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e.httpStatus).toBe(400);
      }
    });

    it("refuses a note on a missing job (404)", () => {
      try {
        store.writeJobNote("Nope - Nowhere", "gaps.md", "x");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e.httpStatus).toBe(404);
      }
    });
  });

  // ---- blobs: byte-identical round-trip + containment --------------------
  describe("blobs (attachments + job artifacts)", () => {
    it("stores + reads an attachment blob byte-identically", () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250]);
      store.saveAttachmentBlob("t-1", "abc.png", bytes);
      const p = store.attachmentFilePath("t-1", "abc.png");
      expect(p).toBeTruthy();
      expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    });

    it("contains a traversal attachment name inside the task dir", () => {
      // The file arg is basename-stripped, so a "../../etc/passwd" can never
      // resolve outside attachments/<taskId>/ - the returned path is the plain
      // basename inside the task dir, never an escape.
      const p = store.attachmentFilePath("t-1", "../../etc/passwd");
      expect(path.basename(p)).toBe("passwd");
      expect(p.includes(path.join("attachments", "t-1"))).toBe(true);
    });

    it("round-trips a generated job artifact byte-identically", () => {
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      const bytes = Buffer.from("%PDF-1.4 fake cv bytes \x00\x01", "binary");
      const meta = store.saveJobArtifact(id, "CV.pdf", "application/pdf", bytes);
      expect(meta.name).toBe("CV.pdf");
      expect(meta.bytes).toBe(bytes.length);
      const r = store.openJobFile(id, "CV.pdf");
      expect(r.ok).toBe(true);
      const chunks = [];
      r.stream.on("data", (c) => chunks.push(c));
      return new Promise((resolve) => {
        r.stream.on("end", () => {
          expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
          resolve();
        });
      });
    });

    it("openJobFile reports a missing folder / file with the contract statuses", () => {
      expect(store.openJobFile("Nope - Nowhere", "x.pdf")).toEqual({ ok: false, status: 404, error: "job folder not found" });
      const { id } = store.createJob({ role: "Analyst", employer: "OCI", sector: "private" });
      expect(store.openJobFile(id, "nope.pdf")).toEqual({ ok: false, status: 404, error: "file not found" });
    });
  });

  // ---- vault->cloud sync ingest: INSERT-ONLY on BOTH backends (SIM-393 I1) ----
  // The differential: FileStore and PgStore implement the IDENTICAL observable
  // insert-only contract (this spec runs against both), so the two can never drift.
  describe("sync ingest (createJobIfAbsent / addJobFileIfAbsent / syncManifest)", () => {
    const front = () => ({ type: "job", role: "Analyst", employer: "OCI", status: "queued", tags: ["job"], deadline: "2026-08-01" });
    const seedJob = () =>
      store.createJobIfAbsent({ id: "Analyst - OCI", role: "Analyst", employer: "OCI", front: front(), body: "# Analyst - OCI\n\nbody text", tags: ["job"] });

    it("syncManifest is empty on a fresh store", () => {
      expect(store.syncManifest()).toEqual({ jobs: [], files: [] });
    });

    it("createJobIfAbsent inserts a job (raw fidelity) readable via getJobSummary", () => {
      const r = seedJob();
      expect(r).toEqual({ created: true, id: "Analyst - OCI" });
      const rec = store.getJobSummary("Analyst - OCI");
      expect(rec.role).toBe("Analyst");
      expect(rec.employer).toBe("OCI");
      expect(rec.status).toBe("queued");
      const m = store.syncManifest();
      expect(m.jobs).toHaveLength(1);
      expect(m.jobs[0].id).toBe("Analyst - OCI");
      expect(m.jobs[0].rowSha).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a second createJobIfAbsent for the same id is a reported conflict, NEVER an overwrite", () => {
      seedJob();
      const before = store.syncManifest().jobs[0].rowSha;
      const r = store.createJobIfAbsent({ id: "Analyst - OCI", role: "Analyst", employer: "OCI", front: front(), body: "TAMPERED BODY", tags: ["job"] });
      expect(r).toEqual({ created: false, conflict: "job-exists" });
      expect(store.syncManifest().jobs[0].rowSha).toBe(before); // unchanged
    });

    it("createJobIfAbsent rejects an unsafe id (400) and an invalid front (400)", () => {
      expect(() => store.createJobIfAbsent({ id: "../escape", role: "A", employer: "B", front: {} })).toThrow();
      try {
        store.createJobIfAbsent({ id: "../escape", role: "A", employer: "B", front: {} });
      } catch (e) {
        expect(e.httpStatus).toBe(400);
      }
      expect(() => store.createJobIfAbsent({ id: "Bad - Job", role: 123, employer: "B", front: {} })).toThrow();
    });

    it("addJobFileIfAbsent: insert -> manifest reflects sha256 + bytesLen; identical bytes -> noop", () => {
      seedJob();
      const bytes = Buffer.from("%PDF-1.4 tailored cv bytes");
      const ins = store.addJobFileIfAbsent("Analyst - OCI", "CV - Analyst.pdf", { mime: "application/pdf", bytes });
      expect(ins.result).toBe("inserted");
      expect(ins.sha256).toMatch(/^[0-9a-f]{64}$/);
      const m = store.syncManifest();
      const f = m.files.find((x) => x.name === "CV - Analyst.pdf");
      expect(f).toBeTruthy();
      expect(f.sha256).toBe(ins.sha256);
      expect(f.bytesLen).toBe(bytes.length);
      const noop = store.addJobFileIfAbsent("Analyst - OCI", "CV - Analyst.pdf", { bytes });
      expect(noop.result).toBe("noop");
      expect(noop.sha256).toBe(ins.sha256);
    });

    it("addJobFileIfAbsent: same path + DIFFERENT bytes = bytes-differ, cloud copy untouched", () => {
      seedJob();
      const original = Buffer.from("original cv");
      const ins = store.addJobFileIfAbsent("Analyst - OCI", "CV - Analyst.pdf", { mime: "application/pdf", bytes: original });
      const conflict = store.addJobFileIfAbsent("Analyst - OCI", "CV - Analyst.pdf", { bytes: Buffer.from("POISONED cv") });
      expect(conflict.result).toBe("bytes-differ");
      expect(conflict.cloudSha).toBe(ins.sha256);
      // the stored bytes are STILL the original - nothing was overwritten
      const r = store.openJobFile("Analyst - OCI", "CV - Analyst.pdf");
      expect(r.ok).toBe(true);
      const chunks = [];
      r.stream.on("data", (c) => chunks.push(c));
      return new Promise((resolve) => {
        r.stream.on("end", () => {
          expect(Buffer.concat(chunks).equals(original)).toBe(true);
          resolve();
        });
      });
    });

    it("addJobFileIfAbsent: unknown job -> job-not-found; hostile name -> 400", () => {
      expect(store.addJobFileIfAbsent("Nope - Nowhere", "x.md", { bytes: Buffer.from("x") })).toEqual({ result: "job-not-found" });
      seedJob();
      try {
        store.addJobFileIfAbsent("Analyst - OCI", "../../etc/passwd", { bytes: Buffer.from("x") });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e.httpStatus).toBe(400);
      }
    });

    // ---- drawer upload (SIM-393 I4): INSERT-ONLY unique-name derivation ----
    // addJobFileUnique is deliberately NOT saveJobArtifact (which upserts): a
    // collision derives a "<stem> (2).<ext>" sibling and can never replace
    // existing bytes, on BOTH backends identically.
    it("addJobFileUnique inserts under the requested name and populates sha256", () => {
      seedJob();
      const bytes = Buffer.from("uploaded posting bytes");
      const r = store.addJobFileUnique("Analyst - OCI", "Posting.pdf", { mime: "application/pdf", bytes });
      expect(r.result).toBe("inserted");
      expect(r.name).toBe("Posting.pdf");
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      const f = store.syncManifest().files.find((x) => x.name === "Posting.pdf");
      expect(f.sha256).toBe(r.sha256);
      expect(f.bytesLen).toBe(bytes.length);
    });

    it("addJobFileUnique: a collision derives '<stem> (2).<ext>' then '(3)', never replacing bytes", () => {
      seedJob();
      const original = Buffer.from("original bytes");
      const first = store.addJobFileUnique("Analyst - OCI", "notes.md", { bytes: original });
      expect(first.name).toBe("notes.md");
      const second = store.addJobFileUnique("Analyst - OCI", "notes.md", { bytes: Buffer.from("second DIFFERENT bytes") });
      expect(second.result).toBe("inserted");
      expect(second.name).toBe("notes (2).md");
      const third = store.addJobFileUnique("Analyst - OCI", "notes.md", { bytes: Buffer.from("third bytes") });
      expect(third.name).toBe("notes (3).md");
      // the original name still holds the ORIGINAL bytes
      const r = store.openJobFile("Analyst - OCI", "notes.md");
      expect(r.ok).toBe(true);
      const chunks = [];
      r.stream.on("data", (c) => chunks.push(c));
      return new Promise((resolve) => {
        r.stream.on("end", () => {
          expect(Buffer.concat(chunks).equals(original)).toBe(true);
          resolve();
        });
      });
    });

    it("addJobFileUnique: unknown job -> job-not-found; hostile name -> 400 (shared name-safety)", () => {
      expect(store.addJobFileUnique("Nope - Nowhere", "x.md", { bytes: Buffer.from("x") })).toEqual({ result: "job-not-found" });
      seedJob();
      for (const bad of ["../../etc/passwd", "NUL.txt", "a/b.md", "dot-alias.md."]) {
        let err = null;
        try {
          store.addJobFileUnique("Analyst - OCI", bad, { bytes: Buffer.from("x") });
        } catch (e) {
          err = e;
        }
        expect(err && err.httpStatus, `name ${JSON.stringify(bad)} must throw 400`).toBe(400);
      }
    });

    it("countJobFiles counts companion files (never the SoT job file); unknown job -> null", () => {
      expect(store.countJobFiles("Nope - Nowhere")).toBeNull();
      seedJob();
      expect(store.countJobFiles("Analyst - OCI")).toBe(0); // <Role>.md excluded
      store.addJobFileIfAbsent("Analyst - OCI", "CV.pdf", { bytes: Buffer.from("cv") });
      store.addJobFileUnique("Analyst - OCI", "notes.md", { bytes: Buffer.from("n") });
      expect(store.countJobFiles("Analyst - OCI")).toBe(2);
    });

    // ---- mirror raw job read (SIM-393 I6): both backends, identical shape ----
    it("mirrorJobDetail returns the RAW front + body + <Role>.md name, rowSha matching the manifest", () => {
      seedJob();
      const d = store.mirrorJobDetail("Analyst - OCI");
      expect(d).toBeTruthy();
      expect(d.id).toBe("Analyst - OCI");
      expect(d.name).toBe("Analyst.md"); // the file createJobIfAbsent writes / role-derived
      expect(d.front).toEqual(front()); // raw fidelity, verbatim keys
      expect(d.body).toBe("# Analyst - OCI\n\nbody text");
      expect(d.rowSha).toBe(store.syncManifest().jobs[0].rowSha);
    });

    it("mirrorJobDetail is null for an unknown / traversal id and is read-only", () => {
      seedJob();
      const before = store.syncManifest();
      expect(store.mirrorJobDetail("Nope - Nowhere")).toBeNull();
      expect(store.mirrorJobDetail("../escape")).toBeNull();
      expect(store.syncManifest()).toEqual(before); // read-only: nothing changed
    });
  });
});

// ---- cross-backend rowSha parity (SIM-393 I1) --------------------------------
// The manifest's rowSha MUST be identical across FileStore and PgStore for the SAME
// seeded job, or the sync client's drift detection would false-positive after a
// backend swap. Seeds one job into a fresh FileStore and (when the ephemeral PG is
// available) a fresh PgStore, and asserts equal rowSha + equal file sha256. Skips
// the PG half cleanly when the cluster can't start.
describe("sync manifest rowSha/sha256 parity across backends", () => {
  const jobFront = { type: "job", role: "Analyst", employer: "OCI", status: "queued", tags: ["job"], deadline: "2026-08-01" };
  const seed = (s) => {
    s.createJobIfAbsent({ id: "Analyst - OCI", role: "Analyst", employer: "OCI", front: jobFront, body: "# Analyst - OCI\n\nbody text", tags: ["job"] });
    s.addJobFileIfAbsent("Analyst - OCI", "CV - Analyst.pdf", { mime: "application/pdf", bytes: Buffer.from("cv bytes here") });
  };

  it("FileStore and PgStore produce the identical manifest for the same seed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-parity-file-"));
    const jobsDir = path.join(root, "Jobs");
    const docsDir = path.join(root, "docs");
    const dataDir = path.join(root, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    const fileStore = resolveStore({}, { jobsDir, docsDir, dataDir, deps: DEPS });
    fileStore.init();
    seed(fileStore);
    const fileManifest = fileStore.syncManifest();
    fs.rmSync(root, { recursive: true, force: true });

    expect(fileManifest.jobs).toHaveLength(1);
    expect(fileManifest.files).toHaveLength(1);

    if (!pgBackend.available) {
      // eslint-disable-next-line no-console
      console.warn(`[sync-parity] PgStore half SKIPPED: ${pgBackend.reason}`);
      return;
    }
    pgBackend.store.truncateAllForTests();
    seed(pgBackend.store);
    const pgManifest = pgBackend.store.syncManifest();
    expect(pgManifest.jobs[0].rowSha).toBe(fileManifest.jobs[0].rowSha);
    expect(pgManifest.files[0].sha256).toBe(fileManifest.files[0].sha256);
    expect(pgManifest.files[0].bytesLen).toBe(fileManifest.files[0].bytesLen);
  });
});

// ---- FileStore-specific: the frontmatter BYTE-CONTRACT -----------------------
// The surgical updateFrontmatter guarantee (design 1.2.1) is a FileStore property:
// body byte-identical, EOL + BOM handling preserved, only WRITABLE_FIELDS touched,
// unmodeled/legacy keys untouched. PgStore reproduces the DOMAIN round-trip (above)
// but has no markdown bytes, so this block is FileStore-only by construction.
describe("FileStore frontmatter byte-contract", () => {
  let root, store, jobsDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "store-bytes-"));
    jobsDir = path.join(root, "Jobs");
    const docsDir = path.join(root, "docs");
    const dataDir = path.join(root, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    store = new FileStore({ jobsDir, docsDir, dataDir, deps: DEPS });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("preserves CRLF line endings + body bytes, changes only the one field, leaves legacy keys", () => {
    const folder = "Analyst - OCI";
    const dir = path.join(jobsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    // CRLF file with a legacy/unmodeled key (`custom_legacy`) and a body block.
    const raw = [
      "---",
      "type: job",
      "role: Analyst",
      "employer: OCI",
      "status: queued",
      "custom_legacy: keep-this-untouched",
      "tags: [job]",
      "---",
      "",
      "# Analyst - OCI",
      "",
      "**Lead with:** the numbers",
      "",
    ].join("\r\n");
    fs.writeFileSync(path.join(dir, "Analyst.md"), raw, "utf8");

    // A write that flips status AND passes a NON-writable field (role) that must
    // be ignored by the WRITABLE_FIELDS gate.
    store.updateJobFields(folder, { status: "drafted", role: "HACKED" });

    const after = fs.readFileSync(path.join(dir, "Analyst.md"), "utf8");
    expect(after.includes("\r\n")).toBe(true); // EOL preserved (CRLF)
    expect(after).toContain("status: drafted"); // the one field changed
    expect(after).not.toContain("status: queued");
    expect(after).toContain("role: Analyst"); // non-writable field NOT overwritten
    expect(after).not.toContain("HACKED");
    expect(after).toContain("custom_legacy: keep-this-untouched"); // legacy key untouched
    // Body after the closing fence is byte-identical.
    const body = after.slice(after.indexOf("---\r\n", 3) + "---\r\n".length);
    expect(body).toBe(
      ["", "# Analyst - OCI", "", "**Lead with:** the numbers", ""].join("\r\n"),
    );
  });

  it("removes a field when the value is null/empty, never a delete of the file", () => {
    const folder = "Analyst - OCI";
    const dir = path.join(jobsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const raw = ["---", "type: job", "role: Analyst", "employer: OCI", "status: submitted", "applied: 2026-07-01", "tags: [job]", "---", "", "# body", ""].join("\n");
    fs.writeFileSync(path.join(dir, "Analyst.md"), raw, "utf8");
    store.updateJobFields(folder, { applied: null });
    const after = fs.readFileSync(path.join(dir, "Analyst.md"), "utf8");
    expect(after).not.toContain("applied:");
    expect(after).toContain("status: submitted");
    expect(fs.existsSync(path.join(dir, "Analyst.md"))).toBe(true); // never a delete
  });
});
