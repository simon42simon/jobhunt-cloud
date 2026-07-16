// RC-3 / SIM-87 I6 - demo seed determinism + apply-through-the-Store-seam.
// The seed is store-agnostic, so we prove applySeed against a real FileStore in a
// temp vault (no DB needed) - the same seam the cloud demo's PgStore uses.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate, applySeed } from "../demo/seed.mjs";

// Keep the index.js import (for the injected domain helpers) hermetic.
process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-seed-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;

const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const { FileStore } = await import("../server/store.js");
const STATUSES = ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"];
const DEPS = { TRACKS: {}, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource };

describe("demo seed determinism", () => {
  it("generate(v) is fully deterministic for a fixed seed version", () => {
    const a = generate(1);
    const b = generate(1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a different seed version yields a different board", () => {
    expect(JSON.stringify(generate(1))).not.toBe(JSON.stringify(generate(2)));
  });

  it("produces a believable spread: jobs, tasks, requests, sources, activity", () => {
    const ds = generate(1);
    expect(ds.jobs.length).toBeGreaterThan(5);
    expect(ds.tasks.length).toBeGreaterThan(0);
    expect(ds.requests.length).toBeGreaterThan(0);
    expect(ds.sources.length).toBeGreaterThan(0);
    expect(ds.activity.length).toBeGreaterThan(0);
    // jobs span multiple statuses (a live-looking board, not all in one column)
    const statuses = new Set(ds.jobs.map((j) => j.status));
    expect(statuses.size).toBeGreaterThan(2);
  });
});

describe("applySeed through the Store seam (FileStore)", () => {
  let root, store;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-seed-apply-"));
    const jobsDir = path.join(root, "Jobs");
    const docsDir = path.join(root, "docs");
    const dataDir = path.join(root, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    store = new FileStore({ jobsDir, docsDir, dataDir, deps: DEPS });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("populates jobs (with artifacts + notes), tasks, requests, sources, chats, activity", () => {
    const ds = generate(1);
    applySeed(store, ds);

    const jobs = store.listJobs();
    expect(jobs.length).toBe(ds.jobs.length);

    // A far-along job carries its pre-baked CV/cover artifacts + gaps note.
    const withArtifacts = ds.jobs.find((j) => j.artifacts.length);
    const detail = store.getJob(withArtifacts.id);
    expect(detail).toBeTruthy();
    expect(detail.hasCV).toBe(true);
    expect(detail.hasCoverLetter).toBe(true);
    expect(detail.gaps).toBeTruthy();

    expect(store.loadTasks().tasks.length).toBe(ds.tasks.length);
    expect(store.loadRequests().requests.length).toBe(ds.requests.length);
    expect(store.loadSources().sources.length).toBe(ds.sources.length);
    expect(Object.keys(store.loadChats()).length).toBeGreaterThan(0);
    const activityLines = store.readActivityText().split(/\r?\n/).filter((l) => l.trim());
    expect(activityLines.length).toBe(ds.activity.length);
  });
});
