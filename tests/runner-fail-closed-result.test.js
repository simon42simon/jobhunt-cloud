// SIM-615 (+SIM-613 same-root): "a jobhunt run can no longer lie" - a required-
// kind artifact (cv/cover for first-draft-job / finalize-job) that never lands
// durably in job_files must sink the run's reported status, no matter what the
// runner's own /result call claims. This is the SERVER-side backstop
// (server/index.js's /api/runner/jobs/:id/result), deliberately independent of
// ops/agent-runner.mjs's own fix (tests/agent-runner-collect.test.js covers the
// runner's resolveRunOutcome directly) - a stale/buggy runner build that still
// reports "done" over a gate-rejected or simply-never-posted artifact must be
// caught here too. Reproduces the exact SIM-615 candidate-1 evidence: cover
// letter lands, CV is rejected by the SIM-598 gate, the runner (or a caller
// hitting this endpoint directly) reports status:"done" anyway.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";
import { buildDocxFixture } from "./helpers/docx-fixture.mjs";

const TOKEN = "test-runner-token-fail-closed-4321";
const bearer = () => `Bearer ${TOKEN}`;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeJob(dir, folder, status) {
  const [role, employer] = folder.split(" - ");
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, `${role}.md`),
    ["---", "type: job", `role: ${role}`, `employer: ${employer}`, `status: ${status}`, "sector: private", "tags: [job]", "---", "", `# ${folder}`, ""].join("\n"),
    "utf8",
  );
}

let app, tmpRoot, jobsDir;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-fail-closed-"));
  jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  process.env.RUNNER_TOKEN_HASH = hashToken(TOKEN);
  process.env.JOBHUNT_SOURCE_DISPATCH = "runner"; // force the pg-instance decision, mirrors routine-runner-dispatch.test.js
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.RUNNER_TOKEN_HASH;
  delete process.env.JOBHUNT_SOURCE_DISPATCH;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Launches through the REAL product path (POST /api/routines/run), the same
// one candidate-1's evidence took - not the raw /api/agent-jobs test seam -
// so the run record exists and the status auto-advance wiring actually fires,
// same as tests/routine-runner-dispatch.test.js.
async function claim(kind, jobId) {
  const launched = await request(app).post("/api/routines/run").send({ routine: kind, jobId });
  if (launched.status !== 201) throw new Error(`launch failed: ${launched.status} ${JSON.stringify(launched.body)}`);
  for (let i = 0; i < 10; i++) {
    const rr = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
    if (rr.status !== 200) break;
    if (rr.body.jobId === jobId && rr.body.kind === kind) return rr.body;
  }
  throw new Error(`could not claim ${kind} for ${jobId}`);
}

const jobById = async (jid) => (await request(app).get(`/api/jobs/${encodeURIComponent(jid)}`)).body;

describe("SIM-615/613 fail-closed backstop at /api/runner/jobs/:id/result", () => {
  it("a gate-rejected CV + a 'done' result never advances the job, even though the cover letter landed", async () => {
    const JOB = "Backstop Analyst - Backstop Co";
    makeJob(jobsDir, JOB, "queued");
    const c = await claim("first-draft-job", JOB);

    // Cover letter lands fine.
    const coverRes = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "Cover Letter - Backstop Analyst.docx")
      .set("Content-Type", DOCX_MIME)
      .send(buildDocxFixture(200));
    expect(coverRes.status).toBe(201);

    // CV is over the 2-page cap - the SIM-598 gate correctly rejects it, so it
    // never reaches job_files (the exact SIM-613 repro: a 400 the caller could
    // silently ignore).
    const cvRes = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "CV - Backstop Analyst.docx")
      .set("Content-Type", DOCX_MIME)
      .send(buildDocxFixture(1300));
    expect(cvRes.status).toBe(400);

    expect((await jobById(JOB)).hasCV).toBe(false);
    expect((await jobById(JOB)).hasCoverLetter).toBe(true);

    // A caller (an old/buggy runner build, or anyone hitting this endpoint
    // directly) claims "done" anyway - this is the SIM-615 false-success case.
    const resultRes = await request(app)
      .post(`/api/runner/jobs/${c.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: c.nonce, status: "done" });
    expect(resultRes.status).toBe(200);

    // The job must NOT have advanced to "drafted" - the run is not honestly
    // "done" over a missing required artifact.
    const job = await jobById(JOB);
    expect(job.status).toBe("queued");
    expect(job.hasCV).toBe(false);
  });

  it("both required artifacts landing + a 'done' result DOES advance the job (the backstop is not 'always block')", async () => {
    const JOB = "Backstop Analyst Two - Backstop Co";
    makeJob(jobsDir, JOB, "queued");
    const c = await claim("first-draft-job", JOB);

    const cover = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "Cover Letter - Backstop Analyst Two.docx")
      .set("Content-Type", DOCX_MIME)
      .send(buildDocxFixture(200));
    expect(cover.status).toBe(201);

    const cv = await request(app)
      .post(`/api/runner/jobs/${c.id}/artifact`)
      .set("authorization", bearer())
      .set("x-runner-nonce", c.nonce)
      .set("x-artifact-name", "CV - Backstop Analyst Two.docx")
      .set("Content-Type", DOCX_MIME)
      .send(buildDocxFixture(400));
    expect(cv.status).toBe(201);

    const resultRes = await request(app)
      .post(`/api/runner/jobs/${c.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: c.nonce, status: "done" });
    expect(resultRes.status).toBe(200);

    const job = await jobById(JOB);
    expect(job.status).toBe("drafted");
    expect(job.hasCV).toBe(true);
    expect(job.hasCoverLetter).toBe(true);
  });

  it("a routine with no required kinds (interview-prep) is unaffected by the backstop", async () => {
    const JOB = "Backstop Prep - Backstop Co";
    makeJob(jobsDir, JOB, "drafted");
    const c = await claim("interview-prep", JOB);
    const resultRes = await request(app)
      .post(`/api/runner/jobs/${c.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: c.nonce, status: "done" });
    expect(resultRes.status).toBe(200);
    expect(resultRes.body.ok).toBe(true);
  });
});
