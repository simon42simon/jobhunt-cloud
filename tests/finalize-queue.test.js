import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// Finalize queue (ticket t-1783183576482): the server DERIVES `gapsAnswered` +
// `finalizeReady` per job (never stored - ADR-010..013), and the batch endpoint
// gains a readiness guard for finalize-job (defense in depth). This suite pins:
//   1. the derive rules (gaps newer/older/missing/CV missing; strictly-newer
//      boundary; the finalizeReady status gate),
//   2. the batch guard (a non-ready job is REFUSED; a ready one passes; a mixed
//      set keeps only the ready), and that first-draft-job is NOT readiness-gated.
//
// The batch endpoint launches the real `claude.exe` via startRun; a test must
// never spawn it, so node:child_process's spawn is mocked with a fake
// ChildProcess BEFORE importing the server (same pattern as routine-agents.test).
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", 0));
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

let app;
let tmpRoot;
let fixture; // the Jobs/ dir
let docsDir; // a throwaway docs/ so appendActivity (batch runs) stays hermetic

// Frontmatter for a job at a given status, with NO deadline so the lazy
// auto-close sweep never touches (and thus never rewrites) these fixtures.
function jobFront(role, employer, status) {
  return [
    "---", "type: job", `role: ${role}`, `employer: ${employer}`,
    "track: b2b_gtm_focused", "fit: strong", `status: ${status}`,
    "sector: private", "tailoring: light", "tags: [job]",
    "---", "", `# ${role} - ${employer}`, "", "**Lead with:** x", "",
  ].join("\n");
}

// mtimes we pin so "strictly newer" is unambiguous (10s apart, plus an exact tie).
const BASE = new Date("2026-07-01T12:00:00Z");
const OLDER = new Date(BASE.getTime() - 10_000);
const NEWER = new Date(BASE.getTime() + 10_000);
const setMtime = (p, when) => fs.utimesSync(p, when, when);

// Build one job folder: writes job.md, optionally a CV and a gaps note, then
// pins the CV / gaps mtimes so the gapsAnswered comparison is deterministic.
function makeJob(folder, { status, cvAt, gapsAt }) {
  const [role, employer] = folder.split(" - ");
  const dir = path.join(fixture, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${role}.md`), jobFront(role, employer, status), "utf8");
  if (cvAt) {
    const cv = path.join(dir, `${role} CV.docx`);
    fs.writeFileSync(cv, "cv bytes", "utf8");
    setMtime(cv, cvAt);
  }
  if (gapsAt) {
    const gaps = path.join(dir, "gaps.md");
    fs.writeFileSync(gaps, "# gaps\n\nanswered?\n", "utf8");
    setMtime(gaps, gapsAt);
  }
}

function writeFixture() {
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  // NB: role/employer words deliberately avoid the substrings "cv"/"gaps"/"cover"
  // so a folder's own <Role>.md never trips the CV/gaps/cover file predicates.
  // drafted + CV + gaps NEWER than CV -> gapsAnswered, finalizeReady.
  makeJob("Ready Role - Ready Co", { status: "drafted", cvAt: BASE, gapsAt: NEWER });
  // drafted + CV + gaps OLDER than CV -> not answered.
  makeJob("Stale Role - Stale Co", { status: "drafted", cvAt: BASE, gapsAt: OLDER });
  // drafted + CV, no gaps note -> not answered (gaps missing).
  makeJob("Draftonly Role - Draftonly Co", { status: "drafted", cvAt: BASE });
  // drafted + gaps, NO CV -> not answered (CV missing) AND hasCV false.
  makeJob("Await Role - Await Co", { status: "drafted", gapsAt: NEWER });
  // drafted + CV + gaps at the SAME mtime -> not answered (strictly-newer boundary).
  makeJob("Equal Role - Equal Co", { status: "drafted", cvAt: BASE, gapsAt: BASE });
  // gaps ARE answered but status is queued -> finalizeReady false (status gate).
  makeJob("Queued Role - Queued Co", { status: "queued", cvAt: BASE, gapsAt: NEWER });
}

const id = (s) => encodeURIComponent(s);
const jobs = () => request(app).get("/api/jobs").then((r) => r.body);
const jobById = async (jid) => (await jobs()).find((j) => j.id === jid);

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-finalize-"));
  fixture = path.join(tmpRoot, "Jobs");
  docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  writeFixture();
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DOCS_DIR = docsDir; // batch runs appendActivity here, not the real docs/
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

// Reset to the pristine fixture before EVERY test. Needed now that a successful
// finalize run auto-advances a drafted job to `ready` (t-1783481509014): the fake
// child proc closes with exit 0, so a batch-finalize test mutates "Ready Role" on
// disk (drafted -> ready), which must not leak into the next test. Each test's
// pending setImmediate close flushes before the next test's beforeEach, so this is
// race-free (the pattern api.test.js already uses).
beforeEach(() => writeFixture());

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("GET /api/jobs derives gapsAnswered (strictly newer than the CV)", () => {
  it("gaps NEWER than the CV -> gapsAnswered true", async () => {
    expect((await jobById("Ready Role - Ready Co")).gapsAnswered).toBe(true);
  });

  it("gaps OLDER than the CV -> gapsAnswered false", async () => {
    expect((await jobById("Stale Role - Stale Co")).gapsAnswered).toBe(false);
  });

  it("gaps note MISSING -> gapsAnswered false", async () => {
    expect((await jobById("Draftonly Role - Draftonly Co")).gapsAnswered).toBe(false);
  });

  it("CV MISSING -> gapsAnswered false (and hasCV false)", async () => {
    const j = await jobById("Await Role - Await Co");
    expect(j.hasCV).toBe(false);
    expect(j.gapsAnswered).toBe(false);
  });

  it("EQUAL mtimes -> gapsAnswered false (strictly-newer boundary, not >=)", async () => {
    expect((await jobById("Equal Role - Equal Co")).gapsAnswered).toBe(false);
  });
});

describe("GET /api/jobs derives finalizeReady = drafted && hasCV && gapsAnswered", () => {
  it("true only for a drafted job with a CV and answered gaps", async () => {
    expect((await jobById("Ready Role - Ready Co")).finalizeReady).toBe(true);
  });

  it("false when gaps are not answered (stale / missing / equal / no CV)", async () => {
    for (const f of ["Stale Role - Stale Co", "Draftonly Role - Draftonly Co", "Await Role - Await Co", "Equal Role - Equal Co"]) {
      expect((await jobById(f)).finalizeReady, f).toBe(false);
    }
  });

  it("false when gaps ARE answered but the status is not drafted (queued)", async () => {
    const j = await jobById("Queued Role - Queued Co");
    expect(j.gapsAnswered).toBe(true); // gaps were answered ...
    expect(j.finalizeReady).toBe(false); // ... but it is not drafted
  });
});

describe("POST /api/routines/batch - finalize-job readiness guard (defense in depth)", () => {
  it("REFUSES a batch of non-finalizeReady jobs (total 0, launches nothing)", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/batch")
      .send({
        routine: "finalize-job",
        jobIds: [
          "Stale Role - Stale Co",
          "Draftonly Role - Draftonly Co",
          "Await Role - Await Co",
          "Equal Role - Equal Co",
          "Queued Role - Queued Co",
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ACCEPTS a finalizeReady job (total 1, launches one agent)", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "finalize-job", jobIds: ["Ready Role - Ready Co"] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ONLY the ready jobs from a mixed set (ready + stale -> total 1)", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "finalize-job", jobIds: ["Ready Role - Ready Co", "Stale Role - Stale Co"] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT readiness-gate first-draft-job (a non-ready job still queues)", async () => {
    spawnMock.mockClear();
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "first-draft-job", jobIds: ["Queued Role - Queued Co"] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1); // draft batch is unaffected by the finalize guard
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// The ticket's headline behavior, end to end through the REAL run-close path
// (t-1783481509014): "when Finalize runs successfully, it should be Ready". The
// fake child proc closes with exit 0, so launching finalize on a drafted job and
// letting the close fire must land the job at `ready` on disk.
describe("finalize run-close auto-advances drafted -> ready (t-1783481509014)", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const closeWith = (code) =>
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("close", code));
      return proc;
    });

  it("a SUCCESSFUL finalize run advances the drafted job to `ready`", async () => {
    expect((await jobById("Ready Role - Ready Co")).status).toBe("drafted"); // precondition
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "finalize-job", jobIds: ["Ready Role - Ready Co"] });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
    // maybeAutoAdvanceJob writes status: ready asynchronously on the close event.
    let job;
    for (let i = 0; i < 50 && (job = await jobById("Ready Role - Ready Co")).status !== "ready"; i++) {
      await sleep(10);
    }
    expect(job.status).toBe("ready");
    expect(job.finalizeReady).toBe(false); // a ready job is no longer "ready to finalize"
    expect(job.finalizeDone).toBe(true); // and reads as finalized
  });

  it("a FAILED finalize run (exit 1) leaves the job at drafted (evidence-backed only)", async () => {
    closeWith(1);
    const res = await request(app)
      .post("/api/routines/batch")
      .send({ routine: "finalize-job", jobIds: ["Ready Role - Ready Co"] });
    expect(res.status).toBe(201);
    await sleep(80); // give any (non-)advance time to fire
    expect((await jobById("Ready Role - Ready Co")).status).toBe("drafted");
  });
});
