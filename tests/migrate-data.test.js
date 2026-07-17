// RC-2 / SIM-86 P7 - REHEARSAL for the one-shot file -> Postgres data migration
// (ops/migrate-data.mjs), against the embedded-Postgres harness.
//
// Builds a small but non-trivial REAL-SHAPED FileStore fixture (jobs across
// statuses with hand-written frontmatter + bodies + notes + a binary artifact +
// a dated history copy + an Office-style lock file, tasks with an attachment
// blob, requests, sources, chats, activity, telemetry, notify state), runs the
// migration into an ephemeral Postgres, and asserts:
//   1. the import + Store-seam verification pass is GREEN,
//   2. the SOURCE tree is byte-for-byte untouched (read-only proof),
//   3. a re-run REFUSES the non-empty target (one-shot guard),
//   4. --verify-only re-verifies the migrated target,
//   5. the verifier CAN FAIL: mutating one pg row turns verification red,
//   6. a strict source anomaly (unparseable job .md) aborts before any DB work.
//
// Follows the differential suite's conventions (tests/pg-filestore-differential
// .test.js): self-provisions the cluster, SKIPS cleanly (describe.skip) when it
// cannot start - offline binary download or an elevated Windows token (see
// tests/helpers/README-pg.md for the de-elevated scheduled-task recipe).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import pg from "pg";
import { startCluster } from "./helpers/embedded-pg.mjs";

process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-data-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;

const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const { FileStore } = await import("../server/store.js");
const { migrateData } = await import("../ops/migrate-data.mjs");

const STATUSES = ["lead", "queued", "drafted", "ready", "submitted", "interview", "offer", "rejected", "closed"];
const TRACKS = { operations_leadership_focused: "Operations Leadership", b2b_gtm_focused: "B2B GTM" };
const DEPS = { TRACKS, STATUSES, dropInvalidJobEnums, normalizeSource, serializeSource };

const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  // eslint-disable-next-line no-console
  console.warn(`[migrate-data rehearsal] SKIPPED: ${cluster.reason}`);
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Recursive { relPath -> { sha256, mtimeMs } } snapshot: the read-only proof.
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(root, p)] = { sha256: sha256(fs.readFileSync(p)), mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root);
  return out;
}

// Deterministic fixture mtimes (the mtime ORDER drives gapsAnswered /
// prepFeedbackAnswered on both backends - file mtime vs migrated updated_at).
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00Z
const MIN = 60000;

suite("migrate-data rehearsal (file -> embedded Postgres)", () => {
  let root, jobsDir, dataDir, docsDir, opts, sourceSnapshot;
  const logs = [];
  const log = (m) => logs.push(m);

  const JOB1 = "Operations Analyst - Northwind Analytics";
  const JOB2 = "GTM Program Manager - Kestrel Aerospace";
  const JOB3 = "Logistics Planner - Ironwood Logistics";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-data-src-"));
    jobsDir = path.join(root, "Jobs");
    dataDir = path.join(root, "data");
    docsDir = path.join(root, "docs");
    for (const d of [jobsDir, dataDir, docsDir]) fs.mkdirSync(d, { recursive: true });

    const touch = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));
    const put = (dir, name, content, ms) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      touch(p, ms);
      return p;
    };

    // ---- JOB1: drafted, LF, full artifact spread + dated copy + lock file ----
    const j1 = path.join(jobsDir, JOB1);
    fs.mkdirSync(j1);
    put(
      j1,
      "Operations Analyst.md",
      [
        "---",
        "type: job",
        "role: Operations Analyst",
        "employer: Northwind Analytics",
        "track: operations_leadership_focused",
        "fit: strong",
        "status: drafted",
        "sector: private",
        "tailoring: light",
        "deadline: 2099-11-30",
        "link: https://example.test/postings/1",
        "source: demo-board",
        "legacy_note: kept from the old vault schema", // unmodeled key -> raw_frontmatter fidelity
        "tags: [job, priority]",
        "---",
        "",
        "# Operations Analyst - Northwind Analytics",
        "",
        "**Lead with:** fictional ops wins",
        "",
        "## Notes",
        "",
        "Fictional rehearsal body.",
        "",
      ].join("\n"),
      T0,
    );
    // Binary artifact with non-UTF8 bytes (a real .docx is a zip - arbitrary bytes).
    put(j1, "Ada Vale - CV - Operations Analyst.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x9c, 0x01]), T0 + 10 * MIN);
    put(j1, "Ada Vale - Cover Letter - Northwind.pdf", Buffer.from("%PDF-1.4 fictional cover\n"), T0 + 11 * MIN);
    // Dated regenerate-history copy (must migrate but stay excluded from readiness).
    put(j1, "Ada Vale - CV - Operations Analyst (2026-05-20).docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), T0 + 5 * MIN);
    // Office-style lock file (a real-vault resident; migrated verbatim).
    put(j1, "~$a Vale - CV - Operations Analyst.docx", Buffer.from([0x00, 0x01, 0x02]), T0 + 12 * MIN);
    put(j1, "job-description.md", "# Posting\n\nFictional JD text.\n", T0 + 2 * MIN);
    // gaps ANSWERED: newer than the CV -> gapsAnswered + finalizeReady on drafted.
    put(j1, "gaps.md", "# Gaps\n\n- Q: sample gap?\n- A: answered.\n", T0 + 20 * MIN);

    // ---- JOB2: interview, BOM + CRLF, prep docs + feedback + submitted ----
    const j2 = path.join(jobsDir, JOB2);
    fs.mkdirSync(j2);
    const j2md =
      "---\r\ntype: job\r\nrole: GTM Program Manager\r\nemployer: Kestrel Aerospace\r\n" +
      "track: b2b_gtm_focused\r\nfit: moderate\r\nstatus: interview\r\nsector: private\r\n" +
      'tailoring: heavy\r\ndeadline: 1-yr contract\r\napplied: 2026-05-10\r\n' +
      'next_action: "prep: panel round"\r\nnext_action_date: 2026-06-05\r\n' +
      'link: "https://example.test/postings/2?ref=a&b=c"\r\ntags: [job]\r\n---\r\n' +
      "\r\n# GTM Program Manager - Kestrel Aerospace\r\n\r\n**Lead with:** fictional GTM story\r\n";
    const p2 = path.join(j2, "GTM Program Manager.md");
    fs.writeFileSync(p2, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(j2md, "utf8")]));
    touch(p2, T0);
    put(j2, "Interview Prep.md", "---\ntype: prep\n---\n\n# Prep\n\nUse Story A.\n", T0 + 10 * MIN);
    put(j2, "STAR Stories.md", "## Story A - fictional win\n\nSituation...\n", T0 + 11 * MIN);
    // feedback newer than every prep doc -> prepFeedbackAnswered + prepRefineReady.
    put(j2, "feedback.md", "# Feedback\n\nAnswered the prep questions.\n", T0 + 30 * MIN);
    put(j2, "application-content.json", JSON.stringify({ cv: "fictional", cover: "fictional" }), T0 + 3 * MIN);
    put(j2, "recruiter-email.txt", "Fictional recruiter note.\n", T0 + 4 * MIN);

    // ---- JOB3: minimal lead ----
    const j3 = path.join(jobsDir, JOB3);
    fs.mkdirSync(j3);
    put(
      j3,
      "Logistics Planner.md",
      "---\ntype: job\nrole: Logistics Planner\nemployer: Ironwood Logistics\ntrack: \nfit: moderate\nstatus: lead\nsector: private\ntailoring: light\ntags: [job]\n---\n\n# Logistics Planner - Ironwood Logistics\n\n**Lead with:** \n\n## Notes\n",
      T0,
    );

    // ---- task board + one attachment blob ----
    const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33]);
    const blobFile = `${sha256(blob)}.png`;
    const tasks = {
      columns: ["backlog", "todo", "in_progress", "done"],
      tasks: [
        { id: "t-1", title: "Review a lead", status: "todo", priority: "high", labels: ["review"], created: "2026-05-20" },
        {
          id: "t-2",
          title: "Prep the Kestrel interview",
          status: "in_progress",
          priority: "medium",
          comments: [{ author: "cto", body: "use the STAR bank", ts: "2026-05-28T10:00:00.000Z" }],
          attachments: [{ file: blobFile, name: "screenshot.png", mime: "image/png", bytes: blob.length, ts: "2026-05-28T11:00:00.000Z" }],
        },
        { id: "t-3", title: "Tune a source", status: "done", created: "2026-05-01", completed: "2026-05-15" },
      ],
    };
    put(dataDir, "tasks.yaml", "# Task board (app-managed).\n" + yaml.dump(tasks, { lineWidth: 100 }), T0);
    const attDir = path.join(dataDir, "attachments", "t-2");
    fs.mkdirSync(attDir, { recursive: true });
    put(attDir, blobFile, blob, T0 + MIN);

    // ---- intake ledger (verbatim multi-line text) ----
    put(
      dataDir,
      "requests.yaml",
      yaml.dump({
        requests: [
          {
            id: "r-1",
            text: 'ship it: fast # not a comment "quoted"\nsecond line',
            source: "chatbot",
            created: "2026-05-25",
            ts: "2026-05-25T09:00:00.000Z",
            assessment: "spawned one task",
            spawned: { tasks: ["T-1 ", "t-1"], projects: [] },
          },
        ],
      }),
      T0,
    );

    // ---- discovery sources (runs + version-skew cargo + header stamps) ----
    put(
      docsDir,
      "discovery-sources.yaml",
      yaml.dump({
        version: 1,
        updated: "2026-05-30",
        sources: [
          {
            id: "board-one",
            name: "Board One",
            type: "board",
            sector: "municipal",
            active: "yes",
            urls: ["https://example.test/board"],
            cadence: "weekly",
            instructions: "fictional",
            outputFields: ["title", "employer"],
            aliases: ["B1"],
            tracks: [],
            runs: [{ startedAt: "2026-05-29T08:00:00.000Z", outcome: "succeeded", trigger: "manual", leadsFound: 3, leadsNew: 1 }],
            futureKey: "version-skew cargo must survive",
          },
        ],
      }),
      T0,
    );

    // ---- chats / activity / telemetry / notify state ----
    put(dataDir, "job-chats.json", JSON.stringify({ [JOB1]: [{ role: "user", text: "hi" }, { role: "assistant", text: "hey" }] }, null, 2) + "\n", T0);
    put(
      dataDir,
      "activity-log.jsonl",
      [
        { ts: "2026-05-26T10:00:00.000Z", kind: "run", runId: "r-a1", routine: "first-draft-job", jobId: JOB1, status: "running" },
        { ts: "2026-05-26T10:02:00.000Z", kind: "run", runId: "r-a1", routine: "first-draft-job", jobId: JOB1, status: "done", exitCode: 0 },
        { ts: "2026-05-27T09:00:00.000Z", kind: "task", taskId: "t-2", action: "comment" },
        { ts: "2026-05-28T09:00:00.000Z", kind: "run", runId: "r-a2", routine: "interview-prep", jobId: JOB2, status: "running" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      T0,
    );
    put(
      dataDir,
      "usage-telemetry.jsonl",
      [
        { ts: "2026-05-26T10:00:00.000Z", sessionId: "s1", kind: "view", surface: "insights", name: "open" },
        { ts: "2026-05-26T10:00:05.000Z", sessionId: "s1", kind: "action", surface: "kanban", name: "drag" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      T0,
    );
    put(
      dataDir,
      "notify-state.json",
      JSON.stringify({ version: 1, cursor: "2026-05-28T00:00:00.000Z", baseline: { tasks: { "t-1": "todo" }, projects: ["p-1"] }, updatedAt: "2026-05-28T00:00:00.000Z" }, null, 2) + "\n",
      T0,
    );

    opts = { jobsDir, dataDir, docsDir, databaseUrl: cluster.url, verifyOnly: false, forceEmptyCheckBypass: false };
    sourceSnapshot = snapshotTree(root);

    // Fixture sanity: the mtime-ordered readiness really is exercised on the file
    // side (so the deep-equal verify below proves the pg side derives it too).
    const fileStore = new FileStore({ jobsDir, docsDir, dataDir, deps: DEPS });
    const d1 = fileStore.getJob(JOB1);
    expect(d1.hasCV).toBe(true);
    expect(d1.gapsAnswered).toBe(true);
    expect(d1.finalizeReady).toBe(true);
    const d2 = fileStore.getJob(JOB2);
    expect(d2.interviewPrepDone).toBe(true);
    expect(d2.prepFeedbackAnswered).toBe(true);
    expect(d2.prepRefineReady).toBe(true);
    expect(d2.hasSubmitted).toBe(true);
  });

  afterAll(async () => {
    if (cluster.available) await cluster.stop();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("one-shot import + Store-seam verification is green, and the source tree is untouched", async () => {
    const res = await migrateData(opts, log);
    expect(res.ok).toBe(true);
    expect(res.rows.every((r) => r.ok)).toBe(true);
    // Every domain actually carried data (a green pass over empty domains proves nothing).
    const byDomain = Object.fromEntries(res.rows.map((r) => [r.domain, r]));
    expect(byDomain["jobs (DTO + detail)"].fileCount).toBe(3);
    expect(byDomain["job files (sha256)"].fileCount).toBe(11); // 6 + 5 companions
    expect(byDomain["job files (sha256)"].pgCount).toBe(11);
    expect(byDomain["tasks"].fileCount).toBe(3);
    expect(byDomain["task attachments (sha256)"].fileCount).toBe(1);
    expect(byDomain["requests"].fileCount).toBe(1);
    expect(byDomain["discovery sources"].fileCount).toBe(1);
    expect(byDomain["job chats"].fileCount).toBe(1);
    expect(byDomain["activity log (per line)"].fileCount).toBe(4);
    expect(byDomain["telemetry (per line)"].fileCount).toBe(2);
    expect(byDomain["notify state"].fileCount).toBe(1);
    // READ-ONLY proof: not a byte (or mtime) changed anywhere under the source root.
    expect(snapshotTree(root)).toEqual(sourceSnapshot);
  }, 120000);

  it("refuses a non-empty target without --force-empty-check-bypass (one-shot guard)", async () => {
    await expect(migrateData(opts, log)).rejects.toThrow(/not empty/i);
  }, 60000);

  it("--verify-only re-verifies the migrated target without importing", async () => {
    const res = await migrateData({ ...opts, verifyOnly: true }, log);
    expect(res.ok).toBe(true);
    expect(res.rows.every((r) => r.ok)).toBe(true);
  }, 60000);

  it("the verifier can FAIL: mutating one pg row turns verification red", async () => {
    const client = new pg.Client({ connectionString: cluster.url });
    await client.connect();
    try {
      const r = await client.query("update jobs set fit='stretch' where id=$1", [JOB3]);
      expect(r.rowCount).toBe(1);
    } finally {
      await client.end();
    }
    await expect(migrateData({ ...opts, verifyOnly: true }, log)).rejects.toThrow(/verification FAILED/);
  }, 60000);

  it("aborts strictly on an unparseable job .md, before touching the target", async () => {
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-data-bad-"));
    const badJobs = path.join(badRoot, "Jobs");
    const badData = path.join(badRoot, "data");
    const badDocs = path.join(badRoot, "docs");
    const badFolder = path.join(badJobs, "Broken - Employer");
    fs.mkdirSync(badFolder, { recursive: true });
    fs.mkdirSync(badData, { recursive: true });
    fs.mkdirSync(badDocs, { recursive: true });
    fs.writeFileSync(path.join(badFolder, "Broken.md"), "---\ntype: job\nrole: [unclosed\n---\nbody\n");
    try {
      await expect(
        migrateData({ ...opts, jobsDir: badJobs, dataDir: badData, docsDir: badDocs }, log),
      ).rejects.toThrow(/unparseable/);
    } finally {
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  }, 60000);
});
