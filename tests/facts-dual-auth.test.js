// SIM-597 - the facts routes' DUAL-AUTH contract when app-auth is ON.
//
// The ruling (integrator-20, 2026-07-23; closes the "auth question" the SIM-597
// handoff brief left open): the agent lane presents the RUNNER bearer - the same
// least-privilege credential class as /api/track-packs - and a Bearer header on
// /api/facts* routes through runnerAuth; no header keeps the owner cookie gate.
//
// Hermetic (R19 standing rule): boots the app with auth ENABLED (argon2 hash +
// signing secret in env) AND the runner lane configured (RUNNER_TOKEN_HASH),
// FileStore, tmp dirs; drives it via supertest. Mirrors tests/auth.test.js's
// auth-on boot and tests/track-packs.test.js's runner-token setup.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import argon2 from "argon2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";

const RUNNER_TOKEN = "test-runner-token-facts-dual-auth";
const PASSPHRASE = "correct horse battery staple";
const AUTH_SECRET = "facts-dual-auth-test-secret";

let app, tmpRoot;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "facts-dual-auth-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");

  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  delete process.env.STORE_BACKEND;
  delete process.env.APP_MODE;
  process.env.JOBHUNT_AUTH_HASH = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
  process.env.JOBHUNT_AUTH_SECRET = AUTH_SECRET;
  process.env.RUNNER_TOKEN_HASH = hashToken(RUNNER_TOKEN); // real mode + runner enabled
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  for (const k of ["JOBHUNT_AUTH_HASH", "JOBHUNT_AUTH_SECRET", "RUNNER_TOKEN_HASH"]) delete process.env[k];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

async function ownerCookie() {
  const res = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
  expect(res.status).toBe(200);
  return res.headers["set-cookie"];
}

const DOC = { personal_info: { name: "Test Person" } };

describe("facts dual-auth (SIM-597)", () => {
  it("401s with no credential at all (fail-closed baseline)", async () => {
    expect((await request(app).get("/api/facts")).status).toBe(401);
    expect((await request(app).put("/api/facts/resume").send(DOC)).status).toBe(401);
  });

  it("accepts the runner bearer on GET and PUT (the agent lane)", async () => {
    const put = await request(app)
      .put("/api/facts/resume")
      .set("authorization", `Bearer ${RUNNER_TOKEN}`)
      .send(DOC);
    expect(put.status).toBe(201);
    const get = await request(app).get("/api/facts").set("authorization", `Bearer ${RUNNER_TOKEN}`);
    expect(get.status).toBe(200);
    expect(get.body.facts.resume.doc).toEqual(DOC);
  });

  it("401s an INVALID bearer (never falls through to an open path)", async () => {
    const res = await request(app).get("/api/facts").set("authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("still accepts the owner session cookie (the owner lane, unchanged)", async () => {
    const cookie = await ownerCookie();
    const res = await request(app).get("/api/facts").set("cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("the bearer does NOT unlock non-facts owner routes (scope stays least-privilege)", async () => {
    const res = await request(app).get("/api/jobs").set("authorization", `Bearer ${RUNNER_TOKEN}`);
    expect(res.status).toBe(401);
  });
});
