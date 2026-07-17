import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// Sources write-back can never eat a field it does not model (t-1783258133295).
// The incident: the dual-track setup lets an OLDER server binary (the stable
// channel, v0.20.0) write docs/discovery-sources.yaml; its serializer predated
// fetchMode, so a single lastVisitedAt visit-stamp write round-tripped the
// registry and erased fetchMode from all 33 sources. The fix is two-sided:
//   - every CURRENT schema field is modeled explicitly (round-trip test 1);
//   - any key the serializer does NOT model rides through normalizeSource's
//     `_extra` carrier and is written back verbatim (tests 2-4) - so the NEXT
//     version-skewed writer stops eating the next new field.
// Plus the incident-shaped regression: a visit-stamp PATCH round-trips
// fetchMode (and a future unknown field) intact on disk.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, "..", "docs");
const BOARD_FIXTURES = path.resolve(__dirname, "fixtures", "board");

let app;
let pure;
let tmpRoot;
let docsDir;
let jobsDir;
let findsFile;

const SOURCES_YAML = () => path.join(docsDir, "discovery-sources.yaml");

function setSources(sources) {
  fs.writeFileSync(SOURCES_YAML(), yaml.dump({ version: 1, sources }), "utf8");
}
const readSources = () => yaml.load(fs.readFileSync(SOURCES_YAML(), "utf8"));

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-src-ser-"));
  docsDir = path.join(tmpRoot, "docs");
  jobsDir = path.join(tmpRoot, "Jobs");
  findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries: [], runLog: [] }), "utf8");
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = jobsDir;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  const mod = await import("../server/index.js");
  app = mod.app;
  pure = mod;
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.cpSync(REPO_DOCS, docsDir, { recursive: true });
  fs.cpSync(BOARD_FIXTURES, docsDir, { recursive: true });
});

// A source exercising EVERY field the current schema stores.
const FULL = {
  id: "full-source",
  name: "Full Source",
  type: "employer",
  sector: "private",
  active: "yes",
  urls: ["https://example.com/careers"],
  cadence: "weekly",
  fetchMode: "direct-list",
  fetchNote: "query params are cosmetic - filter client-side",
  instructions: "Enumerate postings from the list page.",
  outputFields: ["title", "link", "deadline"],
  aliases: ["Full Src"],
  tracks: [],
  lastRunAt: "2026-07-01T10:00:00.000Z",
  lastVisitedAt: "2026-07-02T10:00:00.000Z",
  notes: "a note",
  runs: [{ runId: "r1", startedAt: "2026-07-01T10:00:00.000Z", outcome: "succeeded", trigger: "manual", durationMs: 5, leadsFound: 2, leadsNew: 1 }],
  instructionProposals: [
    { id: "p1", ts: "2026-07-03T10:00:00.000Z", status: "pending", proposedInstructions: "new text", ownerComment: "note", rationale: "why" },
  ],
  instructionsApprovedFrom: "p0",
  instructionsUpdatedAt: "2026-06-30T10:00:00.000Z",
};

describe("serializeSource round-trip (every modeled field)", () => {
  it("normalize -> serialize preserves every current schema field", () => {
    const out = pure.serializeSource(pure.normalizeSource(FULL));
    for (const k of Object.keys(FULL)) {
      expect(out, `field ${k}`).toHaveProperty(k);
    }
    expect(out.fetchMode).toBe("direct-list");
    expect(out.fetchNote).toMatch(/cosmetic/);
    expect(out.runs).toHaveLength(1);
    expect(out.instructionProposals).toHaveLength(1);
  });

  it("MODELED_SOURCE_KEYS covers everything serializeSource writes for a modeled source", () => {
    const out = pure.serializeSource(pure.normalizeSource(FULL));
    for (const k of Object.keys(out)) {
      expect(pure.MODELED_SOURCE_KEYS.has(k), `serializer writes unlisted key ${k}`).toBe(true);
    }
  });

  it("round-trips an apify source's actorId / input / fieldMap (ADR 2026-07-06)", () => {
    const APIFY = {
      id: "indeed-apify",
      name: "Indeed (Apify)",
      type: "apify",
      sector: "private",
      active: "yes",
      urls: [],
      cadence: "weekly",
      instructions: "",
      outputFields: [],
      aliases: [],
      tracks: [],
      actorId: "misceres~indeed-scraper",
      input: { position: "product manager", location: "Toronto, ON", maxItems: 50 },
      fieldMap: { title: "positionName", link: "jobUrl" },
    };
    const out = pure.serializeSource(pure.normalizeSource(APIFY));
    expect(out.type).toBe("apify");
    expect(out.actorId).toBe("misceres~indeed-scraper");
    expect(out.input).toEqual({ position: "product manager", location: "Toronto, ON", maxItems: 50 });
    expect(out.fieldMap).toEqual({ title: "positionName", link: "jobUrl" });
    // no _extra leakage, and every written key is modeled
    expect(out).not.toHaveProperty("_extra");
    for (const k of Object.keys(out)) expect(pure.MODELED_SOURCE_KEYS.has(k), `unlisted key ${k}`).toBe(true);
  });

  it("writes NO apify keys for a non-apify source (byte-identical round-trip preserved)", () => {
    const out = pure.serializeSource(pure.normalizeSource(FULL)); // FULL is type:"employer"
    expect(out).not.toHaveProperty("actorId");
    expect(out).not.toHaveProperty("input");
    expect(out).not.toHaveProperty("fieldMap");
  });
});

describe("version-skew passthrough (_extra): unmodeled keys survive the round-trip", () => {
  const skewed = {
    id: "skewed",
    name: "Skewed",
    // Fields THIS serializer does not model - stand-ins for whatever a newer
    // schema adds next (the fetchMode of the next incident).
    crawlBudget: 5,
    futureFlags: { retryOn429: true, regions: ["ca", "eu"] },
  };

  it("normalizeSource captures unmodeled keys on _extra, verbatim", () => {
    const n = pure.normalizeSource(skewed);
    expect(n._extra).toEqual({ crawlBudget: 5, futureFlags: { retryOn429: true, regions: ["ca", "eu"] } });
  });

  it("serializeSource writes them back as real keys and never stores _extra itself", () => {
    const out = pure.serializeSource(pure.normalizeSource(skewed));
    expect(out.crawlBudget).toBe(5);
    expect(out.futureFlags).toEqual({ retryOn429: true, regions: ["ca", "eu"] });
    expect(out).not.toHaveProperty("_extra");
  });

  it("a double round-trip is stable (normalize -> serialize -> normalize -> serialize)", () => {
    const once = pure.serializeSource(pure.normalizeSource(skewed));
    const twice = pure.serializeSource(pure.normalizeSource(once));
    expect(twice).toEqual(once);
  });

  it("a modeled field always wins a name collision with cargo", () => {
    const n = pure.normalizeSource({ id: "x", name: "X", _extra: { name: "smuggled", cargo: 1 } });
    const out = pure.serializeSource(n);
    expect(out.name).toBe("X");
    expect(out.cargo).toBe(1);
  });

  it("the served (derived) source never leaks _extra or the unknown keys", () => {
    const derived = pure.deriveSources({ version: 1, sources: [skewed] }, []).sources[0];
    expect(derived).not.toHaveProperty("_extra");
    expect(derived).not.toHaveProperty("crawlBudget");
    expect(derived).not.toHaveProperty("futureFlags");
  });
});

// Clean-repo hermeticity (I9): the curated registry is deliberately absent from
// the public extraction - skip the committed-content guard there, never fail.
describe.skipIf(!fs.existsSync(path.join(REPO_DOCS, "discovery-sources.yaml")))("committed registry guard: no key in the real data is droppable", () => {
  it("every key on every source in docs/discovery-sources.yaml survives a round-trip", () => {
    const committed = yaml.load(fs.readFileSync(path.join(REPO_DOCS, "discovery-sources.yaml"), "utf8"));
    expect(committed.sources.length).toBeGreaterThan(0);
    for (const s of committed.sources) {
      const out = pure.serializeSource(pure.normalizeSource(s));
      for (const k of Object.keys(s)) {
        expect(out, `source ${s.id} key ${k}`).toHaveProperty(k);
      }
    }
  });
});

describe("incident regression: a visit-stamp PATCH round-trips the whole file intact", () => {
  it("PATCH lastVisitedAt keeps fetchMode/fetchNote AND a future unmodeled field on disk", async () => {
    setSources([
      {
        id: "linkedin-jobs",
        name: "LinkedIn Jobs",
        type: "board",
        sector: "private",
        active: "yes",
        urls: ["https://linkedin.com/jobs"],
        cadence: "daily",
        fetchMode: "google-site",
        fetchNote: "anti-bot",
        instructions: "",
        outputFields: [],
        aliases: [],
        // The next incident's field: nothing in this build models it.
        futureField: "must survive",
      },
    ]);
    const stamp = "2026-07-05T12:47:06.896Z";
    const res = await request(app)
      .patch("/api/discovery/sources/linkedin-jobs")
      .send({ lastVisitedAt: stamp });
    expect(res.status).toBe(200);

    const onDisk = readSources().sources.find((s) => s.id === "linkedin-jobs");
    expect(onDisk.lastVisitedAt).toBe(stamp);
    expect(onDisk.fetchMode).toBe("google-site"); // the field the incident erased
    expect(onDisk.fetchNote).toBe("anti-bot");
    expect(onDisk.futureField).toBe("must survive"); // the field the NEXT incident would erase
    expect(onDisk).not.toHaveProperty("_extra");
  });
});
