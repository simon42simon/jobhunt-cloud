// SIM-393 I5 - the laptop-side export snapshot client (ops/export-snapshot.mjs).
//
// The load-bearing guarantees under test:
//   - GC-1 (HIGH): every cloud-supplied name (job folder id, file name,
//     attachment task id + file, any id used in a path) passes the SHARED
//     server/name-safety.js rules + resolveInside-the-snapshot-root containment
//     BEFORE any write - the hostile-name fixtures prove the write is REFUSED
//     (no file, no directory, no partial path anywhere) and that a refused
//     item also withholds the VERIFIED marker (an incomplete snapshot is never
//     certified). Client-side: these fixtures drive a hostile MANIFEST, i.e.
//     exactly the compromised-cloud case server-side validation cannot cover.
//   - VERIFIED is written ONLY after the verification pass (re-fetch + exact
//     match against re-read disk bytes): byte tamper, mid-run domain drift,
//     refused names, and integrity conflicts all leave the snapshot UNVERIFIED.
//   - Unique snapshot dirs: same-second runs land in distinct directories.
//   - GC-7: --prune REFUSES without owner-set retention.keep; with it, the
//     newest `keep` VERIFIED snapshots (always including the newest) survive
//     and UNVERIFIED snapshots are never auto-deleted.
//   - The GC-2 run report posts one line per run (verified flag included).
//
// The api object is faked in-memory (same technique as mirror-client.test.js):
// runExportSnapshot takes { api } by injection, so no socket is involved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { sha256Hex, rowShaOf } from "../server/sync-lib.js";
import { reconstructJobFileText } from "../ops/mirror-vault.mjs";
import {
  runExportSnapshot,
  runPrune,
  createSnapshotDir,
  writeSnapshotEntry,
  snapshotBaseDir,
  utcStamp,
  createExportApi,
} from "../ops/export-snapshot.mjs";

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "export-client-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// ---- an in-memory cloud the fake api serves --------------------------------
function makeCloud() {
  const front = { type: "job", role: "Analyst", employer: "OCI", status: "queued", tags: ["job"] };
  const body = "# Analyst - OCI\n\nbody text";
  const cv = Buffer.from("%PDF-1.4 exported cv bytes");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
  return {
    jobs: { "Analyst - OCI": { name: "Analyst.md", front, body } },
    files: { "Analyst - OCI/CV - Analyst.pdf": cv },
    tasks: { columns: ["backlog", "todo"], tasks: [{ id: "t-1", title: "One", status: "todo", attachments: [{ file: "abc.png", name: "shot.png", mime: "image/png", bytes: png.length }] }] },
    attachments: { "t-1/abc.png": png },
    requests: { requests: [{ id: "r-1", text: "verbatim ask" }] },
    sources: { version: 1, updated: null, sources: [] },
    chats: { "Analyst - OCI": [{ role: "user", text: "hi" }] },
    notify: { cursor: null, baseline: { tasks: {}, projects: [] }, initialized: false },
    activity: '{"ts":"2026-07-18T00:00:00Z","kind":"run"}\n',
    telemetry: "",
    meta: { app: "jobhunt-cloud", version: "0.38.1", appMode: "real", storeBackend: "pg", ts: "2026-07-18T00:00:00Z" },
  };
}

function makeApi(cloud, { tamper = {} } = {}) {
  const calls = { runs: [] };
  const manifest = () => ({
    jobs: Object.entries(cloud.jobs).map(([id, j]) => ({ id, rowSha: rowShaOf(j.front, j.body) })),
    files: Object.entries(cloud.files).map(([key, buf]) => {
      // split on the FIRST "/" only, so a traversal-shaped fixture name like
      // "../escape.md" survives into the manifest verbatim
      const idx = key.indexOf("/");
      return { jobId: key.slice(0, idx), name: key.slice(idx + 1), sha256: sha256Hex(buf), bytesLen: buf.length };
    }),
  });
  const api = {
    calls,
    async getJson(p) {
      if (p === "/api/export/meta") return cloud.meta;
      if (p === "/api/export/manifest") return tamper.manifest ? tamper.manifest() : manifest();
      if (p.startsWith("/api/export/jobs/")) {
        const id = decodeURIComponent(p.slice("/api/export/jobs/".length));
        const j = cloud.jobs[id];
        if (!j) throw new Error(`404 ${p}`);
        return { id, name: j.name, front: j.front, body: j.body, rowSha: rowShaOf(j.front, j.body) };
      }
      if (p === "/api/export/tasks") return cloud.tasks;
      if (p === "/api/export/requests") return cloud.requests;
      if (p === "/api/export/sources") return cloud.sources;
      if (p === "/api/export/chats") return cloud.chats;
      if (p === "/api/export/notify-state") return cloud.notify;
      throw new Error(`unexpected getJson ${p}`);
    },
    async getBytes(p) {
      const fileM = p.match(/^\/api\/export\/jobs\/([^/]+)\/files\/([^/]+)$/);
      if (fileM) {
        const key = `${decodeURIComponent(fileM[1])}/${decodeURIComponent(fileM[2])}`;
        const buf = cloud.files[key];
        if (!buf) throw new Error(`404 ${p}`);
        return tamper.fileBytes ? tamper.fileBytes(key, buf) : buf;
      }
      const attM = p.match(/^\/api\/export\/attachments\/([^/]+)\/([^/]+)$/);
      if (attM) {
        const key = `${decodeURIComponent(attM[1])}/${decodeURIComponent(attM[2])}`;
        const buf = cloud.attachments[key];
        if (!buf) throw new Error(`404 ${p}`);
        return buf;
      }
      throw new Error(`unexpected getBytes ${p}`);
    },
    async getText(p) {
      if (p === "/api/export/activity") return cloud.activity;
      if (p === "/api/export/telemetry") return cloud.telemetry;
      throw new Error(`unexpected getText ${p}`);
    },
    async postJson(p, bodyObj) {
      if (p === "/api/export/runs") {
        calls.runs.push(bodyObj);
        return { ok: true };
      }
      throw new Error(`unexpected postJson ${p}`);
    },
  };
  return api;
}

const snapRoot = () => {
  const dir = path.join(tmpRoot, "snap");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Every path that exists under root, relative, forward-slashed.
function walk(root, base = root) {
  const out = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const abs = path.join(base, e.name);
    if (e.isDirectory()) out.push(...walk(root, abs));
    else out.push(path.relative(root, abs).replace(/\\/g, "/"));
  }
  return out;
}

describe("runExportSnapshot (happy path)", () => {
  it("writes the full FileStore layout + manifest, verifies, and ONLY then writes VERIFIED", async () => {
    const cloud = makeCloud();
    const api = makeApi(cloud);
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });

    expect(summary.verified).toBe(true);
    expect(summary.refused).toBe(0);
    expect(summary.conflicts).toEqual([]);

    const rels = walk(root);
    expect(rels).toContain("Jobs/Analyst - OCI/Analyst.md");
    expect(rels).toContain("Jobs/Analyst - OCI/CV - Analyst.pdf");
    expect(rels).toContain("tasks.yaml");
    expect(rels).toContain("requests.yaml");
    expect(rels).toContain("discovery-sources.yaml");
    expect(rels).toContain("job-chats.json");
    expect(rels).toContain("notify-state.json");
    expect(rels).toContain("activity-log.jsonl");
    expect(rels).toContain("usage-telemetry.jsonl");
    expect(rels).toContain("attachments/t-1/abc.png");
    expect(rels).toContain("snapshot-manifest.json");
    expect(rels).toContain("VERIFIED");

    // <Role>.md is the byte-faithful reconstruction, matching the manifest rowSha
    const jobText = fs.readFileSync(path.join(root, "Jobs", "Analyst - OCI", "Analyst.md"), "utf8");
    expect(jobText).toBe(reconstructJobFileText(cloud.jobs["Analyst - OCI"].front, cloud.jobs["Analyst - OCI"].body));

    // snapshot-manifest carries per-file sha256 + counts + the app version
    const man = JSON.parse(fs.readFileSync(path.join(root, "snapshot-manifest.json"), "utf8"));
    expect(man.app.version).toBe("0.38.1");
    expect(man.counts).toMatchObject({ jobs: 1, files: 1, attachments: 1, tasks: 1, requests: 1 });
    expect(man.files["Jobs/Analyst - OCI/CV - Analyst.pdf"]).toBe(sha256Hex(cloud.files["Analyst - OCI/CV - Analyst.pdf"]));
    // every recorded sha re-verifies against the disk bytes
    for (const [rel, sha] of Object.entries(man.files)) {
      expect(sha256Hex(fs.readFileSync(path.join(root, ...rel.split("/"))))).toBe(sha);
    }
    // tasks.yaml round-trips to the cloud payload
    expect(yaml.load(fs.readFileSync(path.join(root, "tasks.yaml"), "utf8"))).toEqual(cloud.tasks);

    // GC-2: exactly one run report, verified:true
    expect(api.calls.runs).toHaveLength(1);
    expect(api.calls.runs[0].verified).toBe(true);
    expect(api.calls.runs[0].clientVersion).toBe("export-snapshot/1");
  });
});

describe("GC-1 (HIGH): hostile cloud-supplied names are refused CLIENT-SIDE, before any write", () => {
  it("a hostile JOB ID in the manifest produces NO write and NO VERIFIED marker", async () => {
    const cloud = makeCloud();
    cloud.jobs["..\\..\\evil"] = { name: "Evil.md", front: { role: "X" }, body: "evil" };
    const api = makeApi(cloud);
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });

    expect(summary.refused).toBeGreaterThan(0);
    expect(summary.verified).toBe(false); // an incomplete snapshot is never certified
    const rels = walk(root);
    expect(rels.some((r) => r.toLowerCase().includes("evil"))).toBe(false); // nothing landed
    expect(rels).not.toContain("VERIFIED");
    // and nothing escaped ABOVE the snapshot root either
    expect(fs.readdirSync(tmpRoot).sort()).toEqual(["snap"]);
  });

  it("hostile FILE names (traversal, absolute, reserved device, control char, dot-alias) all refuse", async () => {
    const cloud = makeCloud();
    const hostiles = ["../escape.md", "/abs.md", "C:\\abs.md", "NUL.txt", "bad\x07.md", "alias.md.", "a\\b.md"];
    for (const name of hostiles) cloud.files[`Analyst - OCI/${name}`] = Buffer.from("poison");
    const api = makeApi(cloud);
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });

    expect(summary.refused).toBeGreaterThanOrEqual(hostiles.length);
    expect(summary.verified).toBe(false);
    const rels = walk(root);
    for (const bad of ["escape.md", "abs.md", "NUL.txt", "alias.md"]) {
      expect(rels.some((r) => r.endsWith(bad)), bad).toBe(false);
    }
    // the legitimate content still landed (refusal is per-item, not per-run)
    expect(rels).toContain("Jobs/Analyst - OCI/CV - Analyst.pdf");
  });

  it("a hostile ATTACHMENT task id / file name refuses without touching the filesystem", async () => {
    const cloud = makeCloud();
    cloud.tasks.tasks.push({ id: "../../t-evil", title: "X", status: "todo", attachments: [{ file: "abc.png" }] });
    cloud.tasks.tasks.push({ id: "t-2", title: "Y", status: "todo", attachments: [{ file: "..\\..\\boom.png" }] });
    cloud.attachments["../../t-evil/abc.png"] = Buffer.from("p");
    cloud.attachments["..\\..\\boom.png"] = Buffer.from("p");
    const api = makeApi(cloud);
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });
    expect(summary.refused).toBeGreaterThanOrEqual(2);
    expect(summary.verified).toBe(false);
    expect(walk(root).some((r) => r.includes("t-evil") || r.includes("boom"))).toBe(false);
    expect(fs.readdirSync(tmpRoot).sort()).toEqual(["snap"]); // nothing above the root
  });

  it("writeSnapshotEntry itself throws BEFORE any fs access on an unsafe segment", () => {
    const root = snapRoot();
    for (const seg of ["..", "../x", "a/b", "NUL", "x.txt ", ""]) {
      expect(() => writeSnapshotEntry({ root, segments: [seg], bytes: Buffer.from("x") }), seg).toThrow();
    }
    expect(walk(root)).toEqual([]); // zero writes, zero partial paths
  });
});

describe("VERIFIED is withheld on any integrity failure", () => {
  it("byte tamper (pulled bytes do not hash to the manifest sha) -> conflict, no VERIFIED", async () => {
    const cloud = makeCloud();
    const api = makeApi(cloud, { tamper: { fileBytes: () => Buffer.from("TAMPERED BYTES") } });
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });
    expect(summary.conflicts.some((c) => c.startsWith("file-sha-mismatch"))).toBe(true);
    expect(summary.verified).toBe(false);
    expect(walk(root)).not.toContain("VERIFIED");
    // the tampered bytes were never written
    expect(walk(root)).not.toContain("Jobs/Analyst - OCI/CV - Analyst.pdf");
  });

  it("mid-run manifest drift (a job appears during the pull) -> no VERIFIED", async () => {
    const cloud = makeCloud();
    let calls = 0;
    const realManifest = () => makeApi(cloud).getJson("/api/export/manifest");
    const api = makeApi(cloud, {
      tamper: {
        manifest: () => {
          calls += 1;
          if (calls === 1) return makeApi(cloud).getJson("/api/export/manifest");
          // the verification re-fetch sees an extra job
          return realManifest().then((m) => ({ ...m, jobs: [...m.jobs, { id: "New - Job", rowSha: "0".repeat(64) }] }));
        },
      },
    });
    const root = snapRoot();
    const summary = await runExportSnapshot({ api, snapshotRoot: root });
    expect(summary.verified).toBe(false);
    expect(walk(root)).not.toContain("VERIFIED");
    // the run report still fired, with verified:false (owner-visible)
    expect(api.calls.runs[0].verified).toBe(false);
  });
});

describe("snapshot directories", () => {
  it("same-second runs land in DISTINCT directories (exclusive create, -2/-3 suffixes)", () => {
    const base = path.join(tmpRoot, "cloud-snapshots");
    const now = new Date("2026-07-18T05:06:07Z");
    const a = createSnapshotDir(base, now);
    const b = createSnapshotDir(base, now);
    const c = createSnapshotDir(base, now);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(path.basename(a)).toBe(utcStamp(now));
    expect(path.basename(b)).toBe(`${utcStamp(now)}-2`);
    expect(path.basename(c)).toBe(`${utcStamp(now)}-3`);
  });

  it("snapshotBaseDir derives %SSC_ROOT%\\data\\jobhunt\\cloud-snapshots, with the env override winning", () => {
    const sscRoot = path.join(tmpRoot, "ssc-brain");
    expect(snapshotBaseDir({ SSC_ROOT: sscRoot })).toBe(path.join(sscRoot, "data", "jobhunt", "cloud-snapshots"));
    const override = path.join(tmpRoot, "elsewhere");
    expect(snapshotBaseDir({ JOBHUNT_SNAPSHOT_DIR: override, SSC_ROOT: sscRoot })).toBe(override);
  });
});

describe("GC-7: prune stays cold", () => {
  const mkSnap = (base, name, verified) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshot-manifest.json"), "{}");
    if (verified) fs.writeFileSync(path.join(dir, "VERIFIED"), "{}");
    return dir;
  };

  it("REFUSES to run unless owner-set retention.keep exists in config", () => {
    const base = path.join(tmpRoot, "snaps");
    mkSnap(base, "20260716-000000", true);
    for (const config of [{}, { retention: {} }, { retention: { keep: 0 } }, { retention: { keep: "3" } }, { retention: { keep: -1 } }, null]) {
      expect(() => runPrune({ baseDir: base, config })).toThrow(/REFUSED: retention\.keep is not set/);
    }
    expect(fs.existsSync(path.join(base, "20260716-000000"))).toBe(true); // nothing deleted on refusal
  });

  it("with retention.keep set: keeps the newest `keep` VERIFIED (always incl. the newest), never touches UNVERIFIED", () => {
    const base = path.join(tmpRoot, "snaps");
    mkSnap(base, "20260714-000000", true); // oldest VERIFIED -> pruned
    mkSnap(base, "20260715-000000", true); // middle VERIFIED  -> pruned at keep=1
    mkSnap(base, "20260716-000000", false); // UNVERIFIED       -> untouched, never auto-deleted
    mkSnap(base, "20260717-000000", true); // newest VERIFIED  -> ALWAYS protected
    const r = runPrune({ baseDir: base, config: { retention: { keep: 1 } } });
    expect(r.kept).toEqual(["20260717-000000"]);
    expect(r.deleted.sort()).toEqual(["20260714-000000", "20260715-000000"]);
    expect(r.unverified).toEqual(["20260716-000000"]);
    expect(fs.existsSync(path.join(base, "20260717-000000", "VERIFIED"))).toBe(true);
    expect(fs.existsSync(path.join(base, "20260716-000000"))).toBe(true);
    expect(fs.existsSync(path.join(base, "20260714-000000"))).toBe(false);
  });

  it("keep larger than the VERIFIED set deletes nothing", () => {
    const base = path.join(tmpRoot, "snaps");
    mkSnap(base, "20260716-000000", true);
    mkSnap(base, "20260717-000000", true);
    const r = runPrune({ baseDir: base, config: { retention: { keep: 14 } } });
    expect(r.deleted).toEqual([]);
    expect(r.kept).toEqual(["20260717-000000", "20260716-000000"]);
  });
});

describe("createExportApi (GC-6 posture, reused from the mirror client)", () => {
  it("refuses http, TLS bypass, and redirects; pins the host; adds the text reader", async () => {
    expect(() => createExportApi({ token: "t", cloudUrl: "http://insecure.example" })).toThrow(/https/);
    expect(() =>
      createExportApi({ token: "t", cloudUrl: "https://ok.example", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }),
    ).toThrow(/TLS/);
    const fetchImpl = async (url) => ({ status: 302, ok: false, headers: {}, async arrayBuffer() {} });
    const api = createExportApi({ token: "t", cloudUrl: "https://ok.example", fetchImpl, env: {} });
    expect(api.host).toBe("ok.example");
    await expect(api.getJson("/api/export/meta")).rejects.toThrow(/redirect/);
    expect(typeof api.getText).toBe("function");
  });
});
