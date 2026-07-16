import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// t-1783186106119 (guardian INFO finding, telemetry W1 review): app.use(cors())
// emitted Access-Control-Allow-Origin: * on EVERY /api response, so any page
// loaded in the owner's browser could READ every endpoint (jobs, telemetry,
// tasks) and preflight its way into WRITES while the app runs. The loopback
// bind keeps the API on-box, but a malicious page in the same browser is
// already inside that boundary - the wildcard invited it in.
//
// The fix under test is the REMOVAL of CORS entirely, not an allowlist,
// because every real client is same-origin or not a browser:
//   - the Vite UI (localhost:5180 / 127.0.0.1:5180) calls /api with RELATIVE
//     fetches (src/api.ts); Vite's dev proxy forwards them to :8787
//     SERVER-side, so the browser only ever sees its own origin
//   - the tailnet path (https://galena.tail30b7b8.ts.net) proxies to Vite,
//     which proxies /api - again one origin from the browser's view
//   - ops scripts / hooks / curl hit 127.0.0.1:8787 directly, and CORS is a
//     browser-enforcement mechanism that does not apply to them
// With no Access-Control-Allow-Origin ever emitted, the browser's own
// same-origin policy blocks cross-origin reads, and preflight (mandatory for
// JSON bodies and custom headers) fails closed, so cross-origin writes never
// leave the browser. These tests pin that posture: NO CORS grant headers for
// ANY origin, while the real (proxied / non-browser) paths keep working.
// Red-checked: with app.use(cors()) present, every "no grant" assertion here
// fails on the wildcard header.

let app;
let tmpRoot;

beforeAll(async () => {
  // Hermetic fixture dirs: the import must never depend on (or touch) the real
  // vault or the committed docs/. Only read endpoints are exercised here.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-cors-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1"; // skip watcher + port bind on import
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// The full set of CORS grant headers - NONE may ever appear. Checking all of
// them (not just allow-origin) guards against a partial re-introduction, e.g.
// a credentials or expose-headers grant sneaking in via some other middleware.
const GRANT_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
];

function expectNoCorsGrant(res) {
  for (const h of GRANT_HEADERS) {
    expect(res.headers[h], `unexpected CORS grant header: ${h}`).toBeUndefined();
  }
}

describe("no CORS grant for a foreign origin (browser same-origin policy stays in charge)", () => {
  it("GET /api/config with a foreign Origin: 200 server-side, but NO CORS headers -> the browser blocks the read", async () => {
    const res = await request(app).get("/api/config").set("Origin", "https://evil.example");
    // CORS never blocks on the server - enforcement is the browser refusing to
    // hand the response to the page when no grant header comes back.
    expect(res.status).toBe(200);
    expectNoCorsGrant(res);
  });

  it("GET /api/telemetry/summary (the endpoint from the finding) with a foreign Origin: no CORS grant", async () => {
    const res = await request(app)
      .get("/api/telemetry/summary")
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(200);
    expectNoCorsGrant(res);
  });

  it("cross-origin WRITE preflight fails closed: OPTIONS /api/tasks gets no grant, so the browser never sends the POST", async () => {
    // A JSON write (Content-Type: application/json) is not a "simple" request,
    // so the browser MUST preflight it. No access-control-allow-* in the
    // preflight response means the actual cross-origin POST is never sent.
    const res = await request(app)
      .options("/api/tasks")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    expectNoCorsGrant(res);
  });
});

describe("the real access paths are unaffected (they never needed a CORS grant)", () => {
  it("a Vite-proxied request (browser Origin forwarded by the dev proxy) still succeeds - same-origin needs no grant", async () => {
    // Browsers send an Origin header on POSTs even same-origin, and the Vite
    // proxy forwards it. The response needs no CORS headers because from the
    // browser's view the request went to its OWN origin (the proxy is
    // server-side). So: 200, and still no grant emitted.
    for (const origin of ["http://localhost:5180", "http://127.0.0.1:5180"]) {
      const res = await request(app).get("/api/config").set("Origin", origin);
      expect(res.status).toBe(200);
      expectNoCorsGrant(res);
    }
  });

  it("non-browser clients (ops scripts, hooks, curl) send no Origin and are untouched", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statuses");
    expectNoCorsGrant(res);
  });
});
