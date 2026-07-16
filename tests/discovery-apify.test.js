import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import yaml from "js-yaml";

// The SERVER side of the type:"apify" discovery source (ADR 2026-07-06; guardian
// conditions C1-C10, ticket t-1783339605935). A deterministic, server-side,
// cost-capped run path that CANNOT fire until the owner sets apifyEnabled AND
// provides APIFY_TOKEN. This suite proves it hermetically - ZERO network, ZERO
// spend:
//   - JOBHUNT_APIFY_FIXTURE feeds canned dataset items (no real Apify call);
//   - JOBHUNT_APIFY_STATUS drives the error branches (401 / 5xx / bad-shape);
//   - node:child_process.execFile (the discovery.py `add` write) is mocked so
//     the finds seam (JOBHUNT_DISCOVERY_FINDS) is the only finds store touched;
//   - JOBHUNT_APIFY_ENABLED / _MAX_SWEEP / _MONTHLY_CAP are the owner-launch
//     overrides used to exercise the gate + the cost caps without real config.
// The token used below is a sentinel; a dedicated test asserts it appears in
// ZERO logs / errors / responses (guardian C4).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
// ADR-023: live board files left docs/ for the data zone; suites overlay the
// committed synthetic fixtures so the server boots against tracked test data.
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");
const SENTINEL_TOKEN = "apify_api_SENTINEL-DO-NOT-LEAK-9f8e7d6c";

// ---- child_process mock: capture discovery.py `add` calls, swap behaviour ----
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", 0));
  return proc;
}
const spawnMock = vi.fn(() => makeFakeProc());

// Swappable so a test can make the workbook write succeed or report a lock.
let addBehaviour = "ok"; // "ok" | "locked"
const addCalls = [];
let FINDS_FILE = null;

function invokeCb(args, err, stdout, stderr) {
  const cb = typeof args[2] === "function" ? args[2] : args[3];
  setImmediate(() => cb(err, stdout, stderr));
  return new EventEmitter();
}
const execFileMock = vi.fn((...args) => {
  const argv = args[1];
  if (Array.isArray(argv) && argv[1] === "add") {
    // discovery.py add <date> <title> <employer> <sector> <track> <fit>
    //                  <deadline> <location> <source> <link> [notes] [source_id]
    const [, , date, title, employer, , , , , location, source, link, notes, sourceId] = argv;
    addCalls.push({ date, title, employer, location, source, link, notes, sourceId });
    if (addBehaviour === "locked") {
      return invokeCb(args, Object.assign(new Error("locked"), { code: 4 }), "", "LOCKED: Job Discovery.xlsx is open in Excel");
    }
    // Mirror discovery.py's real side effect into the finds seam so leadsNew is
    // asserted end-to-end (baseline captured before the run -> after includes
    // these rows).
    try {
      const disc = JSON.parse(fs.readFileSync(FINDS_FILE, "utf8"));
      disc.discoveries.push({ Title: title, Source: source, sourceId, Link: link, "Date Found": date, Decision: "" });
      fs.writeFileSync(FINDS_FILE, JSON.stringify(disc), "utf8");
    } catch {
      /* ignore - a test may not use the finds seam */
    }
    return invokeCb(args, null, `ADDED row: ${title}`, "");
  }
  // discovery.py prune (run-all-due) and anything else -> benign success.
  return invokeCb(args, null, "PRUNED 0 rows\n", "");
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...a) => spawnMock(...a), execFile: (...a) => execFileMock(...a) };
});

let app;
let pure;
let tmpRoot;
let docsDir;
let jobsDir;

const SOURCES_YAML = () => path.join(docsDir, "discovery-sources.yaml");
const ACTIVITY_LOG = () => path.join(docsDir, "activity-log.jsonl");

function setSources(sources) {
  fs.writeFileSync(SOURCES_YAML(), yaml.dump({ version: 1, sources }), "utf8");
}
function setFinds(discoveries) {
  fs.writeFileSync(FINDS_FILE, JSON.stringify({ config: [], discoveries, runLog: [] }), "utf8");
}
function writeFixture(items) {
  const p = path.join(tmpRoot, `apify-fixture-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(items), "utf8");
  return p;
}
async function waitFor(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const getSource = async (id) => (await request(app).get(`/api/discovery/sources/${id}`)).body;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-apify-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  FINDS_FILE = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
  setFinds([]);
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = FINDS_FILE;
  vi.resetModules();
  const mod = await import("../server/index.js");
  app = mod.app;
  pure = mod;
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  for (const k of ["APIFY_TOKEN", "JOBHUNT_APIFY_ENABLED", "JOBHUNT_APIFY_FIXTURE", "JOBHUNT_APIFY_STATUS", "JOBHUNT_APIFY_MAX_SWEEP", "JOBHUNT_APIFY_MONTHLY_CAP", "JOBHUNT_APIFY_MAX_ITEMS"]) {
    delete process.env[k];
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  setSources([]);
  setFinds([]);
  addCalls.length = 0;
  addBehaviour = "ok";
  spawnMock.mockClear();
  execFileMock.mockClear();
  // Off by default every test; a test opts IN explicitly.
  for (const k of ["APIFY_TOKEN", "JOBHUNT_APIFY_ENABLED", "JOBHUNT_APIFY_FIXTURE", "JOBHUNT_APIFY_STATUS", "JOBHUNT_APIFY_MAX_SWEEP", "JOBHUNT_APIFY_MONTHLY_CAP", "JOBHUNT_APIFY_MAX_ITEMS"]) {
    delete process.env[k];
  }
});

function enableApify() {
  process.env.JOBHUNT_APIFY_ENABLED = "1";
  process.env.APIFY_TOKEN = SENTINEL_TOKEN;
}

// ===========================================================================
// PURE UNITS - importable under JOBHUNT_TEST=1, no server boot, no network.
// ===========================================================================

describe("sanitizeActorId (guardian C2 - never a URL, actor-id charset only)", () => {
  it("accepts the tilde and slash actor-id forms + hex-ish ids", () => {
    expect(pure.sanitizeActorId("misceres~indeed-scraper")).toBe("misceres~indeed-scraper");
    expect(pure.sanitizeActorId("username/actorName")).toBe("username/actorName");
    expect(pure.sanitizeActorId("  aBcD_123~.-  ")).toBe("aBcD_123~.-");
  });
  it("REJECTS a full URL, a scheme, whitespace, query/fragment, and path escapes", () => {
    for (const bad of [
      "https://api.apify.com/v2/acts/x",
      "http://evil.com/x",
      "actor?token=leak",
      "actor#frag",
      "a b",
      "a\tb",
      "../etc/passwd",
      "a//b",
      "/leading",
      "trailing/",
      "acts&other",
      "back\\slash",
      "",
    ]) {
      expect(pure.sanitizeActorId(bad), `should reject ${JSON.stringify(bad)}`).toBe("");
    }
  });
});

describe("clampMaxItems (guardian C5b - hard per-run ceiling)", () => {
  it("clamps a value DOWN to the ceiling and floors absent/invalid at the ceiling", () => {
    expect(pure.clampMaxItems(9999, 50)).toBe(50);
    expect(pure.clampMaxItems(10, 50)).toBe(10);
    expect(pure.clampMaxItems(50, 50)).toBe(50);
    expect(pure.clampMaxItems(undefined, 50)).toBe(50);
    expect(pure.clampMaxItems(0, 50)).toBe(50);
    expect(pure.clampMaxItems(-5, 50)).toBe(50);
    expect(pure.clampMaxItems("30", 50)).toBe(30);
  });
});

describe("buildApifyInput (guardian C1 - built SOLELY from the source record)", () => {
  it("is a source-only, byte-stable copy with count knobs clamped; injects nothing", () => {
    const source = { id: "s", input: { position: "product manager", location: "Toronto, ON", maxItems: 9999, maxResults: 500 } };
    const a = pure.buildApifyInput(source, 50);
    const b = pure.buildApifyInput(source, 50);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // byte-stable for a fixed source
    expect(a).toEqual({ position: "product manager", location: "Toronto, ON", maxItems: 50, maxResults: 50 });
    // Only the owner-typed keys survive; nothing is added from anywhere else.
    expect(Object.keys(a).sort()).toEqual(["location", "maxItems", "maxResults", "position"]);
  });
  it("defaults to {} when the source has no input", () => {
    expect(pure.buildApifyInput({ id: "s" }, 50)).toEqual({});
  });
});

describe("sanitizeCell (guardian C9 - xlsx formula-injection guard)", () => {
  it("quote-prefixes a leading formula/command trigger, leaves safe text alone", () => {
    expect(pure.sanitizeCell("=1+1")).toBe("'=1+1");
    expect(pure.sanitizeCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(pure.sanitizeCell("-2")).toBe("'-2");
    expect(pure.sanitizeCell("@cmd")).toBe("'@cmd");
    expect(pure.sanitizeCell("\t=danger")).toBe("'\t=danger");
    expect(pure.sanitizeCell("Senior PM")).toBe("Senior PM");
    expect(pure.sanitizeCell("https://x/y")).toBe("https://x/y");
    expect(pure.sanitizeCell(null)).toBe("");
  });
});

describe("mapApifyItem / mapApifyDataset (defensive alias mapping)", () => {
  const source = { id: "indeed", name: "Indeed (Apify)", sector: "private" };

  it("resolves default aliases; blanks track/fit; stamps sector/source/sourceId", () => {
    const f = pure.mapApifyItem(source, { jobTitle: "Engineer", companyName: "Acme", applyUrl: "https://a/1", city: "Toronto", salary: "$120k" }, "2026-07-06");
    expect(f.title).toBe("Engineer");
    expect(f.employer).toBe("Acme");
    expect(f.link).toBe("https://a/1");
    expect(f.location).toBe("Toronto");
    expect(f.notes).toBe("Salary: $120k");
    expect(f.track).toBe(""); // never fabricated
    expect(f.fit).toBe("");
    expect(f.sector).toBe("private");
    expect(f.source).toBe("Indeed (Apify)");
    expect(f.sourceId).toBe("indeed");
    expect(f.date).toBe("2026-07-06");
  });

  it("source.fieldMap overrides the defaults (proves the override, not a default hit)", () => {
    const s2 = { ...source, fieldMap: { title: "customTitle", link: "customLink" } };
    const f = pure.mapApifyItem(s2, { customTitle: "PM", customLink: "https://a/2", company: "Beta" }, "2026-07-06");
    expect(f.title).toBe("PM");
    expect(f.link).toBe("https://a/2");
    expect(f.employer).toBe("Beta");
    // Without the fieldMap those non-default keys resolve to nothing:
    const bare = pure.mapApifyItem(source, { customTitle: "PM", customLink: "https://a/2" }, "2026-07-06");
    expect(bare).toBeNull(); // no title, no link -> unusable
  });

  it("skips an item missing BOTH title and link (-> null)", () => {
    expect(pure.mapApifyItem(source, { company: "Co", location: "X" }, "2026-07-06")).toBeNull();
  });

  it("runs every untrusted field through the formula-injection guard (C9)", () => {
    const f = pure.mapApifyItem(source, { title: "=cmd|'/c calc'!A1", company: "+SUM(1)", url: "https://a/3", location: "@evil", deadline: "-2026" }, "2026-07-06");
    expect(f.title.startsWith("'=")).toBe(true);
    expect(f.employer.startsWith("'+")).toBe(true);
    expect(f.location.startsWith("'@")).toBe(true);
    expect(f.deadline.startsWith("'-")).toBe(true);
    expect(f.link).toBe("https://a/3"); // a real link is untouched
  });

  it("dataset: counts unusable + within-batch duplicate links as skipped", () => {
    const items = [
      { title: "A", url: "https://a/1" },
      { title: "B", url: "https://a/1" }, // dup link -> dropped
      { title: "C", url: "https://a/2" },
      { location: "nowhere" }, // no title/link -> unusable
    ];
    const { finds, skipped } = pure.mapApifyDataset(source, items, "2026-07-06");
    expect(finds.map((f) => f.title)).toEqual(["A", "C"]);
    expect(skipped).toBe(2);
  });

  it("dataset: DROPS a find whose deadline already passed; keeps today / future / free-text / absent (t-1783422051088)", () => {
    const items = [
      { title: "Expired", url: "https://a/1", deadline: "2026-07-05" }, // strictly before today -> dropped
      { title: "Today", url: "https://a/2", deadline: "2026-07-06" }, // deadline == today -> still live
      { title: "Future", url: "https://a/3", deadline: "2026-08-01" }, // future -> kept
      { title: "Rolling", url: "https://a/4", deadline: "rolling" }, // free text -> never judged, kept
      { title: "NoDeadline", url: "https://a/5" }, // absent -> never judged, kept
    ];
    const { finds, skipped } = pure.mapApifyDataset(source, items, "2026-07-06");
    // The expired one is gone; every still-applyable posting survives.
    expect(finds.map((f) => f.title)).toEqual(["Today", "Future", "Rolling", "NoDeadline"]);
    expect(skipped).toBe(1); // the expired item counted as filtered-out, not silently lost
  });
});

describe("countApifyRunsThisMonth (guardian C5c - DERIVED from runs[], no new store)", () => {
  it("counts apify runs in the current LOCAL month across apify sources only", () => {
    const now = new Date("2026-07-15T12:00:00");
    const thisMonth = "2026-07-03T09:00:00";
    const lastMonth = "2026-06-28T09:00:00";
    const sources = [
      { type: "apify", runs: [{ startedAt: thisMonth }, { startedAt: thisMonth }, { startedAt: lastMonth }] },
      { type: "apify", runs: [{ startedAt: thisMonth }] },
      { type: "board", runs: [{ startedAt: thisMonth }] }, // agent runs must NOT count
    ];
    expect(pure.countApifyRunsThisMonth(sources, now)).toBe(3);
  });
});

describe("selectApifySweepTargets (guardian C5c + C5d - budget + monthly cap)", () => {
  const mk = (id, daysAgo) => ({ id, lastRunAt: new Date(Date.now() - daysAgo * 86400000).toISOString() });
  const due = [mk("a", 10), mk("b", 5), mk("c", 3)];

  it("launches most-overdue-first, capped at the per-sweep budget", () => {
    const { launch, skippedBudget } = pure.selectApifySweepTargets(due, { perSweepCap: 1, monthlyCount: 0, monthlyCap: 100 });
    expect(launch.map((s) => s.id)).toEqual(["a"]); // oldest lastRunAt first
    expect(skippedBudget.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("launches all when the per-sweep cap and monthly room both allow it", () => {
    const { launch } = pure.selectApifySweepTargets(due, { perSweepCap: 5, monthlyCount: 0, monthlyCap: 100 });
    expect(launch.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("FILTERS OUT every apify source at the monthly cap (launches zero)", () => {
    const { launch, skippedBudget } = pure.selectApifySweepTargets(due, { perSweepCap: 5, monthlyCount: 100, monthlyCap: 100 });
    expect(launch).toEqual([]);
    expect(skippedBudget).toHaveLength(3);
  });

  it("never crosses the monthly cap mid-sweep (budget = min(perSweep, room left))", () => {
    const { launch } = pure.selectApifySweepTargets(due, { perSweepCap: 5, monthlyCount: 99, monthlyCap: 100 });
    expect(launch).toHaveLength(1); // only 1 slot left this month
  });
});

describe("apifyConfigured (guardian C5a - enable flag AND token, both required)", () => {
  it("is true ONLY when enabled AND a token is present", () => {
    process.env.JOBHUNT_APIFY_ENABLED = "1";
    process.env.APIFY_TOKEN = SENTINEL_TOKEN;
    expect(pure.apifyConfigured()).toBe(true);

    delete process.env.APIFY_TOKEN; // token alone missing
    expect(pure.apifyConfigured()).toBe(false);

    process.env.APIFY_TOKEN = SENTINEL_TOKEN;
    process.env.JOBHUNT_APIFY_ENABLED = "0"; // enabled off, token present
    expect(pure.apifyConfigured()).toBe(false);

    delete process.env.JOBHUNT_APIFY_ENABLED;
    delete process.env.APIFY_TOKEN;
    expect(pure.apifyConfigured()).toBe(false);
  });
});

// ===========================================================================
// SCHEMA - POST / validation / round-trip (supertest).
// ===========================================================================

describe("POST /api/discovery/sources (apify schema + validation)", () => {
  it("creates an apify source and round-trips actorId / input / fieldMap", async () => {
    const res = await request(app)
      .post("/api/discovery/sources")
      .send({
        name: "Indeed Apify",
        type: "apify",
        sector: "private",
        actorId: "misceres~indeed-scraper",
        input: { position: "product manager", location: "Toronto, ON", maxItems: 50 },
        fieldMap: { title: "positionName", link: "jobUrl" },
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("apify");
    expect(res.body.actorId).toBe("misceres~indeed-scraper");
    expect(res.body.input).toEqual({ position: "product manager", location: "Toronto, ON", maxItems: 50 });
    expect(res.body.fieldMap).toEqual({ title: "positionName", link: "jobUrl" });
    // persisted, not just echoed
    const onDisk = yaml.load(fs.readFileSync(SOURCES_YAML(), "utf8")).sources.find((s) => s.id === res.body.id);
    expect(onDisk.actorId).toBe("misceres~indeed-scraper");
    expect(onDisk.input.position).toBe("product manager");
  });

  it("400s an apify source with no actorId", async () => {
    const res = await request(app).post("/api/discovery/sources").send({ name: "X", type: "apify" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorId/i);
  });

  it("400s an apify source whose actorId is a URL (sanitizes to empty)", async () => {
    const res = await request(app)
      .post("/api/discovery/sources")
      .send({ name: "X", type: "apify", actorId: "https://api.apify.com/v2/acts/evil" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorId/i);
  });

  it("400s a non-object input / fieldMap", async () => {
    const bad1 = await request(app).post("/api/discovery/sources").send({ name: "X", type: "apify", actorId: "a~b", input: "not-json" });
    expect(bad1.status).toBe(400);
    expect(bad1.body.error).toMatch(/input must be a JSON object/);
    const bad2 = await request(app).post("/api/discovery/sources").send({ name: "X", type: "apify", actorId: "a~b", fieldMap: [1, 2] });
    expect(bad2.status).toBe(400);
    expect(bad2.body.error).toMatch(/fieldMap must be a JSON object/);
  });
});

// ===========================================================================
// GET - apifyConfigured signal (never the token).
// ===========================================================================

describe("GET /api/discovery/sources - apifyConfigured signal (guardian C4/C5a)", () => {
  it("reports apifyConfigured:false when no token / not enabled, and never leaks a token", async () => {
    setSources([{ id: "ap", name: "Ap", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "a~b" }]);
    const list = await request(app).get("/api/discovery/sources");
    expect(list.status).toBe(200);
    expect(list.body.apifyConfigured).toBe(false);
    const one = await request(app).get("/api/discovery/sources/ap");
    expect(one.body.apifyConfigured).toBe(false);
  });

  it("reports apifyConfigured:true once enabled AND a token is present", async () => {
    enableApify();
    setSources([{ id: "ap", name: "Ap", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "a~b" }]);
    const list = await request(app).get("/api/discovery/sources");
    expect(list.body.apifyConfigured).toBe(true);
    // the token value itself is NEVER in the payload
    expect(JSON.stringify(list.body)).not.toContain(SENTINEL_TOKEN);
  });
});

// ===========================================================================
// RUN-NOW - the spend gate + the fixture happy path + error branches.
// ===========================================================================

describe("POST /api/discovery/sources/:id/run (apify spend gate, guardian C5a)", () => {
  beforeEach(() => {
    setSources([{ id: "ap", name: "Indeed Apify", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "misceres~indeed-scraper", input: { position: "pm" } }]);
  });

  it("refuses (400) and writes NO run record when apify is disabled / token-less", async () => {
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Configure APIFY_TOKEN and enable Apify/);
    // No optimistic record, cadence NOT advanced, no outbound write attempted.
    const s = await getSource("ap");
    expect(s.runs).toEqual([]);
    expect(s.lastRunAt).toBe(null);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("token present but NOT enabled is still refused (token alone is never enough)", async () => {
    process.env.APIFY_TOKEN = SENTINEL_TOKEN; // no JOBHUNT_APIFY_ENABLED
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(400);
    const s = await getSource("ap");
    expect(s.runs).toEqual([]);
  });

  it("enabled + token + fixture -> optimistic running, then succeeded with mapped finds", async () => {
    enableApify();
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([
      { positionName: "Product Manager", company: "Acme", jobUrl: "https://a/1", location: "Toronto" },
      { positionName: "Senior PM", company: "Beta", jobUrl: "https://a/2", location: "Remote" },
    ]);
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.source.runs[0].outcome).toBe("running"); // optimistic
    expect(res.body.source.runs[0].trigger).toBe("manual");

    const done = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "succeeded");
    expect(done).toBe(true);
    const s = await getSource("ap");
    const rec = s.runs[0];
    expect(rec.outcome).toBe("succeeded");
    expect(rec.leadsNew).toBe(2); // both finds new since the (0) baseline
    expect(rec.candidatesReviewed).toBe(2); // honesty counters, server-computed
    expect(rec.filteredOut).toBe(0);
    // discovery.py add was the write path, once per mapped find (sequential).
    expect(addCalls).toHaveLength(2);
    expect(addCalls.map((c) => c.title)).toEqual(["Product Manager", "Senior PM"]);
    expect(addCalls[0].sourceId).toBe("ap"); // provenance stamped
    expect(spawnMock).not.toHaveBeenCalled(); // NO agent spawned - deterministic path
  });

  it("an expired posting is filtered out end-to-end: never written, counted in filteredOut (t-1783422051088)", async () => {
    enableApify();
    // One posting whose deadline is long past + one still-open (no deadline). The
    // run uses the real local date as `today`, so 2020 is unambiguously expired.
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([
      { positionName: "Dead Role", company: "Old Co", jobUrl: "https://a/dead", deadline: "2020-01-01" },
      { positionName: "Open Role", company: "New Co", jobUrl: "https://a/open" },
    ]);
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(201);
    const done = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "succeeded");
    expect(done).toBe(true);
    const rec = (await getSource("ap")).runs[0];
    expect(rec.leadsNew).toBe(1); // only the open posting became a lead
    expect(rec.candidatesReviewed).toBe(2); // both were reviewed
    expect(rec.filteredOut).toBe(1); // the expired one is HONESTLY counted, not silently dropped
    // The expired posting never reached the workbook write path at all.
    expect(addCalls.map((c) => c.title)).toEqual(["Open Role"]);
  });

  it("a 401 from Apify -> failed run with a friendly, token-free reason (guardian C10)", async () => {
    enableApify();
    process.env.JOBHUNT_APIFY_STATUS = "401";
    const res = await request(app).post("/api/discovery/sources/ap/run").send({});
    expect(res.status).toBe(201); // launched; the failure is a terminal outcome, not an HTTP error
    const failed = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "failed");
    expect(failed).toBe(true);
    const rec = (await getSource("ap")).runs[0];
    expect(rec.errorReason).toBe("APIFY_TOKEN rejected by Apify");
    expect(addCalls).toHaveLength(0); // nothing written on a rejected token
  });

  it("a 5xx / timeout -> failed 'unreachable or timed out'; a bad shape -> failed 'unexpected shape'", async () => {
    enableApify();
    for (const [status, reason] of [
      ["500", "Apify unreachable or timed out"],
      ["timeout", "Apify unreachable or timed out"],
      ["bad-shape", "unexpected Apify response shape"],
    ]) {
      setSources([{ id: "ap", name: "Indeed Apify", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "a~b" }]);
      process.env.JOBHUNT_APIFY_STATUS = status;
      await request(app).post("/api/discovery/sources/ap/run").send({});
      const failed = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "failed");
      expect(failed, `status ${status}`).toBe(true);
      expect((await getSource("ap")).runs[0].errorReason).toBe(reason);
    }
  });

  it("a workbook lock at write time -> failed with the friendly locked message (cadence honest)", async () => {
    enableApify();
    addBehaviour = "locked";
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([{ positionName: "PM", jobUrl: "https://a/1" }]);
    await request(app).post("/api/discovery/sources/ap/run").send({});
    const failed = await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "failed");
    expect(failed).toBe(true);
    const rec = (await getSource("ap")).runs[0];
    expect(rec.errorReason).toMatch(/open in Excel/i);
    // the run DID happen (attempted) -> lastRunAt honestly stamped
    expect((await getSource("ap")).lastRunAt).toBeTruthy();
  });
});

// ===========================================================================
// TOKEN NEVER LEAKS (guardian C4) - the load-bearing secret assertion.
// ===========================================================================

describe("the token appears in ZERO logs / errors / responses (guardian C4)", () => {
  it("a forced failure leaves the sentinel token nowhere observable", async () => {
    enableApify();
    setSources([{ id: "ap", name: "Ap", type: "apify", sector: "private", active: "yes", cadence: "weekly", actorId: "a~b" }]);
    process.env.JOBHUNT_APIFY_STATUS = "401";
    const launch = await request(app).post("/api/discovery/sources/ap/run").send({});
    const runId = launch.body.runId;
    await waitFor(async () => (await getSource("ap")).runs[0]?.outcome === "failed");

    // 1. the run record (errorReason / output) served by the run endpoint
    const runView = await request(app).get(`/api/routines/run/${runId}`);
    expect(JSON.stringify(runView.body)).not.toContain(SENTINEL_TOKEN);
    expect(runView.body.output || "").not.toContain(SENTINEL_TOKEN);

    // 2. the source + its run history
    const src = await request(app).get("/api/discovery/sources/ap");
    expect(JSON.stringify(src.body)).not.toContain(SENTINEL_TOKEN);

    // 3. the durable activity log on disk
    const activity = fs.existsSync(ACTIVITY_LOG()) ? fs.readFileSync(ACTIVITY_LOG(), "utf8") : "";
    expect(activity).not.toContain(SENTINEL_TOKEN);

    // 4. the persisted registry
    expect(fs.readFileSync(SOURCES_YAML(), "utf8")).not.toContain(SENTINEL_TOKEN);
  });
});

// ===========================================================================
// RUN-ALL-DUE - per-sweep budget + no-token skip (paid fan-out guard, C5d).
// ===========================================================================

describe("POST /api/discovery/run-all-due (apify fan-out guards)", () => {
  const dueApify = (id, daysAgo) => ({
    id,
    name: id,
    type: "apify",
    sector: "private",
    active: "yes",
    cadence: "daily",
    actorId: "a~b",
    lastRunAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  });

  it("skips ALL apify sources (reported, cadence untouched) when apify is not configured", async () => {
    setSources([dueApify("ap-a", 5), dueApify("ap-b", 4), dueApify("ap-c", 3)]);
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(200); // nothing queued
    expect(res.body.total).toBe(0);
    expect(res.body.apifySkippedNoToken.sort()).toEqual(["ap-a", "ap-b", "ap-c"]);
    expect(res.body.apifyLaunched).toEqual([]);
    // cadence untouched: no run records, lastRunAt unchanged (not re-stamped now)
    expect((await getSource("ap-a")).runs).toEqual([]);
  });

  it("launches at most the per-sweep budget, most-overdue-first; the rest stay due", async () => {
    enableApify();
    process.env.JOBHUNT_APIFY_MAX_SWEEP = "1"; // force a tiny budget
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([]); // quiet run, no writes
    setSources([dueApify("ap-a", 5), dueApify("ap-b", 4), dueApify("ap-c", 3)]);
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    expect(res.body.apifyLaunched).toEqual(["ap-a"]); // oldest lastRunAt
    expect(res.body.apifySkippedBudget.sort()).toEqual(["ap-b", "ap-c"]);
    expect(res.body.total).toBe(1);
    // let the one launched run settle so it cannot bleed into the next test
    await waitFor(async () => (await getSource("ap-a")).runs[0]?.outcome === "succeeded");
  });

  it("at the derived monthly cap, run-all-due launches ZERO apify runs", async () => {
    enableApify();
    process.env.JOBHUNT_APIFY_MONTHLY_CAP = "2";
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([]);
    const now = new Date().toISOString();
    // Two apify runs already this month across the registry -> cap reached.
    setSources([
      { id: "hist", name: "hist", type: "apify", sector: "private", active: "no", cadence: "daily", actorId: "a~b", runs: [{ runId: "r1", startedAt: now, outcome: "succeeded", trigger: "manual" }, { runId: "r2", startedAt: now, outcome: "succeeded", trigger: "manual" }] },
      dueApify("ap-a", 5),
      dueApify("ap-b", 4),
    ]);
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(200);
    expect(res.body.apifyLaunched).toEqual([]);
    expect(res.body.apifySkippedBudget.sort()).toEqual(["ap-a", "ap-b"]);
  });

  it("does not disturb agent (board) sources - they fan out as before, unaffected by the paid caps", async () => {
    enableApify();
    process.env.JOBHUNT_APIFY_MAX_SWEEP = "1";
    process.env.JOBHUNT_APIFY_FIXTURE = writeFixture([]);
    setSources([
      { id: "board-a", name: "Board A", type: "board", sector: "private", active: "yes", cadence: "daily" },
      { id: "board-b", name: "Board B", type: "board", sector: "private", active: "yes", cadence: "daily" },
      dueApify("ap-a", 5),
      dueApify("ap-b", 4),
    ]);
    const res = await request(app).post("/api/discovery/run-all-due");
    expect(res.status).toBe(201);
    // both boards queued; only 1 apify (the budget) launched
    expect(res.body.targets).toEqual(expect.arrayContaining(["board-a", "board-b", "ap-a"]));
    expect(res.body.apifyLaunched).toEqual(["ap-a"]);
    expect(res.body.targets).not.toContain("ap-b");
    // let the launched runs (2 boards + 1 apify) settle before the next test
    await waitFor(async () => {
      const all = (await request(app).get("/api/discovery/sources")).body.sources;
      return ["board-a", "board-b", "ap-a"].every((id) => {
        const s = all.find((x) => x.id === id);
        return s && (s.runs || []).every((r) => r.outcome !== "running");
      });
    });
  });
});
