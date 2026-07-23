// Shared laptop-side building blocks for the ops/*.mjs cloud clients: the
// pinned-host, redirect-refusing outbound API (GC-6), the overlap-guard
// lockfile (no delete path), and the byte-faithful <Role>.md reconstruction.
//
// EXTRACTION NOTE (SIM-614, 2026-07-23): this code originally lived inside
// ops/mirror-vault.mjs (the SIM-393 I6 cloud->vault mirror client). The owner
// retired the mirror lane outright - the OneDrive vault is no longer part of
// the jobhunt product loop - so ops/mirror-vault.mjs and everything specific
// to it (the three-way sha check, the no-delete write path, the debounced
// long-poll loop, the mirror-state manifest) were deleted. The THREE pieces
// below were not mirror-specific: ops/export-snapshot.mjs (the still-live I5
// export-snapshot lane) depends on all three, so they were pulled out here
// first and both mirror-vault.mjs's own logic and the file itself were then
// removed, rather than deleting export-snapshot.mjs's dependency out from
// under it.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { assertOutboundUrl, assertTlsNotBypassed } from "../server/runner-lib.js";

// ---- pinned-host, redirect-refusing outbound API (GC-6) ---------------------
// Every call re-asserts the URL + TLS posture, so a reconnect after an outage
// gets the identical checks the first connection got.
export function createApi({ token, cloudUrl, fetchImpl = fetch, env = process.env }) {
  assertTlsNotBypassed(env);
  const pinned = assertOutboundUrl(cloudUrl); // https-only, parsed once for the pin
  const call = async (pathPart, init = {}) => {
    assertTlsNotBypassed(env); // GC-6 holds across reconnects
    const u = assertOutboundUrl(new URL(pathPart, cloudUrl).toString(), { requireHost: pinned.hostname });
    const res = await fetchImpl(u.toString(), {
      ...init,
      redirect: "manual", // NEVER follow a redirect off the pinned host
      headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`cloud-client: refused redirect (${res.status}) from ${pinned.hostname}`);
    }
    return res;
  };
  return {
    host: pinned.hostname,
    async getJson(p) {
      const r = await call(p);
      if (!r.ok) throw new Error(`cloud-client: GET ${p} -> ${r.status}`);
      return r.json();
    },
    async getBytes(p) {
      const r = await call(p);
      if (!r.ok) throw new Error(`cloud-client: GET ${p} -> ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async postJson(p, body) {
      const r = await call(p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`cloud-client: POST ${p} -> ${r.status}`);
      return r.json();
    },
  };
}

// ---- <Role>.md reconstruction (byte-faithful) -------------------------------
// EXACTLY the serialization FileStore.createJobIfAbsent writes for a sync-inserted
// job: "---\n" + yaml.dump(front) + "---\n" + body. Round-trips through the
// app's parseFrontmatter with front/body identical, so rowShaOf(front, body) of
// the re-read file equals the manifest rowSha (proven in tests).
export function reconstructJobFileText(front, body) {
  return "---\n" + yaml.dump(front || {}) + "---\n" + (body == null ? "" : String(body));
}

// ---- lockfile (overlap guard, NO unlink) ------------------------------------
// Acquired with an exclusive "wx" create. A pre-existing lock is honored unless
// its recorded pid is dead or it is stale (> 6h), in which case it is RE-WRITTEN
// in place (overwrite, never delete).
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, release: () => releaseLock(lockPath) };
  } catch {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      holder = null;
    }
    const stale =
      !holder ||
      holder.released === true ||
      !pidAlive(holder.pid) ||
      (holder.startedAt && Date.now() - Date.parse(holder.startedAt) > LOCK_STALE_MS);
    if (!stale) return { ok: false, release: () => {} };
    fs.writeFileSync(lockPath, payload); // take over the stale lock in place
    return { ok: true, release: () => releaseLock(lockPath) };
  }
}
function releaseLock(lockPath) {
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ released: true, releasedAt: new Date().toISOString() }));
  } catch {
    /* best-effort */
  }
}
function pidAlive(pid) {
  if (!Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // alive but not ours
  }
}
