// SIM-393 I6 - the laptop-side mirror client (ops/mirror-vault.mjs): V2-3 write
// semantics + the GC-8/GC-1/GC-13 guardian conditions, exercised against fixture
// vaults with a fake pinned-host API (no socket, no real vault, no secrets).
//
//   - three-way sha check (only overwrite bytes the mirror itself wrote)
//   - NO delete path: grep-level AND behavioral
//   - adoption pass (sha-equal adopt; differing bytes -> one-time transition report)
//   - GC-8: exclusive creates, case-insensitive collision safety (file AND folder
//     AND manifest-level double-spelling), cache-loss degradation to adoption
//   - GC-1 verbatim: hostile cloud-supplied names refused via the SHARED
//     server/name-safety.js before ANY write
//   - <Role>.md reconstruction byte-fidelity (round-trips through the app's own
//     frontmatter parser; rowSha matches the manifest)
//   - GC-13: state/log/lock paths all live under %LOCALAPPDATA%\ssc\
//   - >= 5s debounce batching

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  mirrorPaths,
  reconstructJobFileText,
  loadMirrorState,
  saveMirrorState,
  caseSiblings,
  findCaseCollisions,
  writeMirrorEntry,
  dismissReported,
  runMirrorPass,
  createDebouncer,
  createApi,
  acquireLock,
  MIRROR_CLIENT_VERSION,
  DEBOUNCE_MS,
} from "../ops/mirror-vault.mjs";
import { parseFrontmatter } from "../server/lib.js";
import { sha256Hex, rowShaOf } from "../server/sync-lib.js";

let tmpRoot, jobsRoot, statePath;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-client-"));
  jobsRoot = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });
  statePath = path.join(tmpRoot, "state", "jobhunt-mirror-state.json");
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

const mkSummary = () => ({ created: 0, updated: 0, adopted: 0, skipped: 0, refused: 0, conflicts: [] });
const freshState = () => ({ version: 1, entries: {}, reported: {}, rows: {}, vaultHash: {} });
const listVault = () => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(jobsRoot, "");
  return out.sort();
};

// A fake pinned-host API surface: manifest + job details + file bytes, and a
// record of every POSTed mirror-pass report.
function fakeApi({ manifest, details = {}, fileBytes = {}, posts = [] }) {
  return {
    posts,
    host: "pinned.example",
    async getJson(p) {
      if (p === "/api/sync/manifest") return JSON.parse(JSON.stringify(manifest));
      const m = p.match(/^\/api\/mirror\/jobs\/([^/?]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (details[id]) return JSON.parse(JSON.stringify(details[id]));
        throw new Error(`mirror: GET ${p} -> 404`);
      }
      throw new Error(`unexpected getJson ${p}`);
    },
    async getBytes(p) {
      const m = p.match(/^\/api\/mirror\/jobs\/([^/?]+)\/files\/([^/?]+)$/);
      if (m) {
        const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
        if (fileBytes[key] != null) return Buffer.from(fileBytes[key]);
      }
      throw new Error(`mirror: GET ${p} -> 404`);
    },
    async postJson(p, body) {
      posts.push({ p, body });
      return { ok: true };
    },
  };
}

const FRONT = () => ({ type: "job", role: "Analyst", employer: "Acme", status: "lead", tags: ["job"], deadline: "2026-08-01" });
const BODY = "# Analyst - Acme\n\nnotes body\n";
const jobDetail = (id = "Analyst - Acme") => ({ id, name: "Analyst.md", front: FRONT(), body: BODY, rowSha: rowShaOf(FRONT(), BODY) });
const manifestFor = (jobs = [], files = []) => ({ jobs, files });

// ---------------------------------------------------------------------------
describe("GC-13: no mirror artifact in the vault or any synced store", () => {
  it("state, log, and lock ALL resolve under %LOCALAPPDATA%\\ssc\\ (the one central path builder)", () => {
    const p = mirrorPaths({ LOCALAPPDATA: "C:\\Users\\simon\\AppData\\Local" });
    const base = path.join("C:\\Users\\simon\\AppData\\Local", "ssc");
    expect(p.dir).toBe(base);
    for (const k of ["state", "log", "lock"]) {
      expect(path.dirname(p[k])).toBe(base);
    }
    // never inside a vault / OneDrive / repo path by construction
    expect(p.state.toLowerCase()).not.toContain("onedrive");
  });
});

// ---------------------------------------------------------------------------
describe("<Role>.md reconstruction byte-fidelity", () => {
  it("emits EXACTLY the FileStore createJobIfAbsent serialization and round-trips through the app parser", () => {
    const text = reconstructJobFileText(FRONT(), BODY);
    // the exact serialization server/store.js createJobIfAbsent writes
    expect(text).toBe("---\n" + yaml.dump(FRONT()) + "---\n" + BODY);
    const parsed = parseFrontmatter(text); // the app's own reader -> { meta, body }
    expect(parsed.meta).toEqual(FRONT()); // front round-trips verbatim
    expect(parsed.body).toBe(BODY); // body byte-faithful
    expect(rowShaOf(parsed.meta, parsed.body)).toBe(rowShaOf(FRONT(), BODY)); // manifest rowSha holds
  });

  it("a full pass writes the reconstructed <Role>.md whose re-read rowSha equals the manifest rowSha", async () => {
    const d = jobDetail();
    const api = fakeApi({ manifest: manifestFor([{ id: d.id, rowSha: d.rowSha }]), details: { [d.id]: d } });
    const summary = await runMirrorPass({ api, jobsRoot, statePath });
    expect(summary.created).toBe(1);
    const raw = fs.readFileSync(path.join(jobsRoot, d.id, "Analyst.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(rowShaOf(parsed.meta, parsed.body)).toBe(d.rowSha);
  });
});

// ---------------------------------------------------------------------------
describe("GC-1 verbatim: hostile cloud-supplied names are refused before ANY write", () => {
  const HOSTILE = [
    "../evil.md",
    "..\\evil.md",
    "sub/evil.md",
    "sub\\evil.md",
    "C:\\evil.md",
    "/etc/passwd",
    "NUL",
    "nul.txt",
    "CONOUT$",
    "notes.md.", // trailing-dot aliasing
    "notes.md ", // trailing-space aliasing
    "badname.md", // control char
    "",
  ];

  it("refuses every hostile FILE name (vault stays untouched, nothing recorded)", () => {
    for (const name of HOSTILE) {
      const state = freshState();
      const summary = mkSummary();
      const r = writeMirrorEntry({ jobsRoot, jobId: "Analyst - Acme", name, bytes: Buffer.from("x"), state, summary });
      expect(r, name).toBe("refused-name");
      expect(summary.refused).toBe(1);
      expect(Object.keys(state.entries)).toHaveLength(0);
    }
    expect(listVault()).toEqual([]); // NOT ONE write happened
  });

  it("refuses every hostile JOB-FOLDER name", () => {
    for (const jobId of HOSTILE) {
      const summary = mkSummary();
      const r = writeMirrorEntry({ jobsRoot, jobId, name: "notes.md", bytes: Buffer.from("x"), state: freshState(), summary });
      expect(r, jobId).toBe("refused-name");
    }
    expect(listVault()).toEqual([]);
  });

  it("a hostile name arriving via the MANIFEST is refused without fetching or writing", async () => {
    const api = fakeApi({
      manifest: manifestFor(
        [], // no jobs
        [{ jobId: "Analyst - Acme", name: "../../escape.md", sha256: sha256Hex(Buffer.from("x")), bytesLen: 1 }],
      ),
    });
    const summary = await runMirrorPass({ api, jobsRoot, statePath });
    expect(summary.refused).toBe(1);
    expect(listVault()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("V2-3 three-way sha check (only overwrite bytes the mirror itself wrote)", () => {
  const jobId = "Analyst - Acme";
  const name = "notes.md";
  const target = () => path.join(jobsRoot, jobId, name);

  it("create -> update-own-bytes -> out-of-band edit is SKIPPED and preserved, never clobbered", () => {
    const state = freshState();
    let summary = mkSummary();
    // 1. exclusive create
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("v1"), state, summary })).toBe("created");
    expect(fs.readFileSync(target(), "utf8")).toBe("v1");
    // 2. cloud updates; current vault sha == last-mirrored sha -> the ONE sanctioned overwrite
    summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("v2"), state, summary })).toBe("updated");
    expect(fs.readFileSync(target(), "utf8")).toBe("v2");
    // 3. an out-of-band vault edit (violating mirror-only) then another cloud change:
    fs.writeFileSync(target(), "HAND EDIT - must survive");
    summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("v3"), state, summary })).toBe("skipped-divergent");
    expect(fs.readFileSync(target(), "utf8")).toBe("HAND EDIT - must survive"); // never clobbers work
    expect(summary.skipped).toBe(1);
    expect(summary.conflicts.some((c) => c.startsWith("divergent"))).toBe(true);
  });

  it("a stale .mirror-tmp refuses the sanctioned update: skip + report, nothing clobbered (L1)", () => {
    const state = freshState();
    let summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("v1"), state, summary })).toBe("created");
    // A crashed prior pass left its staged tmp behind; no delete path exists to
    // clean it, so the wx-exclusive stage must refuse instead of clobbering it.
    fs.writeFileSync(`${target()}.mirror-tmp`, "stale stage from a crashed pass");
    summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("v2"), state, summary })).toBe("skipped-update-refused");
    expect(fs.readFileSync(target(), "utf8")).toBe("v1"); // target untouched
    expect(fs.readFileSync(`${target()}.mirror-tmp`, "utf8")).toBe("stale stage from a crashed pass"); // tmp untouched
    expect(summary.skipped).toBe(1);
    expect(summary.conflicts.some((c) => c.startsWith("update-refused"))).toBe(true);
  });

  it("the divergence report is ONE-TIME (transition-report semantics); the skip itself continues", () => {
    const state = freshState();
    fs.mkdirSync(path.join(jobsRoot, jobId), { recursive: true });
    fs.writeFileSync(target(), "pre-existing agent work");
    const s1 = mkSummary();
    writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud"), state, summary: s1 });
    expect(s1.conflicts).toHaveLength(1); // loud the first time
    const s2 = mkSummary();
    writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud"), state, summary: s2 });
    expect(s2.skipped).toBe(1); // still skipped
    expect(s2.conflicts).toHaveLength(0); // but not re-reported
    expect(fs.readFileSync(target(), "utf8")).toBe("pre-existing agent work");
  });
});

// ---------------------------------------------------------------------------
describe("V2-3 owner dismissal of the transition report (resolution flow)", () => {
  const jobId = "Analyst - Acme";
  const name = "notes.md";
  const key = `${jobId}/${name}`;
  const target = () => path.join(jobsRoot, jobId, name);

  it("dismissal writes NOTHING to the vault, but lets the NEXT write overwrite with cloud bytes", () => {
    const state = freshState();
    // a pre-existing divergent vault file surfaces in the one-time report (skip)
    fs.mkdirSync(path.join(jobsRoot, jobId), { recursive: true });
    fs.writeFileSync(target(), "STALE pre-cutover copy");
    let summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud truth"), state, summary })).toBe("skipped-divergent");
    expect(state.reported[key]).toBeTruthy();
    expect(fs.readFileSync(target(), "utf8")).toBe("STALE pre-cutover copy");

    // DISMISS: writes nothing, only marks the path mirror-managed at its current bytes
    const res = dismissReported(state, jobsRoot);
    expect(res.dismissed).toEqual([key]);
    expect(state.reported[key]).toBeUndefined();
    expect(fs.readFileSync(target(), "utf8")).toBe("STALE pre-cutover copy"); // vault untouched by dismissal itself

    // the next pass now takes the ONE sanctioned overwrite (three-way check passes)
    summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud truth"), state, summary })).toBe("updated");
    expect(fs.readFileSync(target(), "utf8")).toBe("cloud truth");
    expect(summary.updated).toBe(1);
  });

  it("a still-divergent, UN-dismissed path is never overwritten (dismissal is per-report, opt-in)", () => {
    const state = freshState();
    fs.mkdirSync(path.join(jobsRoot, jobId), { recursive: true });
    fs.writeFileSync(target(), "keep me");
    writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud"), state, summary: mkSummary() });
    // dismiss ONLY some other key -> this one stays reported and protected
    dismissReported(state, jobsRoot, { only: new Set(["Other - Co/x.md"]) });
    expect(state.reported[key]).toBeTruthy();
    const summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("cloud"), state, summary })).toBe("skipped-divergent");
    expect(fs.readFileSync(target(), "utf8")).toBe("keep me");
  });

  it("a reported path that vanished from disk is left reported (not silently dismissed)", () => {
    const state = freshState();
    state.reported["Gone - Co/missing.md"] = "deadbeef";
    const res = dismissReported(state, jobsRoot);
    expect(res.missing).toEqual(["Gone - Co/missing.md"]);
    expect(res.dismissed).toEqual([]);
    expect(state.reported["Gone - Co/missing.md"]).toBe("deadbeef");
  });
});

// ---------------------------------------------------------------------------
describe("adoption pass (first run) + GC-8 cache-loss degradation", () => {
  const jobId = "Analyst - Acme";
  const name = "CV - Analyst.pdf";
  const target = () => path.join(jobsRoot, jobId, name);

  it("a pre-existing vault file with MATCHING sha is adopted: recorded, no write", () => {
    fs.mkdirSync(path.join(jobsRoot, jobId), { recursive: true });
    fs.writeFileSync(target(), "identical bytes");
    const before = fs.statSync(target()).mtimeMs;
    const state = freshState();
    const summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("identical bytes"), state, summary })).toBe("adopted");
    expect(summary.adopted).toBe(1);
    expect(state.entries[`${jobId}/${name}`]).toBe(sha256Hex(Buffer.from("identical bytes")));
    expect(fs.statSync(target()).mtimeMs).toBe(before); // adopt = zero write
  });

  it("GC-8: with the mirror-state cache LOST, an existing file is NEVER overwritten - degraded mode is adoption, not write-through", () => {
    // First life: the mirror creates the file and records it.
    const state1 = freshState();
    writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("mirrored v1"), state: state1, summary: mkSummary() });
    // Cache loss: a brand-new empty state (deleted / corrupt file both load to this).
    const lost = loadMirrorState(path.join(tmpRoot, "nope", "missing.json"));
    expect(lost.entries).toEqual({});
    // The cloud now carries DIFFERENT bytes. Without the cache there is no proof
    // the vault bytes are mirror-written -> skip + report, never overwrite.
    const summary = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("mirrored v2"), state: lost, summary })).toBe("skipped-divergent");
    expect(fs.readFileSync(target(), "utf8")).toBe("mirrored v1");
    // Sha-EQUAL bytes under a lost cache re-adopt cleanly.
    const summary2 = mkSummary();
    expect(writeMirrorEntry({ jobsRoot, jobId, name, bytes: Buffer.from("mirrored v1"), state: lost, summary: summary2 })).toBe("adopted");
  });

  it("a corrupt state FILE loads as the empty (adoption-semantics) state", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ not json !!");
    const s = loadMirrorState(statePath);
    expect(s.entries).toEqual({});
    expect(s.reported).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe("GC-8: exclusive creates + case-insensitive collision safety", () => {
  it("a FILE differing only in case from an existing entry routes through skip-report, never a plain write", () => {
    const jobId = "Analyst - Acme";
    const state = freshState();
    writeMirrorEntry({ jobsRoot, jobId, name: "notes.md", bytes: Buffer.from("original"), state, summary: mkSummary() });
    const summary = mkSummary();
    const r = writeMirrorEntry({ jobsRoot, jobId, name: "Notes.md", bytes: Buffer.from("CLOBBER ATTEMPT"), state, summary });
    expect(r).toBe("skipped-case-collision");
    expect(summary.conflicts.some((c) => c.startsWith("case-collision"))).toBe(true);
    // the original file's bytes are untouched (on NTFS both names are ONE path)
    expect(fs.readFileSync(path.join(jobsRoot, jobId, "notes.md"), "utf8")).toBe("original");
    // and no second-spelling entry was recorded as mirror-owned
    expect(state.entries[`${jobId}/Notes.md`]).toBeUndefined();
  });

  it("a JOB FOLDER differing only in case from an existing folder routes through skip-report", () => {
    fs.mkdirSync(path.join(jobsRoot, "analyst - acme"), { recursive: true });
    const summary = mkSummary();
    const r = writeMirrorEntry({ jobsRoot, jobId: "Analyst - Acme", name: "notes.md", bytes: Buffer.from("x"), state: freshState(), summary });
    expect(r).toBe("skipped-case-collision");
    expect(summary.skipped).toBe(1);
    // nothing was written into (or beside) the differently-cased folder
    expect(listVault()).toEqual(["analyst - acme"]);
  });

  it("TWO cloud names differing only in case in the SAME manifest are skipped WHOLESALE (file and job variants)", async () => {
    const bytesA = Buffer.from("spelling A");
    const bytesB = Buffer.from("spelling B");
    const d = jobDetail();
    const api = fakeApi({
      manifest: manifestFor(
        [
          { id: d.id, rowSha: d.rowSha },
          // job-folder case collision: two spellings of a second job id
          { id: "Dev - Beta", rowSha: "x".repeat(64) },
          { id: "dev - beta", rowSha: "y".repeat(64) },
        ],
        [
          { jobId: d.id, name: "Notes.md", sha256: sha256Hex(bytesA), bytesLen: bytesA.length },
          { jobId: d.id, name: "notes.md", sha256: sha256Hex(bytesB), bytesLen: bytesB.length },
        ],
      ),
      details: { [d.id]: d },
      fileBytes: { [`${d.id}/Notes.md`]: bytesA, [`${d.id}/notes.md`]: bytesB },
    });
    const summary = await runMirrorPass({ api, jobsRoot, statePath });
    // the clean job mirrored; every colliding spelling skipped, NONE written
    expect(fs.existsSync(path.join(jobsRoot, d.id, "Analyst.md"))).toBe(true);
    expect(fs.existsSync(path.join(jobsRoot, d.id, "Notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(jobsRoot, d.id, "notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(jobsRoot, "Dev - Beta"))).toBe(false);
    expect(fs.existsSync(path.join(jobsRoot, "dev - beta"))).toBe(false);
    expect(summary.skipped).toBeGreaterThanOrEqual(4);
    expect(summary.conflicts.filter((c) => c.includes("case-collision")).length).toBeGreaterThanOrEqual(4);
  });

  it("caseSiblings + findCaseCollisions primitives behave case-insensitively", () => {
    fs.mkdirSync(path.join(jobsRoot, "A Folder"));
    expect(caseSiblings(jobsRoot, "a folder")).toEqual(["A Folder"]);
    expect(caseSiblings(path.join(jobsRoot, "missing"), "x")).toEqual([]);
    expect([...findCaseCollisions(["a.md", "A.md", "b.md"])]).toEqual(["a.md"]);
    expect(findCaseCollisions(["a.md", "a.md", "b.md"]).size).toBe(0); // same spelling twice is not a collision
  });
});

// ---------------------------------------------------------------------------
describe("NO delete path (never-deletes, structural)", () => {
  it("grep-level: the client module contains no unlink/rm/rmdir call path", () => {
    const src = fs.readFileSync(new URL("../ops/mirror-vault.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bunlink(Sync)?\s*\(/);
    expect(src).not.toMatch(/\brmSync\s*\(/);
    expect(src).not.toMatch(/\brmdir(Sync)?\s*\(/);
    expect(src).not.toMatch(/\bfs\.rm\b/);
    expect(src).not.toMatch(/\bfs\.promises\b/); // no promise-API backdoor either
  });

  it("behavioral: a vault file ABSENT from the cloud manifest survives a pass untouched (absence is not a delete instruction)", async () => {
    const d = jobDetail();
    fs.mkdirSync(path.join(jobsRoot, d.id), { recursive: true });
    fs.writeFileSync(path.join(jobsRoot, d.id, "stale-copy.md"), "stale but sacred");
    const api = fakeApi({ manifest: manifestFor([{ id: d.id, rowSha: d.rowSha }]), details: { [d.id]: d } });
    await runMirrorPass({ api, jobsRoot, statePath });
    expect(fs.readFileSync(path.join(jobsRoot, d.id, "stale-copy.md"), "utf8")).toBe("stale but sacred");
  });
});

// ---------------------------------------------------------------------------
describe("runMirrorPass end-to-end (fake pinned API)", () => {
  it("creates the job file + companion, then reports ONE structured mirror-pass line (GC-2); a quiet re-run reports nothing", async () => {
    const d = jobDetail();
    const cv = Buffer.from("%PDF-1.4 cv bytes");
    const posts = [];
    const api = fakeApi({
      manifest: manifestFor(
        [{ id: d.id, rowSha: d.rowSha }],
        [{ jobId: d.id, name: "CV - Analyst.pdf", sha256: sha256Hex(cv), bytesLen: cv.length }],
      ),
      details: { [d.id]: d },
      fileBytes: { [`${d.id}/CV - Analyst.pdf`]: cv },
      posts,
    });
    const s1 = await runMirrorPass({ api, jobsRoot, statePath, trigger: "event" });
    expect(s1.created).toBe(2);
    expect(fs.readFileSync(path.join(jobsRoot, d.id, "CV - Analyst.pdf")).equals(cv)).toBe(true);
    expect(posts).toHaveLength(1); // the WRITING pass reported itself
    expect(posts[0].p).toBe("/api/mirror/runs");
    expect(posts[0].body.trigger).toBe("event");
    expect(posts[0].body.created).toBe(2);
    expect(posts[0].body.clientVersion).toBe(MIRROR_CLIENT_VERSION);
    // idempotent re-run: nothing written, nothing loud, no second report
    const s2 = await runMirrorPass({ api, jobsRoot, statePath, trigger: "sweep" });
    expect(s2.created + s2.updated).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it("integrity: pulled bytes that do not hash to the manifest sha are SKIPPED (no write off unverified data)", async () => {
    const d = jobDetail();
    const api = fakeApi({
      manifest: manifestFor(
        [{ id: d.id, rowSha: d.rowSha }],
        [{ jobId: d.id, name: "CV - Analyst.pdf", sha256: "0".repeat(64), bytesLen: 5 }],
      ),
      details: { [d.id]: d },
      fileBytes: { [`${d.id}/CV - Analyst.pdf`]: Buffer.from("tampered bytes") },
    });
    const s = await runMirrorPass({ api, jobsRoot, statePath });
    expect(fs.existsSync(path.join(jobsRoot, d.id, "CV - Analyst.pdf"))).toBe(false);
    expect(s.conflicts.some((c) => c.startsWith("file-sha-mismatch"))).toBe(true);
  });

  it("integrity: a job detail whose reconstruction misses the manifest rowSha is SKIPPED", async () => {
    const d = jobDetail();
    const api = fakeApi({
      manifest: manifestFor([{ id: d.id, rowSha: "f".repeat(64) }]), // stale/tampered manifest row
      details: { [d.id]: d },
    });
    const s = await runMirrorPass({ api, jobsRoot, statePath });
    expect(fs.existsSync(path.join(jobsRoot, d.id))).toBe(false);
    expect(s.conflicts.some((c) => c.startsWith("row-sha-mismatch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("outbound posture (GC-6) + loop plumbing", () => {
  it("createApi refuses http, an unpinned redirect target, and a TLS bypass", async () => {
    expect(() => createApi({ token: "t", cloudUrl: "http://insecure.example" })).toThrow(/https/);
    expect(() => createApi({ token: "t", cloudUrl: "https://ok.example", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } })).toThrow(/TLS/);
    // a 3xx answer is REFUSED, never followed (redirect: "manual" + explicit throw)
    const api = createApi({
      token: "t",
      cloudUrl: "https://ok.example",
      env: {},
      fetchImpl: async (url, init) => {
        expect(init.redirect).toBe("manual");
        expect(init.headers.authorization).toBe("Bearer t");
        return { status: 302, ok: false, headers: new Map([["location", "https://evil.example/"]]) };
      },
    });
    await expect(api.getJson("/api/sync/manifest")).rejects.toThrow(/refused redirect/);
  });

  it("debounce batches events with a >= 5s quiet window (V2-3)", () => {
    const delays = [];
    let fired = 0;
    const d = createDebouncer(() => fired++, {
      setT: (fn, ms) => {
        delays.push(ms);
        return { fn };
      },
      clearT: () => {},
    });
    d.trigger(1000);
    expect(delays[0]).toBe(DEBOUNCE_MS); // first event waits the full quiet window
    expect(DEBOUNCE_MS).toBeGreaterThanOrEqual(5000);
    d.trigger(2000); // a burst extends the window (still >= 5s from the last event)
    expect(delays[1]).toBe(DEBOUNCE_MS);
    // but a sustained storm is capped by maxWait, so a pass still happens
    d.trigger(1000 + 29_000);
    expect(delays[2]).toBeLessThanOrEqual(DEBOUNCE_MS);
    expect(fired).toBe(0); // nothing fires until a timer actually elapses
  });

  it("the overlap lockfile is honored while held and taken over ONLY when stale/released - without any delete", () => {
    const lockPath = path.join(tmpRoot, "state", "jobhunt-mirror.lock");
    const l1 = acquireLock(lockPath);
    expect(l1.ok).toBe(true);
    const l2 = acquireLock(lockPath); // same live pid holds it
    expect(l2.ok).toBe(false);
    l1.release(); // marks released IN PLACE (no unlink anywhere in the module)
    expect(fs.existsSync(lockPath)).toBe(true); // the file still exists...
    const l3 = acquireLock(lockPath); // ...but a released lock is re-acquirable
    expect(l3.ok).toBe(true);
  });

  it("saveMirrorState round-trips through an atomic temp+rename", () => {
    const s = freshState();
    s.entries["A - B/x.md"] = "a".repeat(64);
    saveMirrorState(statePath, s);
    expect(loadMirrorState(statePath).entries["A - B/x.md"]).toBe("a".repeat(64));
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false); // staging name renamed away
  });
});
