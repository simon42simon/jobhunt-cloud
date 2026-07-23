// SIM-598 (JP-6) - the fail-closed quality gate wired into the hybrid-runner
// artifact-post endpoint (POST /api/runner/jobs/:id/artifact), the EARLIEST
// point the cloud sees a rendered CV/cover-letter. Mirrors
// tests/runner-endpoints.test.js's exact boot/claim harness.
//
// The headline case (first test): the owner-reported failure itself - an
// over-2-page CV posted for first-draft-job, which renders --no-pdf, so this
// is a .docx with no PDF anywhere in the picture. Before SIM-598 the page cap
// only existed as prose the model was trusted to follow at draft time; this
// proves the artifact is now rejected before it can ever land.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";
import { buildDocxFixture, buildPdfFixture } from "./helpers/docx-fixture.mjs";

const TOKEN = "test-runner-token-quality-gate-9876";
const bearer = (t = TOKEN) => `Bearer ${t}`;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeJob(dir, folder) {
  const [role, employer] = folder.split(" - ");
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, `${role}.md`),
    ["---", "type: job", `role: ${role}`, `employer: ${employer}`, "status: queued", "sector: private", "tags: [job]", "---", "", `# ${folder}`, ""].join("\n"),
    "utf8",
  );
}

let app, tmpRoot, JOB;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quality-gate-ep-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  JOB = "Analyst - QualityGateCo";
  makeJob(jobsDir, JOB);

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN); // real mode + runner enabled
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

async function claim(kind) {
  await request(app).post("/api/agent-jobs").send({ kind, jobId: JOB });
  for (let i = 0; i < 10; i++) {
    const rr = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
    if (rr.status !== 200) break;
    if (rr.body.jobId === JOB && rr.body.kind === kind) return rr.body;
  }
  throw new Error(`could not claim ${kind} for ${JOB}`);
}

async function closeClaim(c) {
  await request(app).post(`/api/runner/jobs/${c.id}/result`).set("authorization", bearer()).send({ nonce: c.nonce, status: "done" });
}

describe("SIM-598 quality gate at the runner artifact-post endpoint", () => {
  it("REJECTS an over-2-page CV .docx at DRAFT time (--no-pdf; the owner-reported failure)", async () => {
    const c = await claim("first-draft-job");
    const overLimit = buildDocxFixture(1300); // ceil(1300/500) = 3 pages, over the 2-page CV cap
    const r = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "CV - Analyst.docx")
      .set("Content-Type", DOCX_MIME)
      .send(overLimit);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/page/i);
    // never landed - the job still shows no CV
    const detail = await request(app).get(`/api/jobs/${encodeURIComponent(JOB)}`);
    expect(detail.body.hasCV).toBe(false);
    await closeClaim(c);
  });

  it("ACCEPTS an in-cap CV .docx at draft time (the gate is not just 'always block')", async () => {
    const c = await claim("first-draft-job");
    const inLimit = buildDocxFixture(600); // ceil(600/500) = 2 pages, within cap
    const r = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "CV - Analyst.docx")
      .set("Content-Type", DOCX_MIME)
      .send(inLimit);
    expect(r.status).toBe(201);
    const detail = await request(app).get(`/api/jobs/${encodeURIComponent(JOB)}`);
    expect(detail.body.hasCV).toBe(true);
    await closeClaim(c);
  });

  it("REJECTS an over-1-page cover letter .pdf at finalize time (PDF path, the other cap)", async () => {
    const c = await claim("finalize-job");
    const overLimit = buildPdfFixture(2); // over the 1-page cover-letter cap
    const r = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "Cover Letter.pdf")
      .set("Content-Type", "application/pdf")
      .send(overLimit);
    expect(r.status).toBe(400);
    await closeClaim(c);
  });

  it("still REJECTS an unrelated kind first (MF-2 unchanged) before the quality gate even runs", async () => {
    const c = await claim("finalize-job");
    const r = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "STAR prep.md")
      .set("Content-Type", "text/markdown")
      .send(Buffer.from("prep content", "utf8"));
    expect(r.status).toBe(400);
    await closeClaim(c);
  });
});
