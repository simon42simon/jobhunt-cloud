import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// POST /api/jobs/:id/open-folder (t-1783481685241) - the "Open folder" shortcut
// next to a job's Files list. It reveals the job's own folder in the server
// desktop's file manager (Explorer / Finder), a sibling to POST /api/open (which
// opens ONE file). This suite pins the GUARD only: an unknown or traversal-shaped
// id resolves to no folder and 404s BEFORE any shell-open runs, so importing the
// app and hitting these paths never spawns a real file-manager window. The
// success path is deliberately NOT exercised here (it would pop a real Explorer
// window mid-test, and there is no execFile seam to stub - exactly as the sibling
// POST /api/open is not success-tested either); the argv it would launch for a
// real folder path is pinned by the pure `buildOpenCommand` unit test in
// tests/lib.test.js.

let app;
let fixture;

const jobA = [
  "---", "type: job", "role: Alpha Role", "employer: Alpha Co",
  "track: industry_outreach_focused", "fit: strong", "status: drafted",
  "sector: bps", "tailoring: heavy", "deadline: 2099-07-15", "tags: [job]",
  "---", "", "# Alpha Role - Alpha Co", "",
].join("\n");

const A = "Alpha Role - Alpha Co";
const id = (s) => encodeURIComponent(s);

beforeAll(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jh-openfolder-"));
  const a = path.join(fixture, A);
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "Alpha Role.md"), jobA, "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(fixture, { recursive: true, force: true });
  } catch {}
});

describe("POST /api/jobs/:id/open-folder - reveal a job folder (guard)", () => {
  it("404s an unknown job id (no folder resolves, nothing is launched)", async () => {
    const res = await request(app).post(`/api/jobs/${id("No Such Job")}/open-folder`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it("cannot traverse out of Jobs/ via the job id", async () => {
    for (const bad of ["../", "..", "../outside", "..\\outside"]) {
      const res = await request(app).post(`/api/jobs/${encodeURIComponent(bad)}/open-folder`);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("never opens the Jobs/ root itself via a '.' id", async () => {
    // A bare "." path.joins to JOBS_DIR itself; resolveJobFolder's containment
    // check (path.relative === "" is falsy) rejects it, so even if the route
    // matches with id ".", the root is never openable. (If the router instead
    // normalizes the "." segment away, the request simply doesn't match and
    // 404s all the same - either way the root stays closed.)
    const res = await request(app).post(`/api/jobs/${id(".")}/open-folder`);
    expect([400, 404]).toContain(res.status);
  });
});
