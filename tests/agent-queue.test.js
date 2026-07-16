// RC-3 / SIM-87 I7 - hybrid-runner queue lifecycle at the Store seam (MF-7).
// Exercised against FileStore with a controllable clock (nowMs/leaseMs/maxAttempts)
// so lease expiry + the attempts cap are deterministic. PgStore implements the same
// contract (FOR UPDATE SKIP LOCKED); it is covered by the embedded-pg suites when
// run de-elevated.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queue-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;
const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const { FileStore } = await import("../server/store.js");
const DEPS = { TRACKS: {}, STATUSES: ["lead", "drafted"], dropInvalidJobEnums, normalizeSource, serializeSource };

let root, store;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queue-"));
  const jobsDir = path.join(root, "Jobs");
  const docsDir = path.join(root, "docs");
  const dataDir = path.join(root, "data");
  for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
  store = new FileStore({ jobsDir, docsDir, dataDir, deps: DEPS });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const R = "runner-aaaa1111";

describe("agent_jobs queue lifecycle", () => {
  it("enqueue -> claim -> heartbeat -> complete(done)", () => {
    const { id } = store.enqueueAgentJob({ kind: "finalize-job", jobId: "Analyst - OCI", payload: { note: "go" } });
    expect(id).toMatch(/^aj-/);

    const claim = store.claimAgentJob(R);
    expect(claim.id).toBe(id);
    expect(claim.kind).toBe("finalize-job");
    expect(claim.jobId).toBe("Analyst - OCI");
    expect(claim.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(claim.attempts).toBe(1);

    expect(store.heartbeatAgentJob(id, R).ok).toBe(true);
    expect(store.agentJobById(id).status).toBe("running");

    const done = store.completeAgentJob(id, { runnerId: R, nonce: claim.nonce, status: "done", result: { ok: true } });
    expect(done.ok).toBe(true);
    expect(store.agentJobById(id).status).toBe("done");
  });

  it("claim returns null on an empty queue and does not double-claim (single-runner)", () => {
    expect(store.claimAgentJob(R)).toBeNull();
    store.enqueueAgentJob({ kind: "discover-jobs", jobId: null });
    expect(store.claimAgentJob(R)).toBeTruthy();
    expect(store.claimAgentJob(R)).toBeNull(); // the one job is now claimed, nothing else queued
  });

  it("REPLAY protection: a stale/duplicate nonce is rejected; the terminal result is an idempotent no-op", () => {
    const { id } = store.enqueueAgentJob({ kind: "finalize-job", jobId: "Analyst - OCI" });
    const claim = store.claimAgentJob(R);

    // wrong nonce -> rejected, job stays claimed
    const bad = store.completeAgentJob(id, { runnerId: R, nonce: "deadbeef", status: "done" });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/nonce mismatch/);
    expect(store.agentJobById(id).status).toBe("claimed");

    // correct nonce -> done
    expect(store.completeAgentJob(id, { runnerId: R, nonce: claim.nonce, status: "done" }).ok).toBe(true);

    // REPLAY the same result -> idempotent 200 no-op (nonce already consumed)
    const replay = store.completeAgentJob(id, { runnerId: R, nonce: claim.nonce, status: "done" });
    expect(replay.ok).toBe(true);
    expect(replay.idempotent).toBe(true);
  });

  it("a result from a DIFFERENT runner is rejected", () => {
    const { id } = store.enqueueAgentJob({ kind: "finalize-job", jobId: "X - Y" });
    const claim = store.claimAgentJob(R);
    const r = store.completeAgentJob(id, { runnerId: "runner-bbbb2222", nonce: claim.nonce, status: "done" });
    expect(r.ok).toBe(false);
  });

  it("POISON job: an expired lease re-queues; the attempts cap (3) moves it to dead", () => {
    const { id } = store.enqueueAgentJob({ kind: "finalize-job", jobId: "P - Q" });
    let t = 1_000_000;
    const lease = 1000;
    // attempt 1: claim, then let the lease expire before the next claim
    let c = store.claimAgentJob(R, { nowMs: t, leaseMs: lease, maxAttempts: 3 });
    expect(c.attempts).toBe(1);
    t += lease + 1;
    // the sweep on the next claim re-queues attempt 1 and claims it as attempt 2
    c = store.claimAgentJob(R, { nowMs: t, leaseMs: lease, maxAttempts: 3 });
    expect(c.attempts).toBe(2);
    t += lease + 1;
    c = store.claimAgentJob(R, { nowMs: t, leaseMs: lease, maxAttempts: 3 });
    expect(c.attempts).toBe(3);
    t += lease + 1;
    // attempt 3's lease expired with attempts==3 -> dead; nothing left to claim
    const none = store.claimAgentJob(R, { nowMs: t, leaseMs: lease, maxAttempts: 3 });
    expect(none).toBeNull();
    expect(store.agentJobById(id).status).toBe("dead");
  });

  it("runnerQueueState reports counts + newest heartbeat for the honest pending UI", () => {
    store.enqueueAgentJob({ kind: "discover-jobs", jobId: null });
    store.enqueueAgentJob({ kind: "finalize-job", jobId: "A - B" });
    const claim = store.claimAgentJob(R);
    store.heartbeatAgentJob(claim.id, R);
    const st = store.runnerQueueState();
    expect(st.counts.queued).toBe(1);
    expect(st.counts.running).toBe(1);
    expect(typeof st.lastHeartbeatAt).toBe("string");
    expect(typeof st.oldestQueuedAt).toBe("string");
  });
});
