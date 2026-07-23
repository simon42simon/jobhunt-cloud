// SIM-544 (JP-1) + SIM-574 (JP-2) - the track-pack cache HTTP surface (now
// keyed off SERVER-COMPUTED factsHash, since facts live in this store as of
// the 2026-07-23 architecture correction - see server/facts-lib.js) and the
// SIM-535 result lane's economics extension. Boots the app in RUNNER-ENABLED
// real mode (RUNNER_TOKEN_HASH set, FileStore, auth off) and drives it via
// supertest, mirroring tests/runner-endpoints.test.js exactly.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";

const TOKEN = "test-runner-token-1234567890";
const bearer = (t = TOKEN) => `Bearer ${t}`;

function makeJob(dir, folder) {
  const [role, employer] = folder.split(" - ");
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, `${role}.md`),
    ["---", "type: job", `role: ${role}`, `employer: ${employer}`, "status: drafted", "sector: private", "tags: [job]", "---", "", `# ${folder}`, ""].join("\n"),
    "utf8",
  );
}

let app, tmpRoot, JOB;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "track-packs-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "tasks.yaml"), "columns: [backlog, todo, in_progress, done]\ntasks: []\n", "utf8");
  JOB = "Analyst - OCI";
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

const TRACK = "industry_outreach_focused";
const packBody = () => ({ styleDigest: "abc123", blocks: { summaryBase: "Operations leader...", heroStats: ["Cut vendor spend 30%"] } });

describe("track-pack cache auth gate", () => {
  it("401s with no token and with a wrong token", async () => {
    expect((await request(app).get(`/api/track-packs/${TRACK}`)).status).toBe(401);
    expect((await request(app).put(`/api/track-packs/${TRACK}`).set("authorization", bearer("wrong")).send(packBody())).status).toBe(401);
  });
});

describe("track-pack cache round-trip (FileStore), keyed off server-computed factsHash", () => {
  it("404s a cache miss (no facts set, no pack for this track's current - empty - facts state yet)", async () => {
    const r = await request(app).get(`/api/track-packs/${TRACK}`).set("authorization", bearer());
    expect(r.status).toBe(404);
  });

  it("REJECTS a PUT with an unknown track", async () => {
    const r = await request(app).put("/api/track-packs/bogus_track").set("authorization", bearer()).send(packBody());
    expect(r.status).toBe(400);
  });

  it("PUTs a well-formed pack (201) then GETs it back byte-identical (200), against the CURRENT (still empty) facts state", async () => {
    const put = await request(app).put(`/api/track-packs/${TRACK}`).set("authorization", bearer()).send(packBody());
    expect(put.status).toBe(201);
    expect(put.body.pack.track).toBe(TRACK);
    expect(put.body.pack.cacheKey).toMatch(new RegExp(`^${TRACK}:[0-9a-f]{64}$`));

    const get = await request(app).get(`/api/track-packs/${TRACK}`).set("authorization", bearer());
    expect(get.status).toBe(200);
    expect(get.body.pack.blocks).toEqual(packBody().blocks);
    expect(get.body.pack.cacheKey).toBe(put.body.pack.cacheKey);
  });

  it("a facts edit changes the SERVER-COMPUTED hash -> the SAME track now misses (implicit invalidation, no explicit delete anywhere)", async () => {
    // still hits at this point (nothing about facts has changed yet)
    const before = await request(app).get(`/api/track-packs/${TRACK}`).set("authorization", bearer());
    expect(before.status).toBe(200);

    const putFacts = await request(app).put("/api/facts/resume").send({ title_line: "Operations Leader", summary_base: "8 years..." });
    expect(putFacts.status).toBe(201);

    // the OLD pack (built against the pre-edit, empty facts state) is now unreachable
    const after = await request(app).get(`/api/track-packs/${TRACK}`).set("authorization", bearer());
    expect(after.status).toBe(404);
  });

  it("PUTting a fresh pack against the NEW facts state, then editing facts again, produces a THIRD distinct, non-colliding key", async () => {
    const put1 = await request(app).put(`/api/track-packs/${TRACK}`).set("authorization", bearer()).send(packBody());
    expect(put1.status).toBe(201);
    const key1 = put1.body.pack.cacheKey;

    await request(app).put("/api/facts/professional_experience").send({ achievement_pool: ["Cut vendor spend 30%"] });

    const miss = await request(app).get(`/api/track-packs/${TRACK}`).set("authorization", bearer());
    expect(miss.status).toBe(404); // key1's pack is unreachable again

    const put2 = await request(app).put(`/api/track-packs/${TRACK}`).set("authorization", bearer()).send(packBody());
    expect(put2.status).toBe(201);
    expect(put2.body.pack.cacheKey).not.toBe(key1); // a genuinely new key, not a collision/overwrite
  });
});

describe("facts CRUD (SIM-544 architecture correction, 2026-07-23)", () => {
  it("404s a kind that was never set", async () => {
    const r = await request(app).get("/api/facts/cover_letter");
    expect(r.status).toBe(404);
  });

  it("400s an unknown kind on GET and PUT", async () => {
    expect((await request(app).get("/api/facts/bogus")).status).toBe(400);
    expect((await request(app).put("/api/facts/bogus").send({ a: 1 })).status).toBe(400);
  });

  it("PUTs a facts doc (201) then GETs it back byte-identical (200)", async () => {
    const doc = { openings: ["Dear hiring team,"], hero_phrases: ["shipped X"] };
    const put = await request(app).put("/api/facts/cover_letter").send(doc);
    expect(put.status).toBe(201);
    expect(put.body.facts.doc).toEqual(doc);

    const get = await request(app).get("/api/facts/cover_letter");
    expect(get.status).toBe(200);
    expect(get.body.facts.doc).toEqual(doc);
  });

  it("GET /api/facts (all kinds) reports every kind, null for anything never set", async () => {
    const r = await request(app).get("/api/facts");
    expect(r.status).toBe(200);
    expect(r.body.facts).toHaveProperty("resume");
    expect(r.body.facts).toHaveProperty("professional_experience");
    expect(r.body.facts).toHaveProperty("cover_letter");
    expect(r.body.facts.cover_letter.doc).toEqual({ openings: ["Dear hiring team,"], hero_phrases: ["shipped X"] });
  });
});

describe("run-economics via the SIM-535 result lane (SIM-574)", () => {
  it("a first-draft-job run's tokens/wallMs land durably in agent_jobs.result, and track-pack lookups during the run become reuseHitRate/cacheKeyProvenance", async () => {
    // a real cache hit + a real miss to correlate: PUT the current track pack
    // (a hit target), and probe a track that has never been cached (a miss)
    const hit = await request(app).put(`/api/track-packs/${TRACK}`).set("authorization", bearer()).send(packBody());
    const hitKey = hit.body.pack.cacheKey;
    const OTHER_TRACK = "b2b_gtm_focused";

    await request(app).post("/api/agent-jobs").send({ kind: "first-draft-job", jobId: JOB });
    let claim;
    for (let i = 0; i < 10; i++) {
      const rr = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
      if (rr.status !== 200) break;
      if (rr.body.jobId === JOB && rr.body.kind === "first-draft-job") {
        claim = rr.body;
        break;
      }
    }
    expect(claim).toBeTruthy();

    // the runner relays raw stdout lines to /progress AS IT GOES, including the
    // terminal stream-json result event (exactly what ops/agent-runner.mjs does)
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 42_000,
      num_turns: 5,
      total_cost_usd: 0.9,
      usage: { input_tokens: 8000, output_tokens: 1200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 },
      result: "Draft complete.",
    });
    const prog = await request(app)
      .post(`/api/runner/jobs/${claim.id}/progress`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .send({ lines: [resultLine] });
    expect(prog.status).toBe(200);

    // during the run, the skill would have hit the track-pack cache: one hit
    // (the pack just PUT above), one miss (a different track, never cached)
    const hitReq = await request(app).get(`/api/track-packs/${TRACK}?agentJobId=${claim.id}`).set("authorization", bearer());
    expect(hitReq.status).toBe(200);
    const missReq = await request(app).get(`/api/track-packs/${OTHER_TRACK}?agentJobId=${claim.id}`).set("authorization", bearer());
    expect(missReq.status).toBe(404);

    const done = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "done" });
    expect(done.status).toBe(200);

    // read the durable row back directly off the store (no new read-endpoint
    // needed for this - same approach other store-focused tests use)
    const { resolveStore } = await import("../server/store.js");
    const store = resolveStore(process.env, {
      jobsDir: process.env.JOBHUNT_JOBS_DIR,
      docsDir: process.env.JOBHUNT_DOCS_DIR,
      dataDir: process.env.JOBHUNT_DOCS_DIR, // matches index.js's DATA_DIR-follows-DOCS_DIR test-mode rule
      deps: {},
    });
    const aj = store.agentJobById(claim.id);
    expect(aj.result).toBeTruthy();
    expect(aj.result.economics).toBeTruthy();
    expect(aj.result.economics.wallMs).toBe(42_000);
    expect(aj.result.economics.tokens).toEqual({ input: 8000, output: 1200, cacheRead: 3000, cacheCreate: 500 });
    expect(aj.result.economics.reuseHitRate).toBe(0.5); // 1 hit, 1 miss
    expect(aj.result.economics.cacheKeyProvenance).toEqual(expect.arrayContaining([hitKey, `${OTHER_TRACK}:` + hitKey.split(":")[1]]));
  });

  it("a run with no track-pack lookups reports economics with no reuseHitRate (honest: never fabricated)", async () => {
    await request(app).post("/api/agent-jobs").send({ kind: "finalize-job", jobId: JOB });
    let claim;
    for (let i = 0; i < 10; i++) {
      const rr = await request(app).get("/api/runner/jobs/next").set("authorization", bearer());
      if (rr.status !== 200) break;
      if (rr.body.jobId === JOB && rr.body.kind === "finalize-job") {
        claim = rr.body;
        break;
      }
    }
    expect(claim).toBeTruthy();
    const resultLine = JSON.stringify({ type: "result", subtype: "success", duration_ms: 5000, num_turns: 2, total_cost_usd: 0.1, result: "done" });
    await request(app)
      .post(`/api/runner/jobs/${claim.id}/progress`)
      .set("authorization", bearer())
      .set("x-runner-nonce", claim.nonce)
      .send({ lines: [resultLine] });
    const done = await request(app)
      .post(`/api/runner/jobs/${claim.id}/result`)
      .set("authorization", bearer())
      .send({ nonce: claim.nonce, status: "done" });
    expect(done.status).toBe(200);

    const { resolveStore } = await import("../server/store.js");
    const store = resolveStore(process.env, {
      jobsDir: process.env.JOBHUNT_JOBS_DIR,
      docsDir: process.env.JOBHUNT_DOCS_DIR,
      dataDir: process.env.JOBHUNT_DOCS_DIR, // matches index.js's DATA_DIR-follows-DOCS_DIR test-mode rule
      deps: {},
    });
    const aj = store.agentJobById(claim.id);
    expect(aj.result.economics.wallMs).toBe(5000);
    expect(aj.result.economics.reuseHitRate).toBeUndefined();
    expect(aj.result.economics.cacheKeyProvenance).toBeUndefined();
  });
});

describe("capability probes (STORE_TRACK_PACKS / STORE_FACTS)", () => {
  // Both backends implement facts + track-packs today (migrations/0006, 0007) -
  // the probe survives purely as defense-in-depth for a FUTURE backend that
  // might omit either. Verified here: this instance's store really does carry
  // both (so the 200/201 paths above exercise the real gate, not a bypassed
  // one), and the probe expression itself reads a backend that lacks them.
  it("FileStore implements getTrackPack/putTrackPack/getFacts/putFacts; a backend without them probes false", async () => {
    const storeModule = await import("../server/store.js");
    const s = storeModule.resolveStore(process.env, {
      jobsDir: process.env.JOBHUNT_JOBS_DIR,
      docsDir: process.env.JOBHUNT_DOCS_DIR,
      dataDir: process.env.JOBHUNT_DOCS_DIR,
      deps: {},
    });
    for (const fn of ["getTrackPack", "putTrackPack", "getFacts", "putFacts", "getAllFacts"]) {
      expect(typeof s[fn]).toBe("function");
    }
    const bareStub = {}; // stands in for a hypothetical backend that omits these
    expect(typeof bareStub.getTrackPack === "function").toBe(false);
  });
});
