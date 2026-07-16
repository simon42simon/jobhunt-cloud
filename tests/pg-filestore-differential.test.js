// RC-3 / SIM-87 I4 - FileStore vs PgStore DIFFERENTIAL.
//
// Drives the SAME operations through both backends over one fixture dataset and
// asserts the returned DOMAIN OBJECTS are equivalent. This is the parity proof the
// PoR DoD calls for on top of the shared contract suite: not just "each backend
// passes the contract" but "both backends AGREE on the same inputs".
//
// Two field classes are excluded from equality BY DESIGN, not by convenience:
//   - FILESYSTEM-ONLY DTO fields (folderPath / jobFile / jobFileName / mtime /
//     the raw `files` listing): FileStore has a real folder; PgStore has rows and
//     no <Role>.md file, so these can never be identical. The DERIVED readiness
//     BOOLEANS - the thing that actually drives the UI - ARE compared and must match.
//   - the discovery `updated` header stamp (today's date): a cosmetic wall-clock
//     value, not payload. The `sources` array + `version` are compared.
// Timestamp-ORDERED readiness (gapsAnswered/finalizeReady) is exercised with a real
// ordering delay so file-mtime and row-updated_at agree.
//
// Self-provisions an ephemeral Postgres; SKIPS cleanly (describe.skip) when it
// cannot start (offline binary / elevated Windows token) so the gate stays green.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCluster } from "./helpers/embedded-pg.mjs";
import { PgStore } from "../server/pg-store.js";
import { FileStore } from "../server/store.js";

process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-diff-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;

const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const STATUSES = ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"];
const TRACKS = { industry_outreach_focused: "Industry Outreach" };
const DEPS = { TRACKS, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource };

const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  // eslint-disable-next-line no-console
  console.warn(`[differential] SKIPPED: ${cluster.reason}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stripJob = (j) => {
  if (!j) return j;
  const { folderPath, jobFile, jobFileName, mtime, files, ...rest } = j;
  return rest;
};

suite("FileStore vs PgStore differential", () => {
  let fileStore;
  let pgStore;
  let roots;

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-diff-file-"));
    const jobsDir = path.join(root, "Jobs");
    const docsDir = path.join(root, "docs");
    const dataDir = path.join(root, "data");
    for (const d of [jobsDir, docsDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    roots = { root, jobsDir, docsDir, dataDir };
    fileStore = new FileStore({ jobsDir, docsDir, dataDir, deps: DEPS });
    fileStore.init();

    const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-diff-blob-"));
    pgStore = new PgStore({ url: cluster.url, docsDir, blobDir, deps: DEPS });
  });

  afterAll(async () => {
    if (pgStore) pgStore.close();
    if (cluster.available) await cluster.stop();
    try {
      if (roots) fs.rmSync(roots.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("tasks: same board round-trips to equivalent objects", () => {
    const board = {
      columns: ["backlog", "todo", "in_progress", "done"],
      tasks: [
        { id: "t-1", title: "Alpha", status: "todo", priority: "high", labels: ["a", "b"], estimate: 3 },
        { id: "t-2", title: "Beta", status: "done", created: "2026-07-01", completed: "2026-07-10", comments: [{ author: "cto", body: "ship" }] },
      ],
    };
    fileStore.saveTasks(board);
    pgStore.saveTasks(board);
    expect(pgStore.loadTasks()).toEqual(fileStore.loadTasks());
  });

  it("requests: verbatim text + spawned coercion agree", () => {
    const data = {
      requests: [
        { id: "r-1", text: 'ship it: fast # now "q"\nline2', source: "session", created: "2026-07-16", ts: "2026-07-16T00:00:00.000Z", spawned: { tasks: ["T-1 ", "t-1", "b@d!"], projects: [] } },
      ],
    };
    fileStore.saveRequests(data);
    pgStore.saveRequests(data);
    expect(pgStore.loadRequests()).toEqual(fileStore.loadRequests());
  });

  it("notify state + chats agree", () => {
    const state = { cursor: "2026-07-16T00:00:00.000Z", baseline: { tasks: { "t-1": "done" }, projects: ["p-1"] } };
    fileStore.saveNotifyState(state);
    pgStore.saveNotifyState(state);
    // updatedAt is stamped per store; loadNotifyState does not surface it.
    expect(pgStore.loadNotifyState()).toEqual(fileStore.loadNotifyState());

    const chats = { "Analyst - OCI": [{ role: "user", text: "hi" }, { role: "assistant", text: "hey" }] };
    fileStore.saveChats(chats);
    pgStore.saveChats(chats);
    expect(pgStore.loadChats()).toEqual(fileStore.loadChats());
  });

  it("discovery sources: normalized sources + version agree (updated stamp excluded)", () => {
    const data = {
      sources: [
        { id: "s1", name: "Board One", type: "board", sector: "private", active: "yes", urls: ["https://example.test"], cadence: "manual", instructions: "look", outputFields: ["title"], aliases: [], tracks: [], _extra: { futureKey: "keep" } },
      ],
    };
    fileStore.saveSources(data);
    pgStore.saveSources(data);
    const f = fileStore.loadSources();
    const p = pgStore.loadSources();
    expect(p.sources).toEqual(f.sources);
    expect(p.version).toEqual(f.version);
  });

  it("activity + telemetry streams agree (ts excluded from activity records)", () => {
    fileStore.appendActivity({ kind: "run", runId: "r1", status: "running" });
    fileStore.appendActivity({ kind: "run", runId: "r1", status: "done", exitCode: 0 });
    pgStore.appendActivity({ kind: "run", runId: "r1", status: "running" });
    pgStore.appendActivity({ kind: "run", runId: "r1", status: "done", exitCode: 0 });
    // Compare PARSED records, not raw JSONL text: jsonb canonicalizes key ORDER
    // (semantically irrelevant - every activity/telemetry consumer JSON.parses each
    // line), so the objects must match even when the serialized key order does not.
    const parseLines = (text, dropTs) =>
      text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => {
          const rec = JSON.parse(l);
          if (dropTs) {
            expect(typeof rec.ts).toBe("string");
            delete rec.ts;
          }
          return rec;
        });
    expect(parseLines(pgStore.readActivityText(), true)).toEqual(parseLines(fileStore.readActivityText(), true));

    const events = [
      { ts: "2026-07-16T00:00:00.000Z", sessionId: "s", kind: "view", surface: "insights", name: "open" },
      { ts: "2026-07-16T00:00:01.000Z", sessionId: "s", kind: "action", surface: "insights", name: "click" },
    ];
    fileStore.appendTelemetry(events);
    pgStore.appendTelemetry(events);
    expect(parseLines(pgStore.readTelemetryText(), false)).toEqual(parseLines(fileStore.readTelemetryText(), false));
  });

  it("jobs: create + artifact + gaps note derive equivalent DTOs (fs-only fields excluded)", async () => {
    const args = { role: "Analyst", employer: "OCI", track: "industry_outreach_focused", fit: "strong", status: "drafted", sector: "private" };
    const fj = fileStore.createJob({ ...args });
    const pj = pgStore.createJob({ ...args });
    expect(stripJob(pj)).toEqual(stripJob(fj));

    // Draft artifact then (ordered) the gaps answer, so gapsAnswered is a true,
    // deterministic transition in BOTH backends (file mtime and row updated_at both
    // advance with the wall clock).
    const cv = Buffer.from("%PDF-1.4 cv");
    fileStore.saveJobArtifact("Analyst - OCI", "Analyst CV.pdf", "application/pdf", cv);
    pgStore.saveJobArtifact("Analyst - OCI", "Analyst CV.pdf", "application/pdf", cv);
    await delay(25);
    fileStore.writeJobNote("Analyst - OCI", "gaps.md", "# Gaps\nanswered");
    pgStore.writeJobNote("Analyst - OCI", "gaps.md", "# Gaps\nanswered");

    const fd = fileStore.getJob("Analyst - OCI");
    const pd = pgStore.getJob("Analyst - OCI");
    // Full detail (minus fs-only fields): body, gaps content, derived flags incl.
    // hasCV / gapsAnswered / finalizeReady all compared.
    expect(stripJob(pd)).toEqual(stripJob(fd));
    expect(pd.gapsAnswered).toBe(true);
    expect(pd.finalizeReady).toBe(true);
    expect(pd.hasCV).toBe(true);
  });
});
