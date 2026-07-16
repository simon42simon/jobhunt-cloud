import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

// [SCHEMA] Job.source disposition: WIRED as discovery provenance
// (t-1783199066654). The orphaned frontmatter key becomes the
// source->lead->job provenance link the schema's relations map formalizes:
//   WRITER  - createJobFolder, at job creation only: POST /api/discovery/pursue
//             resolves the find's source (explicit body.sourceId, else the
//             workbook row's own sourceId/name/alias join); POST /api/jobs
//             accepts a `sourceId` that must resolve in the registry.
//             Only a CANONICAL registry id is ever written - unresolvable
//             values are ignored (Task posture), never a 400 and never a
//             bogus write. Resolution is best-effort: it never blocks pursue.
//   READER  - toJob serves `source` verbatim on every Job payload.
//   LEGACY  - real vault files carry free-string values ("source: Northwind Supply",
//             a NAME); they are served verbatim, never rewritten, and stay
//             un-editable (source is NOT in WRITABLE_FIELDS - provenance is a
//             creation-time fact, not a dashboard-editable field).

let app;
let tmpRoot;
let fixture;
let docsDir;
let findsFile;

const SOURCES = [
  {
    id: "university-affairs",
    name: "University Affairs",
    type: "board",
    sector: "bps",
    active: "yes",
    cadence: "weekly",
    urls: ["https://ua.example/jobs"],
    aliases: ["UA board"],
  },
  {
    id: "mars",
    name: "MaRS",
    type: "board",
    sector: "private",
    active: "yes",
    cadence: "daily",
    urls: ["https://mars.example/jobs"],
  },
];

function setFinds(discoveries) {
  fs.writeFileSync(findsFile, JSON.stringify({ config: [], discoveries, runLog: [] }), "utf8");
}

function writeFixture() {
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(fixture, { recursive: true });
  // A legacy job whose on-disk source is a free-string NAME, not a registry id.
  const dir = path.join(fixture, "Legacy Role - Northwind Supply");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Legacy Role.md"),
    [
      "---", "type: job", "role: Legacy Role", "employer: Northwind Supply",
      "track: b2b_gtm_focused", "fit: strong", "status: lead",
      "sector: private", "tailoring: light", "source: Northwind Supply", "tags: [job]",
      "---", "", "# Legacy Role - Northwind Supply", "", "**Lead with:** x", "",
    ].join("\n"),
    "utf8"
  );
}

const readFront = (folder, file) => fs.readFileSync(path.join(fixture, folder, file), "utf8").split("---")[1];

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jh-provenance-"));
  fixture = path.join(tmpRoot, "Jobs");
  docsDir = path.join(tmpRoot, "docs");
  findsFile = path.join(tmpRoot, "finds.json");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "discovery-sources.yaml"), yaml.dump({ version: 1, sources: SOURCES }), "utf8");
  writeFixture();
  setFinds([]);
  process.env.JOBHUNT_TEST = "1";
  process.env.JOBHUNT_JOBS_DIR = fixture;
  process.env.JOBHUNT_DOCS_DIR = docsDir;
  process.env.JOBHUNT_DISCOVERY_FINDS = findsFile;
  ({ app } = await import("../server/index.js"));
});

afterAll(() => {
  delete process.env.JOBHUNT_DISCOVERY_FINDS;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  writeFixture();
  setFinds([]);
});

describe("POST /api/discovery/pursue writes provenance", () => {
  it("an explicit body.sourceId that resolves in the registry is written as the canonical id", async () => {
    const res = await request(app).post("/api/discovery/pursue").send({
      title: "Direct Role",
      employer: "Direct Co",
      sourceId: "university-affairs",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("university-affairs");
    expect(readFront("Direct Role - Direct Co", "Direct Role.md")).toContain("source: university-affairs");
  });

  it("a source NAME or ALIAS as sourceId resolves to the canonical id (never written raw)", async () => {
    const byName = await request(app).post("/api/discovery/pursue").send({
      title: "Name Role",
      employer: "Name Co",
      sourceId: "University Affairs",
    });
    expect(byName.body.source).toBe("university-affairs");
    const byAlias = await request(app).post("/api/discovery/pursue").send({
      title: "Alias Role",
      employer: "Alias Co",
      sourceId: "UA board",
    });
    expect(byAlias.body.source).toBe("university-affairs");
  });

  it("with NO sourceId, the matching workbook row's provenance is joined (Title + Link, sourceId else Source label)", async () => {
    setFinds([
      { Title: "Found Role", Employer: "Found Co", Source: "University Affairs", Link: "https://ua.example/jobs/1" },
      { Title: "Stamped Role", Employer: "Stamped Co", sourceId: "mars", Link: "https://mars.example/jobs/2" },
    ]);
    const byLabel = await request(app).post("/api/discovery/pursue").send({
      title: "Found Role",
      employer: "Found Co",
      link: "https://ua.example/jobs/1",
    });
    expect(byLabel.status).toBe(201);
    expect(byLabel.body.source).toBe("university-affairs");

    const byStamp = await request(app).post("/api/discovery/pursue").send({
      title: "Stamped Role",
      employer: "Stamped Co",
      link: "https://mars.example/jobs/2",
    });
    expect(byStamp.body.source).toBe("mars");
  });

  it("disambiguates same-Title rows by Link; stays honest (no source) when truly ambiguous", async () => {
    setFinds([
      { Title: "Twin Role", Employer: "Twin Co", Source: "University Affairs", Link: "https://ua.example/jobs/9" },
      { Title: "Twin Role", Employer: "Twin Co", Source: "MaRS", Link: "https://mars.example/jobs/9" },
    ]);
    const withLink = await request(app).post("/api/discovery/pursue").send({
      title: "Twin Role",
      employer: "Twin Co",
      link: "https://mars.example/jobs/9",
    });
    expect(withLink.body.source).toBe("mars");

    fs.rmSync(path.join(fixture, "Twin Role - Twin Co"), { recursive: true, force: true });
    const noLink = await request(app).post("/api/discovery/pursue").send({
      title: "Twin Role",
      employer: "Twin Co",
    });
    expect(noLink.status).toBe(201); // ambiguity NEVER blocks the pursue
    expect(noLink.body.source).toBe("");
    expect(readFront("Twin Role - Twin Co", "Twin Role.md")).not.toContain("source:");
  });

  it("no match anywhere -> the job is created WITHOUT a source key (never a fake value, never a failure)", async () => {
    const res = await request(app).post("/api/discovery/pursue").send({
      title: "Orphan Role",
      employer: "Orphan Co",
      sourceId: "not-a-real-source",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("");
    expect(readFront("Orphan Role - Orphan Co", "Orphan Role.md")).not.toContain("source:");
  });
});

describe("POST /api/jobs provenance (manual / scout intake)", () => {
  it("writes a resolvable sourceId as the canonical id", async () => {
    const res = await request(app).post("/api/jobs").send({
      role: "Manual Role",
      employer: "Manual Co",
      sourceId: "MaRS", // name form -> canonical id
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("mars");
    expect(readFront("Manual Role - Manual Co", "Manual Role.md")).toContain("source: mars");
  });

  it("ignores an unresolvable sourceId AND a raw `source` body key (only canonical ids ever land)", async () => {
    const res = await request(app).post("/api/jobs").send({
      role: "Smuggle Role",
      employer: "Smuggle Co",
      sourceId: "bogus-board",
      source: "hand-crafted-provenance",
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("");
    expect(readFront("Smuggle Role - Smuggle Co", "Smuggle Role.md")).not.toContain("source:");
  });
});

describe("reader + legacy tolerance", () => {
  it("serves a legacy free-string source verbatim (never rewritten, never dropped)", async () => {
    const res = await request(app).get("/api/jobs");
    const legacy = res.body.find((j) => j.id === "Legacy Role - Northwind Supply");
    expect(legacy.source).toBe("Northwind Supply");
  });

  it("PATCH cannot touch source (not a WRITABLE_FIELD - provenance is a creation-time fact)", async () => {
    const before = fs.readFileSync(path.join(fixture, "Legacy Role - Northwind Supply", "Legacy Role.md"), "utf8");
    const res = await request(app)
      .patch(`/api/jobs/${encodeURIComponent("Legacy Role - Northwind Supply")}`)
      .send({ source: "university-affairs", fit: "moderate" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("Northwind Supply"); // untouched
    expect(res.body.fit).toBe("moderate"); // the rest of the body applied
    expect(fs.readFileSync(path.join(fixture, "Legacy Role - Northwind Supply", "Legacy Role.md"), "utf8")).toContain(
      "source: Northwind Supply"
    );
    // ...and reverting fit restores the file byte-identically (surgical write).
    await request(app)
      .patch(`/api/jobs/${encodeURIComponent("Legacy Role - Northwind Supply")}`)
      .send({ fit: "strong" });
    expect(fs.readFileSync(path.join(fixture, "Legacy Role - Northwind Supply", "Legacy Role.md"), "utf8")).toBe(before);
  });
});
