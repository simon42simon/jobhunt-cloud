import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Usage-journey telemetry (ADR-017): the local-only, events-not-content movement
// log (docs/usage-telemetry.jsonl), its fire-and-forget beacon POST, and the
// aggregate summary GET. Hermetic - JOBHUNT_DOCS_DIR points the store at a
// throwaway temp dir (the same docs test seam discovery-sources / tasks use), so
// the suite never touches the real docs/usage-telemetry.jsonl. The pure helpers
// (validateTelemetryEvent, summarizeTelemetry) are exercised directly, and the
// endpoints through supertest.

let app;
let pure;
let tmpRoot;
let docsDir;
let jobsDir;

const TELE = () => path.join(docsDir, "usage-telemetry.jsonl");

// Read the raw store back as parsed event objects (skips blank lines).
function storedEvents() {
  let raw;
  try {
    raw = fs.readFileSync(TELE(), "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const evt = (over = {}) => ({ sessionId: "s1", kind: "view", surface: "jobs-board", name: "open", ...over });

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-usage-tele-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  const mod = await import("../server/index.js");
  app = mod.app;
  pure = mod;
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Fresh store per test (all tests share the one seamed docs dir).
  fs.rmSync(TELE(), { force: true });
});

// ---------------------------------------------------------------------------
// POST /api/telemetry - the beacon target.
// ---------------------------------------------------------------------------
describe("POST /api/telemetry (append + counts)", () => {
  it("appends a valid batch and reports { accepted, dropped }", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt(), evt({ kind: "action", surface: "job-detail", name: "save" })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 2, dropped: 0 });
    const stored = storedEvents();
    expect(stored.length).toBe(2);
    expect(stored[0].kind).toBe("view");
    expect(stored[1].surface).toBe("job-detail");
  });

  it("server-stamps ts and ignores a client-supplied ts (unforgeable)", async () => {
    const before = Date.now();
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt({ ts: "1999-01-01T00:00:00.000Z" })] });
    expect(res.status).toBe(200);
    const [stored] = storedEvents();
    expect(stored.ts).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Date.parse(stored.ts)).toBeGreaterThanOrEqual(before - 1000);
    // Only the validated core is stored - no leaked client fields.
    expect(Object.keys(stored).sort()).toEqual(["kind", "name", "sessionId", "surface", "ts"]);
  });

  it("junk kind is a loud 400 (the closed-enum discriminator)", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt({ kind: "delete" })] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ accepted: 0, dropped: 1 });
    expect(storedEvents().length).toBe(0);
  });

  it("a bad kind still 400s but appends the valid siblings in the batch", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt(), evt({ kind: "nope" }), evt({ name: "close" })] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ accepted: 2, dropped: 1 });
    expect(storedEvents().length).toBe(2);
  });

  it("an unknown surface is dropped-not-fatal (200, counted, valid siblings persist)", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt(), evt({ surface: "totally-made-up" })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1, dropped: 1 });
    expect(storedEvents().length).toBe(1);
  });

  it("a batch mixing a valid event + an unknown-surface event + a junk-kind event 400s with correct accepted/dropped AND the valid event is genuinely persisted", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({
        events: [
          evt({ name: "keep-me" }), // valid
          evt({ surface: "not-a-real-surface" }), // soft drop
          evt({ kind: "delete" }), // hard drop - forces the 400
        ],
      });
    expect(res.status).toBe(400); // the one hard (junk-kind) failure makes the whole response loud
    expect(res.body).toEqual({ accepted: 1, dropped: 2 });
    // Not just a count check - read the store back and prove the valid one truly landed.
    const stored = storedEvents();
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("keep-me");
    expect(stored[0].surface).toBe("jobs-board");
  });

  it("truncates an oversized name to 80 chars (documented: truncate, not reject)", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ events: [evt({ name: "x".repeat(200) })] });
    expect(res.status).toBe(200);
    const [stored] = storedEvents();
    expect(stored.name.length).toBe(80);
  });

  it("coerces + caps meta: <=8 keys, scalar-only, string values <=60 chars", async () => {
    const meta = {
      longstr: "y".repeat(100),
      num: 5,
      flag: true,
      nested: { deep: 1 }, // dropped (content-block)
      arr: [1, 2, 3], // dropped
      nil: null, // dropped
      k3: "c",
      k4: "d",
      k5: "e",
      k6: "f",
      k7: "g", // 8th surviving key
      k8: "h", // over the cap -> not stored
    };
    const res = await request(app).post("/api/telemetry").send({ events: [evt({ meta })] });
    expect(res.status).toBe(200);
    const [stored] = storedEvents();
    expect(Object.keys(stored.meta).length).toBe(8);
    expect(stored.meta.longstr.length).toBe(60);
    expect(stored.meta.num).toBe(5);
    expect(stored.meta.flag).toBe(true);
    expect("nested" in stored.meta).toBe(false);
    expect("arr" in stored.meta).toBe(false);
    expect("nil" in stored.meta).toBe(false);
    expect("k8" in stored.meta).toBe(false);
  });

  it("a __proto__/constructor/prototype-shaped meta cannot pollute Object.prototype - the event survives, and only safe keys are stored", async () => {
    // Sent as a raw JSON string (not a JS object literal) so the wire bytes carry
    // a genuine "__proto__" key the way `JSON.parse` reconstitutes it server-side
    // (an object-literal `{ __proto__: ... }` in test source would instead set the
    // literal's prototype and never reach the server at all - that would prove
    // nothing about the server's own defenses).
    const raw =
      '{"events":[{"sessionId":"s1","kind":"view","surface":"jobs-board","name":"open",' +
      '"meta":{"__proto__":"polluted","constructor":"ctor-val","prototype":"proto-val","safe":"ok"}}]}';
    const res = await request(app).post("/api/telemetry").set("Content-Type", "application/json").send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1, dropped: 0 });

    // No global pollution: a brand-new plain object is unaffected.
    expect(({}).polluted).toBe(undefined);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    const [stored] = storedEvents();
    // `__proto__` assigned via a computed key with a scalar value is a documented
    // no-op (the inherited setter ignores non-object/non-null values), so it never
    // becomes an own key on the stored meta at all - it is not merely "sanitized",
    // it is structurally absent.
    expect(Object.prototype.hasOwnProperty.call(stored.meta, "__proto__")).toBe(false);
    expect("__proto__" in stored.meta).toBe(true); // still true - inherited from Object.prototype, not an own key
    // constructor/prototype are ordinary (if unusually named) own string keys -
    // shadowing them on one plain object is not pollution.
    expect(Object.keys(stored.meta).sort()).toEqual(["constructor", "prototype", "safe"]);
    expect(stored.meta.constructor).toBe("ctor-val");
    expect(stored.meta.prototype).toBe("proto-val");
    expect(stored.meta.safe).toBe("ok");
  });

  it("keeps a valid journey + durationMs, and drops invalid optional fields (event survives)", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({
        events: [
          evt({ journey: "J3", durationMs: 1200 }),
          evt({ journey: "banana", durationMs: -5 }), // both invalid -> fields dropped
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 2, dropped: 0 });
    const stored = storedEvents();
    expect(stored[0].journey).toBe("J3");
    expect(stored[0].durationMs).toBe(1200);
    expect("journey" in stored[1]).toBe(false);
    expect("durationMs" in stored[1]).toBe(false);
  });

  it("keeps journey J10 (2-digit boundary) and drops J123 / lowercase j4 / junk as a FIELD - the event always survives", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({
        events: [
          evt({ journey: "J10" }),
          evt({ journey: "J123" }), // 3 digits - past the \d{1,2} boundary
          evt({ journey: "j4" }), // lowercase - the enum is case-sensitive
          evt({ journey: "junk" }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 4, dropped: 0 });
    const stored = storedEvents();
    expect(stored.length).toBe(4);
    expect(stored[0].journey).toBe("J10");
    expect("journey" in stored[1]).toBe(false);
    expect("journey" in stored[2]).toBe(false);
    expect("journey" in stored[3]).toBe(false);
  });

  it("drops a negative, NaN-string, or non-numeric durationMs as a FIELD - the event always survives", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({
        events: [evt({ durationMs: -1 }), evt({ durationMs: "NaN" }), evt({ durationMs: "fast" })],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 3, dropped: 0 });
    const stored = storedEvents();
    expect(stored.length).toBe(3);
    expect(stored.every((e) => !("durationMs" in e))).toBe(true);
  });

  it("rejects a batch over the 50-event cap with 400 and appends nothing", async () => {
    const events = Array.from({ length: 51 }, () => evt());
    const res = await request(app).post("/api/telemetry").send({ events });
    expect(res.status).toBe(400);
    expect(res.body.dropped).toBe(51);
    expect(res.body.accepted).toBe(0);
    expect(storedEvents().length).toBe(0);
  });

  it("accepts exactly 50 events (the boundary)", async () => {
    const events = Array.from({ length: 50 }, () => evt());
    const res = await request(app).post("/api/telemetry").send({ events });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(50);
    expect(storedEvents().length).toBe(50);
  });

  it("rejects a body whose events is not an array with 400 (nothing appended)", async () => {
    const res = await request(app).post("/api/telemetry").send({ events: "nope" });
    expect(res.status).toBe(400);
    expect(storedEvents().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/summary - the aggregate read model.
// ---------------------------------------------------------------------------
describe("GET /api/telemetry/summary", () => {
  it("aggregates counts and tolerates malformed / non-object lines", async () => {
    fs.writeFileSync(
      TELE(),
      [
        JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", sessionId: "s", kind: "view", surface: "jobs-board", name: "a" }),
        JSON.stringify({ ts: "2026-07-02T00:00:00.000Z", sessionId: "s", kind: "view", surface: "jobs-board", name: "b" }),
        JSON.stringify({ ts: "2026-07-03T00:00:00.000Z", sessionId: "s", kind: "action", surface: "job-detail", name: "a" }),
        "{ this is not valid json",
        JSON.stringify([1, 2, 3]), // valid JSON, not an object
        "", // blank -> skipped, not counted as malformed
        JSON.stringify({ ts: "2026-07-04T00:00:00.000Z", sessionId: "s", kind: "run", surface: "insights", name: "c" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const res = await request(app).get("/api/telemetry/summary");
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(4);
    expect(res.body.malformed).toBe(2);
    expect(res.body.byKind).toEqual({ view: 2, action: 1, run: 1 });
    expect(res.body.firstTs).toBe("2026-07-01T00:00:00.000Z");
    expect(res.body.lastTs).toBe("2026-07-04T00:00:00.000Z");
    expect(res.body.bySurface[0]).toEqual({ surface: "jobs-board", count: 2 });
    expect(res.body.byName[0]).toEqual({ name: "a", count: 2 });
  });

  it("returns an empty summary when the file is missing (never a 500)", async () => {
    const res = await request(app).get("/api/telemetry/summary");
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.firstTs).toBe(null);
    expect(res.body.lastTs).toBe(null);
    expect(res.body.byKind).toEqual({ view: 0, action: 0, run: 0 });
    expect(res.body.bySurface).toEqual([]);
    expect(res.body.byName).toEqual([]);
    expect(res.body.malformed).toBe(0);
  });

  it("round-trips POST -> summary", async () => {
    await request(app)
      .post("/api/telemetry")
      .send({ events: [evt(), evt({ kind: "run", surface: "insights", name: "insights-run" })] });
    const res = await request(app).get("/api/telemetry/summary");
    expect(res.body.totalEvents).toBe(2);
    expect(res.body.byKind.view).toBe(1);
    expect(res.body.byKind.run).toBe(1);
  });

  it("caps bySurface at 15 and byName at 20", async () => {
    const lines = [];
    // 18 distinct surfaces would exceed 15, but surface is allowlisted (11 max);
    // use names to prove the top-N cap and surfaces to prove <=15 holds.
    for (let i = 0; i < 25; i++) {
      lines.push(
        JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", sessionId: "s", kind: "view", surface: "jobs-board", name: `name-${i}` }),
      );
    }
    fs.writeFileSync(TELE(), lines.join("\n") + "\n", "utf8");
    const res = await request(app).get("/api/telemetry/summary");
    expect(res.body.byName.length).toBe(20);
    expect(res.body.bySurface.length).toBeLessThanOrEqual(15);
  });

  it("byName's top-20 truncation actually truncates BY COUNT (not an arbitrary 20 of 25)", async () => {
    const lines = [];
    // 25 distinct names with strictly decreasing, all-different counts (25 down to
    // 1), so the top-20 cut has one unambiguous correct answer: name-0..name-19
    // survive (counts 25..6) and name-20..name-24 (counts 5..1) are dropped.
    for (let i = 0; i < 25; i++) {
      const count = 25 - i;
      for (let c = 0; c < count; c++) {
        lines.push(
          JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", sessionId: "s", kind: "view", surface: "jobs-board", name: `name-${i}` }),
        );
      }
    }
    fs.writeFileSync(TELE(), lines.join("\n") + "\n", "utf8");
    const res = await request(app).get("/api/telemetry/summary");
    expect(res.body.byName.length).toBe(20);
    expect(res.body.byName[0]).toEqual({ name: "name-0", count: 25 });
    expect(res.body.byName[19]).toEqual({ name: "name-19", count: 6 });
    const survivingNames = res.body.byName.map((r) => r.name);
    expect(survivingNames).not.toContain("name-20");
    expect(survivingNames).not.toContain("name-24");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers - validateTelemetryEvent / summarizeTelemetry.
// ---------------------------------------------------------------------------
describe("validateTelemetryEvent (pure)", () => {
  const ts = "2026-07-04T12:00:00.000Z";

  it("accepts a well-formed event and injects the server ts", () => {
    const r = pure.validateTelemetryEvent(evt(), ts);
    expect(r.ok).toBe(true);
    expect(r.event.ts).toBe(ts);
    expect(r.event).toMatchObject({ sessionId: "s1", kind: "view", surface: "jobs-board", name: "open" });
  });

  it("rejects a junk kind as HARD (the loud-400 trigger)", () => {
    const r = pure.validateTelemetryEvent(evt({ kind: "junk" }), ts);
    expect(r.ok).toBe(false);
    expect(r.hard).toBe(true);
  });

  it("rejects an unknown surface as SOFT", () => {
    const r = pure.validateTelemetryEvent(evt({ surface: "ghost" }), ts);
    expect(r.ok).toBe(false);
    expect(r.hard).toBe(false);
  });

  it("soft-drops a missing sessionId or name; strips control chars from name", () => {
    expect(pure.validateTelemetryEvent(evt({ sessionId: "" }), ts).ok).toBe(false);
    expect(pure.validateTelemetryEvent(evt({ name: "   " }), ts).ok).toBe(false);
    const r = pure.validateTelemetryEvent(evt({ name: "a\u0000b  c" }), ts);
    expect(r.ok).toBe(true);
    expect(r.event.name).toBe("ab c"); // NUL control char stripped, double space collapsed
  });

  it("soft-drops a non-object event", () => {
    for (const bad of [null, "str", 42, [1]]) {
      const r = pure.validateTelemetryEvent(bad, ts);
      expect(r.ok).toBe(false);
      expect(r.hard).toBe(false);
    }
  });

  it("exposes the closed enum + allowlist contract", () => {
    expect(pure.TELEMETRY_KINDS).toEqual(["view", "action", "run"]);
    expect(pure.TELEMETRY_SURFACES).toContain("jobs-board");
    expect(pure.TELEMETRY_SURFACES).toContain("topbar");
    expect(pure.TELEMETRY_MAX_BATCH).toBe(50);
  });
});

describe("summarizeTelemetry (pure)", () => {
  it("returns an empty summary for empty / nullish input", () => {
    const empty = pure.summarizeTelemetry("");
    expect(empty.totalEvents).toBe(0);
    expect(empty.firstTs).toBe(null);
    expect(empty.byKind).toEqual({ view: 0, action: 0, run: 0 });
    expect(pure.summarizeTelemetry(null).totalEvents).toBe(0);
  });

  it("computes firstTs/lastTs order-independently (min/max, not file order)", () => {
    const text =
      [
        JSON.stringify({ ts: "2026-07-05T00:00:00.000Z", kind: "view", surface: "topbar", name: "z" }),
        JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", kind: "view", surface: "topbar", name: "a" }),
      ].join("\n") + "\n";
    const s = pure.summarizeTelemetry(text);
    expect(s.firstTs).toBe("2026-07-01T00:00:00.000Z");
    expect(s.lastTs).toBe("2026-07-05T00:00:00.000Z");
  });
});
