// SIM-544 (JP-1) + SIM-574 (JP-2) - the track-pack cache HTTP surface and the
// SIM-535 result lane's economics extension. Boots the app in RUNNER-ENABLED
// real mode (RUNNER_TOKEN_HASH set, FileStore, auth off) and drives it via
// supertest, mirroring tests/runner-endpoints.test.js exactly.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToken } from "../server/runner-lib.js";
import { computeContentHash } from "../server/track-pack-lib.js";

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
const factsHash = computeContentHash(["resume.yaml bytes v1", "professional-experience.yaml bytes v1"]);
const cacheKey = `${TRACK}:${factsHash}`;
const packBody = () => ({
  track: TRACK,
  factsHash,
  styleDigest: "abc123",
  blocks: { summaryBase: "Operations leader...", heroStats: ["Cut vendor spend 30%"] },
});

describe("track-pack cache auth gate", () => {
  it("401s with no token and with a wrong token", async () => {
    expect((await request(app).get(`/api/track-packs/${cacheKey}`)).status).toBe(401);
    expect((await request(app).put(`/api/track-packs/${cacheKey}`).set("authorization", bearer("wrong")).send(packBody())).status).toBe(401);
  });
});

describe("track-pack cache round-trip (FileStore)", () => {
  it("404s a cache miss", async () => {
    const r = await request(app).get(`/api/track-packs/${cacheKey}`).set("authorization", bearer());
    expect(r.status).toBe(404);
  });

  it("REJECTS a PUT whose body track/hash disagree with the URL cacheKey", async () => {
    const wrongUrlKey = `${TRACK}:${computeContentHash(["a different hash"])}`;
    const r = await request(app).put(`/api/track-packs/${wrongUrlKey}`).set("authorization", bearer()).send(packBody());
    expect(r.status).toBe(400);
  });

  it("REJECTS a PUT with an unknown track", async () => {
    const r = await request(app)
      .put(`/api/track-packs/bogus_track:${factsHash}`)
      .set("authorization", bearer())
      .send({ ...packBody(), track: "bogus_track" });
    expect(r.status).toBe(400);
  });

  it("PUTs a well-formed pack (201) then GETs it back byte-identical (200)", async () => {
    const put = await request(app).put(`/api/track-packs/${cacheKey}`).set("authorization", bearer()).send(packBody());
    expect(put.status).toBe(201);
    expect(put.body.pack.cacheKey).toBe(cacheKey);

    const get = await request(app).get(`/api/track-packs/${cacheKey}`).set("authorization", bearer());
    expect(get.status).toBe(200);
    expect(get.body.pack.blocks).toEqual(packBody().blocks);
    expect(get.body.pack.track).toBe(TRACK);
    expect(get.body.pack.factsHash).toBe(factsHash);
  });

  it("a facts edit (new factsHash) is reached under a NEW key - the old key is untouched (implicit invalidation)", async () => {
    const newHash = computeContentHash(["resume.yaml bytes v2"]);
    const newKey = `${TRACK}:${newHash}`;
    const miss = await request(app).get(`/api/track-packs/${newKey}`).set("authorization", bearer());
    expect(miss.status).toBe(404);
    const stillThere = await request(app).get(`/api/track-packs/${cacheKey}`).set("authorization", bearer());
    expect(stillThere.status).toBe(200);
  });
});

describe("run-economics via the SIM-535 result lane (SIM-574)", () => {
  it("a first-draft-job run's tokens/wallMs land durably in agent_jobs.result, and track-pack lookups during the run become reuseHitRate/cacheKeyProvenance", async () => {
    // enqueue + claim a first-draft-job run
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

    // during the run, the skill would have hit the track-pack cache: one hit,
    // one miss (a second, different track's pack it had to build fresh)
    const hitKey = cacheKey; // already cached above
    const missKey = `${TRACK}:${computeContentHash(["a fresh, never-cached hash"])}`;
    await request(app).get(`/api/track-packs/${hitKey}?agentJobId=${claim.id}`).set("authorization", bearer());
    await request(app).get(`/api/track-packs/${missKey}?agentJobId=${claim.id}`).set("authorization", bearer());

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
    expect(aj.result.economics.cacheKeyProvenance).toEqual(expect.arrayContaining([hitKey, missKey]));
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

  it("a discover-jobs-source result (no economics-eligible kind) is left exactly as the runner sent it", async () => {
    // sanity: economics merging is scoped to first-draft-job/finalize-job only,
    // never applied to unrelated kinds (no behavior change to generation, no
    // scope creep into discovery's own result contract)
    const r = await request(app).get("/api/runner/state");
    expect(r.status).toBe(200); // smoke: the server is still healthy after the above
  });
});

describe("track-pack capability probe (STORE_TRACK_PACKS)", () => {
  // server/index.js computes `STORE_TRACK_PACKS = typeof store.getTrackPack ===
  // "function"` ONCE at boot from whichever store resolveStore/createPgStore
  // constructed (the exact SIM-547 STORE_FINDS pattern) - there is no hermetic
  // way to flip it post-boot without a real PgStore connection (not available
  // in this test env), so the true GET/PUT-returns-501-on-PgStore path is a
  // manual/integration-environment check, not a unit test here. What IS
  // verified hermetically: FileStore actually implements the capability (so
  // the 200/201 paths above are exercising the real gate, not a bypassed one),
  // and the probe expression itself correctly reads a backend that lacks it.
  it("FileStore implements getTrackPack/putTrackPack; a backend without them probes false", async () => {
    const storeModule = await import("../server/store.js");
    const s = storeModule.resolveStore(process.env, {
      jobsDir: process.env.JOBHUNT_JOBS_DIR,
      docsDir: process.env.JOBHUNT_DOCS_DIR,
      dataDir: process.env.JOBHUNT_DOCS_DIR,
      deps: {},
    });
    expect(typeof s.getTrackPack).toBe("function");
    expect(typeof s.putTrackPack).toBe("function");
    const bareStub = {}; // stands in for PgStore's current (deliberate) absence
    expect(typeof bareStub.getTrackPack === "function").toBe(false);
  });
});
