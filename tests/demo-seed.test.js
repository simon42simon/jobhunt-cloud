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

  it("matches the PM-spec funnel (rc4-demo-journey-spec 3.1): ~23 jobs, all 9 statuses, honest losses, every track twice", () => {
    const ds = generate(1);
    const byStatus = {};
    for (const j of ds.jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    // The exact funnel shape is the product requirement (wide top, narrow bottom).
    expect(byStatus).toEqual({ lead: 5, queued: 3, drafted: 2, ready: 2, submitted: 4, interview: 2, offer: 1, rejected: 2, closed: 2 });
    // Every track badge/filter has at least 2 jobs (board + Insights look alive).
    const byTrack = {};
    for (const j of ds.jobs) byTrack[j.track] = (byTrack[j.track] || 0) + 1;
    for (const [track, n] of Object.entries(byTrack)) expect(n, `track ${track}`).toBeGreaterThanOrEqual(2);
    expect(Object.keys(byTrack).length).toBe(7);
    // Lead/queued deadlines are far-future so the lazy auto-close sweep can never
    // eat the top of the funnel (the demo must not degrade as days pass).
    for (const j of ds.jobs.filter((x) => ["lead", "queued"].includes(x.status))) {
      expect(j.deadline > "2098-12-31", `deadline ${j.deadline} on ${j.id}`).toBe(true);
    }
  });

  it("refDate anchors lead/queued deadlines 1-5 weeks ahead (sane 'due in Nd' chips, BUG-4), deterministically per day", () => {
    const ref = new Date("2026-07-16T23:45:00Z");
    const a = generate(1, { refDate: ref });
    const lo = "2026-07-23", hi = "2026-08-20";
    for (const j of a.jobs.filter((x) => ["lead", "queued"].includes(x.status))) {
      expect(j.deadline >= lo && j.deadline <= hi, `deadline ${j.deadline} on ${j.id}`).toBe(true);
    }
    // Same calendar day, different wall-clock time -> byte-identical dataset.
    const b = generate(1, { refDate: new Date("2026-07-16T01:02:03Z") });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("Hero A/B contracts hold: full artifact set + multi-run history on interview; queued and drafted heroes exist", () => {
    const ds = generate(1);
    // Hero A (an interview job) carries the complete artifact set + a multi-run history.
    const heroA = ds.jobs.find((j) => j.status === "interview");
    expect(heroA.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(heroA.notes.map((n) => n.name)).toContain("gaps.md");
    expect(ds.activity.filter((a) => a.jobId === heroA.id).length).toBeGreaterThanOrEqual(4);
    // Hero B: a queued job (Draft replay) and a drafted job (Finalize replay) both exist.
    expect(ds.jobs.some((j) => j.status === "queued")).toBe(true);
    expect(ds.jobs.some((j) => j.status === "drafted")).toBe(true);
  });

  // SIM-424: "Finalized application" used to be able to land AFTER "Applied"
  // (sometimes even after the anchor day) because the run schedule and the
  // applied date were computed independently. Pin the fix on EVERY job that
  // carries both, not just Hero A - the same uncorrelated-counter bug hit the
  // other hero/rejected jobs too, just unnoticed.
  it("every job's finalize-job run lands BEFORE its applied date, and (when both exist) draft before finalize (SIM-424)", () => {
    const ds = generate(1);
    const withApplied = ds.jobs.filter((j) => j.applied);
    expect(withApplied.length).toBeGreaterThanOrEqual(3); // enough jobs to be a real spot-check, not a fluke
    for (const j of withApplied) {
      const finalizeDone = ds.activity.find(
        (a) => a.jobId === j.id && a.routine === "finalize-job" && a.status === "done",
      );
      expect(finalizeDone, `job ${j.id} has an applied date but no finalize-job run`).toBeTruthy();
      expect(finalizeDone.ts.slice(0, 10) <= j.applied, `${j.id}: finalize ${finalizeDone.ts} vs applied ${j.applied}`).toBe(
        true,
      );
      const draftDone = ds.activity.find(
        (a) => a.jobId === j.id && a.routine === "first-draft-job" && a.status === "done",
      );
      if (draftDone) {
        expect(draftDone.ts < finalizeDone.ts, `${j.id}: draft ${draftDone.ts} vs finalize ${finalizeDone.ts}`).toBe(true);
      }
    }
    // Hero A specifically (the job QA's repro named): an interview-status job.
    const heroA = ds.jobs.find((j) => j.status === "interview");
    expect(heroA.applied).toBeTruthy();
  });

  // Every activity date must be in the PAST relative to the anchor - the old
  // uncorrelated-counter formula could push a later-processed job's run date
  // past the anchor (a "finalize" dated tomorrow), which is what actually
  // produced the "finalize after applied" symptom on Hero A.
  it("no seeded run activity lands after the anchor day, hermetic or refDate-anchored (SIM-424)", () => {
    for (const ds of [generate(1), generate(1, { refDate: new Date("2026-07-21") })]) {
      const anchorEndMs = Date.parse(ds.anchor + "T23:59:59.999Z");
      for (const a of ds.activity) {
        expect(Date.parse(a.ts), `${a.jobId} ${a.routine} ${a.status} at ${a.ts}`).toBeLessThanOrEqual(anchorEndMs);
      }
    }
  });
});

// SIM-390 item 5 - the discovery/velocity texture (journey-spec 3.3/3.4) and the
// refDate anchoring that keeps it CURRENT on the live demo.
describe("seed texture (SIM-390 item 5)", () => {
  const DAY = 86400000;

  it("every source carries run history (no 'Never run' pills) with honest counters", () => {
    const ds = generate(1);
    expect(ds.sources.length).toBeGreaterThanOrEqual(3);
    for (const s of ds.sources) {
      expect(s.lastRunAt).toBeTruthy();
      expect(s.runs.length).toBeGreaterThan(0);
      for (const r of s.runs) {
        expect(r.outcome).toBe("succeeded");
        expect(r.startedAt).toBeTruthy();
        expect(typeof r.leadsFound).toBe("number");
        expect(typeof r.candidatesReviewed).toBe("number");
      }
      // lastRunAt agrees with the newest run record.
      const newest = [...s.runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
      expect(s.lastRunAt).toBe(newest.startedAt);
    }
  });

  it("seeds a non-empty, unambiguously fictional finds list (Discovery is not blank)", () => {
    const ds = generate(1);
    expect(ds.finds.length).toBeGreaterThanOrEqual(5);
    const anchorMs = Date.parse(ds.anchor + "T00:00:00Z");
    for (const f of ds.finds) {
      expect(f.Title).toBeTruthy();
      expect(f.Employer).toBeTruthy();
      expect(f.Link).toContain("demo.example.test"); // fictional TLD, never a real posting
      expect(f.sourceId).toBeTruthy();
      expect(ds.sources.some((s) => s.id === f.sourceId)).toBe(true);
      // Date Found sits within the recent-texture window (<= 14 days before anchor).
      const age = (anchorMs - Date.parse(f["Date Found"] + "T00:00:00Z")) / DAY;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(14);
    }
    // A triage spread: mostly new, at least one decided.
    expect(ds.finds.filter((f) => f.Decision === "").length).toBeGreaterThanOrEqual(3);
    expect(ds.finds.some((f) => f.Decision !== "")).toBe(true);
  });

  it("applied dates give the velocity chart movement in the current two weeks", () => {
    const ds = generate(1);
    const anchorMs = Date.parse(ds.anchor + "T00:00:00Z");
    const appliedAges = ds.jobs
      .filter((j) => j.applied)
      .map((j) => (anchorMs - Date.parse(j.applied + "T00:00:00Z")) / DAY);
    expect(appliedAges.length).toBeGreaterThanOrEqual(3);
    // At least two applications inside the anchor's current week, one in the
    // prior week - the chart can no longer stall at "-2w" (the QA finding).
    expect(appliedAges.filter((d) => d < 7).length).toBeGreaterThanOrEqual(2);
    expect(appliedAges.filter((d) => d >= 7 && d < 14).length).toBeGreaterThanOrEqual(1);
  });

  it("refDate re-anchors every relative date to that calendar day, deterministically", () => {
    const ref = new Date("2026-07-17T15:30:00Z");
    const a = generate(1, { refDate: ref });
    const b = generate(1, { refDate: new Date("2026-07-17T02:00:00Z") }); // same UTC day
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // byte-identical within a day
    expect(a.anchor).toBe("2026-07-17");
    // Source history reads recent relative to the refDate...
    const refMs = Date.parse("2026-07-17T00:00:00Z");
    for (const s of a.sources) {
      const age = (refMs - Date.parse(s.lastRunAt)) / DAY;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(7);
    }
    // ...and lead/queued deadlines land AHEAD of it (the auto-close sweep can
    // never eat the top of the funnel on a live demo day).
    for (const j of a.jobs) {
      if (!j.deadline) continue;
      expect(Date.parse(j.deadline + "T00:00:00Z")).toBeGreaterThan(refMs);
    }
  });

  it("without refDate the seed stays hermetic (fixed anchor, no wall-clock input)", () => {
    const ds = generate(1);
    expect(ds.anchor).toBe("2026-07-01"); // the pinned hermetic anchor
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
