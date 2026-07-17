// SIM-386 (guardian RR-1): failed-login visibility on the auth'd private
// instance. Four guarantees pinned here:
//   1. Every failed login (bad passphrase AND rate-limited) is recorded through
//      the storage seam - proven against BOTH backends (FileStore always;
//      PgStore via the embedded cluster, cleanly skipped when it cannot boot).
//   2. Threshold surfacing fires EXACTLY ONCE per window (no notify-spam), and
//      the notification feed shows one login_failed event per window.
//   3. NO CREDENTIAL MATERIAL in any persisted or logged record - asserted on
//      the SERIALIZED event text, not just the object shape.
//   4. Auth OFF is a byte-identical no-op: no endpoints, no auth lines, no
//      login_failed notifications (the ADR-024 regression guarantee).
//
// RED-CHECKED: with the SIM-386 code stashed (server/auth.js monitor +
// index.js deriveAuthEvents), the imports below throw and every integration
// assertion fails (404 endpoint, no activity lines, no notification) - proving
// the feature code, not the fixtures, satisfies the suite.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import {
  createFailedLoginMonitor,
  parseFailedLogins,
  clientIp,
  FAILED_LOGIN_ALERT_THRESHOLD,
  FAILED_LOGIN_DURABLE_CAP,
  FAILED_LOGIN_STDOUT_SAMPLE,
} from "../server/auth.js";
import { hashToken } from "../server/runner-lib.js";
import { provisionPgBackend } from "./helpers/embedded-pg.mjs";

const PASSPHRASE = "correct-horse-battery";
const WRONG = "hunter2-SUPER-SECRET-guess";
const TEST_SECRET = "test-fixed-secret-do-not-use-in-prod";

// A fake request the monitor sees. Deliberately carries the attempted
// passphrase in body - the monitor must never read it.
function fakeReq(ip = "203.0.113.9") {
  return {
    ip,
    headers: { "user-agent": "EvilBot/1.0 (brute)", cookie: "" },
    socket: { remoteAddress: ip },
    body: { passphrase: WRONG },
  };
}

// ---------------------------------------------------------------------------
describe("createFailedLoginMonitor (pure, fake clock/store/log)", () => {
  function harness(env = {}) {
    const appended = [];
    const logged = [];
    let t = 1_000_000;
    const monitor = createFailedLoginMonitor({
      store: { appendActivity: (r) => appended.push(r) },
      env,
      now: () => t,
      log: (s) => logged.push(s),
    });
    return { monitor, appended, logged, tick: (ms) => (t += ms) };
  }

  it("records every failure with whitelisted fields and a rolling count", () => {
    const { monitor, appended } = harness();
    monitor.record(fakeReq(), "bad_passphrase");
    const second = monitor.record(fakeReq(), "bad_passphrase");
    expect(second.count).toBe(2);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      kind: "auth",
      event: "login_failed",
      reason: "bad_passphrase",
      ip: "203.0.113.9",
      userAgent: "EvilBot/1.0 (brute)",
      count: 1,
    });
    expect(typeof appended[0].windowStart).toBe("string");
  });

  it("maps the rate-limited path to its own reason", () => {
    const { monitor, appended } = harness();
    monitor.record(fakeReq(), "rate_limited");
    expect(appended[0].reason).toBe("rate_limited");
  });

  it("crosses the threshold EXACTLY ONCE per window, and re-arms in the next window", () => {
    const { monitor, appended, tick } = harness();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(monitor.record(fakeReq(), "bad_passphrase"));
    // Default threshold 3: crossing fires on the 3rd failure only.
    expect(results.map((r) => r.thresholdCrossed)).toEqual([false, false, true, false, false]);
    const alerts = appended.filter((r) => r.event === "login_failures_threshold");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "auth", count: 3, threshold: FAILED_LOGIN_ALERT_THRESHOLD });

    // Next window: the latch re-arms, a fresh burst alerts again (once).
    tick(15 * 60 * 1000 + 1);
    for (let i = 0; i < 4; i++) monitor.record(fakeReq(), "bad_passphrase");
    const alerts2 = appended.filter((r) => r.event === "login_failures_threshold");
    expect(alerts2).toHaveLength(2);
    expect(alerts2[1].windowStart).not.toBe(alerts2[0].windowStart);
    expect(alerts2[1].count).toBe(3); // the count reset with the window
  });

  it("window expiry resets the rolling count", () => {
    const { monitor, tick } = harness();
    monitor.record(fakeReq(), "bad_passphrase");
    monitor.record(fakeReq(), "bad_passphrase");
    tick(15 * 60 * 1000 + 1);
    const fresh = monitor.record(fakeReq(), "bad_passphrase");
    expect(fresh.count).toBe(1);
    expect(fresh.thresholdCrossed).toBe(false);
  });

  it("threshold and window are env-tunable", () => {
    const { monitor, appended } = harness({
      JOBHUNT_AUTH_ALERT_THRESHOLD: "2",
      JOBHUNT_AUTH_RATELIMIT_WINDOW_MS: "60000",
    });
    expect(monitor.threshold).toBe(2);
    expect(monitor.windowMs).toBe(60000);
    monitor.record(fakeReq(), "bad_passphrase");
    monitor.record(fakeReq(), "bad_passphrase");
    expect(appended.filter((r) => r.event === "login_failures_threshold")).toHaveLength(1);
  });

  it("NEVER emits credential material - serialized records and log lines are clean", () => {
    const { monitor, appended, logged } = harness();
    for (let i = 0; i < 4; i++) monitor.record(fakeReq(), "bad_passphrase");
    const everything = JSON.stringify(appended) + "\n" + logged.join("\n");
    expect(everything).not.toContain(WRONG);
    expect(everything).not.toMatch(/"passphrase"\s*:/i); // no credential FIELD ("bad_passphrase" the enum is fine)
    // ...while the log stream did record every failure, structured.
    expect(logged.filter((l) => l.includes("FAILED LOGIN"))).toHaveLength(4);
    expect(logged.filter((l) => l.includes("THRESHOLD CROSSED"))).toHaveLength(1);
  });

  // Guardian condition 1 (SIM-386 review, 2026-07-17): the durable write path is
  // BOUNDED per window. Before the fix every post-cap request appended a
  // permanent activity_log row - an unbounded, unauthenticated, attacker-driven
  // write primitive into a never-deletes store. RED-CHECKED: against the
  // pre-condition code these assertions fail (50 durable lines, not 20).
  it("guardian condition 1: durable appends cap at FAILED_LOGIN_DURABLE_CAP while the count stays exact", () => {
    const { monitor, appended, logged } = harness();
    const results = [];
    for (let i = 0; i < 50; i++) results.push(monitor.record(fakeReq(), "rate_limited"));

    // Durable: at most CAP failure lines + the ONE threshold alert. Nothing more.
    const failures = appended.filter((r) => r.event === "login_failed");
    const alerts = appended.filter((r) => r.event === "login_failures_threshold");
    expect(failures).toHaveLength(FAILED_LOGIN_DURABLE_CAP);
    expect(alerts).toHaveLength(1);
    expect(appended).toHaveLength(FAILED_LOGIN_DURABLE_CAP + 1);

    // In-memory: the rolling counter never stopped.
    expect(results[49].count).toBe(50);
    expect(results.filter((r) => r.durable)).toHaveLength(FAILED_LOGIN_DURABLE_CAP);
    expect(monitor.snapshot()).toMatchObject({ count: 50 });

    // stdout: one line per durable failure, then a SAMPLED heartbeat (every
    // FAILED_LOGIN_STDOUT_SAMPLE-th failure: counts 30, 40, 50) - never silent,
    // never a per-request flood.
    const sampledBeyond = Math.floor(50 / FAILED_LOGIN_STDOUT_SAMPLE) - Math.floor(FAILED_LOGIN_DURABLE_CAP / FAILED_LOGIN_STDOUT_SAMPLE);
    expect(logged.filter((l) => l.includes("FAILED LOGIN"))).toHaveLength(FAILED_LOGIN_DURABLE_CAP + sampledBeyond);
  });

  it("guardian condition 1: the durable cap resets with the window", () => {
    const { monitor, appended, tick } = harness();
    for (let i = 0; i < 30; i++) monitor.record(fakeReq(), "bad_passphrase");
    expect(appended.filter((r) => r.event === "login_failed")).toHaveLength(FAILED_LOGIN_DURABLE_CAP);
    tick(15 * 60 * 1000 + 1);
    for (let i = 0; i < 5; i++) monitor.record(fakeReq(), "bad_passphrase");
    // Durable writes resumed in the fresh window.
    expect(appended.filter((r) => r.event === "login_failed")).toHaveLength(FAILED_LOGIN_DURABLE_CAP + 5);
    expect(monitor.snapshot()).toMatchObject({ count: 5 });
  });

  it("surface/defaultReason options tag another auth lane through the same bounded pipeline", () => {
    const appended = [];
    const sync = createFailedLoginMonitor({
      store: { appendActivity: (r) => appended.push(r) },
      env: {},
      now: () => 1_000_000,
      log: () => {},
      surface: "sync",
      defaultReason: "bad_token",
      windowMs: 60_000,
    });
    sync.record(fakeReq(), "bad_token");
    sync.record(fakeReq(), "rate_limited");
    expect(appended[0]).toMatchObject({ surface: "sync", reason: "bad_token" });
    expect(appended[1]).toMatchObject({ surface: "sync", reason: "rate_limited" });
    expect(sync.windowMs).toBe(60_000);
  });

  it("a store append failure never breaks the login path (best-effort contract holds end to end)", () => {
    const monitor = createFailedLoginMonitor({
      // FileStore/PgStore swallow their own errors; a hostile stand-in that
      // throws would be a contract violation, so pin the monitor's own posture
      // with a store that misbehaves the worst way the seam allows: absent.
      store: null,
      env: {},
      now: () => 0,
      log: () => {},
    });
    expect(() => monitor.record(fakeReq(), "bad_passphrase")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("clientIp / parseFailedLogins (pure)", () => {
  it("clientIp prefers the trust-proxy-derived req.ip, falls back to the socket, never throws", () => {
    expect(clientIp({ ip: "198.51.100.7", socket: { remoteAddress: "10.0.0.1" } })).toBe("198.51.100.7");
    expect(clientIp({ socket: { remoteAddress: "10.0.0.1" } })).toBe("10.0.0.1");
    expect(clientIp({})).toBe("unknown");
    expect(clientIp(null)).toBe("unknown");
  });

  it("parseFailedLogins folds only kind:auth lines, newest-first, tolerant of torn lines", () => {
    const raw = [
      JSON.stringify({ ts: "2026-07-17T09:00:00Z", kind: "run", runId: "r1", status: "done" }),
      JSON.stringify({ ts: "2026-07-17T09:01:00Z", kind: "auth", event: "login_failed", count: 1 }),
      "{torn line",
      JSON.stringify({ ts: "2026-07-17T09:02:00Z", kind: "auth", event: "login_failures_threshold", count: 3 }),
    ].join("\n");
    const events = parseFailedLogins(raw);
    expect(events.map((e) => e.event)).toEqual(["login_failures_threshold", "login_failed"]);
  });

  it("parseFailedLogins caps the feed", () => {
    const raw = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({ ts: `t${i}`, kind: "auth", event: "login_failed", count: i }),
    ).join("\n");
    expect(parseFailedLogins(raw)).toHaveLength(50);
    expect(parseFailedLogins(raw, 5)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// BOTH STORE BACKENDS: the monitor's write path is store.appendActivity + the
// read surface is store.readActivityText - prove the auth event round-trips on
// FileStore and PgStore identically (same registry pattern as store-contract).
process.env.JOBHUNT_TEST = "1";
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-login-boot-"));
process.env.JOBHUNT_JOBS_DIR = process.env.JOBHUNT_JOBS_DIR || bootDir;
process.env.JOBHUNT_DOCS_DIR = process.env.JOBHUNT_DOCS_DIR || bootDir;
const { dropInvalidJobEnums, normalizeSource, serializeSource } = await import("../server/index.js");
const { resolveStore } = await import("../server/store.js");
const DEPS = { TRACKS: {}, STATUSES: ["lead"], dropInvalidJobEnums, normalizeSource, serializeSource };

const backends = [
  {
    name: "FileStore",
    make() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-login-store-"));
      const dirs = { jobsDir: path.join(root, "Jobs"), docsDir: path.join(root, "docs"), dataDir: path.join(root, "data") };
      for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
      const store = resolveStore({}, { ...dirs, deps: DEPS });
      store.init();
      return { store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    },
  },
];
const pgBackend = await provisionPgBackend(DEPS);
if (pgBackend.available) {
  backends.push(pgBackend.backend);
} else {
  // eslint-disable-next-line no-console
  console.warn(`[failed-login] PgStore backend SKIPPED: ${pgBackend.reason}`);
}
afterAll(async () => {
  if (pgBackend.available) await pgBackend.stopAll();
});

describe.each(backends)("failed-login events persist via the store seam [$name]", ({ make }) => {
  it("a failed login writes a durable, credential-free auth event; threshold line rides the same log", () => {
    const ctx = make();
    try {
      const monitor = createFailedLoginMonitor({ store: ctx.store, env: {}, log: () => {} });
      for (let i = 0; i < 3; i++) monitor.record(fakeReq(), "bad_passphrase");

      const raw = ctx.store.readActivityText();
      // The persisted SERIALIZED text carries no credential material.
      expect(raw).not.toContain(WRONG);
      expect(raw).not.toMatch(/"passphrase"\s*:/i); // no credential FIELD ("bad_passphrase" the enum is fine)

      const events = parseFailedLogins(raw);
      const failures = events.filter((e) => e.event === "login_failed");
      const alerts = events.filter((e) => e.event === "login_failures_threshold");
      expect(failures).toHaveLength(3);
      expect(alerts).toHaveLength(1);
      expect(failures.every((e) => typeof e.ts === "string" && e.ts)).toBe(true); // seam stamps ts
      expect(failures[0]).toMatchObject({ ip: "203.0.113.9", userAgent: "EvilBot/1.0 (brute)" });
    } finally {
      ctx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: the real Express app (same hermetic loadApp pattern as
// auth.test.js). FileStore backend; DATA_DIR follows the JOBHUNT_DOCS_DIR seam.
async function loadApp(envOverrides = {}) {
  vi.resetModules();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-faillogin-"));
  const jobsDir = path.join(tmpRoot, "Jobs");
  const docsDir = path.join(tmpRoot, "docs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  for (const k of [
    "JOBHUNT_AUTH",
    "JOBHUNT_AUTH_HASH",
    "JOBHUNT_AUTH_SECRET",
    "JOBHUNT_AUTH_RATELIMIT_MAX",
    "JOBHUNT_AUTH_RATELIMIT_WINDOW_MS",
    "JOBHUNT_AUTH_ALERT_THRESHOLD",
    "JOBHUNT_TLS",
    "JOBHUNT_TRUST_PROXY",
    "SYNC_TOKEN_HASH",
    "RUNNER_TOKEN_HASH",
    "STORE_BACKEND",
    "APP_MODE",
    "JOBHUNT_DATA_DIR",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, envOverrides);
  const mod = await import("../server/index.js");
  return { app: mod.app, tmpRoot, docsDir };
}

const activityRaw = (docsDir) => {
  try {
    return fs.readFileSync(path.join(docsDir, "activity-log.jsonl"), "utf8");
  } catch {
    return "";
  }
};

describe("integration: auth ON - failed logins are recorded and surfaced", () => {
  let app;
  let tmpRoot;
  let docsDir;
  let cookie;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot, docsDir } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
    }));
    // A real session first, so the read surfaces below are exercised authed.
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    cookie = login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("GET /api/auth/failed-logins requires a session (401 anonymous)", async () => {
    const res = await request(app).get("/api/auth/failed-logins");
    expect(res.status).toBe(401);
  });

  it("each bad passphrase writes a structured event; threshold surfaces ONE notification per window", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("User-Agent", "EvilBot/1.0 (brute)")
        .send({ passphrase: WRONG });
      expect(res.status).toBe(401);
    }

    // Durable record: 3 failures + exactly 1 threshold line, credential-free.
    const raw = activityRaw(docsDir);
    expect(raw).not.toContain(WRONG);
    expect(raw).not.toContain(PASSPHRASE);
    expect(raw).not.toMatch(/"passphrase"\s*:/i); // no credential FIELD ("bad_passphrase" the enum is fine)
    const lines = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const failures = lines.filter((r) => r.kind === "auth" && r.event === "login_failed");
    const alerts = lines.filter((r) => r.kind === "auth" && r.event === "login_failures_threshold");
    expect(failures).toHaveLength(3);
    expect(failures.map((r) => r.count)).toEqual([1, 2, 3]);
    expect(failures[0].userAgent).toBe("EvilBot/1.0 (brute)");
    expect(typeof failures[0].ip).toBe("string");
    expect(failures[0].ip.length).toBeGreaterThan(0);
    expect(alerts).toHaveLength(1);

    // The bell: exactly one login_failed event, carrying the window count.
    const feed = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(feed.status).toBe(200);
    const loginEvents = feed.body.events.filter((e) => e.type === "login_failed");
    expect(loginEvents).toHaveLength(1);
    expect(loginEvents[0].title).toBe("3 failed login attempts");
    expect(loginEvents[0].ref).toMatchObject({ kind: "auth", count: 3 });

    // A 4th failure in the SAME window: still one notification (no spam),
    // count grows.
    await request(app).post("/api/auth/login").send({ passphrase: WRONG });
    const feed2 = await request(app).get("/api/notifications").set("Cookie", cookie);
    const loginEvents2 = feed2.body.events.filter((e) => e.type === "login_failed");
    expect(loginEvents2).toHaveLength(1);
    expect(loginEvents2[0].title).toBe("4 failed login attempts");

    // The authed read surface returns the events newest-first.
    const api = await request(app).get("/api/auth/failed-logins").set("Cookie", cookie);
    expect(api.status).toBe(200);
    expect(api.body.threshold).toBe(FAILED_LOGIN_ALERT_THRESHOLD);
    const kinds = api.body.events.map((e) => e.event);
    expect(kinds.filter((k) => k === "login_failed")).toHaveLength(4);
    expect(kinds.filter((k) => k === "login_failures_threshold")).toHaveLength(1);
    expect(api.body.events[0].event).toBe("login_failed"); // newest (the 4th failure) first
    expect(JSON.stringify(api.body)).not.toContain(WRONG);
  });
});

describe("integration: rate-limited attempts are counted as failures too", () => {
  let app;
  let tmpRoot;
  let docsDir;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot, docsDir } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_AUTH_RATELIMIT_MAX: "2",
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("the 429 path records reason:rate_limited with the same unchanged response body", async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      last = await request(app).post("/api/auth/login").send({ passphrase: WRONG });
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: "too many login attempts, try again later" }); // body pinned pre-SIM-386
    const lines = activityRaw(docsDir).split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const failures = lines.filter((r) => r.kind === "auth" && r.event === "login_failed");
    expect(failures.map((r) => r.reason)).toEqual(["bad_passphrase", "bad_passphrase", "rate_limited"]);
    expect(failures.map((r) => r.count)).toEqual([1, 2, 3]); // one rolling counter across both paths
  });
});

describe("integration: auth OFF - the feature is a complete no-op (regression guarantee)", () => {
  let app;
  let tmpRoot;
  let docsDir;

  beforeAll(async () => {
    ({ app, tmpRoot, docsDir } = await loadApp()); // no hash, no JOBHUNT_AUTH
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("the failed-logins endpoint does not exist (404, like every auth endpoint)", async () => {
    const res = await request(app).get("/api/auth/failed-logins");
    expect(res.status).toBe(404);
  });

  it("no auth lines are ever written and the feed carries no login_failed events", async () => {
    await request(app).get("/api/config");
    const feed = await request(app).get("/api/notifications");
    expect(feed.status).toBe(200);
    expect(feed.body.events.some((e) => e.type === "login_failed")).toBe(false);
    const raw = activityRaw(docsDir);
    expect(raw).not.toMatch(/"kind":"auth"/);
  });
});

// ---------------------------------------------------------------------------
// GUARDIAN CONDITION 1 (SIM-386 review): a flood of post-rate-limit requests
// must NOT be an unbounded durable-write primitive. N requests past the cap
// leave at most FAILED_LOGIN_DURABLE_CAP failure lines (+ the one threshold
// alert) in the never-deletes store, while every 429 response is byte-identical
// and un-throttled and the bell still reports the TRUE count (live overlay).
describe("integration: guardian condition 1 - login flood is write-bounded, 429 contract untouched", () => {
  let app;
  let tmpRoot;
  let docsDir;
  let cookie;
  const FLOOD = 60;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });
    ({ app, tmpRoot, docsDir } = await loadApp({
      JOBHUNT_AUTH_HASH: hash,
      JOBHUNT_AUTH_SECRET: TEST_SECRET,
      JOBHUNT_AUTH_RATELIMIT_MAX: "3", // 1 good login + 2 bad-passphrase 401s, then 429s
    }));
    const login = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    cookie = login.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it(`${FLOOD} failed logins -> at most CAP+1 durable lines, all 429s intact, bell count exact`, async () => {
    const statuses = [];
    for (let i = 0; i < FLOOD; i++) {
      const res = await request(app).post("/api/auth/login").send({ passphrase: WRONG });
      statuses.push(res.status);
      if (res.status === 429) {
        // The 429 contract is UNTOUCHED: same body on every single one, never throttled away.
        expect(res.body).toEqual({ error: "too many login attempts, try again later" });
      }
    }
    // 2 bad-passphrase 401s (the good login used slot 1 of max 3), then 429s only.
    expect(statuses.slice(0, 2)).toEqual([401, 401]);
    expect(statuses.slice(2).every((s) => s === 429)).toBe(true);

    // Durable bound: CAP failure lines + exactly 1 threshold alert. Not one more.
    const lines = activityRaw(docsDir).split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const failures = lines.filter((r) => r.kind === "auth" && r.event === "login_failed");
    const alerts = lines.filter((r) => r.kind === "auth" && r.event === "login_failures_threshold");
    expect(failures).toHaveLength(FAILED_LOGIN_DURABLE_CAP);
    expect(alerts).toHaveLength(1);

    // The bell still reports the TRUE count (live in-memory overlay, not the
    // capped log): one event, count = all 60 failures.
    const feed = await request(app).get("/api/notifications").set("Cookie", cookie);
    const loginEvents = feed.body.events.filter((e) => e.type === "login_failed");
    expect(loginEvents).toHaveLength(1);
    expect(loginEvents[0].title).toBe(`${FLOOD} failed login attempts`);
    expect(loginEvents[0].ref.count).toBe(FLOOD);

    // The authed endpoint exposes the same truth alongside the capped events.
    const api = await request(app).get("/api/auth/failed-logins").set("Cookie", cookie);
    expect(api.status).toBe(200);
    expect(api.body.live).toMatchObject({ count: FLOOD });
  });
});

// ---------------------------------------------------------------------------
// The same condition applied to the SIM-393 sync surface: its 429 branch also
// called the recorder on EVERY post-cap request with an unbounded direct
// appendActivity - it now rides the same bounded monitor (surface:"sync").
describe("integration: guardian condition 1 - the sync surface is write-bounded too", () => {
  let app;
  let tmpRoot;
  let docsDir;
  const FLOOD = 60;
  const SYNC_AUTH_MAX_FAILURES = 20; // pinned server-side constant (per IP per window)

  beforeAll(async () => {
    ({ app, tmpRoot, docsDir } = await loadApp({
      SYNC_TOKEN_HASH: hashToken("sync-token-abcdefghij-1234567890"),
    }));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it(`${FLOOD} bad sync tokens -> at most CAP+1 durable lines, 401/429 responses intact`, async () => {
    const statuses = [];
    for (let i = 0; i < FLOOD; i++) {
      const res = await request(app).get("/api/sync/manifest").set("authorization", "Bearer wrong-token");
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body).toEqual({ error: "too many failed sync-auth attempts; try again later" });
      }
    }
    // Sync's own per-IP limiter: 20 bad-token 401s, then 429s only.
    expect(statuses.slice(0, SYNC_AUTH_MAX_FAILURES).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(SYNC_AUTH_MAX_FAILURES).every((s) => s === 429)).toBe(true);

    const lines = activityRaw(docsDir).split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const failures = lines.filter((r) => r.kind === "auth" && r.event === "login_failed" && r.surface === "sync");
    const alerts = lines.filter((r) => r.kind === "auth" && r.event === "login_failures_threshold" && r.surface === "sync");
    expect(failures).toHaveLength(FAILED_LOGIN_DURABLE_CAP); // 60 requests, 20 durable lines
    expect(alerts).toHaveLength(1);
    // GC-2(c) posture preserved: bad_token lines, no credential material.
    expect(failures[0]).toMatchObject({ reason: "bad_token", surface: "sync" });
    expect(activityRaw(docsDir)).not.toContain("wrong-token");
  });
});
