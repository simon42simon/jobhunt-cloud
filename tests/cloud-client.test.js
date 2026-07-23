// ops/cloud-client.mjs - the shared laptop-side outbound cloud API client
// (GC-6 pinned-host/TLS/redirect posture), the overlap-guard lockfile (no
// delete path), and the byte-faithful <Role>.md reconstruction.
//
// EXTRACTION NOTE (SIM-614, 2026-07-23): this module used to live inside
// ops/mirror-vault.mjs (the SIM-393 I6 cloud->vault mirror client). That lane
// was retired outright by owner directive - the OneDrive vault is no longer
// part of the jobhunt product loop - and ops/mirror-vault.mjs was deleted, but
// ops/export-snapshot.mjs (the still-live I5 export-snapshot lane) depends on
// these three primitives, so they were extracted here first. This file carries
// forward exactly the coverage of createApi/acquireLock/reconstructJobFileText
// that used to live in tests/mirror-client.test.js (also deleted with the
// mirror client) so none of it was lost in the retirement.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createApi, acquireLock, reconstructJobFileText } from "../ops/cloud-client.mjs";
import { parseFrontmatter } from "../server/lib.js";
import { rowShaOf } from "../server/sync-lib.js";

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-client-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("<Role>.md reconstruction byte-fidelity", () => {
  const FRONT = () => ({ type: "job", role: "Analyst", employer: "Acme", status: "lead", tags: ["job"], deadline: "2026-08-01" });
  const BODY = "# Analyst - Acme\n\nnotes body\n";

  it("emits EXACTLY the FileStore createJobIfAbsent serialization and round-trips through the app parser", () => {
    const text = reconstructJobFileText(FRONT(), BODY);
    expect(text).toBe("---\n" + yaml.dump(FRONT()) + "---\n" + BODY);
    const parsed = parseFrontmatter(text); // the app's own reader -> { meta, body }
    expect(parsed.meta).toEqual(FRONT()); // front round-trips verbatim
    expect(parsed.body).toBe(BODY); // body byte-faithful
    expect(rowShaOf(parsed.meta, parsed.body)).toBe(rowShaOf(FRONT(), BODY)); // manifest rowSha holds
  });

  it("a null/missing body serializes to an empty string, never 'null'/'undefined'", () => {
    expect(reconstructJobFileText(FRONT(), null)).toBe("---\n" + yaml.dump(FRONT()) + "---\n");
    expect(reconstructJobFileText(null, "body")).toBe("---\n" + yaml.dump({}) + "---\nbody");
  });
});

describe("createApi outbound posture (GC-6)", () => {
  it("refuses http, an unpinned redirect target, and a TLS bypass", async () => {
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
    await expect(api.getJson("/api/export/meta")).rejects.toThrow(/refused redirect/);
  });

  it("getJson/getBytes/postJson all carry the bearer token and pin the host", async () => {
    const calls = [];
    const api = createApi({
      token: "t",
      cloudUrl: "https://pinned.example",
      env: {},
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/bytes")) {
          return { status: 200, ok: true, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
        }
        if (init.method === "POST") return { status: 201, ok: true, async json() { return { ok: true }; } };
        return { status: 200, ok: true, async json() { return { hello: "world" }; } };
      },
    });
    expect(api.host).toBe("pinned.example");
    expect(await api.getJson("/api/x")).toEqual({ hello: "world" });
    expect(Buffer.from(await api.getBytes("/api/bytes")).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(await api.postJson("/api/x", { a: 1 })).toEqual({ ok: true });
    expect(calls.every((c) => c.init.headers.authorization === "Bearer t")).toBe(true);
  });

  it("a non-ok GET/POST response throws with the status code", async () => {
    const api = createApi({
      token: "t",
      cloudUrl: "https://pinned.example",
      env: {},
      fetchImpl: async () => ({ status: 404, ok: false, async json() { return {}; } }),
    });
    await expect(api.getJson("/api/nope")).rejects.toThrow(/404/);
  });
});

describe("acquireLock (overlap guard, no delete path)", () => {
  it("is honored while held and taken over ONLY when stale/released - without any delete", () => {
    const lockPath = path.join(tmpRoot, "state", "some.lock");
    const l1 = acquireLock(lockPath);
    expect(l1.ok).toBe(true);
    const l2 = acquireLock(lockPath); // same live pid holds it
    expect(l2.ok).toBe(false);
    l1.release(); // marks released IN PLACE (no unlink anywhere in the module)
    expect(fs.existsSync(lockPath)).toBe(true); // the file still exists...
    const l3 = acquireLock(lockPath); // ...but a released lock is re-acquirable
    expect(l3.ok).toBe(true);
  });

  it("a stale lock (dead pid) is taken over without any delete", () => {
    const lockPath = path.join(tmpRoot, "state", "stale.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // a pid that (almost certainly) does not exist
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    const l = acquireLock(lockPath);
    expect(l.ok).toBe(true);
  });

  it("grep-level: the module contains no unlink/rm/rmdir call path", () => {
    const src = fs.readFileSync(new URL("../ops/cloud-client.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bunlink(Sync)?\s*\(/);
    expect(src).not.toMatch(/\brmSync\s*\(/);
    expect(src).not.toMatch(/\brmdir(Sync)?\s*\(/);
    expect(src).not.toMatch(/\bfs\.rm\b/);
  });
});
